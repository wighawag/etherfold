import {generationDigestOf} from '@etherfold/core';
import {EMISSION_STREAM_TABLE} from '@etherfold/server';
import {declareEntities} from '@etherfold/state-store';
import {processorArtifactIdentity} from '@etherfold/utils';
import {createClient} from '@libsql/client';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {afterEach, describe, expect, it} from 'vitest';
import {node, run, type RunningIndexer} from '../src/index.js';
import type {Options} from '../src/types.js';
import {uploadMain} from '../src/uploadCommand.js';
import {
	abi,
	ALICE,
	addressTopic,
	BOB,
	CAROL,
	CONTRACT,
	nftEntities,
	START_BLOCK,
	timestampOf,
	transfer,
	TRANSFER_TOPIC,
	ZERO,
	type RawLog,
} from './utils/chain.js';
import {canonicalStoreIn} from './utils/reads.js';

// ---------------------------------------------------------------------------------------------------
// A SUCCESSOR ON A NEW STREAM IS FETCHED BY ITS OWN WRITER, so the "add an event" deploy completes
// ---------------------------------------------------------------------------------------------------
// The maintainer decided on 2026-09-26 that an upload carrying DIFFERENT contracts is a
// legitimate change, and registers a successor on its NEW stream rather than being
// refused. It used to register and then never advance: a `run` built ONE fetcher over ONE
// source, so nothing appended to the new stream. The decision is a SECOND WRITER: while a
// successor sits on another stream, that stream is fetched too, by its own fetcher,
// through the container's ONE `StreamWriter` for it (ADR-0087), and the incumbent keeps
// being fetched and answering throughout.
//
// Asserted END TO END against a real `etherfold node` and the real `etherfold upload`,
// over the committed REAL bundles: `nfts.bundle.js` indexes `Transfer`, and
// `nfts-with-approval.bundle.js` adds `Approval` and a handler that needs it -- the
// ordinary "add an event" deploy. The uploads used to go to a `run`; since ADR-0094 the
// upload route is `node`'s, and these cases moved to it, the incumbent being the node's
// first upload. What a configured `run` still does here is recorded where it happens: it
// restarts over a database a `node` wrote, and it restarts with a changed configured source.
//
// The chain here is the one thing that differs from the other upload suites: it FILTERS
// by `topic0`, the way a node does, and COUNTS the `eth_getLogs` calls per filter. So
// "the new stream is fetched" and "the old stream's fetcher stopped" are read off what
// the node was ASKED, rather than inferred from state.
// ---------------------------------------------------------------------------------------------------

const FIXTURES = fileURLToPath(new URL('./fixtures/processor-bundle/', import.meta.url));
const BUNDLE = join(FIXTURES, 'nfts.bundle.js');
const EDITED_BUNDLE = join(FIXTURES, 'nfts-edited.bundle.js');
const APPROVAL_BUNDLE = join(FIXTURES, 'nfts-with-approval.bundle.js');

const INDEXER = 'nfts';
const ADMIN_TOKEN = 'the-operators-own-secret';

/** `keccak256("Approval(address,address,uint256)")`: the event the new bundle adds. */
const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';

let approvalCounter = 0;
/** An ERC-721 `Approval`: every argument is indexed, so the token rides in topic 3. */
function approval(blockNumber: number, blockHash: string, owner: string, approved: string, id: bigint): RawLog {
	approvalCounter++;
	return {
		blockNumber: `0x${blockNumber.toString(16)}`,
		blockHash,
		transactionIndex: '0x0',
		removed: false,
		address: CONTRACT,
		data: '0x',
		topics: [APPROVAL_TOPIC, addressTopic(owner), addressTopic(approved), `0x${id.toString(16).padStart(64, '0')}`],
		transactionHash: `0x${(0xa000 + approvalCounter).toString(16).padStart(64, '0')}`,
		logIndex: '0x1',
		blockTimestamp: `0x${timestampOf(blockNumber).toString(16)}`,
	};
}

const LOGS = [
	transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n),
	transfer(START_BLOCK + 20, '0xa20', ALICE, BOB, 1n),
	// only a fold that fetches `Approval` ever sees this one
	approval(START_BLOCK + 30, '0xa30', BOB, CAROL, 1n),
];
const TIP = START_BLOCK + 50;
/** What the chain does next: BOB hands the token to CAROL. */
const LATER = [...LOGS, transfer(START_BLOCK + 70, '0xa70', BOB, CAROL, 1n)];
const LATER_TIP = START_BLOCK + 100;

