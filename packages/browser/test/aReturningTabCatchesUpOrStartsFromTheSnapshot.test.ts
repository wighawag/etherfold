import 'fake-indexeddb/auto';
import {createHash} from 'node:crypto';
import {
	ArchiveRefusedError,
	generationDigestOf,
	resolveStreamConfig,
	streamDigestOf,
	PUBLICATION_INDEX_FORMAT,
	type LastSync,
	type PublicationIndex,
	type PublishedStateSnapshot,
} from '@etherfold/core';
import {
	createSnapshot,
	EntityEventProcessor,
	openAndBootstrap,
	openForWriting,
	stateFactoriesFrom,
	type BootstrapOutcome,
	type EntityProcessor,
	type EntityStateView,
	type Mutation,
	type StateSnapshot,
	type StateStore,
} from '@etherfold/processor-entities';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
	createBrowserStateStore,
	createIndexerState,
	DEFAULT_CATCH_UP_WITHIN_SECONDS,
	type BrowserPublicationOptions,
	type PublicationSnapshot,
} from '../src/index.js';
import {
	BRANCH_A,
	BRANCH_A_EXTENDED,
	BRANCH_A_EXTENDED_TIP,
	BRANCH_A_LATER,
	BRANCH_A_LATER_TIP,
	fakeChain,
	FINALITY,
	indexToTip,
	SOURCE,
	timestampOf,
	type RawLog,
	type TestABI,
} from '../browser/workload.js';
import {appliedIn, applyingProcessor} from './utils/applied.js';
import {identityOf} from './utils/processorIdentity.js';

/**
 * A RETURNING TAB CATCHES UP WITHIN A TIME BUDGET, OR STARTS FROM THE SNAPSHOT (ADR-0096).
 *
 * A tab that already holds local state catches up from its own cursor, as it
 * always has. Two things switch it to the published snapshot MID-RUN instead,
 * through the one install there is (the app's `createState`, handed
 * `replaceLocal: true`, and `openAndBootstrap`, which wipes and installs):
 *
 * - the node REFUSES the catch-up as an archive refusal (`ArchiveRefusedError`),
 *   which without a snapshot stops the tab exactly as it did before;
 * - the catch-up is ESTIMATED to take longer than the app's one budget, from the
 *   blocks each advance covered and the time it took, on a clock this file
 *   controls.
 *
 * Every case asserts on the REQUESTS made, because half the claims are about
 * what is NOT downloaded: no snapshot body for a tab whose catch-up fits, or for
 * one already at or ahead of the snapshot.
 */

