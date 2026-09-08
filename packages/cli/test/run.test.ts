import {createClient} from '@libsql/client';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {run, runMain, type RunDependencies, type RunningIndexer} from '../src/index.js';
import type {StoreCursorReport} from '../src/cursorReport.js';
import type {Options} from '../src/types.js';
import {canonicalStoreIn} from './utils/reads.js';
import {
	ALICE,
	BOB,
	CAROL,
	entityModule,
	fakeChain,
	nftProcessor,
	noChain,
	START_BLOCK,
	transfer,
	ZERO,
} from './utils/chain.js';

// ---------------------------------------------------------------------------------------------------
// `etherfold run`: ONE PROCESS THAT FOLLOWS, FOLDS AND ANSWERS
// ---------------------------------------------------------------------------------------------------
// The command the whole spec exists for, driven THE WAY THE SUBCOMMAND DRIVES IT
// -- `run(options, deps)` is what the registered action reaches through
// `runMain` -- rather than by constructing the components. That distinction is
// the entire gap this closes: `one-processor-cli-and-split-server` already
// proved the combined pipeline works by wiring the pieces together in a test, so
// what was missing was never the capability, it was a terminal.
//
// Everything below the provider is the shipped thing: a real libSQL database, a
// real HTTP server on a real port, the real `LogFetcher` ->
// `createDirectIngestion` -> `StreamBuilder` -> `EntityEventProcessor` chain.
// Only four things are injected, exactly as the one-shot's tests inject them: a
// fake chain, the database handle, the sleep between cycles, and the way to stop
// it.
// ---------------------------------------------------------------------------------------------------

const RUN: Options = {
	processor: './nfts.js',
	nodeUrl: 'http://localhost:0',
	store: 'sqlite',
	db: ':memory:',
	// 0 asks the OS for a free port, which is what makes the suite runnable on a
	// machine that is already serving something on 2000
	port: '0',
};

/** Logs every 10 blocks, so a bounded fetch range takes several cycles to cover them. */
const SPREAD = [10, 20, 30, 40, 50, 60, 70, 80].map((offset, index) =>
	transfer(START_BLOCK + offset, `0xa${offset}`, index === 0 ? ZERO : ALICE, index === 0 ? ALICE : BOB, BigInt(index)),
);
/** What the chain holds first, and the tip it is at: deliberately BELOW the next log. */
const EARLY = SPREAD.slice(0, 4);
const EARLY_TIP = START_BLOCK + 45;
const TIP = START_BLOCK + 100;

/** Bounded fetch ranges, read from the environment the way every fetcher host reads them. */
const SMALL_RANGES = {MAX_BLOCKS_PER_FETCH: '20'};

let running: RunningIndexer | undefined;

afterEach(async () => {
	await running?.stop().catch(() => undefined);
	running = undefined;
});

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

function depsFor(chain: ReturnType<typeof fakeChain>, db: RemoteSQL, extra: RunDependencies = {}): RunDependencies {
	return {
		importModule: async () => entityModule,
		provider: chain.provider,
		createDB: () => db,
		// a follower waits between cycles, and a test must not: one tick instead of
		// the poll interval, which keeps the loop from monopolising the event loop
		// while an assertion polls the server over real HTTP
		sleep: async () => {
			await new Promise((resolve) => setTimeout(resolve, 1));
		},
		// the test runner's process is not this command's to install handlers on
		handleSignals: false,
		log: () => {},
		env: SMALL_RANGES,
		...extra,
	};
}

/**
 * What this database answers, read the way a reader over it reads: the CANONICAL
 * POINTER resolved to a table namespace (ADR-0053), never the tables a namespace
 * guessed at.
 */
async function transfersIn(db: RemoteSQL): Promise<number | undefined> {
	const store = await canonicalStoreIn(db, nftProcessor.entities);
	return (await store.getCurrent<{value: number}>('counter', {name: 'transfers'}))?.value;
}

/** What `/status` says about the cursor, over real HTTP, exactly as an operator would read it. */
async function statusCursor(url: string): Promise<StoreCursorReport | undefined> {
	const res = await fetch(`${url}/status`);
	const body = (await res.json()) as {cursor?: {reported: boolean; value?: StoreCursorReport}};
	return body.cursor?.reported ? body.cursor.value : undefined;
}

