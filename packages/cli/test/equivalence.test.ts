import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ReorgCounters} from '@etherfold/core';
import type {EnvRecord} from '@etherfold/fetcher-host';
import {createNodeDB, startServer, type RunningServer} from '@etherfold/platform-nodejs';
import type {RunningFetcher} from '@etherfold/platform-nodejs-fetcher';
import {
	applySchema,
	createServer,
	indexerRegistry,
	readReorgCounters,
	readSchemaState,
	type IndexerResolver,
} from '@etherfold/server';
import {createQuerySurface, VersionedStateStore} from '@etherfold/state-store-sqlite';
import type {RemoteSQL} from 'remote-sql';
import {afterEach, describe, expect, it} from 'vitest';
import {DEFAULT_INDEXER_NAME} from '../src/config.js';
import {
	build,
	fetch as startFetch,
	index,
	run,
	serve,
	type RunDependencies,
	type RunningIndexer,
	type RunningReceiver,
	type StoreCursorReport,
} from '../src/index.js';
import type {Options} from '../src/types.js';
import {
	abi,
	ALICE,
	BOB,
	CAROL,
	entityModule,
	fakeChain,
	nftEntities,
	SOURCE,
	START_BLOCK,
	transfer,
	ZERO,
} from './utils/chain.js';

// ---------------------------------------------------------------------------------------------------
// THE SPLIT IS A DEPLOYMENT CHOICE, ASSERTED AT THE COMMANDS
// ---------------------------------------------------------------------------------------------------
// `packages/processor-sqlite/test/deployment-shapes.test.ts` already pins this
// equivalence at the COMPONENT level: it constructs the pieces and shows that
// one processor and one set of declarations land the same state whether the two
// ADR-0003 halves meet in one process or across a wire. That is the same shape
// this file extends, one level up, because the spec insists on it: "the existing
// proof of equivalence is a test that constructs the pieces; this must be the
// COMMAND".
//
// So the two runs below are two DEPLOYMENTS, entered the way an operator enters
// them:
//
//   combined   `etherfold run`  -- one process, the wire removed
//                                 (`createDirectIngestion`)
//   split      `etherfold fetch` -> real HTTP -> `etherfold index`, two
//                                 processes with a socket between them
//
// Everything else is held identical ON PURPOSE, because that is what makes the
// assertion mean anything: the same processor module, the same entity
// declarations, the same explicit source, the same stream config (nothing sets
// `STREAM_FINALITY`, so both halves resolve the same default and therefore the
// same wire identity), and the same fixture chain served to both, INCLUDING a
// reorg whose replacement branch carries FEWER events -- so a state that merely
// grew monotonically cannot pass.
//
// The transport is the only difference. If these two ever disagree, one of the
// two shapes is wrong, and that is the whole claim.
// ---------------------------------------------------------------------------------------------------

const TOKEN = 'a-shared-secret';
/**
 * The NAMED INDEXER the split deployment's two halves agree on (ADR-0036), and
 * the one the COMBINED deployment is told to fold under.
 *
 * The combined shape would default it (`DEFAULT_INDEXER_NAME`, ADR-0052) and is
 * given the same name here on purpose: the emission rows the two shapes store
 * are then comparable COLUMN FOR COLUMN, discriminator included, rather than
 * modulo the one column that would otherwise differ. The default is exercised on
 * the `build` artifact below, which is where it actually lands.
 */
const INDEXER = 'alpha';

/**
 * What varies between deployments of one image, and nothing else.
 *
 * Bounded fetch ranges and short waits so several cycles happen quickly. No
 * `STREAM_FINALITY`: the sender, the receiver and the combined process must all
 * reach the same resolved `finality`, and the way to guarantee that is to let
 * every one of them take the same default rather than to set the same number
 * three times.
 */
const DEPLOYMENT: EnvRecord = {
	INDEXING_SOURCE: JSON.stringify(SOURCE),
	MAX_BLOCKS_PER_FETCH: '20',
	POLL_INTERVAL_MS: '5',
	CATCH_UP_DELAY_MS: '0',
	MIN_RETRY_DELAY_MS: '5',
};

// ---------------------------------------------------------------------------------------------------
// ONE FIXTURE CHAIN, WITH A REORG THAT TAKES EVENTS AWAY
// ---------------------------------------------------------------------------------------------------

/** Two mints low down, then two transfers high up, inside the window a reorg can reach. */
const BRANCH_A = [
	transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n),
	transfer(START_BLOCK + 10, '0xa10', ZERO, BOB, 2n, 1),
	transfer(START_BLOCK + 90, '0xa90', ALICE, BOB, 1n),
	transfer(START_BLOCK + 90, '0xa90', BOB, CAROL, 2n, 1),
];
const TIP_A = START_BLOCK + 100;

