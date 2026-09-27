import 'fake-indexeddb/auto';
import {createHash} from 'node:crypto';
import {serveProvider} from '@eip-1193/over-port';
import {
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
	hostIndexerInThisSharedWorker,
	serveIndexerHost,
	type ConnectOutcome,
	type HostedIndexerSpec,
	type HostProgress,
	type HostSettings,
	type IndexerConnectOptions,
	type IndexerPort,
	type MessageEndpoint,
} from '../src/index.js';
import {
	BRANCH_A,
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
 * A WORKER HOST TAKES ITS PROVIDER AND ITS SETTINGS FROM THE TAB THAT CONNECTS
 * (ADR-0082, amended).
 *
 * The worker entry holds the CODE (`createState`, `createProcessor`) and nothing
 * else; the tab hands over the chain as a `MessagePort` speaking
 * `@eip-1193/over-port`, and the cloneable settings, with
 * `connectToIndexerHost(access, {provider, settings})`.
 *
 * Driven in node the way the other worker suites drive it: the dedicated worker is
 * `serveIndexerHost` over a `MessageChannel` (which is what
 * `hostIndexerInThisWorker` calls over the worker's own scope), and the SharedWorker
 * is `hostIndexerInThisSharedWorker` over a scope made to look like one. "Another
 * worker" serving a provider is a second `MessageChannel` whose one end is served
 * with `serveProvider` and whose other end the tab hands over: the same
 * structured-clone boundary a `webevm` worker would put between the two.
 */

let counter = 0;
const freshName = () => `worker-tab-provider-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

const CONFIG = {stream: {finality: FINALITY}};
const STREAM_CONFIG = resolveStreamConfig(CONFIG.stream);
const THIS_STREAM = streamDigestOf(SOURCE, STREAM_CONFIG);
const PROCESSOR = identityOf('worker-tab-provider-app');
const INDEX = 'https://publications.example/app/publication.json';

const hex = (value: number) => `0x${value.toString(16)}`;
const numberOf = (value: string) => parseInt(value.slice(2), 16);

/** The time every measurement reads, moved only by a node's answers below. */
let now = 0;
beforeEach(() => {
	now = 0;
	vi.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

type Request = {method: string; params?: any};
type Provider = {request(args: Request): Promise<any>};

/**
 * A node over `branch` that REFUSES the way real ones do, recording every
 * `eth_getLogs` range it was asked for:
 *
 * - `spanLimit`: a range wider than this is refused with Infura's structured hint
 *   (`-32005`, `data: {from, to, limit}`), naming the `to` it would serve, or
 *   with the bare code where `withoutHint` says so;
 * - `servesFrom`: a range starting below this is refused as an archive refusal;
 * - `msPerRequest`: what each `eth_getLogs` costs on the clock.
 */
function node(
	branch: readonly RawLog[] = BRANCH_A,
	tip: number = BRANCH_A_TIP,
	options: {spanLimit?: number; withoutHint?: boolean; servesFrom?: number; msPerRequest?: number} = {},
) {
	const chain = fakeChain(branch, tip);
	const asked: {from: number; to: number; refused?: 'range' | 'archive'}[] = [];
	const provider: Provider = {
		async request(args) {
			if (args.method === 'eth_getLogs') {
				now += options.msPerRequest ?? 0;
				const from = numberOf(args.params[0].fromBlock);
				const to = numberOf(args.params[0].toBlock);
				if (options.servesFrom !== undefined && from < options.servesFrom) {
					asked.push({from, to, refused: 'archive'});
					throw Object.assign(new Error('invalid params'), {
						code: -32602,
						data: 'historical state is not available: archive access is not enabled on this plan',
					});
				}
				if (options.spanLimit !== undefined && to - from + 1 > options.spanLimit) {
					asked.push({from, to, refused: 'range'});
					throw Object.assign(new Error('query exceeds the block range limit'), {
						code: -32005,
						...(options.withoutHint
							? {}
							: {data: {from: hex(from), to: hex(from + options.spanLimit - 1), limit: 10000}}),
					});
				}
				asked.push({from, to});
			}
			return chain.provider.request(args);
		},
	};
	return {provider, asked, calls: chain.calls};
}

/** A provider served in ANOTHER context (a `webevm` worker, say): the port the tab hands over. */
function servedElsewhere(provider: Provider): {port: MessagePort; close: () => void} {
	const channel = new MessageChannel();
	const served = serveProvider(provider, channel.port1);
	return {
		port: channel.port2,
		close() {
			served.close();
			channel.port1.close();
		},
	};
}

/**
 * THE APP'S WORKER ENTRY: code, and whatever else `entry` puts in it. No provider
 * and no source unless a case gives one, so the host waits for the tab.
 */
function entrySpec(
	definition: EntityProcessor<TestABI>,
	databaseName: string,
	entry: Partial<HostedIndexerSpec<TestABI, EntityStateView>> = {},
	handed: string[] = [],
): HostedIndexerSpec<TestABI, EntityStateView> {
	return {
		createState: async (_context, {signal}, _bundle, published) => {
			handed.push(published ? `snapshot@${published.replaceLocal ? 'replace' : 'keep'}` : 'nothing');
			const backend = await createBrowserStateStore(definition.entities, {databaseName});
			const {store} = await openAndBootstrap(backend, published?.locations ?? [], {
				processor: published?.processor ?? 'no-snapshot-was-handed',
				finalityDepth: FINALITY,
				replaceLocal: published?.replaceLocal,
			});
			return openForWriting(store, {signal});
		},
		createProcessor: (state) => new EntityEventProcessor<TestABI>(state, definition),
		processorIdentity: PROCESSOR,
		tipIntervalInSeconds: 0.02,
		...entry,
	};
}

/** A DEDICATED-worker host over `spec`, and the tab's port to it, connecting with `connect`. */
function dedicatedTab(spec: HostedIndexerSpec<TestABI, EntityStateView>, connect: IndexerConnectOptions = {}) {
	const ends = wire();
	const outcomes: ConnectOutcome[] = [];
	const host = serveIndexerHost(spec, ends.host);
	const port = connectToIndexerHost(ends.tab, {
		...connect,
		onConnect: (outcome) => outcomes.push(outcome),
	});
	return {
		host,
		port,
		outcomes,
		dispose() {
			host.dispose();
			port.close();
			ends.close();
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

async function untilTip(port: IndexerPort, tip: number): Promise<HostProgress> {
	const progress = await until(port, (p) => p.latestBlock === tip && p.lastToBlock === tip && p.phase === 'at-tip');
	if (progress.failure) throw new Error(`the host stopped: ${progress.failure.name}: ${progress.failure.message}`);
	return progress;
}

async function untilOutcome(outcomes: ConnectOutcome[]): Promise<ConnectOutcome> {
	for (let attempt = 0; attempt < 500 && outcomes.length === 0; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	expect(outcomes).toHaveLength(1);
	return outcomes[0];
}

/** What was applied, read ACROSS THE PORT, with how many times each was. */
async function appliedAcross(port: IndexerPort): Promise<{key: string; times: number}[]> {
	const listing = await port.reads.listCurrent('applied', {bucket: 'all'}, 500);
	return listing.rows.map((row) => ({key: String(row.key), times: Number(row.times)}));
}

async function foldedOnceEach(port: IndexerPort, events: number): Promise<void> {
	const applied = await appliedAcross(port);
	expect(applied).toHaveLength(events);
	expect(applied.map((row) => row.times)).toEqual(applied.map(() => 1));
}

// ---------------------------------------------------------------------------
// THE PROVIDER CROSSES AS A PORT
// ---------------------------------------------------------------------------

describe('a dedicated-worker host whose entry builds no provider', () => {
	it('WAITS, asking the chain nothing, until a tab hands it a provider and a source', async () => {
		const chain = node();
		const elsewhere = servedElsewhere(chain.provider);
		const ends = wire();
		const host = serveIndexerHost(entrySpec(applyingProcessor(), freshName()), ends.host);
		try {
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(host.progress()).toMatchObject({phase: 'waiting', indexing: true});
			expect(chain.calls).toEqual([]);

			const port = connectToIndexerHost(ends.tab, {
				provider: elsewhere.port,
				settings: {source: SOURCE, config: CONFIG},
			});
			await untilTip(port, BRANCH_A_TIP);
			await foldedOnceEach(port, BRANCH_A.length);
			port.close();
		} finally {
			host.dispose();
			ends.close();
			elsewhere.close();
		}
	});

	it('folds through a port served from ANOTHER context, with no provider built in the entry', async () => {
		const chain = node();
		const elsewhere = servedElsewhere(chain.provider);
		const tab = dedicatedTab(entrySpec(applyingProcessor(), freshName()), {
			provider: elsewhere.port,
			settings: {source: SOURCE, config: CONFIG},
		});
		try {
			await untilTip(tab.port, BRANCH_A_TIP);
			await foldedOnceEach(tab.port, BRANCH_A.length);
			expect(chain.asked[0].from).toBe(START_BLOCK);
			expect(await untilOutcome(tab.outcomes)).toMatchObject({accepted: true});
		} finally {
			tab.dispose();
			elsewhere.close();
		}
	});

	it('folds through a provider OBJECT the tab hands over (a wallet), served on a fresh channel by the port', async () => {
		const chain = node();
		const tab = dedicatedTab(entrySpec(applyingProcessor(), freshName()), {
			provider: chain.provider,
			settings: {source: SOURCE, config: CONFIG},
		});
		try {
			await untilTip(tab.port, BRANCH_A_TIP);
			await foldedOnceEach(tab.port, BRANCH_A.length);
			expect(chain.asked[0].from).toBe(START_BLOCK);
		} finally {
			tab.dispose();
		}
	});

	/**
	 * THE SAME REFUSALS, READ THE SAME WAY. What the fetcher does with a refusal is
	 * read from its `code` and its `data` (`getNewToBlockFromError`,
	 * `archiveRefusalFromError`), so each case runs twice, once with the provider
	 * built in the entry and once handed over as a port, and compares what the node
	 * was ASKED: a hint lost on the way across would show as a different range.
	 */
	async function askedBy(handedOver: boolean, options: Parameters<typeof node>[2]) {
		const chain = node(BRANCH_A, BRANCH_A_TIP, options);
		const elsewhere = servedElsewhere(chain.provider);
		const spec = entrySpec(
			applyingProcessor(),
			freshName(),
			handedOver ? {} : {provider: chain.provider as never, source: SOURCE, config: CONFIG},
		);
		const tab = dedicatedTab(
			spec,
			handedOver ? {provider: elsewhere.port, settings: {source: SOURCE, config: CONFIG}} : {},
		);
		try {
			const progress = await until(tab.port, (p) => p.latestBlock === BRANCH_A_TIP && p.phase === 'at-tip');
			return {progress, asked: chain.asked, applied: await appliedAcross(tab.port).catch(() => [])};
		} finally {
			tab.dispose();
			elsewhere.close();
		}
	}

	it('reads a RANGE HINT in `error.data` across the port exactly as from a local provider', async () => {
		const local = await askedBy(false, {spanLimit: 5});
		const across = await askedBy(true, {spanLimit: 5});
		// the node refused, and the fetcher asked next for exactly the `to` it was told
		// The same refusal with its `data` stripped, which the fetcher can only halve at:
		// the range asked next DIFFERS, so what `across` asked next was read from the hint.
		const unhinted = await askedBy(true, {spanLimit: 5, withoutHint: true});
		const refusal = across.asked.findIndex((range) => range.refused === 'range');
		expect(refusal).toBeGreaterThanOrEqual(0);
		expect(across.asked[refusal + 1]).not.toEqual(unhinted.asked[refusal + 1]);
		expect(across.asked).toEqual(local.asked);
		expect(across.progress.failure).toBeUndefined();
		expect(across.applied).toEqual(local.applied);
		expect(across.applied).toHaveLength(BRANCH_A.length);
	});

	it('reads an ARCHIVE REFUSAL across the port exactly as from a local provider', async () => {
		const local = await askedBy(false, {servesFrom: START_BLOCK + 2});
		const across = await askedBy(true, {servesFrom: START_BLOCK + 2});
		expect(local.progress.phase).toBe('refused');
		expect(across.progress.phase).toBe('refused');
		expect(across.progress.failure?.name).toBe('ArchiveRefusedError');
		expect(across.progress.failure?.name).toBe(local.progress.failure?.name);
		expect(across.asked).toEqual(local.asked);
	});
});

// ---------------------------------------------------------------------------
// THE SETTINGS COME WITH THE CONNECTION
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

/** A publisher indexes to `tip` and publishes what it computed. */
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

/** `publication.json` naming `snapshot`, served by a `fetch` that records what it was asked for. */
function publication(snapshot: StateSnapshot) {
	const processor = snapshot.head.processor;
	const contentHash = `sha256:${createHash('sha256').update(snapshot.document).digest('hex')}`;
	const name = `state-${contentHash.slice('sha256:'.length)}.ndjson.gz`;
	const snapshots: Record<string, PublishedStateSnapshot> = {
		[generationDigestOf({stream: THIS_STREAM, processor})]: {
			stream: THIS_STREAM,
			processor,
			body: name,
			contentHash,
			takenAt: snapshot.head.takenAt,
			floor: snapshot.head.floor,
			cut: snapshot.head.takenAt.number,
			savedAt: snapshot.head.savedAt,
		},
	};
	const body = `https://publications.example/app/${name}`;
	const index: PublicationIndex = {format: PUBLICATION_INDEX_FORMAT, snapshots};
	const routes: Record<string, Uint8Array> = {
		[INDEX]: new TextEncoder().encode(JSON.stringify(index)),
		[body]: snapshot.document,
	};
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

/** A tab that visited once and got to `at`: its database is what a return opens. */
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
	await indexToTip(first as never);
	first.dispose();
	return databaseName;
}

describe('settings a tab sends when it connects', () => {
	const LOCAL_AT = 101;
	const SNAPSHOT_AT = 104;
	const SMALL_RANGES = FINALITY + 1;

	it('take effect: the PUBLICATION the tab names is used, and the BUDGET it sends is the one applied', async () => {
		const definition = applyingProcessor();
		const databaseName = await visitedUpTo(definition, LOCAL_AT);
		const published = publication(await publishedSnapshot(definition, SNAPSHOT_AT));
		// The index is fetched by the HOST, where a `fetch` cannot be sent to: the
		// global one, which is what a worker has.
		vi.stubGlobal('fetch', published.get);
		const chain = node(BRANCH_A_LATER, BRANCH_A_LATER_TIP, {msPerRequest: 60_000});
		const handed: string[] = [];
		const budget = 90;
		const tab = dedicatedTab(entrySpec(definition, databaseName, {}, handed), {
			provider: chain.provider,
			settings: {
				source: SOURCE,
				config: {...CONFIG, fetch: {maxBlocksPerFetch: SMALL_RANGES}},
				publication: {locations: [INDEX]},
				catchUpWithinSeconds: budget,
			},
		});
		try {
			const progress = await untilTip(tab.port, BRANCH_A_LATER_TIP);
			expect(progress.publication).toMatchObject({
				status: 'switched',
				reason: 'over-budget',
				from: INDEX,
				snapshot: published.body,
				at: SNAPSHOT_AT,
				budgetSeconds: budget,
			});
			expect(handed).toEqual(['snapshot@keep', 'snapshot@replace']);
			expect(published.asked).toEqual([INDEX, published.body]);
			await foldedOnceEach(tab.port, BRANCH_A_LATER.length);
		} finally {
			tab.dispose();
		}
	});

	it('the budget the tab sends decides, where the default would have decided otherwise', async () => {
		const definition = applyingProcessor();
		const databaseName = await visitedUpTo(definition, LOCAL_AT);
		const published = publication(await publishedSnapshot(definition, SNAPSHOT_AT));
		vi.stubGlobal('fetch', published.get);
		const chain = node(BRANCH_A_LATER, BRANCH_A_LATER_TIP, {msPerRequest: 60_000});
		const tab = dedicatedTab(entrySpec(definition, databaseName), {
			provider: chain.provider,
			settings: {
				source: SOURCE,
				config: {...CONFIG, fetch: {maxBlocksPerFetch: SMALL_RANGES}},
				publication: {locations: [INDEX]},
				catchUpWithinSeconds: 'always',
			},
		});
		try {
			const progress = await untilTip(tab.port, BRANCH_A_LATER_TIP);
			// the same node and the same publication as above switch under the default
			expect(progress.publication).toMatchObject({status: 'found'});
			expect(published.asked).toEqual([INDEX]);
		} finally {
			tab.dispose();
		}
	});

	it('are refused NAMING THE FIELD where they disagree with the entry, and the host folds what the entry said', async () => {
		const chain = node();
		const tab = dedicatedTab(
			entrySpec(applyingProcessor(), freshName(), {provider: chain.provider as never, source: SOURCE, config: CONFIG}),
			{settings: {source: SOURCE_V2 as unknown as HostSettings['source']}},
		);
		try {
			const outcome = await untilOutcome(tab.outcomes);
			expect(outcome.accepted).toBe(false);
			const error = (outcome as {error: Error & {fields?: string[]}}).error;
			expect(error.name).toBe('HostSettingsConflictError');
			expect(error.fields).toEqual(['source']);
			await untilTip(tab.port, BRANCH_A_TIP);
			await foldedOnceEach(tab.port, BRANCH_A.length);
		} finally {
			tab.dispose();
		}
	});

	it('are accepted where they AGREE with the entry, and a setting the tab leaves out agrees with anything', async () => {
		const chain = node();
		const tab = dedicatedTab(entrySpec(applyingProcessor(), freshName(), {source: SOURCE, config: CONFIG}), {
			provider: chain.provider,
			settings: {source: SOURCE},
		});
		try {
			expect(await untilOutcome(tab.outcomes)).toMatchObject({accepted: true});
			await untilTip(tab.port, BRANCH_A_TIP);
		} finally {
			tab.dispose();
		}
	});

	it('refuse a setting the host STARTED WITHOUT, since it could not take effect', async () => {
		const chain = node();
		const tab = dedicatedTab(
			entrySpec(applyingProcessor(), freshName(), {provider: chain.provider as never, source: SOURCE, config: CONFIG}),
			{settings: {catchUpWithinSeconds: 30}},
		);
		try {
			const outcome = await untilOutcome(tab.outcomes);
			expect(outcome.accepted).toBe(false);
			expect((outcome as {error: {fields?: string[]}}).error.fields).toEqual(['catchUpWithinSeconds']);
		} finally {
			tab.dispose();
		}
	});

	it('refuse a PROVIDER where the entry built one, and fold through the entry\u2019s', async () => {
		const entryChain = node();
		const tabChain = node();
		const tab = dedicatedTab(
			entrySpec(applyingProcessor(), freshName(), {
				provider: entryChain.provider as never,
				source: SOURCE,
				config: CONFIG,
			}),
			{provider: tabChain.provider},
		);
		try {
			const outcome = await untilOutcome(tab.outcomes);
			expect(outcome.accepted).toBe(false);
			expect((outcome as {error: {fields?: string[]}}).error.fields).toEqual(['provider']);
			await untilTip(tab.port, BRANCH_A_TIP);
			expect(tabChain.calls).toEqual([]);
		} finally {
			tab.dispose();
		}
	});

	it('are refused by a MAIN-THREAD host, which takes its provider and settings from `init`', async () => {
		const definition = applyingProcessor();
		const databaseName = freshName();
		const indexer = createIndexerState<TestABI, EntityStateView>({
			createState: async () => openForWriting(await createBrowserStateStore(definition.entities, {databaseName})),
			createProcessor: (state) => new EntityEventProcessor<TestABI>(state, definition),
			processorIdentity: PROCESSOR,
		});
		await indexer.init({provider: node().provider as never, source: SOURCE, config: CONFIG});
		const outcomes: ConnectOutcome[] = [];
		const port = connectToIndexerHost(indexer.mainThreadHost(), {
			watch: false,
			settings: {source: SOURCE},
			onConnect: (outcome) => outcomes.push(outcome),
		});
		try {
			const outcome = await untilOutcome(outcomes);
			expect(outcome.accepted).toBe(false);
			expect((outcome as {error: Error}).error.message).toMatch(/init/);
			// and the port goes on answering as it always did
			expect((await port.progress()).host).toBe('main-thread');
		} finally {
			port.close();
			indexer.dispose();
		}
	});

	it('refuse a value that cannot cross, naming it, before anything is sent', async () => {
		const tab = dedicatedTab(entrySpec(applyingProcessor(), freshName()), {
			provider: node().provider,
			settings: {source: SOURCE, publication: {locations: [INDEX], fetch: globalThis.fetch}},
		});
		try {
			const outcome = await untilOutcome(tab.outcomes);
			expect(outcome.accepted).toBe(false);
			expect((outcome as {error: Error}).error.message).toMatch(/publication\.fetch/);
			expect((await tab.port.progress()).phase).toBe('waiting');
		} finally {
			tab.dispose();
		}
	});
});

// ---------------------------------------------------------------------------
// A SHAREDWORKER HOST, TWO TABS, AND THE ONE WHOSE PROVIDER IT USES GOES AWAY
// ---------------------------------------------------------------------------

describe('a SharedWorker host with two tabs that each hand over a provider', () => {
	it('keeps folding when the tab whose provider it uses goes away, through the other tab\u2019s', async () => {
		const scope = sharedWorkerScope();
		const host = hostIndexerInThisSharedWorker(
			entrySpec(applyingProcessor(), freshName(), {config: {...CONFIG, fetch: {maxBlocksPerFetch: 4}}}),
		);
		// The FIRST tab's node answers up to block 103 and then never again: its tab is
		// about to go away with a request in the air.
		const firstChain = node();
		const hanging: Provider = {
			async request(args) {
				if (args.method === 'eth_getLogs' && numberOf(args.params[0].toBlock) > 103) {
					return new Promise(() => undefined);
				}
				return firstChain.provider.request(args);
			},
		};
		const secondChain = node();
		const settings: HostSettings = {source: SOURCE};

		function attach(provider: Provider) {
			const channel = new MessageChannel();
			scope.connect(channel.port1 as unknown as MessageEndpoint);
			const outcomes: ConnectOutcome[] = [];
			const port = connectToIndexerHost(
				{
					host: 'shared-worker',
					endpoint: channel.port2 as unknown as MessageEndpoint,
					close: () => channel.port2.close(),
				},
				{provider, settings, watch: false, onConnect: (outcome) => outcomes.push(outcome)},
			);
			return {port, outcomes, channel};
		}

		const first = attach(hanging);
		const second = attach(secondChain.provider);
		try {
			expect(await untilOutcome(first.outcomes)).toMatchObject({accepted: true});
			expect(await untilOutcome(second.outcomes)).toMatchObject({accepted: true});
			// Folded through the FIRST tab's provider, up to where it hangs.
			const held = await until(second.port, (progress) => progress.lastToBlock === 103);
			expect(held.failure).toBeUndefined();
			expect(firstChain.asked.length).toBeGreaterThan(0);
			expect(secondChain.asked).toEqual([]);

			// The first tab goes away, as a closed document does: its wire closes, with
			// no goodbye said over it.
			first.channel.port2.close();

			const progress = await untilTip(second.port, BRANCH_A_TIP);
			expect(progress.indexing).toBe(true);
			// the rest came through the SECOND tab's provider, starting where the first hung
			expect(secondChain.asked[0].from).toBeGreaterThan(START_BLOCK);
			await foldedOnceEach(second.port, BRANCH_A.length);
		} finally {
			host.dispose();
			second.port.close();
			first.port.close();
			second.channel.port1.close();
			scope.restore();
		}
	});
});
