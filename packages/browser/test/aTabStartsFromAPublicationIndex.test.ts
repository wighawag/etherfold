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
	STREAM_SEED_FORMAT,
	PUBLICATION_INDEX_FORMAT,
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
import {describe, expect, it} from 'vitest';
import {
	createBrowserStateStore,
	createIndexerState,
	keepStreamOnIndexedDB,
	type BrowserPublicationOptions,
	type PublicationSnapshot,
} from '../src/index.js';
import {
	BRANCH_A,
	BRANCH_A_TIP,
	fakeChain,
	FINALITY,
	indexToTip,
	SOURCE,
	SOURCE_V2,
	START_BLOCK,
	timestampOf,
	type TestABI,
} from '../browser/workload.js';
import {appliedIn, applyingProcessor} from './utils/applied.js';
import {identityOf} from './utils/processorIdentity.js';

/**
 * A TAB STARTS FROM A PUBLICATION INDEX (ADR-0095).
 *
 * The browser half of what `etherfold publish` writes: ONE `publication` option
 * names where `publication.json` is (a list, failed over between), the hook reads
 * it and hands `createState` the STATE SNAPSHOT entry for its own GENERATION -- its
 * stream digest AND its processor identity -- and the app starts from it through
 * the existing bootstrap (`openAndBootstrap`, the snapshot-only mode, exactly as
 * `snapshotOnlyMode.test.ts` wires it). The stream seed the index lists is installed
 * only when asked.
 *
 * The index document is `@etherfold/core`'s `PublicationIndex`, the one type the
 * producer (`producePublication`, `@etherfold/server`) writes, so what this file
 * serves is typed by the contract rather than restated beside it. The bodies are a
 * browser-side publisher's (`createSnapshot` over a tab that indexed the same
 * chain), because what is under test is the SELECTION and the start, and a
 * publisher whose cursor context is an ordinary run's is what makes "the state is
 * kept across the first load" a claim about the index and not about a producer.
 *
 * Every case asserts on the REQUESTS made, because two of the claims are about
 * what is NOT downloaded: nothing beyond the index for an entry this tab cannot
 * use, and no seed unless one was asked for.
 */