/** What `/status` says the FETCHER believes about the node, as an operator reads it. */
async function statusFetcher(url: string): Promise<Record<string, any> | undefined> {
	const res = await fetch(`${url}/status`);
	const body = (await res.json()) as {fetcher?: Record<string, any>};
	return body.fetcher;
}

/** Poll something the running process publishes until it says what we are waiting for. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last saw ${JSON.stringify(value)}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Whether the loop has ended, watched from the outside without swallowing the reason. */
function watchStopped(indexer: RunningIndexer): () => boolean {
	let settled = false;
	indexer.stopped.then(
		() => (settled = true),
		() => (settled = true),
	);
	return () => settled;
}

describe('the headline: one command follows, folds and answers', () => {
	it('lands state in the database and reports a cursor that ADVANCES, across cycles', async () => {
		const chain = fakeChain().serve(EARLY, EARLY_TIP);
		const db = oneDatabase();

		running = await run(RUN, depsFor(chain, db));

		// it is answering before it has folded anything, and it says so honestly
		// rather than inventing a block 0
		expect((await fetch(`${running.url}/status`)).status).toBe(200);

		const first = await until(
			() => statusCursor(running!.url),
			(cursor) => cursor?.lastToBlock === EARLY_TIP,
			'the cursor to reach the first tip',
		);
		expect(await transfersIn(db)).toBe(EARLY.length);
		const cyclesAtFirst = running.host.cyclesRun;

		// the chain moves on: more logs, a higher tip. Nothing restarts, nothing is
		// re-run from a terminal -- the SAME process follows it
		chain.serve(SPREAD, TIP);

		const second = await until(
			() => statusCursor(running!.url),
			(cursor) => cursor?.lastToBlock === TIP,
			'the cursor to reach the second tip',
		);

		// the point of the criterion: not "a cursor was reported once" but "it
		// advanced", read twice from the running server with cycles in between
		expect(second!.lastToBlock).toBeGreaterThan(first!.lastToBlock);
		expect(second!.latestBlock).toBe(TIP);
		expect(running.host.cyclesRun).toBeGreaterThan(cyclesAtFirst);
		expect(await transfersIn(db)).toBe(SPREAD.length);
	});

	it('keeps running when it reaches the tip, because stopping is a signal and not a report', async () => {
		const chain = fakeChain().serve(SPREAD, TIP);
		const db = oneDatabase();

		running = await run(RUN, depsFor(chain, db));
		const hasStopped = watchStopped(running);

		await until(
			() => statusCursor(running!.url),
			(cursor) => cursor?.lastToBlock === TIP,
			'the cursor to reach the tip',
		);
		const atTheTip = running.host.cyclesRun;

		// it reached the tip several cycles ago and it is still cycling: the one-shot
		// would have aborted on exactly the report that got us here
		await until(
			async () => running!.host.cyclesRun,
			(cycles) => cycles > atTheTip + 2,
			'more cycles after the tip',
		);
		expect(hasStopped()).toBe(false);
		expect((await fetch(`${running.url}/status`)).status).toBe(200);
	});

	it('binds the port it was asked for and reports which one it got', async () => {
		running = await run(RUN, depsFor(fakeChain().serve(SPREAD, TIP), oneDatabase()));
		expect(running.port).toBeGreaterThan(0);
		expect(running.url).toContain(String(running.port));
	});
});

describe('the store and the server share ONE database handle', () => {
	it('builds it once and hands the same object to both', async () => {
		const db = oneDatabase();
		let built = 0;
		running = await run(
			RUN,
			depsFor(fakeChain().serve(SPREAD, TIP), db, {
				createDB: () => {
					built++;
					return db;
				},
			}),
		);

		expect(built).toBe(1);
		expect(running.db).toBe(db);

		// ...and it cannot pass by accident, which is why this reads the SERVER's own
		// fixed table through the STORE's handle: the server applies that schema at
		// startup, and a server that had opened `:memory:` for itself would not even
		// be talking to this database
		const meta = await db.prepare(`SELECT value FROM _meta WHERE key = 'schemaVersion'`).all<{value: string}>();
		expect(meta.results.length).toBe(1);

		// the other half of "one database": the cursor `/status` reports is READ
		// through the handle the fold WRITES through, so a value that moves there is
		// proof the two are one
		await until(
			() => statusCursor(running!.url),
			(cursor) => (cursor?.lastToBlock ?? 0) > START_BLOCK,
			'a cursor read back through the shared handle',
		);
	});
});

