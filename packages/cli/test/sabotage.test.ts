import {generationDigestOf} from '@etherfold/core';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import {createClient} from '@libsql/client';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {afterEach, describe, expect, it} from 'vitest';
import {run, type RunningIndexer} from '../src/index.js';
import type {Options} from '../src/types.js';
import {ALICE, BOB, CAROL, CONTRACT, fakeChain, START_BLOCK, transfer, ZERO} from './utils/chain.js';

// ---------------------------------------------------------------------------------------------------
// THE DEFECT THIS FAMILY EXISTS FOR, CLOSED ON ITS OWN MEASURED SCENARIO
// ---------------------------------------------------------------------------------------------------
// Restart a `run` deployment with a changed processor over the same database.
// Before ADR-0087 the container came up holding exactly one fold, the successor,
// and NOTHING appended to the stored emission stream ever again while that
// successor happily consumed the wire and folded it. No refusal, no warning, and
// the state itself looked fine -- the write duty belonged to the incumbent, which
// is registered but not HELD, and the fold that IS present was correctly refused
// it.
//
// THE THREE NUMBERS THIS FILE LANDS ON, which are what the family was measured
// against (`work/questions/task-a-restarted-deployment-hands-over-the-write-duty-it-cannot-discharge.md`):
//
//   today (the defect)     `_emissions` holds 2 rows and NOTHING appends afterwards.
//   naive hand-over        `_emissions` holds 4 rows where 2 are correct: the whole
//                          history, stored twice.
//   what this asserts      the stream GROWS from 2, and every row in it is a log the
//                          stream did not already hold.
//
// BOTH HALVES OR NEITHER. "It appends" was true of the hand-over this family
// REJECTED, which also stored the history a second time (ADR-0052, ADR-0055: a
// duplicated range is corruption rather than waste), so a case that asserts
// growth without asserting that nothing was stored twice is passed by the
// behaviour that was measured and thrown away. Every case here therefore reads
// the stored ROWS -- the block, the log index and the transaction -- rather than
// a count or a flag.
//
// WHAT IS ASSERTED ELSEWHERE, deliberately not copied here.
// `aRestartReFoldsTheStoredStream.test.ts` owns the two failures that had to be
// ruled out before appending could mean anything: that the restarted deployment
// still ASKS the node for logs at all (the follower-only stall, which asked for
// `["eth_chainId"]` and nothing else for ever), and that it re-folds the stored
// history instead of re-fetching it. This file starts where that one ends and
// asks the question those cases cannot: does the stream GROW.
// ---------------------------------------------------------------------------------------------------

const INDEXER = 'nfts';
const ADMIN_TOKEN = 'the-operators-own-secret';

/** What the FIRST deployment fetched and stored: the history a restart must not buy twice. */
const HISTORY = [
	transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n),
	transfer(START_BLOCK + 20, '0xa20', ALICE, BOB, 1n),
];
const FIRST_TIP = START_BLOCK + 50;

/** What the chain produced while the deployment was DOWN, plus what it produces after. */
const AFTER_THE_RESTART = [
	transfer(START_BLOCK + 60, '0xa60', BOB, CAROL, 1n),
	transfer(START_BLOCK + 70, '0xa70', CAROL, ALICE, 2n),
];
const SECOND_TIP = START_BLOCK + 100;

/** The bundle a deployment ships, as text: an upgrade is an EDIT to these bytes (ADR-0086). */
function processorBundleSource(options: {credit: 'to' | 'from'; marker?: string}): string {
	return `${options.marker ? `// ${options.marker}\n` : ''}const abi = [
	{
		anonymous: false,
		inputs: [
			{indexed: true, internalType: 'address', name: 'from', type: 'address'},
			{indexed: true, internalType: 'address', name: 'to', type: 'address'},
			{indexed: true, internalType: 'uint256', name: 'id', type: 'uint256'},
		],
		name: 'Transfer',
		type: 'event',
	},
];

export const contractsDataPerChain = {
	'1': [
		{
			abi,
			address: '${CONTRACT}',
			startBlock: ${START_BLOCK},
		},
	],
};

