import 'fake-indexeddb/auto';
import {createHash} from 'node:crypto';
import {
	captureStream,
	generationDigestOf,
	resolveStreamConfig,
	storedStreamOf,
	streamDigestOf,
	streamDigestOfSourceHashes,
	streamSeedContentHash,
	streamSeedPayloadOf,
	PUBLICATION_INDEX_FORMAT,
	STREAM_SEED_FORMAT,
	type LastSync,
	type PublicationIndex,
	type PublishedStateSnapshot,
	type StreamSeed,
} from '@etherfold/core';
import {
	createSnapshot,
	EntityEventProcessor,
	openAndBootstrap,
	openForWriting,
	type BootstrapOutcome,
	type EntityProcessor,
	type EntityStateView,
	type Mutation,
	type StateSnapshot,
	type StateStore,
} from '@etherfold/processor-entities';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
	connectToIndexerHost,
	createBrowserStateStore,
	createIndexerState,
	DEFAULT_CATCH_UP_WITHIN_SECONDS,
	hostIndexerInThisSharedWorker,
	keepStreamOnIndexedDB,
	serveIndexerHost,
	type BrowserPublicationOptions,
	type BrowserStreamSeedOptions,
	type HostedIndexerSpec,
	type HostProgress,
	type IndexerPort,
	type MessageEndpoint,
	type PublicationSnapshot,
} from '../src/index.js';
import {
	BRANCH_A,
	BRANCH_A_EXTENDED,
	BRANCH_A_EXTENDED_TIP,
	BRANCH_A_LATER,
	BRANCH_A_LATER_TIP,
	BRANCH_A_TIP,
	fakeChain,
	FINALITY,
	indexToTip,
	SOURCE,
	SOURCE_V2,
	START_BLOCK,
	timestampOf,
	type RawLog,
	type TestABI,
} from '../browser/workload.js';
import {applyingProcessor} from './utils/applied.js';
import {wire} from './utils/port.js';
import {identityOf} from './utils/processorIdentity.js';
import {sharedWorkerScope} from './utils/sharedWorkerScope.js';

/**
 * A WORKER-HOSTED TAB STARTS FROM A PUBLICATION, catches up within a budget or
 * switches to the snapshot, and installs a seed only when asked (ADR-0082,
 * ADR-0095, ADR-0096).
 *
 * The main-thread host (`createIndexerState`) has had all three for a while; the
 * claim here is PARITY: a dedicated-worker host and a SharedWorker host, handed
 * the same options in the spec their worker entry passes, reach the same outcomes
 * and report them to the tab over the PORT (`HostProgress.publication`,
 * `HostProgress.streamSeed`), which is the only surface a worker-hosted tab has.
 *
 * Every shape runs the SAME cases, the way `aTabRunsAPublishedProcessorBundle` and
 * `aSharedWorkerServesSeveralTabs` drive the worker hosts in node: the dedicated
 * worker is `serveIndexerHost` over a `MessageChannel` (which is exactly what
 * `hostIndexerInThisWorker` calls over the worker's own scope), and the
 * SharedWorker is `hostIndexerInThisSharedWorker` over a scope made to look like
 * one. What is read back is read ACROSS THE PORT: the progress a tab is pushed, and
 * the rows through `port.reads`.
 *
 * The returning-tab cases mirror `aReturningTabCatchesUpOrStartsFromTheSnapshot`
 * case for case, on the same controlled clock, so "the same behaviour" is the same
 * assertions rather than a paraphrase of them.
 */