// ---------------------------------------------------------------------------------------------------
// WHAT THE FETCHING HALF LEARNED IS ON THE SAME PAGE AS THE FOLD'S PROGRESS
// ---------------------------------------------------------------------------------------------------
// `run` is the shape that holds BOTH halves, so it is the one that can report
// what the chain-facing half believes about the node (ADR-0074). It is reported
// so it can be handed BACK on the next start -- the fetcher persists nothing,
// and this is what stops every restart re-paying the discovery from the small
// starting range upwards.
// ---------------------------------------------------------------------------------------------------
describe('the range the fetcher learned is readable, and configurable back in', () => {
	it('reports what it believes about the provider beside the cursor it already reports', async () => {
		running = await run(RUN, depsFor(fakeChain().serve(SPREAD, TIP), oneDatabase()));

		const fetcher = await until(
			() => statusFetcher(running!.url),
			(reported) => reported?.reported === true,
			'the fetcher limits on /status',
		);

		// the deployment's own bound on what it asks for (`MAX_BLOCKS_PER_FETCH: 20`),
		// which is where a fetcher that has been refused nothing sits
		expect(fetcher!.learnedRange).toEqual({safeSpan: expect.any(Number), nextSize: 20});
		expect(fetcher!.suspectResultCount).toEqual({count: 10000, source: 'default'});
	});

	it('starts from a range the environment remembers, rather than from the starting range', async () => {
		// exactly what the previous test read off `/status`, handed back the way an
		// operator or a supervisor hands it back
		running = await run(
			RUN,
			depsFor(fakeChain().serve(SPREAD, TIP), oneDatabase(), {
				env: {...SMALL_RANGES, LEARNED_RANGE: '{"ceiling":20,"safeSpan":15,"nextSize":19}'},
			}),
		);

		expect(running.host.fetcher.limits.learnedRange).toEqual({ceiling: 20, safeSpan: 15, nextSize: 19});

		// and it is a starting point, not a cage: the fold still reaches the tip
		await until(
			() => statusCursor(running!.url),
			(cursor) => cursor?.lastToBlock === TIP,
			'the cursor to reach the tip from a remembered range',
		);
	});
});

// ---------------------------------------------------------------------------------------------------
// A `run` PROCESS HOSTS NO REMOTE WRITER
// ---------------------------------------------------------------------------------------------------
// Its ingestion is the in-process direct wire, so no ingestion capability is
// injected into its server and the ingestion routes are a CAPABILITY it does not
// have rather than a route table it lacks. Two things are asserted together,
// because either alone would mislead: an AUTHENTICATED caller gets `501`, and an
// unauthenticated one still gets `401` -- the token guard is registered on the
// PATH ahead of the capability lookup and fails closed, and moving the capability
// check in front of it would tell an anonymous caller whether a server hosts a
// processor.
//
// The token reaches the server through the ENVIRONMENT, not through a flag:
// `--ingest-token` is refused by `run` (there is no wire to configure), while an
// ambient variable a command does not own is simply not read by the CLI. The
// Node adapter reads `INGEST_TOKEN` for the app it starts, which is how a
// deployment configures the guard on a process that receives no pushes.
//
// The routes are NAMESPACED on the indexer name now (`/{indexer}/ingest`), and
// this process registers no name at all -- `--indexer` is refused by `run` for
// the same reason `--ingest-token` is. So the `501` is answered under EVERY name,
// which is the honest answer: the capability is missing, rather than one
// particular tenant.
// ---------------------------------------------------------------------------------------------------

const TOKEN = 'a-shared-secret';
const AUTHENTICATED = {Authorization: `Bearer ${TOKEN}`};
/** Any name at all: this process registered none, so every one of them answers the same. */
const SOME_NAME = 'whatever';