/** The two fetch filters, as a key: `Transfer` alone, and `Transfer` plus `Approval`. */
const filterKey = (topic0s: readonly string[]) => JSON.stringify(topic0s.map((topic) => topic.toLowerCase()).sort());
const OLD_FILTER = filterKey([TRANSFER_TOPIC]);
const NEW_FILTER = filterKey([TRANSFER_TOPIC, APPROVAL_TOPIC]);

/** What the approval bundle declares: `nfts`'s entities plus the one its new handler writes. */
const approvalEntities = declareEntities([
	...nftEntities,
	{name: 'approval', id: ['tokenID'], fields: {approved: 'text'}},
]);

/**
 * A NODE THAT FILTERS BY `topic0`, as a real one does, and remembers how many
 * `eth_getLogs` it was asked per filter.
 */
function aFilteringChain() {
	const asked = new Map<string, number>();
	let served: RawLog[] = [];
	let tip = 0;
	return {
		/** How many `eth_getLogs` this node was asked with exactly this set of `topic0`s. */
		askedFor(filter: string): number {
			return asked.get(filter) ?? 0;
		},
		serve(logs: RawLog[], latestBlock: number) {
			served = logs;
			tip = latestBlock;
			return this;
		},
		provider: {
			async request(args: {method: string; params?: any}): Promise<any> {
				switch (args.method) {
					case 'eth_chainId':
						return '0x1';
					case 'eth_blockNumber':
						return `0x${tip.toString(16)}`;
					case 'eth_getLogs': {
						const [filter] = args.params;
						const slot = filter.topics?.[0];
						const topic0s: string[] = Array.isArray(slot) ? slot : slot ? [slot] : [];
						const key = filterKey(topic0s);
						asked.set(key, (asked.get(key) ?? 0) + 1);
						const wanted = new Set(topic0s.map((topic) => topic.toLowerCase()));
						const from = parseInt(filter.fromBlock.slice(2), 16);
						const to = parseInt(filter.toBlock.slice(2), 16);
						return served.filter((log) => {
							const blockNumber = parseInt(log.blockNumber.slice(2), 16);
							return blockNumber >= from && blockNumber <= to && wanted.has(log.topics[0]!.toLowerCase());
						});
					}
				}
				throw new Error(`unexpected method ${args.method}`);
			},
		} as any,
	};
}

type Chain = ReturnType<typeof aFilteringChain>;

let running: RunningIndexer | undefined;
const scratch: string[] = [];

afterEach(async () => {
	await running?.stop().catch(() => undefined);
	running = undefined;
	delete process.env.ADMIN_TOKEN;
	for (const dir of scratch.splice(0)) await rm(dir, {recursive: true, force: true}).catch(() => undefined);
});

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

/** A `node`: no processor and no source (ADR-0094). */
const NOTHING: Options = {nodeUrl: 'http://localhost:0', store: 'sqlite', db: ':memory:', port: '0', indexer: INDEXER};
/** A `run` started with `nfts.bundle.js`, whose source comes from that processor module. */
const CONFIGURED: Options = {...NOTHING, processor: BUNDLE};

/**
 * THE LOOP'S WAIT, which a test can PARK: while parked, the drive loop stops at its next
 * wait and neither fetches nor rebuilds until the process is stopped or released.
 */
function aParkableWait() {
	const state = {parked: false, parkedNow: false};
	let release: () => void = () => {};
	const sleep = async (_ms: number, signal?: AbortSignal): Promise<void> => {
		await new Promise((resolve) => setTimeout(resolve, 1));
		if (!state.parked) return;
		state.parkedNow = true;
		await new Promise<void>((resolve) => {
			release = resolve;
			if (signal?.aborted) return resolve();
			signal?.addEventListener('abort', () => resolve(), {once: true});
		});
		state.parkedNow = false;
	};
	return {
		state,
		sleep,
		release() {
			state.parked = false;
			release();
		},
	};
}

