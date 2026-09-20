import {createClient} from '@libsql/client';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {afterEach, describe, expect, it} from 'vitest';
import {run, type RunningIndexer} from '../src/index.js';
import type {Options} from '../src/types.js';
import {ALICE, BOB, CONTRACT, fakeChain, START_BLOCK, transfer, ZERO} from './utils/chain.js';

// ---------------------------------------------------------------------------------------------------
// A RESTART RE-FOLDS THE STORED STREAM, AND THE DEPLOYMENT GOES ON FETCHING
// ---------------------------------------------------------------------------------------------------
// The whole of ADR-0087, asserted where it is a CLAIM rather than an inference:
// on a real deployment, over a real libSQL handle, reading what the process
// actually asked the node for.
//
// It is one file because the two halves killed each other when they were tried
// apart, and both failures were MEASURED
// (`docs/spikes/a-restarted-generation-re-folds-its-stream-instead-of-re-fetching-the-chain/`):
//
//   RE-FOLD ALONE      making the restarted generation a FOLLOWER without moving
//                      the FETCH gives a deployment that re-folds, is promoted,
//                      serves reads, reports healthy -- and asks the node for
//                      `["eth_chainId"]` and nothing else, for ever. Cheap and
//                      DEAD, which is worse than expensive and live.
//   MOVE THE FETCH     handing the append duty to whichever fold is present, with
//                      the position still coming from that fold's own state,
//                      stores the history a SECOND time: measured at 4 emission
//                      rows where 2 are correct.
//
// So the assertions are deliberately about the WIRE and the ROWS rather than
// about a flag: which methods were called, which ranges were asked for, and how
// many emissions the database holds afterwards. A flag can be right while the
// deployment is dead.
// ---------------------------------------------------------------------------------------------------

const INDEXER = 'nfts';
const ADMIN_TOKEN = 'the-operators-own-secret';

const LOGS = [
	transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n),
	transfer(START_BLOCK + 20, '0xa20', ALICE, BOB, 1n),
];
const TIP = START_BLOCK + 50;