let counter = 0;
const freshName = () => `publication-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

const CONFIG = {stream: {finality: FINALITY}};
const STREAM_CONFIG = resolveStreamConfig(CONFIG.stream);

/** The stream every tab here folds, and one it does not: another source, as another deployment's contracts. */
const THIS_STREAM = streamDigestOf(SOURCE, STREAM_CONFIG);
const OTHER_STREAM = streamDigestOf(SOURCE_V2, STREAM_CONFIG);
/** The same contracts under another finality: another stream as well, and the other way a publisher differs. */
const OTHER_FINALITY_STREAM = streamDigestOf(SOURCE, resolveStreamConfig({finality: FINALITY + 9}));

/** The processor this app ships now, and the one an OLD build of it still runs. */
const NEW_PROCESSOR = identityOf('publication-app-v2');
const OLD_PROCESSOR = identityOf('publication-app-v1');

/**
 * Where the publication is served. The second is a mirror of the same directory
 * and the third a build-embedded, hostless copy, which is what the bodies are
 * resolved relative to.
 */
const INDEX = 'https://publications.example/app/publication.json';
const MIRROR = 'https://mirror.example/app/publication.json';

// ---------------------------------------------------------------------------
// A PUBLISHER, and what it puts on a host
// ---------------------------------------------------------------------------

/** The LIVE rows of the `applied` entity, as the upserts that reproduce them (see `snapshotOnlyMode.test.ts`). */
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

/**
 * A publisher tab indexes to `tip` and publishes what it computed, labelled with
 * `processor` and taken `FINALITY` behind the tip it had observed (the cut rule,
 * ADR-0095), so a consumer's reorg-window check admits it.
 */
async function publishedSnapshot(
	definition: EntityProcessor<TestABI>,
	options: {tip: number; processor: string},
): Promise<StateSnapshot> {
	const store = await openForWriting(await createBrowserStateStore(definition.entities, {databaseName: freshName()}));
	const indexer = createIndexerState<TestABI, EntityStateView>({
		createState: () => store,
		createProcessor: (state) => new EntityEventProcessor<TestABI>(state, definition),
		// the fold the publisher ran IS the processor the snapshot is labelled with, as
		// `producePublication` labels it with the canonical generation's own identity
		processorIdentity: options.processor,
	});
	await indexer.init({provider: fakeChain(BRANCH_A, options.tip).provider, source: SOURCE, config: CONFIG});
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
		lastSync: {...lastSync, latestBlock: options.tip + FINALITY},
		processor: options.processor,
	});
}

/** `sha256:<hex>` over the decompressed document, as the producer labels a body (ADR-0066). */
async function contentHashOf(gzipped: Uint8Array): Promise<string> {
	const plain = await new Response(
		new Blob([gzipped as Uint8Array<ArrayBuffer>])
			.stream()
			.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>),
	).arrayBuffer();
	return `sha256:${createHash('sha256').update(new Uint8Array(plain)).digest('hex')}`;
}

/** The index entry for one published snapshot, named as the producer names its bodies. */
async function entryFor(snapshot: StateSnapshot, stream: string): Promise<PublishedStateSnapshot> {
	const contentHash = await contentHashOf(snapshot.document);
	return {
		stream,
		processor: snapshot.head.processor,
		body: `state-${contentHash.slice('sha256:'.length)}.ndjson.gz`,
		contentHash,
		takenAt: snapshot.head.takenAt,
		floor: snapshot.head.floor,
		cut: snapshot.head.takenAt.number,
		savedAt: snapshot.head.savedAt,
	};
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
			name: 'packages/browser/test/aTabStartsFromAPublicationIndex.test.ts',
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

type Published = {
	snapshots?: {snapshot: StateSnapshot; stream: string}[];
	seed?: StreamSeed;
};

/**
 * A publication directory: `publication.json` and every body it names, under the
 * directory of `at`. Answers the routes, plus whatever `extra` adds.
 */
async function publicationAt(at: string, published: Published) {
	const dir = at.slice(0, at.lastIndexOf('/') + 1);
	const routes: Record<string, Uint8Array> = {};
	const snapshots: Record<string, PublishedStateSnapshot> = {};
	for (const {snapshot, stream} of published.snapshots ?? []) {
		const entry = await entryFor(snapshot, stream);
		snapshots[generationDigestOf({stream, processor: entry.processor})] = entry;
		routes[`${dir}${entry.body}`] = snapshot.document;
	}
	let seeds: PublicationIndex['seeds'];
	if (published.seed) {
		const payload = streamSeedPayloadOf(published.seed);
		const contentHash = streamSeedContentHash(payload);
		const body = `seed-${contentHash.slice('sha256:'.length)}.json.gz`;
		routes[`${dir}${body}`] = payload;
		seeds = {
			[published.seed.streamDigest]: {
				stream: published.seed.streamDigest,
				body,
				contentHash,
				coverage: published.seed.coverage,
				events: published.seed.eventStream.length,
				savedAt: '2026-09-27T00:00:00.000Z',
			},
		};
	}
	const index: PublicationIndex = {format: PUBLICATION_INDEX_FORMAT, snapshots, ...(seeds ? {seeds} : {})};
	routes[at] = new TextEncoder().encode(JSON.stringify(index));
	return {routes, index};
}

/** A host serving a routing table, recording every URL asked for. A route may be an error: the host did not answer. */
function servingFetch(routes: Record<string, Uint8Array | Error>) {
	const asked: string[] = [];
	const get = (async (input: unknown) => {
		const url = String(input);
		asked.push(url);
		const served = routes[url];
		if (served === undefined) return new Response('not found', {status: 404, statusText: 'Not Found'});
		if (served instanceof Error) throw served;
		return new Response(new Uint8Array(served), {status: 200});
	}) as typeof globalThis.fetch;
	return {asked, get};
}

// ---------------------------------------------------------------------------
// THE TAB
// ---------------------------------------------------------------------------

/**
 * The tab an app writes: the hook pointed at the publication, and a `createState`
 * that starts from what it is handed through the EXISTING bootstrap, recording
 * what it was handed and what the bootstrap did.
 */
function tabOf(options: {
	definition: EntityProcessor<TestABI>;
	processor?: string;
	publication: BrowserPublicationOptions;
	keepStream?: string;
}) {
	const databaseName = freshName();
	const handed: (PublicationSnapshot | undefined)[] = [];
	const outcomes: BootstrapOutcome[] = [];
	const indexer = createIndexerState<TestABI, EntityStateView>(
		{
			createState: async (_context, {signal}, _bundle, published) => {
				handed.push(published);
				const backend = await createBrowserStateStore(options.definition.entities, {databaseName});
				const {store, outcome} = await openAndBootstrap(backend, published?.locations ?? [], {
					processor: published?.processor ?? 'no-snapshot-was-handed',
					finalityDepth: FINALITY,
					...(options.publication.fetch ? {fetch: options.publication.fetch} : {}),
				});
				outcomes.push(outcome);
				return openForWriting(store, {signal});
			},
			createProcessor: (state) => new EntityEventProcessor<TestABI>(state, options.definition),
			...(options.processor ? {processorIdentity: options.processor} : {}),
		},
		{
			publication: options.publication,
			...(options.keepStream ? {keepStream: keepStreamOnIndexedDB<TestABI>(options.keepStream)} : {}),
		},
	);
	return {indexer, handed, outcomes};
}

/** What the tab's syncing store says the publication gave it. */
function publicationOf(tab: ReturnType<typeof tabOf>) {
	return tab.indexer.syncing.$state.publication;
}

describe('a tab starts from a publication index', () => {
	it('starts from its OWN generation\u2019s snapshot, keeps it across the first load, and fetches no seed by default', async () => {
		const definition = applyingProcessor();
		const snapshot = await publishedSnapshot(definition, {tip: 102, processor: NEW_PROCESSOR});
		const {routes, index} = await publicationAt(INDEX, {
			snapshots: [{snapshot, stream: THIS_STREAM}],
			// LISTED, and not asked for: it must not be fetched
			seed: await publishedSeed(),
		});
		const host = servingFetch(routes);
		const tab = tabOf({definition, processor: NEW_PROCESSOR, publication: {locations: [INDEX], fetch: host.get}});

		const chain = fakeChain(BRANCH_A, BRANCH_A_TIP);
		await tab.indexer.init({provider: chain.provider, source: SOURCE, config: CONFIG});
		const body = `https://publications.example/app/${Object.values(index.snapshots)[0].body}`;

		expect(tab.handed).toEqual([
			{locations: [body], processor: NEW_PROCESSOR, entry: Object.values(index.snapshots)[0], index: INDEX},
		]);
		expect(tab.outcomes).toEqual([{status: 'bootstrapped', at: 102, from: body}]);
		expect(publicationOf(tab)).toEqual({status: 'found', from: INDEX, snapshot: body, at: 102});

		await indexToTip(tab.indexer as never);
		const applied = await appliedIn(tab.indexer.state.$state);
		const registered = tab.indexer.canonical?.record;
		tab.indexer.dispose();

		// registered under the generation the entry was chosen for
		expect(registered).toMatchObject({stream: THIS_STREAM, processor: NEW_PROCESSOR});
		// the whole branch, each event exactly once: the snapshot's rows plus the ones
		// indexed on top of them
		expect(applied).toHaveLength(BRANCH_A.length);
		expect(applied.map((row) => row.times)).toEqual(applied.map(() => 1));
		// KEPT across the first load: the fold resumed from the snapshot's cursor (the
		// reorg window below the tip its publisher observed), where a load that discarded
		// it as another processor or another stream would have asked from the start block
		expect(chain.ranges[0].from).toBe(102);
		expect(chain.ranges[0].from).toBeGreaterThan(START_BLOCK);
		// the index and the snapshot, and no seed although the index lists one
		expect(host.asked).toEqual([INDEX, body]);
	});

	it('starts an OLD build from its own, older entry, never from the newer processor\u2019s', async () => {
		const definition = applyingProcessor();
		const older = await publishedSnapshot(definition, {tip: 102, processor: OLD_PROCESSOR});
		const newer = await publishedSnapshot(definition, {tip: 104, processor: NEW_PROCESSOR});
		const {routes, index} = await publicationAt(INDEX, {
			snapshots: [
				{snapshot: older, stream: THIS_STREAM},
				{snapshot: newer, stream: THIS_STREAM},
			],
		});
		const host = servingFetch(routes);
		const tab = tabOf({definition, processor: OLD_PROCESSOR, publication: {locations: INDEX, fetch: host.get}});

		const chain = fakeChain(BRANCH_A, BRANCH_A_TIP);
		await tab.indexer.init({provider: chain.provider, source: SOURCE, config: CONFIG});
		const olderEntry = index.snapshots[generationDigestOf({stream: THIS_STREAM, processor: OLD_PROCESSOR})];
		const olderBody = `https://publications.example/app/${olderEntry.body}`;

		expect(tab.handed.map((handed) => handed?.entry)).toEqual([olderEntry]);
		expect(tab.outcomes).toEqual([{status: 'bootstrapped', at: 102, from: olderBody}]);
		expect(host.asked).toEqual([INDEX, olderBody]);

		// and it indexes forward from its own, staler cursor to the same state
		await indexToTip(tab.indexer as never);
		const applied = await appliedIn(tab.indexer.state.$state);
		const registered = tab.indexer.canonical?.record.processor;
		tab.indexer.dispose();
		expect(registered).toBe(OLD_PROCESSOR);
		expect(chain.ranges[0].from).toBe(102);
		expect(applied).toHaveLength(BRANCH_A.length);
		expect(applied.map((row) => row.times)).toEqual(applied.map(() => 1));
	});

	it.each([
		['another source (the publisher\u2019s contracts differ)', OTHER_STREAM],
		['another finality', OTHER_FINALITY_STREAM],
	])(
		'REFUSES by name an entry for this processor over %s, and downloads nothing beyond the index',
		async (_, otherStream) => {
			const definition = applyingProcessor();
			const snapshot = await publishedSnapshot(definition, {tip: 102, processor: NEW_PROCESSOR});
			const {routes} = await publicationAt(INDEX, {snapshots: [{snapshot, stream: otherStream}]});
			const host = servingFetch(routes);
			const tab = tabOf({definition, processor: NEW_PROCESSOR, publication: {locations: [INDEX], fetch: host.get}});

			const chain = fakeChain(BRANCH_A, BRANCH_A_TIP);
			await tab.indexer.init({provider: chain.provider, source: SOURCE, config: CONFIG});

			expect(publicationOf(tab)).toEqual({
				status: 'refused',
				reason: 'stream-mismatch',
				from: INDEX,
				streams: [otherStream],
			});
			expect(tab.handed).toEqual([undefined]);
			expect(host.asked).toEqual([INDEX]);

			// nothing installed, so it indexes from the chain as it would with no snapshot
			await indexToTip(tab.indexer as never);
			const applied = await appliedIn(tab.indexer.state.$state);
			tab.indexer.dispose();
			expect(chain.ranges[0].from).toBe(START_BLOCK);
			expect(applied).toHaveLength(BRANCH_A.length);
		},
	);

	it('installs the seed the index lists for its stream when the app ASKS for it', async () => {
		const definition = applyingProcessor();
		const snapshot = await publishedSnapshot(definition, {tip: 102, processor: NEW_PROCESSOR});
		const seed = await publishedSeed();
		const {routes, index} = await publicationAt(INDEX, {snapshots: [{snapshot, stream: THIS_STREAM}], seed});
		const host = servingFetch(routes);
		const keeper = freshName();
		const tab = tabOf({
			definition,
			processor: NEW_PROCESSOR,
			publication: {locations: [INDEX], fetch: host.get, seed: true},
			keepStream: keeper,
		});

		await tab.indexer.init({provider: fakeChain(BRANCH_A, BRANCH_A_TIP).provider, source: SOURCE, config: CONFIG});
		const seedBody = `https://publications.example/app/${index.seeds?.[THIS_STREAM].body}`;
		const streamSeed = tab.indexer.syncing.$state.streamSeed;
		tab.indexer.dispose();

		// the seed's own stream digest IS this tab's: the index is keyed by what the tab computes
		expect(seed.streamDigest).toBe(THIS_STREAM);
		expect(streamSeed).toMatchObject({status: 'seeded', from: seedBody, at: seed.coverage.toBlock});
		expect(host.asked).toContain(seedBody);
		expect(tab.outcomes).toMatchObject([{status: 'bootstrapped', at: 102}]);
	});

	it('reports NO ENTRY for this generation, and indexes from the chain', async () => {
		const definition = applyingProcessor();
		// published for ANOTHER processor only
		const snapshot = await publishedSnapshot(definition, {tip: 102, processor: OLD_PROCESSOR});
		const {routes} = await publicationAt(INDEX, {snapshots: [{snapshot, stream: THIS_STREAM}]});
		const host = servingFetch(routes);
		const tab = tabOf({definition, processor: NEW_PROCESSOR, publication: {locations: [INDEX], fetch: host.get}});

		const chain = fakeChain(BRANCH_A, BRANCH_A_TIP);
		await tab.indexer.init({provider: chain.provider, source: SOURCE, config: CONFIG});
		expect(publicationOf(tab)).toEqual({status: 'refused', reason: 'no-entry', from: INDEX});
		expect(tab.handed).toEqual([undefined]);
		expect(host.asked).toEqual([INDEX]);

		await indexToTip(tab.indexer as never);
		const applied = await appliedIn(tab.indexer.state.$state);
		tab.indexer.dispose();
		expect(chain.ranges[0].from).toBe(START_BLOCK);
		expect(applied).toHaveLength(BRANCH_A.length);
	});

	it('reports an index UNREACHABLE at every location, and indexes from the chain', async () => {
		const definition = applyingProcessor();
		const host = servingFetch({[INDEX]: new Error('connection refused'), [MIRROR]: new Error('connection refused')});
		const tab = tabOf({
			definition,
			processor: NEW_PROCESSOR,
			publication: {locations: [INDEX, MIRROR], fetch: host.get},
		});

		const chain = fakeChain(BRANCH_A, BRANCH_A_TIP);
		await tab.indexer.init({provider: chain.provider, source: SOURCE, config: CONFIG});
		expect(publicationOf(tab)).toEqual({status: 'refused', reason: 'unreachable'});
		expect(tab.handed).toEqual([undefined]);
		expect(host.asked).toEqual([INDEX, MIRROR]);

		await indexToTip(tab.indexer as never);
		const applied = await appliedIn(tab.indexer.state.$state);
		tab.indexer.dispose();
		expect(chain.ranges[0].from).toBe(START_BLOCK);
		expect(applied).toHaveLength(BRANCH_A.length);
	});

	it('uses the SECOND location when the first is unreachable, and resolves the body against it', async () => {
		const definition = applyingProcessor();
		const snapshot = await publishedSnapshot(definition, {tip: 102, processor: NEW_PROCESSOR});
		const {routes, index} = await publicationAt(MIRROR, {snapshots: [{snapshot, stream: THIS_STREAM}]});
		const host = servingFetch({...routes, [INDEX]: new Error('connection refused')});
		const tab = tabOf({
			definition,
			processor: NEW_PROCESSOR,
			publication: {locations: [INDEX, MIRROR], fetch: host.get},
		});

		await tab.indexer.init({provider: fakeChain(BRANCH_A, BRANCH_A_TIP).provider, source: SOURCE, config: CONFIG});
		const body = `https://mirror.example/app/${Object.values(index.snapshots)[0].body}`;

		expect(publicationOf(tab)).toEqual({status: 'found', from: MIRROR, snapshot: body, at: 102});
		expect(tab.outcomes).toEqual([{status: 'bootstrapped', at: 102, from: body}]);
		expect(host.asked).toEqual([INDEX, MIRROR, body]);
		tab.indexer.dispose();
	});

	it('skips a location serving something that is NOT an index, and reports it where no location serves one', async () => {
		const definition = applyingProcessor();
		const notAnIndex = new TextEncoder().encode(JSON.stringify({format: 99, snapshots: {}}));
		const host = servingFetch({[INDEX]: notAnIndex, [MIRROR]: new Error('connection refused')});
		const tab = tabOf({
			definition,
			processor: NEW_PROCESSOR,
			publication: {locations: [INDEX, MIRROR], fetch: host.get},
		});

		await tab.indexer.init({provider: fakeChain(BRANCH_A, BRANCH_A_TIP).provider, source: SOURCE, config: CONFIG});

		// content outranks transport: the app or the publisher is out of date
		expect(publicationOf(tab)).toEqual({status: 'refused', reason: 'unreadable-format'});
		expect(host.asked).toEqual([INDEX, MIRROR]);
		tab.indexer.dispose();
	});

	it('refuses by name a generation with no identity before its state is built (a module arrival)', async () => {
		const definition = applyingProcessor();
		const snapshot = await publishedSnapshot(definition, {tip: 102, processor: NEW_PROCESSOR});
		const {routes} = await publicationAt(INDEX, {snapshots: [{snapshot, stream: THIS_STREAM}]});
		const host = servingFetch(routes);
		const tab = tabOf({definition, publication: {locations: [INDEX], fetch: host.get}});

		await tab.indexer.init({provider: fakeChain(BRANCH_A, BRANCH_A_TIP).provider, source: SOURCE, config: CONFIG});

		expect(publicationOf(tab)).toEqual({status: 'refused', reason: 'no-processor-identity', from: INDEX});
		expect(tab.handed).toEqual([undefined]);
		expect(host.asked).toEqual([INDEX]);
		tab.indexer.dispose();
	});

	it('RAISES at init when a `seed` is given beside a publication asking for its seed', async () => {
		const tab = createIndexerState<TestABI, EntityStateView>(
			{
				createState: async () =>
					openForWriting(await createBrowserStateStore(applyingProcessor().entities, {databaseName: freshName()})),
				createProcessor: (state) => new EntityEventProcessor<TestABI>(state, applyingProcessor()),
				processorIdentity: NEW_PROCESSOR,
			},
			{
				keepStream: keepStreamOnIndexedDB<TestABI>(freshName()),
				seed: {locations: ['https://seeds.example/seed.json.gz']},
				publication: {locations: [INDEX], seed: true},
			},
		);
		await expect(
			tab.init({provider: fakeChain(BRANCH_A, BRANCH_A_TIP).provider, source: SOURCE, config: CONFIG}),
		).rejects.toThrow(/ONE stream seed/);
	});
});