let counter = 0;
const freshName = () => `returning-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

const CONFIG = {stream: {finality: FINALITY}};
const THIS_STREAM = streamDigestOf(SOURCE, resolveStreamConfig(CONFIG.stream));
const PROCESSOR = identityOf('returning-tab-app');
const INDEX = 'https://publications.example/app/publication.json';

/** Where the returning tab got to on its last visit, and where the published snapshot is. */
const LOCAL_AT = 101;
const SNAPSHOT_AT = 104;

// ---------------------------------------------------------------------------
// THE CLOCK, and a node that refuses old ranges
// ---------------------------------------------------------------------------

/** The time every measurement reads, moved only by the node's answers below. */
let now = 0;
beforeEach(() => {
	now = 0;
	vi.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * A node over `branch`: every `eth_getLogs` costs `msPerRequest` on the clock,
 * and one starting below `servesFrom` is refused the way a non-archive public node
 * refuses history (`work/notes/findings/what-nodes-answer-when-a-getlogs-range-is-too-big.md`).
 */
function node(branch: readonly RawLog[], tip: number, options: {servesFrom?: number; msPerRequest?: number} = {}) {
	const chain = fakeChain(branch, tip);
	const refused: {from: number; to: number}[] = [];
	const provider = {
		async request(args: {method: string; params?: any}) {
			if (args.method === 'eth_getLogs') {
				now += options.msPerRequest ?? 0;
				const from = parseInt(args.params[0].fromBlock.slice(2), 16);
				if (options.servesFrom !== undefined && from < options.servesFrom) {
					refused.push({from, to: parseInt(args.params[0].toBlock.slice(2), 16)});
					throw Object.assign(new Error('invalid params'), {
						code: -32602,
						data: 'historical state is not available: archive access is not enabled on this plan',
					});
				}
			}
			return chain.provider.request(args);
		},
	} as any;
	return {provider, ranges: chain.ranges, refused};
}

// ---------------------------------------------------------------------------
// A PUBLISHER, and the host serving its publication
// ---------------------------------------------------------------------------

async function liveRowsOf(store: StateStore): Promise<Mutation[]> {
	const listing = await store.listCurrent<{bucket: string; at: string; key: string; times: number}>(
		'applied',
		{bucket: 'all'},
		500,
	);
	return listing.rows.map((row) => ({
		type: 'upsert',
		entity: 'applied',
		id: {bucket: row.bucket, at: row.at},
		values: {key: row.key, times: Number(row.times)},
	}));
}

/** A publisher tab indexes to `tip` and publishes what it computed, cut `FINALITY` behind the tip it saw. */
async function publishedSnapshot(definition: EntityProcessor<TestABI>, tip: number): Promise<StateSnapshot> {
	const store = await openForWriting(await createBrowserStateStore(definition.entities, {databaseName: freshName()}));
	const indexer = createIndexerState<TestABI, EntityStateView>({
		createState: () => store,
		createProcessor: (state) => new EntityEventProcessor<TestABI>(state, definition),
		processorIdentity: PROCESSOR,
	});
	await indexer.init({provider: fakeChain(BRANCH_A, tip).provider, source: SOURCE, config: CONFIG});
	const lastSync = (await indexToTip(indexer as never)) as LastSync<TestABI>;
	const rows = await liveRowsOf(store);
	indexer.dispose();
	return createSnapshot<TestABI>({
		takenAt: {
			number: lastSync.lastToBlock,
			hash: `0xsnap${lastSync.lastToBlock.toString(16)}`,
			timestamp: timestampOf(lastSync.lastToBlock),
		},
		entities: definition.entities,
		rows,
		lastSync: {...lastSync, latestBlock: tip + FINALITY},
		processor: PROCESSOR,
	});
}

/** `publication.json` naming `snapshot` for this generation (or nothing), and its body. */
async function publication(snapshot?: StateSnapshot) {
	const routes: Record<string, Uint8Array> = {};
	const snapshots: Record<string, PublishedStateSnapshot> = {};
	let body: string | undefined;
	if (snapshot) {
		const contentHash = `sha256:${createHash('sha256').update(snapshot.document).digest('hex')}`;
		const name = `state-${contentHash.slice('sha256:'.length)}.ndjson.gz`;
		snapshots[generationDigestOf({stream: THIS_STREAM, processor: PROCESSOR})] = {
			stream: THIS_STREAM,
			processor: PROCESSOR,
			body: name,
			contentHash,
			takenAt: snapshot.head.takenAt,
			floor: snapshot.head.floor,
			cut: snapshot.head.takenAt.number,
			savedAt: snapshot.head.savedAt,
		};
		body = `https://publications.example/app/${name}`;
		routes[body] = snapshot.document;
	}
	const index: PublicationIndex = {format: PUBLICATION_INDEX_FORMAT, snapshots};
	routes[INDEX] = new TextEncoder().encode(JSON.stringify(index));
	const asked: string[] = [];
	const get = (async (input: unknown) => {
		const url = String(input);
		asked.push(url);
		const served = routes[url];
		if (served === undefined) return new Response('not found', {status: 404});
		return new Response(new Uint8Array(served), {status: 200});
	}) as typeof globalThis.fetch;
	return {asked, get, body};
}

// ---------------------------------------------------------------------------
// THE TAB
// ---------------------------------------------------------------------------

/**
 * The tab an app writes, over ONE database name so a second tab is a RETURN: its
 * `createState` starts from what it is handed through the existing bootstrap and
 * FORWARDS `replaceLocal`, recording what it was handed and what the bootstrap did.
 */