/** The bundle a deployment ships, as text: an upgrade is an EDIT to these bytes (ADR-0086). */
function processorBundleSource(options: {credit: 'to' | 'from'}): string {
	return `const abi = [
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

const scratch: string[] = [];

async function aProcessorBundleOnDisk(source: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'etherfold-refold-'));
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

function optionsFor(processor: string): Options {
	return {
		processor,
		nodeUrl: 'http://localhost:0',
		store: 'sqlite',
		db: ':memory:',
		port: '0',
		indexer: INDEXER,
	};
}

/**
 * START a deployment over a database that may already hold generations, with its
 * OWN fake chain so what it asked for is separable from what the previous run did.
 *
 * The handle is the CALLER's, so stopping one and starting the next over the same
 * `db` is a restart in every way that matters: the registry rows, the stored
 * stream and every generation's state namespace are where the previous process
 * left them, and the new process remembers nothing.
 */
async function aRunOver(db: RemoteSQL, processorPath: string) {
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
	const chain = fakeChain().serve(LOGS, TIP);
	const started = await run(optionsFor(processorPath), {
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

/** How many rows the stored emission stream holds under this name, whatever the stream. */
async function emissionRows(db: RemoteSQL): Promise<number> {
	const rows = await db
		.prepare(`SELECT COUNT(*) AS count FROM _emissions WHERE indexer = ?1`)
		.bind(INDEXER)
		.all<{count: number}>();
	return Number(rows.results[0]?.count ?? 0);
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

describe('a deployment restarted with a changed processor', () => {
	it('KEEPS FETCHING: it asks the node for logs and a tip, not for `eth_chainId` alone', async () => {
		// THE MEASUREMENT THAT STOPPED THIS TASK'S FIRST SHAPE, as an assertion. The
		// narrow fix made the restarted generation a FOLLOWER and left the FETCH on the
		// generation: a follower has no receiver, `liveIngestions()` was empty, the
		// fetch side had nowhere to push, and the deployment asked for `eth_chainId` and
		// nothing else for ever while reporting itself healthy.
		const db = oneDatabase();
		const path = await aProcessorBundleOnDisk(processorBundleSource({credit: 'to'}));
		const first = await aRunOver(db, path);
		await until(
			async () => emissionRows(db),
			(rows) => rows >= LOGS.length,
			'the first run to store its stream',
		);
		await stop();

		await writeFile(path, processorBundleSource({credit: 'from'}), 'utf-8');
		const restarted = await aRunOver(db, path);

		// it FETCHES: the methods a live deployment asks for, on a process whose every
		// held fold is a successor re-folding history it did not fetch
		await until(
			async () => restarted.chain.calls.map((call) => call.method),
			(methods) => methods.includes('eth_blockNumber'),
			'the restarted deployment to ask the node for the tip',
		);
		const methods = new Set(restarted.chain.calls.map((call) => call.method));
		expect(methods.has('eth_chainId')).toBe(true);
		expect([...methods]).not.toEqual(['eth_chainId']);
	});

	it('RE-FOLDS rather than re-fetching: no `eth_getLogs` below what the stream already covers', async () => {
		const db = oneDatabase();
		const path = await aProcessorBundleOnDisk(processorBundleSource({credit: 'to'}));
		const first = await aRunOver(db, path);
		await until(
			async () => emissionRows(db),
			(rows) => rows >= LOGS.length,
			'the first run to store its stream',
		);
		// the first run DID go back to the chain for the history, which is what makes
		// the second run's silence a fact about this change rather than about the fixture
		expect(first.chain.logRanges.some((range) => range.from <= START_BLOCK)).toBe(true);
		await stop();

		await writeFile(path, processorBundleSource({credit: 'from'}), 'utf-8');
		const restarted = await aRunOver(db, path);
		await until(
			async () => restarted.chain.logRanges.length,
			(count) => count > 0,
			'the restarted deployment to fetch at all',
		);

		// ON THE WIRE AND NOT ON A FLAG: not one range reaches back to the source's own
		// first block. The position came from the STREAM, so an empty-state successor
		// could not drag it there.
		for (const range of restarted.chain.logRanges) {
			expect(range.from).toBeGreaterThan(START_BLOCK);
		}
	});

	it('stores NOTHING twice: the emission stream ends the size one history is', async () => {
		// The other measured failure, which is what handing the duty to the fold that
		// happens to be present produced: `_emissions` at 4 rows where 2 are correct.
		const db = oneDatabase();
		const path = await aProcessorBundleOnDisk(processorBundleSource({credit: 'to'}));
		await aRunOver(db, path);
		await until(
			async () => emissionRows(db),
			(rows) => rows >= LOGS.length,
			'the first run to store its stream',
		);
		const stored = await emissionRows(db);
		expect(stored).toBe(LOGS.length);
		await stop();

		await writeFile(path, processorBundleSource({credit: 'from'}), 'utf-8');
		const restarted = await aRunOver(db, path);
		await until(
			async () => restarted.chain.logRanges.length,
			(count) => count > 0,
			'the restarted deployment to fetch at all',
		);
		// give it every chance to append a second history before the count is read
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(await emissionRows(db)).toBe(stored);
	});

	it('holds TWO folds at once and still appends ONCE, because no generation appends at all', async () => {
		// The one-writer rule with its subject moved (ADR-0052/ADR-0087): a deployment
		// holding two generations on one stream stores that stream once, and it is the
		// DEPLOYMENT that stores it rather than whichever fold was elected.
		const db = oneDatabase();
		const path = await aProcessorBundleOnDisk(processorBundleSource({credit: 'to'}));
		const first = await aRunOver(db, path);
		await until(
			async () => emissionRows(db),
			(rows) => rows >= LOGS.length,
			'the first run to store its stream',
		);

		// a SECOND fold beside the live one, on the SAME stream: the same source and the
		// same stream config, different processor bytes. The running process re-reads its
		// own configuration and registers whatever that names beside the live fold.
		await writeFile(path, processorBundleSource({credit: 'from'}), 'utf-8');
		const reconfigured = await fetch(`${first.indexer.url}/${INDEXER}/admin/reconfigure`, {
			method: 'POST',
			headers: {Authorization: `Bearer ${ADMIN_TOKEN}`},
		});
		expect(reconfigured.status, await reconfigured.clone().text()).toBe(200);
		expect(first.indexer.container.held().length).toBe(2);
		expect(new Set(first.indexer.container.held().map((fold) => fold.streamDigest)).size).toBe(1);

		// NEITHER of them can append: there is no per-fold gate left to be true for one
		// of them, because a fold is never handed the thing that appends (ADR-0087)
		expect(first.indexer.container.held().every((fold) => !('writesStream' in fold))).toBe(true);
		// ...and one live wire context, which is the STREAM's writer and not either fold
		const live = await first.indexer.container.liveIngestions();
		expect(live.length).toBe(1);
		expect(live[0]?.generation).toBeUndefined();

		// the stream stays the size ONE history is, with two folds held over it
		const before = await emissionRows(db);
		await until(
			async () => first.chain.logRanges.length,
			(count) => count > 0,
			'the deployment to go on fetching with two folds held',
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await emissionRows(db)).toBe(before);
	});
});