/**
 * The same chain with a different block 90, carrying ONE event where the dead
 * branch carried two.
 *
 * That is the case a monotonic state cannot fake: the counter has to come DOWN
 * from 4 to 3, and tokens 1 and 2 have to go back to the owners the mints gave
 * them, on both deployment shapes.
 */
const BRANCH_B = [BRANCH_A[0]!, BRANCH_A[1]!, transfer(START_BLOCK + 90, '0xb90', ZERO, CAROL, 3n)];
const TIP_B = TIP_A + 1;

const CHAIN_STATES = [
	{logs: BRANCH_A, tip: TIP_A, transfers: 4},
	{logs: BRANCH_B, tip: TIP_B, transfers: 3},
] as const;

// ---------------------------------------------------------------------------------------------------

let combined: RunningIndexer | undefined;
let receiver: RunningReceiver | undefined;
let sender: RunningFetcher<typeof abi> | undefined;
let readTier: RunningServer | undefined;
let directory: string | undefined;

afterEach(async () => {
	await sender?.stop().catch(() => undefined);
	await combined?.stop().catch(() => undefined);
	await receiver?.stop().catch(() => undefined);
	await readTier?.close().catch(() => undefined);
	sender = combined = receiver = undefined;
	readTier = undefined;
	if (directory) rmSync(directory, {recursive: true, force: true});
	directory = undefined;
});

/** Poll something a running process publishes until it says what we are waiting for. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
	const deadline = Date.now() + 20_000;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last saw ${JSON.stringify(value)}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

type Status = {
	healthy: boolean;
	reorgs?: ReorgCounters;
	schema: {applied: boolean; version?: number; expected: number; matches?: boolean};
	cursor?: {reported: boolean; value?: StoreCursorReport};
};

/**
 * The counts alone, which is what two deployments can be compared on.
 *
 * `last.at` is a WALL CLOCK reading taken by whichever process wrote the row, so
 * two shapes folding one chain agree about everything in it except that. Pinning
 * it would make this comparison fail for a reason it does not care about; the
 * classification and the block, which is what the field is FOR, are compared
 * below and in full.
 */
function countsOf(reorgs: ReorgCounters | undefined): {absence: number; contradiction: number} {
	expect(reorgs, 'a folding deployment reports its reorg counters on /status').toBeDefined();
	return {absence: reorgs!.absence, contradiction: reorgs!.contradiction};
}

/** The last recorded reorg, minus the clock reading two processes cannot share. */
function lastReorgOf(reorgs: ReorgCounters | undefined): Record<string, unknown> | undefined {
	if (!reorgs?.last) return undefined;
	const {at, ...detection} = reorgs.last;
	expect(at, 'a recorded reorg says when it was written down').toEqual(expect.any(String));
	return detection;
}

async function statusOf(url: string): Promise<Status> {
	return (await (await globalThis.fetch(`${url}/status`)).json()) as Status;
}

async function cursorOf(url: string): Promise<StoreCursorReport | undefined> {
	const {cursor} = await statusOf(url);
	return cursor?.reported ? cursor.value : undefined;
}

/**
 * Everything a reader can ask, through the surface GENERATED from the entity
 * declarations, opened over one database URL.
 *
 * The declarations are the processor's own (`nftEntities`), which is the point:
 * a consumer names an entity and its declared columns, never a table and never a
 * column string, so this comparison is the one a real reader would make. Both
 * tiers are exercised -- the bounded seam reads every backend has (`getCurrent`)
 * and the SQL tier a server-side reader gets (`queryCurrent`, which is the only
 * way to ask for a whole entity) -- because the read tier this milestone ships
 * is a database connection and not an HTTP query route.
 */
async function readsOver(url: string): Promise<unknown> {
	const store = new VersionedStateStore(createNodeDB(url), nftEntities);
	const surface = createQuerySurface(store, nftEntities);
	return {
		nfts: await surface.nft.queryCurrent({orderBy: 'tokenID'}),
		counters: await surface.counter.queryCurrent({orderBy: 'name'}),
		byId: {
			1: await surface.nft.getCurrent({tokenID: tokenID(1n)}),
			2: await surface.nft.getCurrent({tokenID: tokenID(2n)}),
			3: await surface.nft.getCurrent({tokenID: tokenID(3n)}),
			transfers: await surface.counter.getCurrent({name: 'transfers'}),
		},
	};
}