function tabOf(options: {
	databaseName: string;
	definition: EntityProcessor<TestABI>;
	publication?: BrowserPublicationOptions;
	catchUpWithinSeconds?: number | 'always';
	maxBlocksPerFetch?: number;
}) {
	const handed: (PublicationSnapshot | undefined)[] = [];
	const outcomes: BootstrapOutcome[] = [];
	const indexer = createIndexerState<TestABI, EntityStateView>(
		{
			createState: async (_context, {signal}, _bundle, published) => {
				handed.push(published);
				const backend = await createBrowserStateStore(options.definition.entities, {
					databaseName: options.databaseName,
				});
				const {store, outcome} = await openAndBootstrap(backend, published?.locations ?? [], {
					processor: published?.processor ?? 'no-snapshot-was-handed',
					finalityDepth: FINALITY,
					replaceLocal: published?.replaceLocal,
					...(options.publication?.fetch ? {fetch: options.publication.fetch} : {}),
				});
				outcomes.push(outcome);
				return openForWriting(store, {signal});
			},
			createProcessor: (state) => new EntityEventProcessor<TestABI>(state, options.definition),
			processorIdentity: PROCESSOR,
		},
		{
			...(options.publication ? {publication: options.publication} : {}),
			...(options.catchUpWithinSeconds !== undefined ? {catchUpWithinSeconds: options.catchUpWithinSeconds} : {}),
		},
	);
	const config = options.maxBlocksPerFetch
		? {...CONFIG, fetch: {maxBlocksPerFetch: options.maxBlocksPerFetch}}
		: CONFIG;
	return {indexer, handed, outcomes, config};
}

/** A tab that visited once and got to `at`, then closed: its database is what a return opens. */
async function visitedUpTo(definition: EntityProcessor<TestABI>, at: number): Promise<string> {
	const databaseName = freshName();
	const first = tabOf({databaseName, definition});
	await first.indexer.init({provider: fakeChain(BRANCH_A, at).provider, source: SOURCE, config: CONFIG});
	const reached = await indexToTip(first.indexer as never);
	first.indexer.dispose();
	expect(reached.lastToBlock).toBe(at);
	return databaseName;
}

/** The control: a FRESH tab that installs the same snapshot and indexes forward over the same chain. */
async function freshInstallOf(snapshot: StateSnapshot, branch: readonly RawLog[], tip: number) {
	const definition = applyingProcessor();
	const {get} = await publication(snapshot);
	const tab = tabOf({databaseName: freshName(), definition, publication: {locations: [INDEX], fetch: get}});
	await tab.indexer.init({provider: node(branch, tip).provider, source: SOURCE, config: CONFIG});
	await indexToTip(tab.indexer as never, 200);
	const applied = await appliedIn(tab.indexer.state.$state);
	tab.indexer.dispose();
	expect(tab.outcomes).toMatchObject([{status: 'bootstrapped', at: SNAPSHOT_AT}]);
	return applied;
}