describe('a run process refuses to be written to', () => {
	afterEach(() => {
		delete process.env.INGEST_TOKEN;
	});

	it('answers 501 to an authenticated push and 401 to an anonymous one, while /status answers', async () => {
		process.env.INGEST_TOKEN = TOKEN;
		running = await run(RUN, depsFor(fakeChain().serve(SPREAD, TIP), oneDatabase()));

		const asked = await fetch(`${running.url}/${SOME_NAME}/ingest/expected-from-block`, {
			method: 'POST',
			headers: AUTHENTICATED,
		});
		expect(asked.status).toBe(501);
		expect(((await asked.json()) as {error: string}).error).toBe('ingestion-not-configured');

		const pushed = await fetch(`${running.url}/${SOME_NAME}/ingest`, {
			method: 'POST',
			headers: {...AUTHENTICATED, 'Content-Type': 'application/json'},
			body: JSON.stringify({fromBlock: START_BLOCK, toBlock: START_BLOCK + 1, latestBlock: TIP, logs: []}),
		});
		expect(pushed.status).toBe(501);
		expect(((await pushed.json()) as {error: string}).error).toBe('ingestion-not-configured');

		// the absence of a processor is not something an anonymous caller can probe
		expect((await fetch(`${running.url}/${SOME_NAME}/ingest`, {method: 'POST', body: '{}'})).status).toBe(401);
		expect((await fetch(`${running.url}/${SOME_NAME}/ingest/expected-from-block`, {method: 'POST'})).status).toBe(401);

		// the read half is untouched by the refusal of the write half
		const status = await fetch(`${running.url}/status`);
		expect(status.status).toBe(200);
		expect(((await status.json()) as {healthy: boolean}).healthy).toBe(true);
	});
});

// ---------------------------------------------------------------------------------------------------
// TWO THINGS THE SPEC ASKED TO CHECK RATHER THAN ASSUME
// ---------------------------------------------------------------------------------------------------

describe('through this path', () => {
	it("delivers a reorg's retractions to the processor in ONE batch, with their replacements", async () => {
		const db = oneDatabase();
		const early = [
			transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n),
			transfer(START_BLOCK + 10, '0xa10', ZERO, BOB, 2n, 1),
			transfer(START_BLOCK + 90, '0xa90', ALICE, BOB, 1n),
			transfer(START_BLOCK + 90, '0xa90', BOB, CAROL, 2n, 1),
		];
		const chain = fakeChain().serve(early, TIP);
		running = await run(RUN, depsFor(chain, db));

		await until(
			() => transfersIn(db),
			(transfers) => transfers === 4,
			'the pre-reorg state to land',
		);

		// watch what actually reaches the processor, which is the question: the
		// stream-builder makes exactly one `process` call per batch it receives, so
		// "one batch" is a claim about the stream that call carries
		const folded = vi.spyOn(running.processor, 'process');

		// the same chain, reorged at the block that moved tokens 1 and 2: the
		// replacement carries FEWER events, so the counter must come DOWN
		const reorged = [early[0]!, early[1]!, transfer(START_BLOCK + 90, '0xb90', ZERO, CAROL, 3n)];
		chain.serve(reorged, TIP + 1);

		await until(
			() => transfersIn(db),
			(transfers) => transfers === 3,
			'the reorg to be folded',
		);

		const withRetractions = folded.mock.calls.filter(([stream]) => stream.some((event) => event.removed));
		expect(withRetractions).toHaveLength(1);
		// ...and that ONE stream carries the replacement too, rather than leaving the
		// state briefly holding neither branch
		expect(withRetractions[0]![0].filter((event) => !event.removed).length).toBeGreaterThan(0);
	});

	it('resumes from the cursor in the store rather than from the start block', async () => {
		const db = oneDatabase();
		const first = fakeChain().serve(SPREAD, TIP);
		const interrupted = await run(RUN, depsFor(first, db));
		await until(
			() => statusCursor(interrupted.url),
			(cursor) => cursor?.lastToBlock === TIP,
			'the first process to catch up',
		);
		await interrupted.stop();

		// a NEW process, with a new fetcher that has never been told anything: it
		// holds no cursor of its own, so where it starts can only have come from the
		// store
		const second = fakeChain().serve(SPREAD, TIP);
		running = await run(RUN, depsFor(second, db));
		await until(
			() => statusCursor(running!.url),
			(cursor) => cursor?.lastToBlock === TIP,
			'the second process to catch up',
		);

		expect(second.logRanges[0]!.from).toBeGreaterThan(START_BLOCK);
		expect(await transfersIn(db)).toBe(SPREAD.length);
	});
});