let counter = 0;
const freshName = () => `worker-publication-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

const CONFIG = {stream: {finality: FINALITY}};
const STREAM_CONFIG = resolveStreamConfig(CONFIG.stream);
const THIS_STREAM = streamDigestOf(SOURCE, STREAM_CONFIG);
const OTHER_STREAM = streamDigestOf(SOURCE_V2, STREAM_CONFIG);
const PROCESSOR = identityOf('worker-publication-app');
const OTHER_PROCESSOR = identityOf('worker-publication-app-other');
const INDEX = 'https://publications.example/app/publication.json';

/** Where a returning tab got to on its last visit, and where the published snapshot is. */
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
 * A node over `branch`: every `eth_getLogs` costs `msPerRequest` on the clock, and
 * one starting below `servesFrom` is refused the way a non-archive public node
 * refuses history.
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

/** A publisher indexes to `tip` and publishes what it computed, labelled `processor`. */
async function publishedSnapshot(
	definition: EntityProcessor<TestABI>,
	tip: number,
	processor = PROCESSOR,
): Promise<StateSnapshot> {
	const store = await openForWriting(await createBrowserStateStore(definition.entities, {databaseName: freshName()}));
	const indexer = createIndexerState<TestABI, EntityStateView>({
		createState: () => store,
		createProcessor: (state) => new EntityEventProcessor<TestABI>(state, definition),
		processorIdentity: processor,
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
		processor,
	});
}

/** A published seed of this tab's stream, captured from the same chain (see `streamSeeding.test.ts`). */
async function publishedSeed(): Promise<StreamSeed> {
	const fixture = await captureStream(fakeChain(BRANCH_A, BRANCH_A_TIP).provider, SOURCE, {
		toBlock: 101,
		streamConfig: CONFIG.stream,
	});
	return {
		format: STREAM_SEED_FORMAT,
		producer: {
			kind: 'capture',
			name: 'packages/browser/test/aWorkerHostedTabStartsFromAPublication.test.ts',
			at: '2026-09-27T00:00:00.000Z',
		},
		chainHeadAtCapture: BRANCH_A_TIP,
		streamConfig: STREAM_CONFIG,
		streamDigest: streamDigestOfSourceHashes(fixture.lastSync.context.source, STREAM_CONFIG),
		coverage: {fromBlock: fixture.lastSync.lastFromBlock, toBlock: fixture.lastSync.lastToBlock},
		context: fixture.lastSync.context,
		eventStream: storedStreamOf(fixture.eventStream),
	};
}

/**
 * `publication.json` naming `snapshot` for `stream` (or nothing), a seed where one
 * is given, and every body, served by a host that records what it was asked for.
 * `unreachable` makes the index location fail to answer at all.
 */
async function publication(
	options: {snapshot?: StateSnapshot; stream?: string; seed?: StreamSeed; unreachable?: boolean} = {},
) {
	const routes: Record<string, Uint8Array> = {};
	const snapshots: Record<string, PublishedStateSnapshot> = {};
	let body: string | undefined;
	if (options.snapshot) {
		const stream = options.stream ?? THIS_STREAM;
		const processor = options.snapshot.head.processor;
		const contentHash = `sha256:${createHash('sha256').update(options.snapshot.document).digest('hex')}`;
		const name = `state-${contentHash.slice('sha256:'.length)}.ndjson.gz`;
		snapshots[generationDigestOf({stream, processor})] = {
			stream,
			processor,
			body: name,
			contentHash,
			takenAt: options.snapshot.head.takenAt,
			floor: options.snapshot.head.floor,
			cut: options.snapshot.head.takenAt.number,
			savedAt: options.snapshot.head.savedAt,
		};
		body = `https://publications.example/app/${name}`;
		routes[body] = options.snapshot.document;
	}
	let seeds: PublicationIndex['seeds'];
	let seedBody: string | undefined;
	if (options.seed) {
		const payload = streamSeedPayloadOf(options.seed);
		const contentHash = streamSeedContentHash(payload);
		const name = `seed-${contentHash.slice('sha256:'.length)}.json.gz`;
		seedBody = `https://publications.example/app/${name}`;
		routes[seedBody] = payload;
		seeds = {
			[options.seed.streamDigest]: {
				stream: options.seed.streamDigest,
				body: name,
				contentHash,
				coverage: options.seed.coverage,
				events: options.seed.eventStream.length,
				savedAt: '2026-09-27T00:00:00.000Z',
			},
		};
	}
	const index: PublicationIndex = {format: PUBLICATION_INDEX_FORMAT, snapshots, ...(seeds ? {seeds} : {})};
	if (!options.unreachable) routes[INDEX] = new TextEncoder().encode(JSON.stringify(index));
	const asked: string[] = [];
	const get = (async (input: unknown) => {
		const url = String(input);
		asked.push(url);
		if (options.unreachable && url === INDEX) throw new Error('connection refused');
		const served = routes[url];
		if (served === undefined) return new Response('not found', {status: 404});
		return new Response(new Uint8Array(served), {status: 200});
	}) as typeof globalThis.fetch;
	return {asked, get, body, seedBody};
}