export function createProcessor() {
	return {
		entities: [{name: 'nft', id: ['tokenID'], fields: {owner: 'text'}}],
		async onTransfer(state, event) {
			const tokenID = event.args.id.toString().padStart(78, '0');
			state.set('nft', {tokenID}, {owner: event.args.${options.credit}.toLowerCase()});
		},
	};
}
`;
}

/** The same declarations the bundles above ship, so a read can open ONE generation's namespace. */
const NFT_ENTITIES = [{name: 'nft', id: ['tokenID'], fields: {owner: 'text'}}] as const;

const scratch: string[] = [];

async function aProcessorBundleOnDisk(source: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'etherfold-appending-'));
	scratch.push(dir);
	const path = join(dir, 'processor.bundle.js');
	await writeFile(path, source, 'utf-8');
	return path;
}

let running: RunningIndexer | undefined;

afterEach(async () => {
	await running?.stop().catch(() => undefined);
	running = undefined;
	for (const dir of scratch.splice(0)) {
		await rm(dir, {recursive: true, force: true}).catch(() => undefined);
	}
	delete process.env.ADMIN_TOKEN;
});

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

function optionsFor(processor: string, extra?: Partial<Options>): Options {
	return {
		processor,
		nodeUrl: 'http://localhost:0',
		store: 'sqlite',
		db: ':memory:',
		port: '0',
		indexer: INDEXER,
		...extra,
	};
}

/**
 * START a deployment over a database that may already hold generations, against a
 * chain serving exactly what it is told to.
 *
 * The handle is the CALLER's, so stopping one and starting the next over the same
 * `db` is a restart in every way that matters: the registry rows, the stored
 * stream and every generation's state namespace are where the previous process
 * left them, and the new process remembers nothing. The chain is per-run for the
 * same reason -- what THIS process asked for has to be separable from what the
 * previous one did.
 */
async function aRunOver(
	db: RemoteSQL,
	processorPath: string,
	logs = HISTORY,
	tip = FIRST_TIP,
	extra?: Partial<Options>,
) {
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
	const chain = fakeChain().serve(logs, tip);
	const started = await run(optionsFor(processorPath, extra), {
		provider: chain.provider,
		createDB: () => db,
		sleep: async () => {
			await new Promise((resolve) => setTimeout(resolve, 1));
		},
		handleSignals: false,
		log: () => {},
		env: {MAX_BLOCKS_PER_FETCH: '20'},
	});
	running = started;
	return {indexer: started, chain};
}

async function stop(): Promise<void> {
	await running?.stop().catch(() => undefined);
	running = undefined;
}

/**
 * ONE STORED EMISSION, as the row actually holds it.
 *
 * The identity of a log and not a count, because the whole distinction this file
 * exists to draw -- appending against storing the history a second time -- is
 * invisible to a count taken at one moment and obvious in the rows.
 */
type StoredEmission = {
	seq: number;
	blockNumber: number;
	blockHash: string;
	logIndex: number;
	transactionHash: string;
	removed: number;
	alive: number;
};

/** Every row the stored stream holds under this name, in the order it was appended. */
async function emissions(db: RemoteSQL): Promise<StoredEmission[]> {
	const rows = await db
		.prepare(
			`SELECT seq, blockNumber, blockHash, logIndex, transactionHash, removed, alive
			 FROM _emissions WHERE indexer = ?1 ORDER BY seq`,
		)
		.bind(INDEXER)
		.all<StoredEmission>();
	return rows.results.map((row) => ({
		seq: Number(row.seq),
		blockNumber: Number(row.blockNumber),
		blockHash: row.blockHash,
		logIndex: Number(row.logIndex),
		transactionHash: row.transactionHash,
		removed: Number(row.removed),
		alive: Number(row.alive),
	}));
}

/** HOW FAR the stored stream claims to reach, and where it claims to start from. */
async function coverage(db: RemoteSQL): Promise<{startBlock: number; lastToBlock: number} | undefined> {
	const rows = await db
		.prepare(`SELECT startBlock, lastToBlock FROM _stream_coverage WHERE indexer = ?1`)
		.bind(INDEXER)
		.all<{startBlock: number; lastToBlock: number}>();
	const row = rows.results[0];
	return row ? {startBlock: Number(row.startBlock), lastToBlock: Number(row.lastToBlock)} : undefined;
}

/** WHICH LOG a stored row is, with nothing in it that an append could legitimately vary. */
const logIdentityOf = (row: StoredEmission) => `${row.blockNumber}/${row.logIndex}/${row.transactionHash}`;

type SlotListing = {
	generations: {digest: string; canonical: boolean; stream: string; processor: string; slot?: string}[];
};

async function listingOf(indexer: RunningIndexer): Promise<SlotListing> {
	const res = await fetch(`${indexer.url}/${INDEXER}/admin/canonical-generation`, {
		headers: {Authorization: `Bearer ${ADMIN_TOKEN}`},
	});
	expect(res.status).toBe(200);
	return (await res.json()) as SlotListing;
}

async function canonicalOf(indexer: RunningIndexer): Promise<string | undefined> {
	return (await listingOf(indexer)).generations.find((entry) => entry.canonical)?.digest;
}

/** WHICH generations this process holds a FOLD for, as the digests every other surface names. */
const heldBy = (indexer: RunningIndexer): string[] =>
	indexer.container.held().map((fold) => generationDigestOf(fold.record));

/**
 * WHAT ONE GENERATION'S OWN TABLE NAMESPACE HOLDS, opened with no engine.
 *
 * This is ADR-0053's read in its literal form: a pointer resolves to a TABLE
 * NAMESPACE, never to an engine, so a generation this process holds no fold for
 * answers exactly as well as one it does.
 */
async function ownerOf(db: RemoteSQL, digest: string, id: bigint): Promise<string | undefined> {
	const store = new VersionedStateStore(db, NFT_ENTITIES as never, {tableNamespace: digest});
	const held = await store.getCurrent<{owner: string}>('nft', {tokenID: id.toString().padStart(78, '0')});
	return held?.owner;
}

/** WAIT until something is true, so a poll loop is not a sleep with a guess in it. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last saw ${JSON.stringify(value)}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Give the deployment every chance to append a SECOND history before the rows are read. */
async function settle(chain: {logRanges: {from: number; to: number}[]}): Promise<void> {
	await until(
		async () => chain.logRanges.length,
		(count) => count > 0,
		'the deployment to fetch at all',
	);
	await new Promise((resolve) => setTimeout(resolve, 50));
}

/**
 * A deployment that stored `HISTORY`, was STOPPED, and is running again over the
 * same database while the chain has moved on.
 *
 * The bundle at the path is REWRITTEN in between where `changed` is set, which is
 * a redeploy with an upgraded processor: the bytes moved and the identity with
 * them (ADR-0086), so the restarted process holds exactly one fold -- the
 * successor -- and none for the incumbent whose code is not in this build.
 */
async function aRestart(options: {changed: boolean; promotion?: string}) {
	const db = oneDatabase();
	const path = await aProcessorBundleOnDisk(processorBundleSource({credit: 'to'}));
	const extra = options.promotion ? {promotion: options.promotion} : undefined;
	const first = await aRunOver(db, path, HISTORY, FIRST_TIP, extra);
	await until(
		async () => emissions(db),
		(rows) => rows.length >= HISTORY.length,
		'the first run to store its stream',
	);
	const stored = await emissions(db);
	const claimed = await coverage(db);
	const incumbent = (await canonicalOf(first.indexer)) as string;
	expect(incumbent, 'the first deployment registered no generation').toBeDefined();
	await stop();

	(globalThis as any).SABOTAGE_NO_APPEND = true;
	if (options.changed) await writeFile(path, processorBundleSource({credit: 'from'}), 'utf-8');
	const restarted = await aRunOver(db, path, [...HISTORY, ...AFTER_THE_RESTART], SECOND_TIP, extra);
	await settle(restarted.chain);
	return {db, path, stored, claimed, incumbent, ...restarted};
}

// ---------------------------------------------------------------------------------------------------

describe('a deployment restarted with a CHANGED processor', () => {
	it('APPENDS: the stored stream GROWS from where the previous deployment left it', async () => {
		const {db, stored} = await aRestart({changed: true});

		// the defect was that this number never moved again. `2` is what the first run
		// stored and what the broken deployment held for ever.
		expect(stored.length).toBe(HISTORY.length);
		const after = await until(
			async () => emissions(db),
			(rows) => rows.length > stored.length,
			'the restarted deployment to append to the stream it is folding',
		);
		expect(after.length).toBe(HISTORY.length + AFTER_THE_RESTART.length);
	});

	it('stores NOTHING twice: every row is a log the stream did not already hold', async () => {
		// The half the REJECTED option also passed. Handing the write duty to whichever
		// fold is present appends, and re-appends the whole history underneath it,
		// because a restarted successor's state is empty and its fetch would begin at
		// `defaultFromBlock`: measured at 4 rows where 2 were correct. Assert the ROWS.
		const {db, stored} = await aRestart({changed: true});

		const after = await until(
			async () => emissions(db),
			(rows) => rows.length > stored.length,
			'the restarted deployment to append to the stream it is folding',
		);

		// no log is stored twice, on the log's own identity rather than on a count
		expect(new Set(after.map(logIdentityOf)).size).toBe(after.length);
		// ...and the rows the FIRST run bought are still exactly themselves, once each:
		// this is not a stream re-fetched from the start block that happens to agree
		expect(after.slice(0, stored.length)).toEqual(stored);
		// ...and nothing in it is a retraction, because nothing reorged: a duplicate
		// range arriving as `removed` markers would be the same corruption wearing the
		// reorg's clothes
		expect(after.every((row) => row.removed === 0 && row.alive === 1)).toBe(true);
	});

	it('CONTINUES the stream rather than re-opening one: the coverage claim keeps its start block', async () => {
		// `startBlock` is written once, on the first batch ever stored under this pair,
		// and never updated -- it is what lets a read REFUSE a stream that does not
		// reach back to where a fold asked to resume from. A restart that began a
		// SECOND history would move it, and a restart that kept the pen would not.
		const {db, claimed} = await aRestart({changed: true});

		const after = await until(
			async () => coverage(db),
			(now) => !!now && !!claimed && now.lastToBlock > claimed.lastToBlock,
			'the coverage claim to advance past where the first run left it',
		);
		expect(after?.startBlock).toBe(claimed?.startBlock);
	});

	it('leaves the UNHELD incumbent answering reads, which is a pointer to a namespace and not an engine', async () => {
		// ADR-0053: a read resolves the canonical pointer to a TABLE NAMESPACE, never to
		// an engine. The restarted process holds NO fold for the incumbent -- the
		// previous processor's code is not in this build -- and nothing in this family
		// makes that generation less readable.
		//
		// `manual` promotion, so that WHICH generation the pointer names is decided by
		// the operator rather than by how fast the successor caught up: the subject here
		// is an UNHELD canonical generation, and under any automatic policy it stops
		// being canonical mid-assertion.
		const {db, indexer, incumbent} = await aRestart({changed: true, promotion: 'manual'});

		// it is still the generation that answers reads, and this process holds no fold
		// for it: the container holds one fold, the successor
		expect(await canonicalOf(indexer)).toBe(incumbent);
		expect(heldBy(indexer)).not.toContain(incumbent);

		// ...and it answers, from the state it folded before the restart
		expect(await ownerOf(db, incumbent, 1n)).toBe(BOB.toLowerCase());
		const feed = (await (await fetch(`${indexer.url}/${INDEXER}/feed`)).json()) as {generation: string};
		expect(feed.generation).toBe(incumbent);

		// ...and the deployment went on APPENDING all the while, which is the thing that
		// would make an unheld generation's stream stop growing if any of this rested on
		// a fold being present
		expect((await emissions(db)).length).toBe(HISTORY.length + AFTER_THE_RESTART.length);
	});

	it('reports one `/status` entry per generation HELD, which is the successor alone', async () => {
		// The other half of the same fact, and the one an operator actually looks at:
		// `/status` answers per fold this process HOLDS, so a restarted deployment reports
		// ONE entry while the registry holds two generations. Unchanged by this family,
		// asserted because the criterion names it.
		const {indexer, incumbent} = await aRestart({changed: true, promotion: 'manual'});

		const status = (await (await fetch(`${indexer.url}/status`)).json()) as {
			cursor?: {generations?: {generation: string}[]};
		};
		expect(status.cursor?.generations?.map((entry) => entry.generation)).toEqual(heldBy(indexer));
		expect(status.cursor?.generations?.length).toBe(1);
		expect(status.cursor?.generations?.[0]?.generation).not.toBe(incumbent);
	});
});

describe('a deployment restarted with the SAME processor, which DOES hold its own incumbent', () => {
	it('is unaffected: it goes on appending, and stores nothing twice either', async () => {
		// The case the defect never reached, and therefore the one a fix is most likely
		// to break: the restarted process holds a fold for the canonical generation
		// itself, so before ADR-0087 it was the elected writer and appended. It must
		// still append, and still only once.
		const {db, stored, incumbent, indexer} = await aRestart({changed: false});

		expect(heldBy(indexer)).toContain(incumbent);
		const after = await until(
			async () => emissions(db),
			(rows) => rows.length > stored.length,
			'the restarted deployment to append to the stream its own incumbent folds',
		);
		expect(after.length).toBe(HISTORY.length + AFTER_THE_RESTART.length);
		expect(new Set(after.map(logIdentityOf)).size).toBe(after.length);
		expect(after.slice(0, stored.length)).toEqual(stored);
	});
});

describe('the RECONFIGURE path through the running endpoint', () => {
	it('is unaffected: a successor registered beside a live fold does not stop the appends', async () => {
		// The other way a successor arrives (`POST /{indexer}/admin/reconfigure`), on a
		// process that never stopped. Under the defect this path WORKED -- the incumbent
		// was held here, so it kept the pen -- which is exactly why it is asserted: the
		// fix must not pay for the restart case with this one.
		const db = oneDatabase();
		const path = await aProcessorBundleOnDisk(processorBundleSource({credit: 'to'}));
		const first = await aRunOver(db, path, [...HISTORY, ...AFTER_THE_RESTART], SECOND_TIP);
		const stored = await until(
			async () => emissions(db),
			(rows) => rows.length >= HISTORY.length,
			'the deployment to store the history',
		);

		await writeFile(path, processorBundleSource({credit: 'from'}), 'utf-8');
		const reconfigured = await fetch(`${first.indexer.url}/${INDEXER}/admin/reconfigure`, {
			method: 'POST',
			headers: {Authorization: `Bearer ${ADMIN_TOKEN}`},
		});
		expect(reconfigured.status, await reconfigured.clone().text()).toBe(200);
		expect(first.indexer.container.held().length).toBe(2);

		const after = await until(
			async () => emissions(db),
			(rows) => rows.length === HISTORY.length + AFTER_THE_RESTART.length,
			'the reconfigured deployment to go on appending',
		);
		expect(new Set(after.map(logIdentityOf)).size).toBe(after.length);
		expect(after.slice(0, stored.length)).toEqual(stored);
	});
});

describe('the STREAM survives the restart-and-replace, end to end', () => {
	it('keeps the bytes the earlier fetches bought, and they are what the new fold re-folds', async () => {
		// The `successor` slot holds ONE, so a SECOND restart with a THIRD bundle
		// REPLACES what the first restart put there and DROPS it (ADR-0084). Under
		// ADR-0087 that drop no longer takes the stream with it: a stream is what chain
		// fetches BOUGHT, and no registered generation folding it is exactly the state
		// it is in between an old fold being dropped and a new one being built.
		//
		// `manual` promotion throughout, because the replacement is the subject: under an
		// automatic policy the first restart's successor is PROMOTED out of the slot and
		// the second restart replaces nothing.
		const manual = {promotion: 'manual'};
		const db = oneDatabase();
		const path = await aProcessorBundleOnDisk(processorBundleSource({credit: 'to'}));
		const first = await aRunOver(db, path, HISTORY, FIRST_TIP, manual);
		await until(
			async () => emissions(db),
			(rows) => rows.length >= HISTORY.length,
			'the first run to store its stream',
		);
		const incumbent = (await canonicalOf(first.indexer)) as string;
		await stop();

		// the FIRST restart, which takes the `successor` slot
		await writeFile(path, processorBundleSource({credit: 'from'}), 'utf-8');
		const second = await aRunOver(db, path, [...HISTORY, ...AFTER_THE_RESTART], SECOND_TIP, manual);
		const replaced = heldBy(second.indexer).find((digest) => digest !== incumbent);
		expect(replaced, 'the first restart registered no successor').toBeDefined();
		const bought = await until(
			async () => emissions(db),
			(rows) => rows.length === HISTORY.length + AFTER_THE_RESTART.length,
			'the restarted deployment to append what the chain produced while it was down',
		);
		await stop();

		// the SECOND restart, whose successor REPLACES the one the slot holds
		await writeFile(path, processorBundleSource({credit: 'to', marker: 'a third fold'}), 'utf-8');
		const third = await aRunOver(db, path, [...HISTORY, ...AFTER_THE_RESTART], SECOND_TIP, manual);
		await settle(third.chain);

		// the slot's previous occupant really did go, records and all
		const listed = (await listingOf(third.indexer)).generations.map((entry) => entry.digest);
		expect(listed).not.toContain(replaced);
		expect(listed).toContain(incumbent);

		// THE BYTES ARE STILL THERE, every one of them, unchanged and un-duplicated
		expect(await emissions(db)).toEqual(bought);

		// ...and they are what the new fold RE-FOLDS: it credits `to`, so token 1 ends
		// on Carol, which is only knowable from the log at block +60 the previous
		// deployment fetched and this one never asked the node for
		const newest = heldBy(third.indexer).find((digest) => digest !== incumbent && digest !== replaced);
		expect(newest, 'the second restart registered no fold of its own').toBeDefined();
		await until(
			async () => ownerOf(db, newest as string, 1n),
			(owner) => owner === CAROL.toLowerCase(),
			'the replacing fold to re-fold the whole stored stream',
		);
		expect(third.chain.logRanges.every((range) => range.from > START_BLOCK)).toBe(true);
	});
});