describe('a returning tab whose node refuses the catch-up as an archive refusal', () => {
	it('WIPES and starts from the snapshot, reports `archive-refused`, and indexes forward from its cursor', async () => {
		const definition = applyingProcessor();
		const databaseName = await visitedUpTo(definition, LOCAL_AT);
		const snapshot = await publishedSnapshot(definition, SNAPSHOT_AT);
		const host = await publication(snapshot);
		const chain = node(BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP, {servesFrom: SNAPSHOT_AT - 1});

		const tab = tabOf({databaseName, definition, publication: {locations: [INDEX], fetch: host.get}});
		await tab.indexer.init({provider: chain.provider, source: SOURCE, config: tab.config});
		// on arrival the tab KEEPS its own state and downloads no body: it will catch up
		expect(tab.outcomes).toEqual([{status: 'kept-local', at: LOCAL_AT}]);
		expect(host.asked).toEqual([INDEX]);

		const reached = await indexToTip(tab.indexer as never);
		const applied = await appliedIn(tab.indexer.state.$state);
		const status = tab.indexer.syncing.$state.publication;
		tab.indexer.dispose();

		expect(reached.lastToBlock).toBe(BRANCH_A_EXTENDED_TIP);
		// the catch-up was refused, and then the switch went through the app's own install
		expect(chain.refused.length).toBeGreaterThan(0);
		expect(tab.handed.map((handed) => handed?.replaceLocal)).toEqual([false, true]);
		expect(tab.outcomes).toEqual([
			{status: 'kept-local', at: LOCAL_AT},
			{status: 'bootstrapped', at: SNAPSHOT_AT, from: host.body},
		]);
		expect(host.asked).toEqual([INDEX, host.body]);
		expect(status).toEqual({
			status: 'switched',
			reason: 'archive-refused',
			from: INDEX,
			snapshot: host.body,
			at: SNAPSHOT_AT,
			left: LOCAL_AT,
		});
		// every event exactly once: no block skipped, none applied twice
		expect(applied).toHaveLength(BRANCH_A_EXTENDED.length);
		expect(applied.map((row) => row.times)).toEqual(applied.map(() => 1));
		// and the state IS a fresh install of the same snapshot, indexed forward
		expect(applied).toEqual(await freshInstallOf(snapshot, BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP));
	});

	it('with NO usable snapshot, reports the refusal as before and installs nothing', async () => {
		const definition = applyingProcessor();
		const databaseName = await visitedUpTo(definition, LOCAL_AT);
		// the index names nothing for this generation
		const host = await publication();
		const chain = node(BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP, {servesFrom: SNAPSHOT_AT - 1});

		const tab = tabOf({databaseName, definition, publication: {locations: [INDEX], fetch: host.get}});
		await tab.indexer.init({provider: chain.provider, source: SOURCE, config: tab.config});

		await expect(tab.indexer.indexMore()).rejects.toBeInstanceOf(ArchiveRefusedError);
		const applied = await appliedIn(tab.indexer.state.$state);
		const status = tab.indexer.syncing.$state.publication;
		tab.indexer.dispose();

		expect(status).toEqual({status: 'refused', reason: 'no-entry', from: INDEX});
		expect(tab.handed).toEqual([undefined]);
		expect(tab.outcomes).toHaveLength(1);
		expect(host.asked).toEqual([INDEX]);
		// the tab's own state, untouched: blocks 100 and nothing above its cursor
		expect(applied).toHaveLength(2);
	});
});