const tokenID = (id: bigint) => id.toString().padStart(78, '0');

/**
 * THE STORED EMISSION STREAM a deployment folded (ADR-0006), every row and every
 * column of it.
 *
 * Read straight out of the database rather than through the feed, because what is
 * compared between two deployment shapes is what they STORED: the two
 * discriminators, the sequence, the verdicts and the raw log. The feed is
 * asserted separately, over one of these databases, further down.
 */
async function emissionsIn(url: string): Promise<Record<string, unknown>[]> {
	const db = createNodeDB(url);
	return (await db.prepare(`SELECT * FROM _emissions ORDER BY indexer, seq`).all<Record<string, unknown>>()).results;
}

/** `etherfold run`: the combined deployment, folding into a database it owns. */
async function startCombined(
	db: string,
	chain: ReturnType<typeof fakeChain>,
	over: Partial<Options> = {},
	deps: {onReport?: RunDependencies['onReport']} = {},
): Promise<RunningIndexer> {
	return run(
		{
			processor: './nfts.js',
			store: 'sqlite',
			db,
			nodeUrl: 'http://localhost:0',
			port: '0',
			// the name its stored stream is keyed on. It would DEFAULT one; it is given
			// the split deployment's name so the two shapes' rows compare directly
			indexer: INDEXER,
			...over,
		},
		{
			importModule: async () => entityModule,
			provider: chain.provider,
			// a follower waits between cycles, and a test must not
			sleep: async () => {
				await new Promise((resolve) => setTimeout(resolve, 1));
			},
			handleSignals: false,
			log: () => {},
			env: DEPLOYMENT,
			...deps,
		},
	);
}

/** `etherfold index`: the receiving half, owning the database the split writes. */
async function startReceiver(db: string): Promise<RunningReceiver> {
	return index(
		{processor: './nfts.js', store: 'sqlite', db, port: '0', indexer: INDEXER, ingestToken: TOKEN},
		{
			importModule: async () => entityModule,
			handleSignals: false,
			log: () => {},
			env: DEPLOYMENT,
		},
	);
}

/** `etherfold fetch`: the chain-facing half, pushing over a real socket at a real port. */
async function startSender(endpoint: string, chain: ReturnType<typeof fakeChain>): Promise<RunningFetcher<typeof abi>> {
	// the SAME name on both halves: the sender addresses `/{indexer}/ingest` and the
	// receiver above registers exactly that name
	const options: Options = {
		nodeUrl: 'http://localhost:0',
		indexer: INDEXER,
		ingestEndpoint: endpoint,
		ingestToken: TOKEN,
	};
	return startFetch<typeof abi>(options, {provider: chain.provider, handleSignals: false, env: DEPLOYMENT});
}

// ---------------------------------------------------------------------------------------------------