/** START a configured `run` over `db`, which may already hold generations: a restart, when it does. */
async function aRunOver(
	db: RemoteSQL,
	chain: Chain,
	options: Options,
	sleep?: ReturnType<typeof aParkableWait>['sleep'],
): Promise<RunningIndexer> {
	return aStartOf(run, db, chain, options, sleep);
}

/** START a `node` over `db`, which may already hold generations: a restart, when it does. */
async function aNodeOver(
	db: RemoteSQL,
	chain: Chain,
	options: Options = NOTHING,
	sleep?: ReturnType<typeof aParkableWait>['sleep'],
): Promise<RunningIndexer> {
	return aStartOf(node, db, chain, options, sleep);
}

/** A `node` whose first upload, `nfts.bundle.js`, is its incumbent. */
async function aNodeServingTheIncumbent(
	db: RemoteSQL,
	chain: Chain,
	options: Options = NOTHING,
	sleep?: ReturnType<typeof aParkableWait>['sleep'],
): Promise<RunningIndexer> {
	const indexer = await aNodeOver(db, chain, options, sleep);
	await uploadWith(indexer, BUNDLE);
	return indexer;
}

async function aStartOf(
	start: typeof run,
	db: RemoteSQL,
	chain: Chain,
	options: Options,
	sleep?: ReturnType<typeof aParkableWait>['sleep'],
): Promise<RunningIndexer> {
	process.env.ADMIN_TOKEN = ADMIN_TOKEN;
	running = await start(options, {
		provider: chain.provider,
		createDB: () => db,
		sleep:
			sleep ??
			(async () => {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}),
		handleSignals: false,
		log: () => {},
		env: {MAX_BLOCKS_PER_FETCH: '20'},
		startGuard: {interactive: false},
	});
	return running;
}

async function stop(): Promise<void> {
	await running?.stop().catch(() => undefined);
	running = undefined;
}

/** `etherfold upload`, as `cli.ts` runs it. */
async function uploadWith(indexer: RunningIndexer, bundle: string): Promise<void> {
	const err: string[] = [];
	let code: number | undefined;
	const out: string[] = [];
	await uploadMain(
		{bundle, to: indexer.url, indexer: INDEXER},
		{
			env: {ADMIN_TOKEN},
			log: (...args) => out.push(args.map(String).join(' ')),
			error: (...args) => err.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ')),
			exit: (value) => {
				code = value;
			},
		},
	);
	expect(code, err.join('\n')).toBe(0);
	expect(out.join('\n')).toMatch(/\bregistered\b/);
}

type Listing = {
	slots?: Record<string, {digest: string} | undefined>;
	generations: {digest: string; stream: string; processor: string; canonical: boolean; folding?: string}[];
};

async function listingOf(indexer: RunningIndexer): Promise<Listing> {
	const res = await fetch(`${indexer.url}/${INDEXER}/admin/canonical-generation`, {
		headers: {Authorization: `Bearer ${ADMIN_TOKEN}`},
	});
	expect(res.status).toBe(200);
	return (await res.json()) as Listing;
}

const bytesOf = async (path: string): Promise<Uint8Array> => new Uint8Array(await readFile(path));

/** The listing's entry for the generation a bundle names. */
async function entryOf(indexer: RunningIndexer, bundle: string): Promise<Listing['generations'][number]> {
	const identity = processorArtifactIdentity(await bytesOf(bundle));
	const entry = (await listingOf(indexer)).generations.find((one) => one.processor === identity);
	if (!entry) throw new Error(`this deployment holds no generation for ${bundle}`);
	return entry;
}

/** How far one generation has folded, read from its own namespace with no engine. */
async function positionOf(indexer: RunningIndexer, bundle: string): Promise<number | undefined> {
	const {stream, processor} = await entryOf(indexer, bundle);
	return indexer.container.registry.readStateCursor({stream, processor});
}

/** READ THE FEED, refusing anything but a served answer: the incumbent answers reads throughout. */
async function feedGeneration(indexer: RunningIndexer): Promise<string> {
	const res = await fetch(`${indexer.url}/${INDEXER}/feed`);
	const body = (await res.json()) as {generation: string};
	expect(res.status, JSON.stringify(body)).toBe(200);
	return body.generation;
}