describe('a returning tab and its catch-up budget', () => {
	/** A long quiet gap, fetched a few blocks per request, a minute per request on the clock. */
	const SLOW = {msPerRequest: 60_000};
	// one more than the finality, the least the engine takes: a first advance that stops short of the snapshot
	const SMALL_RANGES = FINALITY + 1;

	it('switches to the snapshot when the estimate EXCEEDS the budget, reporting both', async () => {
		const definition = applyingProcessor();
		const databaseName = await visitedUpTo(definition, LOCAL_AT);
		const snapshot = await publishedSnapshot(definition, SNAPSHOT_AT);
		const host = await publication(snapshot);
		const chain = node(BRANCH_A_LATER, BRANCH_A_LATER_TIP, SLOW);

		const tab = tabOf({
			databaseName,
			definition,
			publication: {locations: [INDEX], fetch: host.get},
			maxBlocksPerFetch: SMALL_RANGES,
		});
		await tab.indexer.init({provider: chain.provider, source: SOURCE, config: tab.config});
		const reached = await indexToTip(tab.indexer as never, 200);
		const applied = await appliedIn(tab.indexer.state.$state);
		const status = tab.indexer.syncing.$state.publication;
		tab.indexer.dispose();

		expect(reached.lastToBlock).toBe(BRANCH_A_LATER_TIP);
		expect(status).toMatchObject({
			status: 'switched',
			reason: 'over-budget',
			at: SNAPSHOT_AT,
			budgetSeconds: DEFAULT_CATCH_UP_WITHIN_SECONDS,
		});
		expect(status?.status === 'switched' && status.estimateSeconds).toBeGreaterThan(DEFAULT_CATCH_UP_WITHIN_SECONDS);
		expect(tab.outcomes).toEqual([
			{status: 'kept-local', at: LOCAL_AT},
			{status: 'bootstrapped', at: SNAPSHOT_AT, from: host.body},
		]);
		expect(host.asked).toEqual([INDEX, host.body]);
		expect(applied).toHaveLength(BRANCH_A_LATER.length);
		expect(applied.map((row) => row.times)).toEqual(applied.map(() => 1));
		expect(applied).toEqual(await freshInstallOf(snapshot, BRANCH_A_LATER, BRANCH_A_LATER_TIP));
	});

	it('catches up, and downloads NO snapshot body, when the estimate fits', async () => {
		const definition = applyingProcessor();
		const databaseName = await visitedUpTo(definition, LOCAL_AT);
		const snapshot = await publishedSnapshot(definition, SNAPSHOT_AT);
		const host = await publication(snapshot);
		// a second per request, and a gap of a hundred blocks four at a time: well inside
		const chain = node(BRANCH_A_LATER, BRANCH_A_LATER_TIP, {msPerRequest: 1_000});

		const tab = tabOf({
			databaseName,
			definition,
			publication: {locations: [INDEX], fetch: host.get},
			catchUpWithinSeconds: 600,
			maxBlocksPerFetch: SMALL_RANGES,
		});
		await tab.indexer.init({provider: chain.provider, source: SOURCE, config: tab.config});
		const reached = await indexToTip(tab.indexer as never, 200);
		const applied = await appliedIn(tab.indexer.state.$state);
		const status = tab.indexer.syncing.$state.publication;
		tab.indexer.dispose();

		expect(reached.lastToBlock).toBe(BRANCH_A_LATER_TIP);
		expect(status).toMatchObject({status: 'found'});
		expect(tab.outcomes).toEqual([{status: 'kept-local', at: LOCAL_AT}]);
		expect(host.asked).toEqual([INDEX]);
		expect(applied).toHaveLength(BRANCH_A_LATER.length);
		expect(applied.map((row) => row.times)).toEqual(applied.map(() => 1));
	});

	it("with 'always', catches up however long the estimate", async () => {
		const definition = applyingProcessor();
		const databaseName = await visitedUpTo(definition, LOCAL_AT);
		const snapshot = await publishedSnapshot(definition, SNAPSHOT_AT);
		const host = await publication(snapshot);
		const chain = node(BRANCH_A_LATER, BRANCH_A_LATER_TIP, SLOW);

		const tab = tabOf({
			databaseName,
			definition,
			publication: {locations: [INDEX], fetch: host.get},
			catchUpWithinSeconds: 'always',
			maxBlocksPerFetch: SMALL_RANGES,
		});
		await tab.indexer.init({provider: chain.provider, source: SOURCE, config: tab.config});
		const reached = await indexToTip(tab.indexer as never, 200);
		const status = tab.indexer.syncing.$state.publication;
		tab.indexer.dispose();

		expect(reached.lastToBlock).toBe(BRANCH_A_LATER_TIP);
		expect(status).toMatchObject({status: 'found'});
		expect(tab.outcomes).toEqual([{status: 'kept-local', at: LOCAL_AT}]);
		expect(host.asked).toEqual([INDEX]);
	});

	it("with 'always', still falls back to the snapshot on an archive refusal", async () => {
		const definition = applyingProcessor();
		const databaseName = await visitedUpTo(definition, LOCAL_AT);
		const snapshot = await publishedSnapshot(definition, SNAPSHOT_AT);
		const host = await publication(snapshot);
		const chain = node(BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP, {...SLOW, servesFrom: SNAPSHOT_AT - 1});

		const tab = tabOf({
			databaseName,
			definition,
			publication: {locations: [INDEX], fetch: host.get},
			catchUpWithinSeconds: 'always',
		});
		await tab.indexer.init({provider: chain.provider, source: SOURCE, config: tab.config});
		const reached = await indexToTip(tab.indexer as never);
		const applied = await appliedIn(tab.indexer.state.$state);
		const status = tab.indexer.syncing.$state.publication;
		tab.indexer.dispose();

		expect(reached.lastToBlock).toBe(BRANCH_A_EXTENDED_TIP);
		expect(status).toMatchObject({status: 'switched', reason: 'archive-refused'});
		expect(host.asked).toEqual([INDEX, host.body]);
		expect(applied).toHaveLength(BRANCH_A_EXTENDED.length);
		expect(applied.map((row) => row.times)).toEqual(applied.map(() => 1));
	});
});