describe('`run` and `fetch` plus `index` land on IDENTICAL state', () => {
	it('reaches the same state and the same cursor from the same chain, reorg included', async () => {
		directory = mkdtempSync(join(tmpdir(), 'etherfold-equivalence-'));
		const combinedDB = `file:${join(directory, 'combined.db')}`;
		const splitDB = `file:${join(directory, 'split.db')}`;

		const combinedChain = fakeChain();
		const splitChain = fakeChain();

		combined = await startCombined(combinedDB, combinedChain);
		receiver = await startReceiver(splitDB);
		sender = await startSender(receiver.url, splitChain);

		// the same chain states, in the same order, to both deployments
		for (const state of CHAIN_STATES) {
			combinedChain.serve([...state.logs], state.tip);
			splitChain.serve([...state.logs], state.tip);

			await until(
				() => cursorOf(combined!.url),
				(cursor) => cursor?.lastToBlock === state.tip,
				`the combined deployment to reach block ${state.tip}`,
			);
			await until(
				() => cursorOf(receiver!.url),
				(cursor) => cursor?.lastToBlock === state.tip,
				`the split deployment to reach block ${state.tip}`,
			);
		}

		const viaOneProcess = await readsOver(combinedDB);
		const viaTheWire = await readsOver(splitDB);

		expect(viaTheWire).toEqual(viaOneProcess);
		// ...and it is not two empty states, nor two states that only ever grew: the
		// replacement branch carried ONE event where the dead one carried two, so the
		// counter came down and the two mints are back where the mints put them
		expect(viaOneProcess).toMatchObject({
			byId: {
				1: {owner: ALICE.toLowerCase()},
				2: {owner: BOB.toLowerCase()},
				3: {owner: CAROL.toLowerCase()},
				transfers: {value: 3},
			},
		});

		// the CURSOR is part of the equivalence, and it is asserted between the two
		// FOLDING processes -- never against the read tier, which owns no store and is
		// given no reporter.
		//
		// On WHERE THE FOLD HAS GOT TO, which is what the report exists to answer: is
		// it moving (`lastToBlock`) and how far behind is it (`latestBlock`). Not on
		// `lastFromBlock`, which is the START of whichever range happened to be last:
		// that depends on how many cycles each side ran while the chain sat at a tip,
		// and a socket makes a cycle take longer than a function call. It is an
		// artefact of timing rather than a property of the deployment shape, and
		// pinning it would make this assertion fail for a reason it does not care
		// about.
		const viaWire = await cursorOf(receiver.url);
		const inOneProcess = await cursorOf(combined.url);
		expect(viaWire).toBeDefined();
		expect(viaWire!.lastToBlock).toBe(inOneProcess!.lastToBlock);
		expect(viaWire!.latestBlock).toBe(inOneProcess!.latestBlock);
		expect(viaWire!.lastToBlock).toBe(TIP_B);

		// -------------------------------------------------------------------------
		// THE REORG COUNTERS, COMPARED DIRECTLY AND WITH NO EXCEPTION
		// -------------------------------------------------------------------------
		// This was the ONE `/status` field that could not be compared between the two
		// shapes: the count was written by the HTTP ingest route, and a combined
		// process folds through the direct in-process wire and never touches it, so
		// `run` reported `{absence: 0, contradiction: 0}` for ever. The count is a fact
		// about the FOLD, so it is taken inside `StreamBuilder.receive` now and written
		// by whoever owns the store (ADR-0050) -- which makes it exactly as comparable
		// as the state and the cursor above, and it is compared here as one.
		// -------------------------------------------------------------------------
		const countedViaWire = (await statusOf(receiver.url)).reorgs;
		const countedInOneProcess = (await statusOf(combined.url)).reorgs;

		// the SPLIT shape's count is UNCHANGED by the move, asserted rather than
		// assumed: it is the number this test already pinned before `run` could count
		// at all, and the reorg on that side was concluded by the RECEIVER, which never
		// saw a chain
		expect(countsOf(countedViaWire)).toEqual({contradiction: 1, absence: 0});

		// ...and the combined process agrees, number for number
		expect(countsOf(countedInOneProcess)).toEqual(countsOf(countedViaWire));

		// ONCE-ONLY, in each shape, which is what `contradiction: 1` above says twice
		// over: the combined process both concludes the revert and receives the batch
		// that carried it, and counts it once; the split receiver concludes it and its
		// route receives it, and counts it once. A second call site on either entrance
		// would make one of these 2.
		expect(countedInOneProcess!.contradiction + countedInOneProcess!.absence).toBe(1);
		expect(countedViaWire!.contradiction + countedViaWire!.absence).toBe(1);

		// and the same CLASSIFICATION of the same block: absence versus contradiction
		// is what tells an operator their RPC provider is truncating results rather
		// than that the chain reorged (ADR-0004), so the two shapes agreeing on the
		// number while disagreeing on the kind would be no agreement at all
		expect(lastReorgOf(countedInOneProcess)).toEqual(lastReorgOf(countedViaWire));
		expect(lastReorgOf(countedInOneProcess)).toMatchObject({
			cause: 'contradiction',
			blockNumber: START_BLOCK + 90,
		});

		// -------------------------------------------------------------------------
		// THE STORED EMISSION STREAM, COMPARED THE SAME WAY AND WITH NO EXCEPTION
		// -------------------------------------------------------------------------
		// The second `/status`-shaped asymmetry, and a worse one than the counter was:
		// the append lived on the HTTP ingest route, so a combined process produced a
		// database whose `_emissions` table was EMPTY -- no feed to serve, and nothing
		// to re-fold a processor change from without re-fetching the whole history from
		// the node. The append is a port on the FOLD now (ADR-0052), so the stream is a
		// property of what was folded rather than of how the batch arrived, and the two
		// shapes' rows are comparable exactly as their state and their counters are.
		// -------------------------------------------------------------------------
		const storedViaWire = await emissionsIn(splitDB);
		const storedInOneProcess = await emissionsIn(combinedDB);

		// the SPLIT shape's rows are UNCHANGED by the move, asserted rather than
		// assumed: the same six rows it stored when the route wrote them, in the same
		// order, under the same two discriminators
		expect(
			storedViaWire.map((row) => [row['seq'], row['blockNumber'], row['blockHash'], row['removed'], row['alive']]),
		).toEqual([
			// the two mints, low down and untouched by the reorg
			[1, START_BLOCK + 10, '0xa10', 0, 1],
			[2, START_BLOCK + 10, '0xa10', 0, 1],
			// the dead branch's two transfers: KEPT, and flagged dead rather than deleted
			[3, START_BLOCK + 90, '0xa90', 0, 0],
			[4, START_BLOCK + 90, '0xa90', 0, 0],
			// their retractions, appended at the ORIGINAL block and never canonical
			[5, START_BLOCK + 90, '0xa90', 1, 0],
			[6, START_BLOCK + 90, '0xa90', 1, 0],
			// and the replacement branch's ONE transfer
			[7, START_BLOCK + 90, '0xb90', 0, 1],
		]);

		// ...and the combined process stored the same stream, row for row and column
		// for column -- the discriminators included, since it was told the same name
		expect(storedInOneProcess).toEqual(storedViaWire);
		// NOT DOUBLE-APPENDED on either shape, which is what a second call site on an
		// entrance would produce: the combined process both concludes the batch and
		// receives it through the direct wire, and the split receiver both concludes it
		// and serves the request that carried it. Seven rows each, allocated 1..7 with
		// no repeats.
		expect(storedInOneProcess.map((row) => row['seq'])).toEqual([1, 2, 3, 4, 5, 6, 7]);
		expect(new Set(storedInOneProcess.map((row) => row['indexer']))).toEqual(new Set([INDEXER]));
		// one stream, named by the wide digest both shapes derive from one source
		expect(new Set(storedInOneProcess.map((row) => row['stream'])).size).toBe(1);
	});

	it('refuses to advance while it cannot STORE what it folded, and leaves no hole', async () => {
		// THE OTHER HALF OF ADR-0052, and the one that is not symmetric with the
		// counter. A count that cannot be persisted is a logged miscount and the fold
		// carries on (`packages/core/test/streamBuilder.test.ts` pins that). A STREAM
		// that cannot be persisted is not survivable in the same way: a state that
		// advanced past events the stream never received is a HOLE -- invisible to the
		// gap check, silent and permanent -- so the batch is not folded at all and the
		// cycle is retried.
		//
		// `--no-auto-setup` is the honest way to produce that: the operator has said
		// somebody else migrates this database, so the fixed tables the stream and the
		// counters live in are simply not there yet and every write against them fails.
		directory = mkdtempSync(join(tmpdir(), 'etherfold-unmigrated-'));
		const unmigratedDB = `file:${join(directory, 'unmigrated.db')}`;
		const chain = fakeChain();

		const retries: unknown[] = [];
		chain.serve([...CHAIN_STATES[0].logs], CHAIN_STATES[0].tip);
		combined = await startCombined(
			unmigratedDB,
			chain,
			{autoSetup: false},
			{
				onReport: (report) => {
					if (report.kind === 'retry') retries.push(report.error);
				},
			},
		);

		// several cycles have now tried and failed, which is what makes the assertions
		// below about a REFUSAL rather than about a process that had not started yet
		await until(
			async () => retries.length,
			(count) => count >= 3,
			'the deployment to refuse a batch it could not store, several times over',
		);

		// the write really could not land: no fixed tables at all
		const refusing = await statusOf(combined.url);
		expect(refusing.schema.applied).toBe(false);
		// ...and NOTHING advanced. The state did not move past events no stream holds,
		// so the two agree about how far they got, which here is nowhere: that is what
		// "no hole" means, and it is the whole reason this write is not best-effort.
		expect(await cursorOf(combined.url)).toBeUndefined();
		await expect(emissionsIn(unmigratedDB)).rejects.toThrow(/_emissions/);

		// now somebody else migrates it, which is what `--no-auto-setup` promised
		await applySchema(combined.db);

		// the next cycle re-derives exactly the delta the refused ones did, and this
		// time it lands: the refusals cost cycles and nothing else
		for (const state of CHAIN_STATES) {
			chain.serve([...state.logs], state.tip);
			await until(
				() => cursorOf(combined!.url),
				(cursor) => cursor?.lastToBlock === state.tip,
				`the migrated deployment to reach block ${state.tip}`,
			);
		}

		expect(await readsOver(unmigratedDB)).toMatchObject({
			byId: {
				1: {owner: ALICE.toLowerCase()},
				2: {owner: BOB.toLowerCase()},
				3: {owner: CAROL.toLowerCase()},
				transfers: {value: 3},
			},
		});
		// and the stream it stored once it could is the whole stream, from the start
		// block: nothing was skipped while it was refusing
		expect((await emissionsIn(unmigratedDB)).map((row) => [row['seq'], row['blockNumber'], row['removed']])).toEqual([
			[1, START_BLOCK + 10, 0],
			[2, START_BLOCK + 10, 0],
			[3, START_BLOCK + 90, 0],
			[4, START_BLOCK + 90, 0],
			[5, START_BLOCK + 90, 1],
			[6, START_BLOCK + 90, 1],
			[7, START_BLOCK + 90, 0],
		]);
	});
});