async function waitFor(what: string, done: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		if (await done()) return;
		if (Date.now() > deadline) throw new Error(`never happened: ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** The canonical generation's `approval` row for token 1, read through the pointer as a reader would. */
async function approvedFor(db: RemoteSQL): Promise<string | undefined> {
	const store = await canonicalStoreIn(db, approvalEntities, {indexer: INDEXER});
	return (await store.getCurrent<{approved: string}>('approval', {tokenID: '1'.padStart(78, '0')}))?.approved;
}

/** How many CANONICAL rows one stored stream holds, and how many of them share a position. */
async function storedRowsOf(db: RemoteSQL, stream: string): Promise<{rows: number; duplicated: number}> {
	const rows = await db
		.prepare(
			`SELECT COUNT(*) AS records FROM ${EMISSION_STREAM_TABLE} WHERE indexer = ?1 AND stream = ?2 AND alive = 1`,
		)
		.bind(INDEXER, stream)
		.all<{records: number}>();
	const duplicated = await db
		.prepare(
			`SELECT COUNT(*) AS positions FROM (SELECT blockNumber, logIndex FROM ${EMISSION_STREAM_TABLE} ` +
				`WHERE indexer = ?1 AND stream = ?2 AND alive = 1 GROUP BY blockNumber, logIndex HAVING COUNT(*) > 1)`,
		)
		.bind(INDEXER, stream)
		.all<{positions: number}>();
	return {rows: Number(rows.results[0]?.records ?? 0), duplicated: Number(duplicated.results[0]?.positions ?? 0)};
}

/**
 * EACH STORED STREAM HAS EXACTLY ONE WRITER (ADR-0087), asserted three ways: the container
 * names each stream it fetches once, with its own writer; this process runs exactly one
 * fetcher per such stream; and the rows each stream stored hold no position twice.
 */
async function expectOneWriterPerStream(indexer: RunningIndexer, db: RemoteSQL): Promise<void> {
	const fetched = await indexer.container.fetchedStreams();
	const streams = fetched.map((one) => one.stream);
	expect(new Set(streams).size).toBe(streams.length);
	expect(new Set(fetched.map((one) => one.writer)).size).toBe(fetched.length);
	for (const one of fetched) expect(one.writer.streamDigest).toBe(one.stream);
	// the wire resolves each stream's address to that same writer and to nothing else
	expect(await indexer.container.liveIngestions()).toEqual(fetched.map((one) => one.writer));
	expect([...indexer.fetchers.streams()].sort()).toEqual([...streams].sort());
	for (const stream of streams) expect((await storedRowsOf(db, stream)).duplicated).toBe(0);
}

// ---------------------------------------------------------------------------------------------------

describe('an upload that ADDS AN EVENT is fetched on its new stream, beside the incumbent', () => {
	it('fetches the successor stream while the incumbent keeps answering and advancing, one writer per stream', async () => {
		const db = oneDatabase();
		const chain = aFilteringChain().serve(LOGS, TIP);
		// `manual`, so the two sit side by side for as long as the case reads them
		const indexer = await aNodeServingTheIncumbent(db, chain, {...NOTHING, promotion: 'manual'});
		await waitFor('the incumbent folded to the tip', async () => (await positionOf(indexer, BUNDLE)) === TIP);
		const incumbent = await entryOf(indexer, BUNDLE);
		expect(chain.askedFor(NEW_FILTER)).toBe(0);

		await uploadWith(indexer, APPROVAL_BUNDLE);
		const successor = await entryOf(indexer, APPROVAL_BUNDLE);
		expect(successor.stream).not.toBe(incumbent.stream);
		expect((await listingOf(indexer)).slots?.successor?.digest).toBe(successor.digest);

		// ITS STREAM IS FETCHED, by a fetcher of its own over the contracts it carries, and it
		// catches up to the tip
		await waitFor(
			'the successor caught up on its own stream',
			async () => (await positionOf(indexer, APPROVAL_BUNDLE)) === TIP,
		);
		expect(chain.askedFor(NEW_FILTER)).toBeGreaterThan(0);
		expect([...indexer.fetchers.streams()].sort()).toEqual([incumbent.stream, successor.stream].sort());
		// ...and it is reported as what it is: HELD, and never `stream-not-fetched`
		expect((await entryOf(indexer, APPROVAL_BUNDLE)).folding).toBe('held');

		// THE INCUMBENT KEEPS BEING FETCHED AND ANSWERING while the chain moves on
		const incumbentAsked = chain.askedFor(OLD_FILTER);
		chain.serve(LATER, LATER_TIP);
		await waitFor('the incumbent advanced past the tip it stood at', async () => {
			return (
				(await positionOf(indexer, BUNDLE)) === LATER_TIP && (await positionOf(indexer, APPROVAL_BUNDLE)) === LATER_TIP
			);
		});
		expect(chain.askedFor(OLD_FILTER)).toBeGreaterThan(incumbentAsked);
		expect(await feedGeneration(indexer)).toBe(incumbent.digest);

		// ONE WRITER PER STREAM, and each stream stored exactly what its filter returned:
		// three transfers on the old stream, three transfers and the approval on the new one
		await expectOneWriterPerStream(indexer, db);
		expect((await storedRowsOf(db, incumbent.stream)).rows).toBe(3);
		expect((await storedRowsOf(db, successor.stream)).rows).toBe(4);
	});

	it('under `on-catch-up` promotes it, answers from it (the new event included), and stops the old stream’s fetcher', async () => {
		const db = oneDatabase();
		const chain = aFilteringChain().serve(LOGS, TIP);
		const indexer = await aNodeServingTheIncumbent(db, chain);
		await waitFor('the incumbent folded to the tip', async () => (await positionOf(indexer, BUNDLE)) === TIP);
		const incumbent = await entryOf(indexer, BUNDLE);

		await uploadWith(indexer, APPROVAL_BUNDLE);
		const successor = await entryOf(indexer, APPROVAL_BUNDLE);

		// every read on the way is a served one, from the incumbent until the pointer moves
		await waitFor('the successor was promoted', async () => {
			const answering = await feedGeneration(indexer);
			expect([incumbent.digest, successor.digest]).toContain(answering);
			return answering === successor.digest;
		});
		expect((await listingOf(indexer)).slots?.canonical?.digest).toBe(successor.digest);
		// ...answering WITH THE NEW EVENT's effect, which the incumbent never fetched
		expect(await approvedFor(db)).toBe(CAROL.toLowerCase());

		// THE FETCH FOLLOWED THE POINTER: the old stream's fetcher stops, the new one goes on
		await waitFor('the old stream stopped being fetched', async () => {
			return JSON.stringify(indexer.fetchers.streams()) === JSON.stringify([successor.stream]);
		});
		expect(indexer.container.fetchedSource).toBeDefined();
		const oldAsked = chain.askedFor(OLD_FILTER);
		chain.serve(LATER, LATER_TIP);
		await waitFor(
			'the promoted generation advanced',
			async () => (await positionOf(indexer, APPROVAL_BUNDLE)) === LATER_TIP,
		);
		// NOT ONE more chain call for the old filter, while the new one advanced to the tip
		expect(chain.askedFor(OLD_FILTER)).toBe(oldAsked);
		// the incumbent is retained, as the way back, and no longer folded here
		expect(indexer.container.held().map((fold) => generationDigestOf(fold.record))).toEqual([successor.digest]);
		expect((await listingOf(indexer)).slots?.predecessor?.digest).toBe(incumbent.digest);
		await expectOneWriterPerStream(indexer, db);
	});

	it('stops the fetcher of a new-stream successor that a newer upload REPLACES', async () => {
		const db = oneDatabase();
		const chain = aFilteringChain().serve(LOGS, TIP);
		const indexer = await aNodeServingTheIncumbent(db, chain, {...NOTHING, promotion: 'manual'});
		await waitFor('the incumbent folded to the tip', async () => (await positionOf(indexer, BUNDLE)) === TIP);
		const incumbent = await entryOf(indexer, BUNDLE);

		await uploadWith(indexer, APPROVAL_BUNDLE);
		const replaced = await entryOf(indexer, APPROVAL_BUNDLE);
		await waitFor('the new stream was fetched', async () => (await positionOf(indexer, APPROVAL_BUNDLE)) === TIP);

		// a newer upload takes the `successor` slot, which holds one, on the INCUMBENT's stream
		await uploadWith(indexer, EDITED_BUNDLE);
		expect((await listingOf(indexer)).generations.map((one) => one.digest)).not.toContain(replaced.digest);
		await waitFor('the replaced successor’s stream stopped being fetched', async () => {
			return JSON.stringify(indexer.fetchers.streams()) === JSON.stringify([incumbent.stream]);
		});
		const replacedAsked = chain.askedFor(NEW_FILTER);
		chain.serve(LATER, LATER_TIP);
		await waitFor('the incumbent advanced', async () => (await positionOf(indexer, BUNDLE)) === LATER_TIP);
		expect(chain.askedFor(NEW_FILTER)).toBe(replacedAsked);
		await expectOneWriterPerStream(indexer, db);
	});
});

describe('the same, across a restart of the `node`', () => {
	it('promotes the new-stream upload, and a restart fetches the NEW stream, whose cursor advances', async () => {
		const db = oneDatabase();
		const chain = aFilteringChain().serve(LOGS, TIP);
		const indexer = await aNodeServingTheIncumbent(db, chain);
		await waitFor('the first upload folded to the tip', async () => (await positionOf(indexer, BUNDLE)) === TIP);
		const incumbent = await entryOf(indexer, BUNDLE);

		await uploadWith(indexer, APPROVAL_BUNDLE);
		const successor = await entryOf(indexer, APPROVAL_BUNDLE);
		await waitFor('the successor was promoted', async () => (await feedGeneration(indexer)) === successor.digest);
		expect(await approvedFor(db)).toBe(CAROL.toLowerCase());
		await waitFor('the old stream stopped being fetched', async () => {
			return JSON.stringify(indexer.fetchers.streams()) === JSON.stringify([successor.stream]);
		});
		// what this deployment says it fetches followed the pointer
		const fetchedNow = await indexer.container.fetchedStreams();
		expect(fetchedNow.map((one) => one.source)).toEqual([indexer.container.fetchedSource]);
		await expectOneWriterPerStream(indexer, db);
		await stop();

		// A RESTART OF THE `node` fetches the stream the canonical generation is on
		const later = aFilteringChain().serve(LATER, LATER_TIP);
		const restarted = await aNodeOver(db, later);
		expect((await listingOf(restarted)).slots?.canonical?.digest).toBe(successor.digest);
		expect(restarted.container.held().map((fold) => generationDigestOf(fold.record))).toEqual([successor.digest]);
		expect([...restarted.fetchers.streams()]).toEqual([successor.stream]);
		await waitFor(
			'the canonical generation advanced after the restart',
			async () => (await positionOf(restarted, APPROVAL_BUNDLE)) === LATER_TIP,
		);
		expect(later.askedFor(NEW_FILTER)).toBeGreaterThan(0);
		expect(later.askedFor(OLD_FILTER)).toBe(0);
		expect(incumbent.stream).not.toBe(successor.stream);
	});
});

// The CONFIGURED shape of this case used to be a `run -p nfts.bundle.js` receiving the
// upload and restarting with the same processor. A configured `run` receives no upload
// since ADR-0094, so it is re-expressed as `run` over the database the `node` wrote,
// configured with the pending upload's own bundle: a start naming the pending successor,
// which changes nothing (the rule both before and after ADR-0094's discard rule), so what
// is asserted is what the configured restart FETCHES and promotes.
describe('a new-stream upload still CATCHING UP survives a restart, and is promoted', () => {
	for (const [shape, restart] of [
		[
			'as the `node` it was',
			(db: RemoteSQL, chain: Chain, sleep: ReturnType<typeof aParkableWait>['sleep']) =>
				aNodeOver(db, chain, NOTHING, sleep),
		],
		[
			'as a `run` configured with the pending upload',
			(db: RemoteSQL, chain: Chain, sleep: ReturnType<typeof aParkableWait>['sleep']) =>
				aRunOver(db, chain, {...NOTHING, processor: APPROVAL_BUNDLE}, sleep),
		],
	] as const) {
		it(`is fetched after a restart ${shape}, reported \`held\`, and promoted`, async () => {
			const db = oneDatabase();
			const wait = aParkableWait();
			const first = await aNodeServingTheIncumbent(db, aFilteringChain().serve(LOGS, TIP), NOTHING, wait.sleep);
			await waitFor('the incumbent folded to the tip', async () => (await positionOf(first, BUNDLE)) === TIP);
			const incumbent = await entryOf(first, BUNDLE);

			// PARKED, so the upload is registered and its stream never fetched before the stop
			wait.state.parked = true;
			await waitFor('the drive loop parked', async () => wait.state.parkedNow);
			await uploadWith(first, APPROVAL_BUNDLE);
			const successor = await entryOf(first, APPROVAL_BUNDLE);
			expect(await positionOf(first, APPROVAL_BUNDLE)).toBeUndefined();
			expect((await listingOf(first)).slots?.successor?.digest).toBe(successor.digest);
			await stop();

			// the restart comes up PARKED after its first cycle, so what it holds is read before
			// the successor can have caught up
			const chain = aFilteringChain().serve(LATER, LATER_TIP);
			const again = aParkableWait();
			again.state.parked = true;
			const restarted = await restart(db, chain, again.sleep);
			expect((await entryOf(restarted, APPROVAL_BUNDLE)).folding).toBe('held');
			expect([...restarted.fetchers.streams()].sort()).toEqual([incumbent.stream, successor.stream].sort());
			again.release();

			await waitFor('the successor was promoted', async () => (await feedGeneration(restarted)) === successor.digest);
			expect(await approvedFor(db)).toBe(CAROL.toLowerCase());
			expect(chain.askedFor(NEW_FILTER)).toBeGreaterThan(0);
			await waitFor('it goes on advancing on its own stream', async () => {
				return (await positionOf(restarted, APPROVAL_BUNDLE)) === LATER_TIP;
			});
			await expectOneWriterPerStream(restarted, db);
		});
	}
});