describe('what does not change', () => {
	it('a FRESH tab starts from the snapshot as before, and never switches', async () => {
		const definition = applyingProcessor();
		const snapshot = await publishedSnapshot(definition, SNAPSHOT_AT);
		const host = await publication(snapshot);
		const chain = node(BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP, {servesFrom: SNAPSHOT_AT - 1, msPerRequest: 60_000});

		const tab = tabOf({databaseName: freshName(), definition, publication: {locations: [INDEX], fetch: host.get}});
		await tab.indexer.init({provider: chain.provider, source: SOURCE, config: tab.config});
		await indexToTip(tab.indexer as never);
		const applied = await appliedIn(tab.indexer.state.$state);
		const status = tab.indexer.syncing.$state.publication;
		tab.indexer.dispose();

		expect(tab.outcomes).toEqual([{status: 'bootstrapped', at: SNAPSHOT_AT, from: host.body}]);
		expect(tab.handed.map((handed) => handed?.replaceLocal)).toEqual([false]);
		expect(status).toMatchObject({status: 'found'});
		expect(chain.refused).toEqual([]);
		expect(applied).toHaveLength(BRANCH_A_EXTENDED.length);
	});

	it('a tab already AT or ahead of the snapshot is untouched: it catches up, and a refusal is reported as before', async () => {
		const definition = applyingProcessor();
		// this tab got to 105, past the snapshot at 104
		const databaseName = await visitedUpTo(definition, SNAPSHOT_AT + 1);
		const snapshot = await publishedSnapshot(definition, SNAPSHOT_AT);
		const host = await publication(snapshot);
		// refuses everything this tab asks for, and slowly
		const chain = node(BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP, {servesFrom: 1_000, msPerRequest: 60_000});

		const tab = tabOf({databaseName, definition, publication: {locations: [INDEX], fetch: host.get}});
		await tab.indexer.init({provider: chain.provider, source: SOURCE, config: tab.config});
		await expect(tab.indexer.indexMore()).rejects.toBeInstanceOf(ArchiveRefusedError);
		const status = tab.indexer.syncing.$state.publication;
		tab.indexer.dispose();

		expect(tab.outcomes).toEqual([{status: 'kept-local', at: SNAPSHOT_AT + 1}]);
		expect(tab.handed.map((handed) => handed?.replaceLocal)).toEqual([false]);
		expect(status).toMatchObject({status: 'found'});
		expect(host.asked).toEqual([INDEX]);
	});
});

/**
 * The same tab, with both seats derived from ONE store constructor
 * (`stateFactoriesFrom`) and standing in a tab election of this name. What it was
 * handed and what the bootstrap did are recorded as `tabOf` records them.
 */
function helperTabOf(options: {
	databaseName: string;
	definition: EntityProcessor<TestABI>;
	publication: BrowserPublicationOptions;
	election: string;
}) {
	const handed: (PublicationSnapshot | undefined)[] = [];
	const outcomes: BootstrapOutcome[] = [];
	const {createState, openState} = stateFactoriesFrom({
		open: (_context, entities) => createBrowserStateStore(entities, {databaseName: options.databaseName}),
		entities: options.definition.entities,
		finalityDepth: FINALITY,
		...(options.publication.fetch ? {fetch: options.publication.fetch} : {}),
		onBootstrap: (outcome) => outcomes.push(outcome),
	});
	const indexer = createIndexerState<TestABI, EntityStateView>(
		{
			createState: (context, patience, bundle, published) => {
				handed.push(published);
				return createState(context, patience, bundle, published);
			},
			openState,
			createProcessor: (state) => new EntityEventProcessor<TestABI>(state, options.definition),
			processorIdentity: PROCESSOR,
		},
		{publication: options.publication, tabElection: {name: options.election}},
	);
	return {indexer, handed, outcomes, config: CONFIG};
}