// ---------------------------------------------------------------------------------------------------
// `build` EMITS AN ARTIFACT, AND AN ARTIFACT CARRIES ITS PROVENANCE
// ---------------------------------------------------------------------------------------------------
// The one-shot terminates at the tip, so nobody polls `/status` on it -- which is
// true and beside the point. The value is not the live poll, it is what the
// produced DATABASE carries: `build` is meant to emit a publishable artifact that
// is later fed into another process, so a database it produced must carry the
// same facts as one `run` produced, or it silently loses its provenance the
// moment it becomes an INPUT rather than an output.
//
// That is why `build` applies the fixed-table schema it used to lack: it binds no
// port, so nothing else ever would. And it is why the artifact carries its
// STREAM as well as its counters (ADR-0052): the stored stream is what a later
// processor change re-folds from, so an artifact without one forces a re-fetch of
// the whole history from the node -- exactly the cost the stored stream exists to
// remove, on the shape whose entire purpose is to be handed to somebody else.
// ---------------------------------------------------------------------------------------------------

describe('`build` emits a database carrying the reorgs it concluded', () => {
	it('applies the _meta schema it once lacked, and counts through the same writer', async () => {
		directory = mkdtempSync(join(tmpdir(), 'etherfold-artifact-'));
		const artifact = `file:${join(directory, 'artifact.db')}`;
		const chain = fakeChain();
		const options: Options = {processor: './nfts.js', store: 'sqlite', db: artifact, nodeUrl: 'http://localhost:0'};
		const deps = {
			importModule: async () => entityModule,
			provider: chain.provider,
			sleep: async () => {},
			env: DEPLOYMENT,
		};

		// two one-shots over ONE artifact: the second resumes from the cursor the
		// first left and meets the replacement branch, which is the only way a
		// stop-at-tip command sees a reorg at all
		for (const state of CHAIN_STATES) {
			chain.serve([...state.logs], state.tip);
			await build(options, deps);
		}

		const emitted = createNodeDB(artifact);

		// the fixed tables are IN the artifact, so a `serve` pointed at it reports a
		// schema version rather than calling it unhealthy
		expect(await readSchemaState(emitted)).toMatchObject({applied: true, matches: true});

		// ...and the counters are the ones `run` and `index` reach on the same chain
		expect(await readReorgCounters(emitted)).toMatchObject({contradiction: 1, absence: 0});

		// the fold is the same fold, which is what makes the counter worth comparing
		expect(await readsOver(artifact)).toMatchObject({
			byId: {3: {owner: CAROL.toLowerCase()}, transfers: {value: 3}},
		});

		// ...AND THE ARTIFACT CARRIES ITS STREAM, which it never did: the same seven
		// rows `run` and `index` store from this chain, retractions included and
		// superseded rows flagged rather than deleted
		const stored = await emissionsIn(artifact);
		expect(
			stored.map((row) => [row['seq'], row['blockNumber'], row['blockHash'], row['removed'], row['alive']]),
		).toEqual([
			[1, START_BLOCK + 10, '0xa10', 0, 1],
			[2, START_BLOCK + 10, '0xa10', 0, 1],
			[3, START_BLOCK + 90, '0xa90', 0, 0],
			[4, START_BLOCK + 90, '0xa90', 0, 0],
			[5, START_BLOCK + 90, '0xa90', 1, 0],
			[6, START_BLOCK + 90, '0xa90', 1, 0],
			[7, START_BLOCK + 90, '0xb90', 0, 1],
		]);

		// under the DEFAULT name, because this command was given none: the one place
		// the combined shapes' default actually lands on disk (ADR-0052). It is a
		// CONSTANT and not the file's name, so the artifact keeps answering under it
		// wherever the file is copied to.
		expect(new Set(stored.map((row) => row['indexer']))).toEqual(new Set([DEFAULT_INDEXER_NAME]));
	});
});