// ---------------------------------------------------------------------------
// THE TWO WORKER SHAPES, and the tab holding a port to one
// ---------------------------------------------------------------------------

type Shape = 'dedicated-worker' | 'shared-worker';
const SHAPES: Shape[] = ['dedicated-worker', 'shared-worker'];

/**
 * THE APP'S WORKER ENTRY, with the tab's port to it.
 *
 * The spec is what `hostIndexerInThisWorker` / `hostIndexerInThisSharedWorker` is
 * handed: the factories, the chain, and the options this suite is about, all built
 * INSIDE the host. `createState` starts from what it is handed through the
 * existing bootstrap and FORWARDS `replaceLocal`, recording what it was handed and
 * what the bootstrap did.
 */
function workerTab(
	shape: Shape,
	options: {
		databaseName?: string;
		definition: EntityProcessor<TestABI>;
		provider: unknown;
		processor?: string;
		publication?: BrowserPublicationOptions;
		catchUpWithinSeconds?: number | 'always';
		maxBlocksPerFetch?: number;
		keepStream?: string;
		seed?: BrowserStreamSeedOptions;
	},
) {
	const databaseName = options.databaseName ?? freshName();
	const handed: (PublicationSnapshot | undefined)[] = [];
	const outcomes: BootstrapOutcome[] = [];
	const spec: HostedIndexerSpec<TestABI, EntityStateView> = {
		createState: async (_context, {signal}, _bundle, published) => {
			handed.push(published);
			const backend = await createBrowserStateStore(options.definition.entities, {databaseName});
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
		processorIdentity: options.processor ?? PROCESSOR,
		provider: options.provider as HostedIndexerSpec<TestABI, EntityStateView>['provider'],
		source: SOURCE,
		config: options.maxBlocksPerFetch ? {...CONFIG, fetch: {maxBlocksPerFetch: options.maxBlocksPerFetch}} : CONFIG,
		tipIntervalInSeconds: 0.02,
		...(options.publication ? {publication: options.publication} : {}),
		...(options.catchUpWithinSeconds !== undefined ? {catchUpWithinSeconds: options.catchUpWithinSeconds} : {}),
		...(options.keepStream ? {keepStream: keepStreamOnIndexedDB<TestABI>(options.keepStream)} : {}),
		...(options.seed ? {seed: options.seed} : {}),
	};

	if (shape === 'dedicated-worker') {
		const ends = wire();
		const host = serveIndexerHost(spec, ends.host);
		const port = connectToIndexerHost(ends.tab);
		return {
			port,
			handed,
			outcomes,
			dispose() {
				host.dispose();
				port.close();
				ends.close();
			},
		};
	}
	const scope = sharedWorkerScope();
	const channel = new MessageChannel();
	const host = hostIndexerInThisSharedWorker(spec);
	scope.connect(channel.port1 as unknown as MessageEndpoint);
	const port = connectToIndexerHost({
		host: 'shared-worker',
		endpoint: channel.port2 as unknown as MessageEndpoint,
		close: () => channel.port2.close(),
	});
	return {
		port,
		handed,
		outcomes,
		dispose() {
			host.dispose();
			port.close();
			channel.port1.close();
			scope.restore();
		},
	};
}

/** Ask until `done` says so, or the host says it stopped (which is returned, for the refusal cases). */
async function until(port: IndexerPort, done: (progress: HostProgress) => boolean, attempts = 1500) {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const progress = await port.progress();
		if (done(progress) || progress.phase === 'refused') return progress;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`the host never got there: ${JSON.stringify(await port.progress())}`);
}

/** At the tip `tip`, and failing loudly where the host stopped instead. */
async function untilTip(port: IndexerPort, tip: number): Promise<HostProgress> {
	const progress = await until(port, (p) => p.latestBlock === tip && p.lastToBlock === tip && p.phase === 'at-tip');
	if (progress.failure) throw new Error(`the host stopped: ${progress.failure.name}: ${progress.failure.message}`);
	return progress;
}

/** What was applied, read ACROSS THE PORT, in chain order with the count beside it. */
async function appliedAcross(port: IndexerPort): Promise<{key: string; times: number}[]> {
	const listing = await port.reads.listCurrent('applied', {bucket: 'all'}, 500);
	expect(listing.truncated).toBe(false);
	return listing.rows.map((row) => ({key: String(row.key), times: Number(row.times)}));
}