/**
 * The SAME install, with both seats derived from ONE store constructor
 * (`stateFactoriesFrom`) in a tab election: the leader still starts from the
 * snapshot and still REPLACES its local state when the host abandons a catch-up
 * (the helper forwards `replaceLocal`), and a reader downloads and installs none.
 */
describe('a publication, through ONE store constructor and the tab election', () => {
	it('the leader starts from the snapshot; a reader of the same store downloads and installs NONE', async () => {
		const definition = applyingProcessor();
		const snapshot = await publishedSnapshot(definition, SNAPSHOT_AT);
		const databaseName = freshName();
		const election = freshName();
		const leaderHost = await publication(snapshot);
		const readerHost = await publication(snapshot);

		const leader = helperTabOf({
			databaseName,
			definition,
			publication: {locations: [INDEX], fetch: leaderHost.get},
			election,
		});
		await leader.indexer.init({provider: node(BRANCH_A, SNAPSHOT_AT).provider, source: SOURCE, config: CONFIG});
		const reader = helperTabOf({
			databaseName,
			definition,
			publication: {locations: [INDEX], fetch: readerHost.get},
			election,
		});
		await reader.indexer.init({provider: node(BRANCH_A, SNAPSHOT_AT).provider, source: SOURCE, config: CONFIG});

		try {
			expect(leader.indexer.syncing.$state.election?.role).toBe('writer');
			expect(reader.indexer.syncing.$state.election?.role).toBe('reader');
			expect(leader.outcomes).toEqual([{status: 'bootstrapped', at: SNAPSHOT_AT, from: leaderHost.body}]);
			expect(leaderHost.asked).toContain(leaderHost.body);
			// the reader built no writer, so it bootstrapped nothing and fetched no body
			expect(reader.handed).toEqual([]);
			expect(reader.outcomes).toEqual([]);
			expect(readerHost.asked).not.toContain(readerHost.body);
			// ...and reads the rows the leader installed
			expect(await appliedIn(reader.indexer.state.$state)).toEqual(await appliedIn(leader.indexer.state.$state));
			expect((await appliedIn(reader.indexer.state.$state)).length).toBeGreaterThan(0);
		} finally {
			leader.indexer.dispose();
			reader.indexer.dispose();
		}
	});

	it('an abandoned catch-up still REPLACES the local state through the helper', async () => {
		const definition = applyingProcessor();
		const databaseName = await visitedUpTo(definition, LOCAL_AT);
		const snapshot = await publishedSnapshot(definition, SNAPSHOT_AT);
		const host = await publication(snapshot);
		const chain = node(BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP, {servesFrom: SNAPSHOT_AT - 1});

		const tab = helperTabOf({
			databaseName,
			definition,
			publication: {locations: [INDEX], fetch: host.get},
			election: freshName(),
		});
		await tab.indexer.init({provider: chain.provider, source: SOURCE, config: tab.config});
		const reached = await indexToTip(tab.indexer as never);
		const applied = await appliedIn(tab.indexer.state.$state);
		tab.indexer.dispose();

		expect(reached.lastToBlock).toBe(BRANCH_A_EXTENDED_TIP);
		expect(tab.handed.map((handed) => handed?.replaceLocal)).toEqual([false, true]);
		expect(tab.outcomes).toEqual([
			{status: 'kept-local', at: LOCAL_AT},
			{status: 'bootstrapped', at: SNAPSHOT_AT, from: host.body},
		]);
		expect(applied).toHaveLength(BRANCH_A_EXTENDED.length);
		expect(applied.map((row) => row.times)).toEqual(applied.map(() => 1));
		expect(applied).toEqual(await freshInstallOf(snapshot, BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP));
	});
});