// ---------------------------------------------------------------------------------------------------
// THE FEED ANSWERS OVER A DATABASE A COMBINED PROCESS FOLDED
// ---------------------------------------------------------------------------------------------------
// ADR-0006's two views were a SPLIT-SHAPE-ONLY surface, and not by design: they
// read the emission table, the table was written by the ingest route, and a
// combined process reaches no route, so the views answered empty pages over a
// database that had folded a whole chain. With the append inside the fold
// (ADR-0052) the views work over whatever a fold stored, and the only thing a
// host still has to supply is what a feed cannot get from the table -- WHICH
// stream is served now, which only the receiver knows.
//
// So this is a host built the way a deployment would build one: the server, over
// the handle `run` folded into, with the combined process's own stream-builder
// registered under the name it folded as. `etherfold run` itself still registers
// no named indexer (its ingestion is the in-process direct wire, and a remote
// sender pushing into it would be a second writer), which is why this is a test
// host rather than a change to that command.
// ---------------------------------------------------------------------------------------------------

describe('both feed views answer over a database `run` folded', () => {
	it('serves the retraction-aware feed and the canonical view from a combined fold', async () => {
		directory = mkdtempSync(join(tmpdir(), 'etherfold-combined-feed-'));
		const combinedDB = `file:${join(directory, 'combined.db')}`;
		const chain = fakeChain();

		combined = await startCombined(combinedDB, chain);
		for (const state of CHAIN_STATES) {
			chain.serve([...state.logs], state.tip);
			await until(
				() => cursorOf(combined!.url),
				(cursor) => cursor?.lastToBlock === state.tip,
				`the combined deployment to reach block ${state.tip}`,
			);
		}

		const db: RemoteSQL = combined.db;
		const app = createServer<{INGEST_TOKEN?: string}>({
			getDB: () => db,
			getEnv: () => ({}),
			// the one thing the table cannot answer: WHICH stream this name serves now.
			// It is the combined process's own receiver, so the digest the feed validates
			// cursors against is the digest its rows were stored under
			getIndexer: indexerRegistry({[INDEXER]: combined.streamBuilder}) as IndexerResolver<{INGEST_TOKEN?: string}>,
		});

		// THE RETRACTION-AWARE VIEW: seq order, retractions INCLUDED
		const feed = (await (await app.request(`/${INDEXER}/feed`)).json()) as {
			success: boolean;
			stream: string;
			entries: {removed: boolean; blockNumber: number; blockHash: string}[];
		};
		expect(feed.success).toBe(true);
		expect(feed.entries.map((entry) => [entry.blockNumber, entry.blockHash, entry.removed])).toEqual([
			[START_BLOCK + 10, '0xa10', false],
			[START_BLOCK + 10, '0xa10', false],
			[START_BLOCK + 90, '0xa90', false],
			[START_BLOCK + 90, '0xa90', false],
			[START_BLOCK + 90, '0xa90', true],
			[START_BLOCK + 90, '0xa90', true],
			[START_BLOCK + 90, '0xb90', false],
		]);
		// the stream a consumer is told is the one the combined receiver folds
		expect(feed.stream).toBe(combined.streamBuilder.streamDigest);

		// THE CANONICAL VIEW: the live entries only, at or below the caller's gate
		const canonical = (await (await app.request(`/${INDEXER}/canonical?gate=${TIP_B}`)).json()) as {
			success: boolean;
			entries: {blockNumber: number; blockHash: string; removed?: boolean}[];
		};
		expect(canonical.success).toBe(true);
		expect(canonical.entries.map((entry) => [entry.blockNumber, entry.blockHash])).toEqual([
			[START_BLOCK + 10, '0xa10'],
			[START_BLOCK + 10, '0xa10'],
			// the reorged-out pair is gone from this view and the replacement is here: a
			// consumer of it never hears the word reorg
			[START_BLOCK + 90, '0xb90'],
		]);
		expect(canonical.entries.every((entry) => entry.removed === undefined)).toBe(true);
	});
});