// ---------------------------------------------------------------------------------------------------
// HOW IT ENDS, AND WHAT THE PROCESS EXITS WITH
// ---------------------------------------------------------------------------------------------------

describe('the process ends only on a signal or on a refusal no waiting fixes', () => {
	it('exits 0 when it is asked to stop, having been at the tip and not stopped there', async () => {
		const chain = fakeChain().serve(SPREAD, TIP);
		const db = oneDatabase();
		const killer = new AbortController();
		const exits: number[] = [];
		let caughtUp = 0;

		await runMain(RUN, {
			...depsFor(chain, db, {
				signal: killer.signal,
				onReport: (report) => {
					// stop only after it has been at the tip for a while, which is what
					// proves the tip did not stop it
					if (report.kind === 'idle' || (report.kind === 'progress' && report.caughtUp)) caughtUp++;
					if (caughtUp > 3) killer.abort();
				},
			}),
			exit: (code) => exits.push(code),
			error: () => {},
		});

		expect(exits).toEqual([0]);
		expect(caughtUp).toBeGreaterThan(3);
		expect(await transfersIn(db)).toBe(SPREAD.length);
	});

	it('exits non-zero on a fatal refusal, so a supervisor can tell a stop from a wedge', async () => {
		// a node that caps its results silently is indistinguishable from one that
		// answered completely, so a count landing exactly on the cap is treated as
		// suspect; a single block that still lands on it has nothing left to halve and
		// is a `SuspectedTruncationError`, which no waiting fixes
		const dense = [
			transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n, 0),
			transfer(START_BLOCK + 10, '0xa10', ZERO, BOB, 2n, 1),
		];
		const exits: number[] = [];
		const errors: unknown[] = [];

		await runMain(RUN, {
			...depsFor(fakeChain().serve(dense, TIP), oneDatabase(), {
				env: {...SMALL_RANGES, SUSPECT_RESULT_COUNT: '2'},
			}),
			exit: (code) => exits.push(code),
			error: (...args) => errors.push(...args),
		});

		expect(exits).toEqual([1]);
		expect((errors[0] as Error).name).toBe('SuspectedTruncationError');
	});
});

describe('every input is resolved through the shared configuration path', () => {
	it('refuses a missing node URL by flag AND variable, before any chain call or database', async () => {
		const chain = noChain();
		let built = 0;
		let started = 0;

		await expect(
			run(
				{processor: './nfts.js', store: 'sqlite', db: ':memory:'},
				{
					importModule: async () => entityModule,
					provider: chain.provider,
					handleSignals: false,
					createDB: () => {
						built++;
						return oneDatabase();
					},
					startServer: async () => {
						started++;
						throw new Error('a refused configuration must never reach a port');
					},
					env: {},
				},
			),
		).rejects.toThrow(/--node-url \(ETH_NODE_URI\) is required by `etherfold run`/);

		expect(chain.calls).toEqual([]);
		expect(built).toBe(0);
		expect(started).toBe(0);
	});

	it('leaves no signal handler on the process when it refused to start', async () => {
		const before = process.listenerCount('SIGTERM');

		await expect(
			// handlers ON, as a deployment runs it: a configuration this command refuses
			// never starts a loop, so there must be nothing left listening for a signal
			// to stop
			run({processor: './nfts.js', store: 'sqlite', db: ':memory:'}, {importModule: async () => entityModule, env: {}}),
		).rejects.toThrow(/--node-url/);

		expect(process.listenerCount('SIGTERM')).toBe(before);
	});

	it('refuses a flag `run` does not own, naming what it is instead', async () => {
		await expect(
			run({...RUN, ingestEndpoint: 'http://elsewhere'}, {importModule: async () => entityModule}),
		).rejects.toThrow(/--ingest-endpoint \(INGEST_ENDPOINT\) is not accepted by `etherfold run`/);
	});
});