// ---------------------------------------------------------------------------------------------------
// A `run` started with an EXPLICIT source receives no upload (ADR-0094), so the one way a
// successor on a new stream reaches it is a RESTART after the operator changed that source.
// MEASURED here rather than assumed: it is fetched the same way. (This case used to ask the
// running process to re-read its configuration; that endpoint is deleted, ADR-0094.)
// ---------------------------------------------------------------------------------------------------

/** A `--deployments` file naming the contract with the events `abi` declares. */
async function writeDeployments(file: string, events: readonly unknown[]): Promise<void> {
	await writeFile(
		file,
		JSON.stringify({chainId: '1', contracts: {NFT: {abi: events, address: CONTRACT, startBlock: START_BLOCK}}}),
	);
}

describe('a `run` RESTARTED after the operator changed a configured source', () => {
	it('registers a successor on the new stream, fetches it beside the incumbent, and promotes it', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'etherfold-new-stream-'));
		scratch.push(dir);
		const deployments = join(dir, 'deployments.json');
		await writeDeployments(deployments, abi);
		const approvalEvent = {
			anonymous: false,
			inputs: [
				{indexed: true, internalType: 'address', name: 'owner', type: 'address'},
				{indexed: true, internalType: 'address', name: 'approved', type: 'address'},
				{indexed: true, internalType: 'uint256', name: 'tokenId', type: 'uint256'},
			],
			name: 'Approval',
			type: 'event',
		};

		const db = oneDatabase();
		const first = await aRunOver(db, aFilteringChain().serve(LOGS, TIP), {...CONFIGURED, deployments});
		await waitFor('the incumbent folded to the tip', async () => (await positionOf(first, BUNDLE)) === TIP);
		const incumbent = (await listingOf(first)).generations[0]!;
		await stop();

		// the operator ADDS AN EVENT to the configured source, and restarts the same `run`
		await writeDeployments(deployments, [...abi, approvalEvent]);
		const chain = aFilteringChain().serve(LOGS, TIP);
		const indexer = await aRunOver(db, chain, {...CONFIGURED, deployments});
		const listed = (await listingOf(indexer)).generations;
		expect(listed).toHaveLength(2);
		const successor = listed.find((entry) => entry.digest !== incumbent.digest)!;
		// the same processor over a different source: a successor on a NEW stream
		expect(successor.processor).toBe(incumbent.processor);
		expect(successor.stream).not.toBe(incumbent.stream);

		await waitFor('the restart-registered generation was promoted', async () => {
			return (await listingOf(indexer)).slots?.canonical?.digest === successor.digest;
		});
		expect(chain.askedFor(NEW_FILTER)).toBeGreaterThan(0);
		await waitFor('the old stream stopped being fetched', async () => {
			return JSON.stringify(indexer.fetchers.streams()) === JSON.stringify([successor.stream]);
		});
		await expectOneWriterPerStream(indexer, db);
	});
});