// ---------------------------------------------------------------------------------------------------
// A READ TIER OVER THE SAME DATABASE, BOUNDED TO THE SURFACES THAT EXIST
// ---------------------------------------------------------------------------------------------------
// "The same reads" is bounded by what this milestone SHIPS. The GraphQL layer is
// deliberately not in it and `/status` is the whole HTTP query surface, so
// "reads" means the surface GENERATED from the entity declarations, opened over
// the database `serve` was pointed at -- and adding an HTTP query route to make
// the sentence literal would be shipping the deferred milestone (a general
// SQL-over-HTTP surface is rejected outright).
//
// Two things about `/status` are asserted here and one is deliberately NOT:
//
//   asserted   the SCHEMA version, which the server reads out of the database
//              itself, is the same on the read tier as on `run`.
//   asserted   the REORG COUNTERS. All THREE processes are compared, and that is
//              new: the read tier reports what its database holds, the WRITER of
//              that database reports the same, and so does `run`. This used to
//              carry an exception -- the count was written by the HTTP ingest
//              route, so a combined process, which folds through the direct
//              in-process wire and never touches a route, counted none, and
//              comparing against it would have pinned a number meaning "nobody
//              counted". The count is a fact about the FOLD now (ADR-0050), so
//              the exception and the observation it pointed at are both gone.
//   NOT        the CURSOR. It reaches `/status` only through an INJECTED
//              reporter, and a read tier owns no store and is given none, so
//              `serve` reports no cursor. That is correct rather than a bug, and
//              the assertion below pins it as such.
// ---------------------------------------------------------------------------------------------------