/** A tab that visited once and got to `at`, then closed: its database is what a return opens. */
async function visitedUpTo(definition: EntityProcessor<TestABI>, at: number): Promise<string> {
	const databaseName = freshName();
	const first = createIndexerState<TestABI, EntityStateView>({
		createState: async () =>
			openForWriting(
				(
					await openAndBootstrap(await createBrowserStateStore(definition.entities, {databaseName}), [], {
						processor: 'no-snapshot-was-handed',
					})
				).store,
			),
		createProcessor: (state) => new EntityEventProcessor<TestABI>(state, definition),
		processorIdentity: PROCESSOR,
	});
	await first.init({provider: fakeChain(BRANCH_A, at).provider, source: SOURCE, config: CONFIG});
	const reached = await indexToTip(first as never);
	first.dispose();
	expect(reached.lastToBlock).toBe(at);
	return databaseName;
}

// ---------------------------------------------------------------------------
// THE CASES, once per worker shape
// ---------------------------------------------------------------------------

describe.each(SHAPES)('in a %s host', (shape) => {
	describe('a tab starts from a publication index', () => {
		it('starts from its OWN generation\u2019s snapshot, keeps it across the first load, and fetches no seed by default', async () => {
			const definition = applyingProcessor();
			const snapshot = await publishedSnapshot(definition, 102);
			const host = await publication({snapshot, seed: await publishedSeed()});
			const chain = node(BRANCH_A, BRANCH_A_TIP);
			const tab = workerTab(shape, {
				definition,
				provider: chain.provider,
				publication: {locations: [INDEX], fetch: host.get},
			});
			try {
				const progress = await untilTip(tab.port, BRANCH_A_TIP);
				expect(progress.publication).toEqual({status: 'found', from: INDEX, snapshot: host.body, at: 102});
				// nothing was asked for, so nothing is reported
				expect(progress.streamSeed).toBeUndefined();
				expect(tab.handed.map((handed) => handed?.replaceLocal)).toEqual([false]);
				expect(tab.outcomes).toEqual([{status: 'bootstrapped', at: 102, from: host.body}]);
				// KEPT across the first load: the fold resumed from the snapshot's cursor
				expect(chain.ranges[0].from).toBe(102);
				const applied = await appliedAcross(tab.port);
				expect(applied).toHaveLength(BRANCH_A.length);
				expect(applied.map((row) => row.times)).toEqual(applied.map(() => 1));
				// the index and the snapshot, and no seed although the index lists one
				expect(host.asked).toEqual([INDEX, host.body]);
			} finally {
				tab.dispose();
			}
		});

		it('reports STREAM-MISMATCH over the port, downloads nothing beyond the index, and indexes from the chain', async () => {
			const definition = applyingProcessor();
			const snapshot = await publishedSnapshot(definition, 102);
			const host = await publication({snapshot, stream: OTHER_STREAM});
			const chain = node(BRANCH_A, BRANCH_A_TIP);
			const tab = workerTab(shape, {
				definition,
				provider: chain.provider,
				publication: {locations: [INDEX], fetch: host.get},
			});
			try {
				const progress = await untilTip(tab.port, BRANCH_A_TIP);
				expect(progress.publication).toEqual({
					status: 'refused',
					reason: 'stream-mismatch',
					from: INDEX,
					streams: [OTHER_STREAM],
				});
				expect(tab.handed).toEqual([undefined]);
				expect(host.asked).toEqual([INDEX]);
				expect(chain.ranges[0].from).toBe(START_BLOCK);
				expect(await appliedAcross(tab.port)).toHaveLength(BRANCH_A.length);
			} finally {
				tab.dispose();
			}
		});

		it('reports NO-ENTRY over the port, and indexes from the chain', async () => {
			const definition = applyingProcessor();
			const snapshot = await publishedSnapshot(definition, 102, OTHER_PROCESSOR);
			const host = await publication({snapshot});
			const chain = node(BRANCH_A, BRANCH_A_TIP);
			const tab = workerTab(shape, {
				definition,
				provider: chain.provider,
				publication: {locations: [INDEX], fetch: host.get},
			});
			try {
				const progress = await untilTip(tab.port, BRANCH_A_TIP);
				expect(progress.publication).toEqual({status: 'refused', reason: 'no-entry', from: INDEX});
				expect(tab.handed).toEqual([undefined]);
				expect(host.asked).toEqual([INDEX]);
				expect(chain.ranges[0].from).toBe(START_BLOCK);
			} finally {
				tab.dispose();
			}
		});

		it('reports an UNREACHABLE index over the port, and indexes from the chain', async () => {
			const definition = applyingProcessor();
			const host = await publication({unreachable: true});
			const chain = node(BRANCH_A, BRANCH_A_TIP);
			const tab = workerTab(shape, {
				definition,
				provider: chain.provider,
				publication: {locations: [INDEX], fetch: host.get},
			});
			try {
				const progress = await untilTip(tab.port, BRANCH_A_TIP);
				expect(progress.publication).toEqual({status: 'refused', reason: 'unreachable'});
				expect(tab.handed).toEqual([undefined]);
				expect(chain.ranges[0].from).toBe(START_BLOCK);
				expect(await appliedAcross(tab.port)).toHaveLength(BRANCH_A.length);
			} finally {
				tab.dispose();
			}
		});

		it('PUSHES the outcome to a tab that subscribed, rather than leaving it to ask', async () => {
			const definition = applyingProcessor();
			const host = await publication({unreachable: true});
			const tab = workerTab(shape, {
				definition,
				provider: node(BRANCH_A, BRANCH_A_TIP).provider,
				publication: {locations: [INDEX], fetch: host.get},
			});
			try {
				const pushed: HostProgress[] = [];
				const stop = tab.port.onProgress((progress) => pushed.push(progress));
				await untilTip(tab.port, BRANCH_A_TIP);
				stop();
				expect(pushed.some((progress) => progress.publication?.status === 'refused')).toBe(true);
			} finally {
				tab.dispose();
			}
		});
	});

	describe('a returning tab whose node refuses the catch-up as an archive refusal', () => {
		it('WIPES and starts from the snapshot, reports `archive-refused` over the port, and indexes forward', async () => {
			const definition = applyingProcessor();
			const databaseName = await visitedUpTo(definition, LOCAL_AT);
			const snapshot = await publishedSnapshot(definition, SNAPSHOT_AT);
			const host = await publication({snapshot});
			const chain = node(BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP, {servesFrom: SNAPSHOT_AT - 1});
			const tab = workerTab(shape, {
				databaseName,
				definition,
				provider: chain.provider,
				publication: {locations: [INDEX], fetch: host.get},
			});
			try {
				const progress = await untilTip(tab.port, BRANCH_A_EXTENDED_TIP);
				expect(chain.refused.length).toBeGreaterThan(0);
				expect(tab.handed.map((handed) => handed?.replaceLocal)).toEqual([false, true]);
				expect(tab.outcomes).toEqual([
					{status: 'kept-local', at: LOCAL_AT},
					{status: 'bootstrapped', at: SNAPSHOT_AT, from: host.body},
				]);
				expect(host.asked).toEqual([INDEX, host.body]);
				expect(progress.publication).toEqual({
					status: 'switched',
					reason: 'archive-refused',
					from: INDEX,
					snapshot: host.body,
					at: SNAPSHOT_AT,
					left: LOCAL_AT,
				});
				expect(progress.failure).toBeUndefined();
				// every event exactly once: no block skipped, none applied twice
				const applied = await appliedAcross(tab.port);
				expect(applied).toHaveLength(BRANCH_A_EXTENDED.length);
				expect(applied.map((row) => row.times)).toEqual(applied.map(() => 1));
			} finally {
				tab.dispose();
			}
		});

		it('with NO usable snapshot, reports the refusal as before and installs nothing', async () => {
			const definition = applyingProcessor();
			const databaseName = await visitedUpTo(definition, LOCAL_AT);
			const host = await publication();
			const chain = node(BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP, {servesFrom: SNAPSHOT_AT - 1});
			const tab = workerTab(shape, {
				databaseName,
				definition,
				provider: chain.provider,
				publication: {locations: [INDEX], fetch: host.get},
			});
			try {
				const progress = await until(tab.port, () => false);
				expect(progress.phase).toBe('refused');
				expect(progress.failure?.name).toBe('ArchiveRefusedError');
				expect(progress.publication).toEqual({status: 'refused', reason: 'no-entry', from: INDEX});
				expect(tab.handed).toEqual([undefined]);
				expect(host.asked).toEqual([INDEX]);
				// the tab's own state, untouched
				expect(await appliedAcross(tab.port)).toHaveLength(2);
			} finally {
				tab.dispose();
			}
		});
	});

	describe('a returning tab and its catch-up budget', () => {
		const SLOW = {msPerRequest: 60_000};
		const SMALL_RANGES = FINALITY + 1;

		it('switches to the snapshot when the estimate EXCEEDS the budget, reporting both', async () => {
			const definition = applyingProcessor();
			const databaseName = await visitedUpTo(definition, LOCAL_AT);
			const snapshot = await publishedSnapshot(definition, SNAPSHOT_AT);
			const host = await publication({snapshot});
			const chain = node(BRANCH_A_LATER, BRANCH_A_LATER_TIP, SLOW);
			const tab = workerTab(shape, {
				databaseName,
				definition,
				provider: chain.provider,
				publication: {locations: [INDEX], fetch: host.get},
				maxBlocksPerFetch: SMALL_RANGES,
			});
			try {
				const progress = await untilTip(tab.port, BRANCH_A_LATER_TIP);
				expect(progress.publication).toMatchObject({
					status: 'switched',
					reason: 'over-budget',
					at: SNAPSHOT_AT,
					budgetSeconds: DEFAULT_CATCH_UP_WITHIN_SECONDS,
				});
				const status = progress.publication;
				expect(status?.status === 'switched' && status.estimateSeconds).toBeGreaterThan(
					DEFAULT_CATCH_UP_WITHIN_SECONDS,
				);
				expect(tab.outcomes).toEqual([
					{status: 'kept-local', at: LOCAL_AT},
					{status: 'bootstrapped', at: SNAPSHOT_AT, from: host.body},
				]);
				expect(host.asked).toEqual([INDEX, host.body]);
				const applied = await appliedAcross(tab.port);
				expect(applied).toHaveLength(BRANCH_A_LATER.length);
				expect(applied.map((row) => row.times)).toEqual(applied.map(() => 1));
			} finally {
				tab.dispose();
			}
		});

		it('catches up, and downloads NO snapshot body, when the estimate fits', async () => {
			const definition = applyingProcessor();
			const databaseName = await visitedUpTo(definition, LOCAL_AT);
			const snapshot = await publishedSnapshot(definition, SNAPSHOT_AT);
			const host = await publication({snapshot});
			const chain = node(BRANCH_A_LATER, BRANCH_A_LATER_TIP, {msPerRequest: 1_000});
			const tab = workerTab(shape, {
				databaseName,
				definition,
				provider: chain.provider,
				publication: {locations: [INDEX], fetch: host.get},
				catchUpWithinSeconds: 600,
				maxBlocksPerFetch: SMALL_RANGES,
			});
			try {
				const progress = await untilTip(tab.port, BRANCH_A_LATER_TIP);
				expect(progress.publication).toMatchObject({status: 'found'});
				expect(tab.outcomes).toEqual([{status: 'kept-local', at: LOCAL_AT}]);
				expect(host.asked).toEqual([INDEX]);
				const applied = await appliedAcross(tab.port);
				expect(applied).toHaveLength(BRANCH_A_LATER.length);
				expect(applied.map((row) => row.times)).toEqual(applied.map(() => 1));
			} finally {
				tab.dispose();
			}
		});

		it("with 'always', catches up however long the estimate", async () => {
			const definition = applyingProcessor();
			const databaseName = await visitedUpTo(definition, LOCAL_AT);
			const snapshot = await publishedSnapshot(definition, SNAPSHOT_AT);
			const host = await publication({snapshot});
			const chain = node(BRANCH_A_LATER, BRANCH_A_LATER_TIP, SLOW);
			const tab = workerTab(shape, {
				databaseName,
				definition,
				provider: chain.provider,
				publication: {locations: [INDEX], fetch: host.get},
				catchUpWithinSeconds: 'always',
				maxBlocksPerFetch: SMALL_RANGES,
			});
			try {
				const progress = await untilTip(tab.port, BRANCH_A_LATER_TIP);
				expect(progress.publication).toMatchObject({status: 'found'});
				expect(tab.outcomes).toEqual([{status: 'kept-local', at: LOCAL_AT}]);
				expect(host.asked).toEqual([INDEX]);
			} finally {
				tab.dispose();
			}
		});

		it("with 'always', still falls back to the snapshot on an archive refusal", async () => {
			const definition = applyingProcessor();
			const databaseName = await visitedUpTo(definition, LOCAL_AT);
			const snapshot = await publishedSnapshot(definition, SNAPSHOT_AT);
			const host = await publication({snapshot});
			const chain = node(BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP, {...SLOW, servesFrom: SNAPSHOT_AT - 1});
			const tab = workerTab(shape, {
				databaseName,
				definition,
				provider: chain.provider,
				publication: {locations: [INDEX], fetch: host.get},
				catchUpWithinSeconds: 'always',
			});
			try {
				const progress = await untilTip(tab.port, BRANCH_A_EXTENDED_TIP);
				expect(progress.publication).toMatchObject({status: 'switched', reason: 'archive-refused'});
				expect(host.asked).toEqual([INDEX, host.body]);
				const applied = await appliedAcross(tab.port);
				expect(applied).toHaveLength(BRANCH_A_EXTENDED.length);
				expect(applied.map((row) => row.times)).toEqual(applied.map(() => 1));
			} finally {
				tab.dispose();
			}
		});

		it('refuses a budget that cannot mean one, as the host\u2019s failure', async () => {
			const tab = workerTab(shape, {
				definition: applyingProcessor(),
				provider: node(BRANCH_A, BRANCH_A_TIP).provider,
				catchUpWithinSeconds: -1,
			});
			try {
				const progress = await until(tab.port, () => false);
				expect(progress.phase).toBe('refused');
				expect(progress.failure?.message).toMatch(/catchUpWithinSeconds/);
				expect(tab.handed).toEqual([]);
			} finally {
				tab.dispose();
			}
		});
	});

	describe('a stream seed', () => {
		it('installs the seed the index lists for its stream when the app ASKS for it, and reports it over the port', async () => {
			const definition = applyingProcessor();
			const snapshot = await publishedSnapshot(definition, 102);
			const seed = await publishedSeed();
			const host = await publication({snapshot, seed});
			const tab = workerTab(shape, {
				definition,
				provider: node(BRANCH_A, BRANCH_A_TIP).provider,
				publication: {locations: [INDEX], fetch: host.get, seed: true},
				keepStream: freshName(),
			});
			try {
				const progress = await untilTip(tab.port, BRANCH_A_TIP);
				expect(progress.streamSeed).toMatchObject({status: 'seeded', from: host.seedBody, at: seed.coverage.toBlock});
				expect(host.asked).toContain(host.seedBody);
				expect(tab.outcomes).toMatchObject([{status: 'bootstrapped', at: 102}]);
			} finally {
				tab.dispose();
			}
		});

		it('installs a seed named by the `seed` option, with no publication at all', async () => {
			const definition = applyingProcessor();
			const seed = await publishedSeed();
			const host = await publication({seed});
			const chain = node(BRANCH_A, BRANCH_A_TIP);
			const tab = workerTab(shape, {
				definition,
				provider: chain.provider,
				seed: {locations: [host.seedBody!], fetch: host.get},
				keepStream: freshName(),
			});
			try {
				const progress = await untilTip(tab.port, BRANCH_A_TIP);
				expect(progress.streamSeed).toMatchObject({status: 'seeded', from: host.seedBody, at: seed.coverage.toBlock});
				expect(progress.publication).toBeUndefined();
				// the stream below the seed's coverage came from the seed, not the node
				expect(chain.ranges[0].from).toBeGreaterThan(START_BLOCK);
				const applied = await appliedAcross(tab.port);
				expect(applied).toHaveLength(BRANCH_A.length);
				expect(applied.map((row) => row.times)).toEqual(applied.map(() => 1));
			} finally {
				tab.dispose();
			}
		});

		it('refuses a seed with no `keepStream` as the host\u2019s failure, and folds nothing', async () => {
			const chain = node(BRANCH_A, BRANCH_A_TIP);
			const tab = workerTab(shape, {
				definition: applyingProcessor(),
				provider: chain.provider,
				seed: {locations: ['https://seeds.example/seed.json.gz']},
			});
			try {
				const progress = await until(tab.port, () => false);
				expect(progress.phase).toBe('refused');
				expect(progress.failure?.message).toMatch(/keepStream/);
				expect(tab.handed).toEqual([]);
				expect(chain.ranges).toEqual([]);
			} finally {
				tab.dispose();
			}
		});
	});
});