describe('`index` plus `serve` against ONE database answer what `run` answers', () => {
	afterEach(() => {
		delete process.env.INGEST_TOKEN;
	});

	it('answers the same reads, agrees on the schema, and reports no cursor', async () => {
		// A read tier's token can only come from the ambient environment:
		// `--ingest-token` is refused by `serve`, which receives no pushes. It is set
		// so the LAST assertion can be made at all -- the token guard sits on the PATH,
		// ahead of the capability lookup, so 501 is reachable only by an AUTHENTICATED
		// caller and an anonymous one gets 401 whether or not a processor is hosted.
		// That ordering is not reordered to make a test simpler: it is what stops an
		// anonymous caller probing which servers hold a processor.
		process.env.INGEST_TOKEN = TOKEN;
		directory = mkdtempSync(join(tmpdir(), 'etherfold-read-tier-'));
		const combinedDB = `file:${join(directory, 'combined.db')}`;
		const splitDB = `file:${join(directory, 'split.db')}`;

		const combinedChain = fakeChain();
		const splitChain = fakeChain();
		combined = await startCombined(combinedDB, combinedChain);
		receiver = await startReceiver(splitDB);
		sender = await startSender(receiver.url, splitChain);

		for (const state of CHAIN_STATES) {
			combinedChain.serve([...state.logs], state.tip);
			splitChain.serve([...state.logs], state.tip);
			await until(
				() => cursorOf(combined!.url),
				(cursor) => cursor?.lastToBlock === state.tip,
				`the combined deployment to reach block ${state.tip}`,
			);
			await until(
				() => cursorOf(receiver!.url),
				(cursor) => cursor?.lastToBlock === state.tip,
				`the split deployment to reach block ${state.tip}`,
			);
		}

		// the READ TIER: a second process, holding no processor, over the database the
		// receiver wrote. It resolves its own database and starts the real Node
		// adapter; only the handle it hands back is captured, so the test can stop it.
		await serve(
			{db: splitDB, port: '0'},
			{
				env: {},
				log: () => {},
				startServer: async (options) => (readTier = await startServer(options)),
			},
		);
		const served = readTier!;

		// the reads: the same surface, generated from the same declarations, over the
		// database `serve` was pointed at
		expect(await readsOver(splitDB)).toEqual(await readsOver(combinedDB));

		const readTierStatus = await statusOf(served.url);
		const combinedStatus = await statusOf(combined.url);
		const writerStatus = await statusOf(receiver.url);

		// the schema version is derived from the DATABASE, so a read tier and a
		// combined process agree on it
		expect(readTierStatus.schema).toEqual(combinedStatus.schema);
		expect(readTierStatus.healthy).toBe(true);

		// so are the reorg counters, which the read tier reads out of the database its
		// writer counted them into -- and which the COMBINED process now reports too,
		// so all three agree about the reverts they concluded from one chain
		expect(readTierStatus.reorgs).toEqual(writerStatus.reorgs);
		expect(countsOf(readTierStatus.reorgs)).toEqual({contradiction: 1, absence: 0});
		expect(countsOf(combinedStatus.reorgs)).toEqual(countsOf(readTierStatus.reorgs));
		expect(lastReorgOf(combinedStatus.reorgs)).toEqual(lastReorgOf(readTierStatus.reorgs));

		// and the cursor is absent, because a read tier owns no store and is given no
		// reporter. `run` reports one; this is the honest size of the read tier today
		expect(readTierStatus.cursor).toBeUndefined();
		expect(combinedStatus.cursor).toMatchObject({reported: true});

		// the read tier writes nothing: the write path is a CAPABILITY it does not
		// have rather than a route table it lacks
		const pushed = await globalThis.fetch(`${served.url}/${INDEXER}/ingest/expected-from-block`, {
			method: 'POST',
			headers: {Authorization: `Bearer ${TOKEN}`},
		});
		expect(pushed.status).toBe(501);
	});
});
