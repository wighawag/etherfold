import 'fake-indexeddb/auto';
import {
	captureStream,
	installStreamSeed,
	resolveStreamConfig,
	storedStreamOf,
	streamDigestOfSourceHashes,
	streamSeedPayloadOf,
	STREAM_SEED_FORMAT,
	type Abi,
	type IndexingSource,
	type StreamSeed,
	type UsedStreamConfig,
} from '@etherfold/core';
import {
	createSnapshot,
	entityProcessorVersionHash,
	openAndBootstrap,
	type EntityProcessor,
	type EntityStateView,
	type Mutation,
	type StateSnapshot,
	type StateStore,
} from '@etherfold/processor-entities';
import {keys as allKeys} from 'idb-keyval';
import {describe, expect, it} from 'vitest';
import {
	createBrowserStateStore,
	keepStreamOnIndexedDB,
	streamAddress,
	type StatusState,
	type StreamSeedState,
	type SyncingState,
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
import {appliedIn, applyingProcessor, indexerOver, keysOf} from './utils/applied.js';

/**
 * STORY 10: THE SEEDING OUTCOME REACHES THE SURFACE AN APP ALREADY SUBSCRIBES
 * TO.
 *
 * The last slice of `a-browser-app-starts-from-a-published-artifact`, and it has
 * nothing to show until there is an outcome to show. `installStreamSeed`
 * (`@etherfold/core`) fetches, checks and writes; what this file is about is that
 * an application can RENDER what it did -- "installing", "seeded at block N", or
 * a refusal with a reason it can explain -- instead of an unexplained empty
 * screen, which is the outcome the whole spec exists to avoid (ADR-0064).
 *
 * Three claims run through every case here:
 *
 *  - **It lands on the EXISTING surface.** A field on the `syncing` store beside
 *    `error` and `nonCanonicalGenerations`, and a value in the `status` phase
 *    enum. No new reactive mechanism, and nothing that already existed changes
 *    meaning -- an app that never seeds is asserted to see exactly what it saw.
 *  - **It REPORTS and does not decide**, exactly as the non-canonical generation
 *    report does. In particular the refusal DIRECTION is data: nothing here ever
 *    claims the client is out of date, because a deliberately narrower client is
 *    indistinguishable from a stale one and only the app knows which it is.
 *  - **A refusal never gates the boot.** State still comes up from a published
 *    snapshot and indexes forward, and the refusal is reported alongside it.
 *
 * The substrate is the real one: `fake-indexeddb` under
 * `keepStreamOnIndexedDB`, one database name per case, so "the seed is installed"
 * is asserted by reading the keys a keeper actually wrote and not by trusting a
 * return value.
 */

let counter = 0;
const freshName = () => `seeding-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

const PROVIDED_CONFIG = {stream: {finality: FINALITY}};
const STREAM_CONFIG: UsedStreamConfig = resolveStreamConfig(PROVIDED_CONFIG.stream);

/** A rolling remote a build NAMES, and the copy EMBEDDED in that build. */
const REMOTE = 'https://seeds.example/token.seed.json.gz';
const EMBEDDED = './token.seed.json.gz';

/**
 * How far the published capture reaches, and the head its producer observed.
 *
 * `SEED_TO` is ABOVE the last event-bearing block the capture holds (block 100),
 * which is what a coverage claim is for: cut it short and the client re-scans
 * every quiet block at the end of the capture. `OBSERVED_HEAD` is far enough
 * above `SEED_TO` to clear the capture-depth check (`finality` blocks of
 * margin), which is the publisher's own duty.
 */
const SEED_TO = 101;
const OBSERVED_HEAD = BRANCH_A_TIP;

// ---------------------------------------------------------------------------
// A PUBLISHER, and what it puts on a host
// ---------------------------------------------------------------------------

/**
 * A published seed, CAPTURED from the same chain the client will index.
 *
 * Taken through `captureStream` rather than written down, for the reason the
 * core's own install suite gives: the publisher and the client are the same
 * build in the deployment this feature is for, so a real seed's stored context is
 * exactly what an ordinary run produces. A hand-made context would fail the
 * identity check and every case below would be asserting the refusal path by
 * accident.
 *
 * `source` is a parameter because the refusal cases need a publisher whose FILTER
 * differs from the client's: that is what makes the two digests disagree, and the
 * direction of the disagreement is the half an application renders.
 */
async function publishedSeed<A extends Abi>(
	source: IndexingSource<A>,
	options: {toBlock?: number; head?: number} = {},
): Promise<StreamSeed> {
	const chain = fakeChain(BRANCH_A, BRANCH_A_TIP);
	const fixture = await captureStream(chain.provider, source, {
		toBlock: options.toBlock ?? SEED_TO,
		streamConfig: PROVIDED_CONFIG.stream,
	});
	return {
		format: STREAM_SEED_FORMAT,
		producer: {kind: 'capture', name: 'packages/browser/test/streamSeeding.test.ts', at: '2026-09-07T00:00:00.000Z'},
		chainHeadAtCapture: options.head ?? OBSERVED_HEAD,
		streamConfig: STREAM_CONFIG,
		// A LABEL the loader VERIFIES rather than trusts, so a publisher states what
		// its own context and resolved config produce.
		streamDigest: streamDigestOfSourceHashes(fixture.lastSync.context.source, STREAM_CONFIG),
		coverage: {fromBlock: fixture.lastSync.lastFromBlock, toBlock: fixture.lastSync.lastToBlock},
		context: fixture.lastSync.context,
		// THE ONE implementation of the strip (ADR-0060): a seed carries only what the
		// node said, because the install discards the decoded half anyway.
		eventStream: storedStreamOf(fixture.eventStream),
	};
}

/**
 * A host serving a fixed routing table, and a record of what was asked for.
 *
 * The bodies are the DECOMPRESSED payload octets: a host that sets
 * `Content-Encoding: gzip` leaves exactly these in a caller's hands, and the core
 * suite already asserts that an opaque `.gz` lands identically. Which arrangement
 * a host chose is not this file's subject.
 */
function servingFetch(routes: Record<string, Uint8Array | Error>) {
	const asked: string[] = [];
	const get = (async (input: unknown) => {
		const url = String(input);
		asked.push(url);
		const served = routes[url];
		if (served === undefined) {
			return new Response('no such artifact', {status: 404, statusText: 'Not Found'});
		}
		if (served instanceof Error) {
			throw served;
		}
		return new Response(new Uint8Array(served), {status: 200});
	}) as typeof globalThis.fetch;
	return {asked, get};
}

/** One location, serving one seed. */
function serving(seed: StreamSeed, at: string = REMOTE) {
	return servingFetch({[at]: streamSeedPayloadOf(seed)});
}

// ---------------------------------------------------------------------------
// READING THE SUBSTRATE, and reading the SURFACE
// ---------------------------------------------------------------------------

/** What the keeper under `name` holds for this client's stream: its keys. */
async function streamKeysUnder(name: string): Promise<IDBValidKey[]> {
	const address = streamAddress(name, SOURCE, STREAM_CONFIG);
	const prefix = address.prefix as IDBValidKey[];
	return (await allKeys()).filter(
		(key): key is IDBValidKey[] =>
			Array.isArray(key) && prefix.every((element, index) => (key as IDBValidKey[])[index] === element),
	);
}

/**
 * EVERY value this surface published, in order, as an app subscribing to what it
 * already subscribes to would see them.
 *
 * It records the FIELD and not the store object, deliberately: the `syncing`
 * store mutates its state in place and republishes the same reference
 * (`work/notes/observations/browser-reactive-updates-depend-on-a-store-that-never-dedupes.md`),
 * so a recorder keeping the object would end up with N references to one value
 * and could assert nothing about a sequence. The field itself is replaced by a
 * fresh object on every publication, which is what makes the sequence readable --
 * and what makes "exactly two publications" an assertion this file can make.
 */
function recorder(indexer: {
	syncing: {subscribe: (run: (value: SyncingState<TestABI>) => void) => () => void};
	status: {subscribe: (run: (value: StatusState) => void) => () => void};
}) {
	const seeds: (StreamSeedState | undefined)[] = [];
	const phases: StatusState['state'][] = [];
	const stopSyncing = indexer.syncing.subscribe((syncing) => {
		if (seeds.length === 0 || seeds[seeds.length - 1] !== syncing.streamSeed) {
			seeds.push(syncing.streamSeed);
		}
	});
	const stopStatus = indexer.status.subscribe((status) => {
		if (phases[phases.length - 1] !== status.state) {
			phases.push(status.state);
		}
	});
	return {
		seeds,
		phases,
		stop() {
			stopSyncing();
			stopStatus();
		},
	};
}

// ---------------------------------------------------------------------------
// A CLIENT
// ---------------------------------------------------------------------------

type Client = {
	name: string;
	definition: EntityProcessor<TestABI>;
	indexer: ReturnType<typeof indexerOver>;
	keeper: ReturnType<typeof keepStreamOnIndexedDB<TestABI>>;
};

/** An app with a stream keeper under it, and the hook driving the install. */
async function appSeededByTheHook(
	seed: NonNullable<Parameters<typeof indexerWithSeed>[1]>,
	store?: StateStore,
): Promise<Client> {
	const name = freshName();
	const definition = applyingProcessor();
	const keeper = keepStreamOnIndexedDB<TestABI>(name);
	const indexer = indexerWithSeed(
		{definition, keeper, store: store ?? (await createBrowserStateStore(definition.entities, {databaseName: name}))},
		seed,
	);
	return {name, definition, indexer, keeper};
}

/** The hook, with a keeper and a `seed` option. `indexerOver` is the same wiring without one. */
function indexerWithSeed(
	over: {definition: EntityProcessor<TestABI>; keeper: unknown; store: StateStore},
	seed: {
		locations: string | readonly string[];
		fetch?: typeof globalThis.fetch;
		expectedContentHash?: string;
		maxEventsPerBatch?: number;
		reachBackTo?: number;
	},
) {
	return indexerOver(over.definition, over.store, {keepStream: over.keeper, seed});
}

describe('the hook installs the seed at init and publishes what it did', () => {
	it('publishes INSTALLING and then SEEDED, naming the block the stream reached', async () => {
		const seed = await publishedSeed(SOURCE);
		const {get, asked} = serving(seed);
		const client = await appSeededByTheHook({locations: [REMOTE], fetch: get});
		const seen = recorder(client.indexer);

		await client.indexer.init({provider: fakeChain().provider, source: SOURCE, config: PROVIDED_CONFIG});

		// what an app renders, in order: nothing, then a spinner, then an explanation
		expect(seen.seeds).toEqual([
			undefined,
			{status: 'installing'},
			{
				status: 'seeded',
				at: SEED_TO,
				reachesBackTo: START_BLOCK,
				from: REMOTE,
				// blocks 100..101, and the two logs block 100 carries
				events: 2,
				segments: 1,
			},
		]);
		// and the boot PHASE was visible on the enum apps already switch on
		expect(seen.phases).toEqual(['Idle', 'InstallingStreamSeed', 'Idle']);
		expect(asked).toEqual([REMOTE]);

		// the claim is true of the SUBSTRATE and not only of the return value: a
		// segment and a cursor record, at the address this client's own stream
		// resolves to
		expect(await streamKeysUnder(client.name)).toHaveLength(2);
		seen.stop();
		client.indexer.dispose();
	});

	it('walks past an unreachable remote to a BUILD-EMBEDDED artifact, and says which one it used', async () => {
		const seed = await publishedSeed(SOURCE);
		const {get} = servingFetch({[REMOTE]: new TypeError('Failed to fetch'), [EMBEDDED]: streamSeedPayloadOf(seed)});
		const client = await appSeededByTheHook({locations: [REMOTE, EMBEDDED], fetch: get});

		await client.indexer.init({provider: fakeChain().provider, source: SOURCE, config: PROVIDED_CONFIG});

		// `from` is on the surface precisely so an app can say where its history came
		// from -- here, from the copy that arrived in the same delivery as the code.
		expect(client.indexer.syncing.$state.streamSeed).toMatchObject({status: 'seeded', from: EMBEDDED});
		client.indexer.dispose();
	});

	it('reports NO byte-level progress: `installing` and one terminal state is the whole surface', async () => {
		// The install below writes THREE segments, so a surface reporting progress
		// would have something to report on each of them. It reports nothing: the
		// variable part of seeding is the DOWNLOAD, not the install, and a progress
		// signal would belong on the fetch rather than here.
		// three event-bearing blocks captured, one event per save: three segments. The
		// producer's observed head is stated `finality` blocks above what it captured,
		// which is the publisher's own duty and what the capture-depth check reads.
		const seed = await publishedSeed(SOURCE, {toBlock: 104, head: 104 + FINALITY});
		const {get} = serving(seed);
		const client = await appSeededByTheHook({locations: [REMOTE], fetch: get, maxEventsPerBatch: 1});
		const seen = recorder(client.indexer);

		await client.indexer.init({provider: fakeChain().provider, source: SOURCE, config: PROVIDED_CONFIG});

		expect(client.indexer.syncing.$state.streamSeed).toMatchObject({status: 'seeded', segments: 3});
		expect(seen.seeds.map((state) => state?.status)).toEqual([undefined, 'installing', 'seeded']);
		seen.stop();
		client.indexer.dispose();
	});

	it('changes NOTHING for an app that never seeds', async () => {
		// The additive claim, asserted rather than assumed: no `seed` option, no
		// field, no new phase, and the fields that were there before behave as they
		// did.
		const name = freshName();
		const definition = applyingProcessor();
		const indexer = indexerOver(definition, await createBrowserStateStore(definition.entities, {databaseName: name}));
		const seen = recorder(indexer);

		await indexer.init({provider: fakeChain().provider, source: SOURCE, config: PROVIDED_CONFIG});
		await indexToTip(indexer as never);

		expect(indexer.syncing.$state.streamSeed).toBeUndefined();
		expect(seen.seeds).toEqual([undefined]);
		expect(seen.phases).not.toContain('InstallingStreamSeed');
		expect(indexer.syncing.$state.error).toBeUndefined();
		expect(keysOf(await appliedIn(indexer.state.$state))).toHaveLength(BRANCH_A.length);
		seen.stop();
		indexer.dispose();
	});

	it('RAISES when a seed is asked for with no keeper to install it into', async () => {
		// A wiring mistake in the caller's own source, and no location makes it
		// right, so it is not a refusal reason: reported as data it would arrive as
		// "unreachable" from every mirror and point at the host.
		const name = freshName();
		const definition = applyingProcessor();
		const store = await createBrowserStateStore(definition.entities, {databaseName: name});
		const indexer = indexerOver(definition, store, {seed: {locations: [REMOTE]}});

		await expect(
			indexer.init({provider: fakeChain().provider, source: SOURCE, config: PROVIDED_CONFIG}),
		).rejects.toThrow(/keepStream/);
		indexer.dispose();
	});
});

describe('a refusal reaches the surface as data, and the app starts anyway', () => {
	/**
	 * THE PUBLISHED STATE SNAPSHOT the app comes up from, whatever the seed did.
	 *
	 * A first tab indexes to `SNAPSHOT_TIP` and publishes what it computed. It is
	 * here because ADR-0064's claim about a refusal is precisely that state STILL
	 * bootstraps from a published snapshot and indexes forward from the tip, and
	 * what is lost is the stream underneath -- so a case that asserted only "init
	 * did not throw" would be asserting the easy half.
	 */
	const SNAPSHOT_TIP = 102;

	async function publishSnapshot(definition: EntityProcessor<TestABI>): Promise<StateSnapshot> {
		const store = await createBrowserStateStore(definition.entities, {databaseName: freshName()});
		const indexer = indexerOver(definition, store);
		await indexer.init({provider: fakeChain(BRANCH_A, SNAPSHOT_TIP).provider, source: SOURCE, config: PROVIDED_CONFIG});
		const lastSync = await indexToTip(indexer as never);
		const listing = await store.listCurrent<{bucket: string; at: string; key: string; times: number}>(
			'applied',
			{bucket: 'all'},
			500,
		);
		indexer.dispose();
		const rows: Mutation[] = listing.rows.map((row) => ({
			type: 'upsert',
			entity: 'applied',
			id: {bucket: row.bucket, at: row.at},
			values: {key: row.key, times: Number(row.times)},
		}));
		return createSnapshot<TestABI>({
			takenAt: {number: SNAPSHOT_TIP, hash: `0xsnap${SNAPSHOT_TIP.toString(16)}`, timestamp: timestampOf(SNAPSHOT_TIP)},
			rows,
			lastSync,
			processor: entityProcessorVersionHash(definition),
		});
	}

	it('names the reason and the DIRECTION, while state comes up from the snapshot and indexes forward', async () => {
		const definition = applyingProcessor();
		const snapshot = await publishSnapshot(definition);
		// A publisher indexing MORE than this client does: same chain, same contract,
		// a wider ABI. The digests disagree, so the seed is refused even though the
		// invalidation model would call such a stream reusable -- its extra events
		// would be stored under THIS client's digest and re-folded by every later
		// generation (ADR-0064).
		const wider = await publishedSeed(SOURCE_V2);
		const {get} = serving(wider);

		const name = freshName();
		const mirror = {
			url: 'https://mirror.example/state.json',
			fetch: (async () => ({json: async () => snapshot}) as Response) as unknown as typeof globalThis.fetch,
		};
		const {store, outcome} = await openAndBootstrap(
			await createBrowserStateStore(definition.entities, {databaseName: name}),
			mirror.url,
			{processor: entityProcessorVersionHash(definition), fetch: mirror.fetch},
		);
		expect(outcome).toMatchObject({status: 'bootstrapped', at: SNAPSHOT_TIP});
		const indexer = indexerWithSeed(
			{definition, keeper: keepStreamOnIndexedDB<TestABI>(name), store},
			{locations: [REMOTE], fetch: get},
		);

		const chain = fakeChain(BRANCH_A, BRANCH_A_TIP);
		await indexer.init({provider: chain.provider, source: SOURCE, config: PROVIDED_CONFIG});

		// THE REFUSAL, as data an app can render: the reason, and the direction where
		// the reason carries one.
		expect(indexer.syncing.$state.streamSeed).toEqual({
			status: 'refused',
			reason: 'seed-covers-more',
			direction: 'seed-covers-more',
		});
		// it is not a FAULT, and `error` keeps its meaning: an app that renders
		// `error` as a crash must not render one for an ordinary outcome
		expect(indexer.syncing.$state.error).toBeUndefined();
		// nothing was written, and nothing was deleted either: the refusal is not what
		// costs a client its stream
		expect(await streamKeysUnder(name)).toEqual([]);

		// AND THE APP STARTS: the boot was never gated on the seed. The state is the
		// snapshot's rows, and it indexes forward from the tip on top of them.
		await indexToTip(indexer as never);
		const applied = await appliedIn(indexer.state.$state);
		expect(applied).toHaveLength(BRANCH_A.length);
		expect(applied.map((row) => row.times)).toEqual(applied.map(() => 1));
		expect(indexer.syncing.$state.streamSeed).toMatchObject({status: 'refused'});
		indexer.dispose();
	});

	it('names the OTHER direction when the client indexes more than the publisher', async () => {
		// The pair, and the reason the direction is data rather than a conclusion: a
		// client that indexes MORE reads a narrow seed as stale, and a client that
		// indexes LESS reads a wide one as newer -- but a deliberately narrower client
		// is indistinguishable from an out-of-date one, so an app may render "a newer
		// version may be available" and this library may not.
		const narrower = await publishedSeed(SOURCE);
		const {get} = serving(narrower);
		const name = freshName();
		const definition = applyingProcessor();
		const indexer = indexerWithSeed(
			{
				definition,
				keeper: keepStreamOnIndexedDB(name),
				store: await createBrowserStateStore(definition.entities, {databaseName: name}),
			},
			{locations: [REMOTE], fetch: get},
		);

		await indexer.init({
			provider: fakeChain().provider,
			// the wider client, reading a seed captured under the narrower filter
			source: SOURCE_V2 as unknown as IndexingSource<TestABI>,
			config: PROVIDED_CONFIG,
		});

		expect(indexer.syncing.$state.streamSeed).toEqual({
			status: 'refused',
			reason: 'seed-covers-less',
			direction: 'seed-covers-less',
		});
		indexer.dispose();
	});

	it('carries a reason with NO direction when the reason has none, and invents nothing', async () => {
		// Every mirror down. The field an app switches on is simply absent rather
		// than filled with a plausible-looking value, and the published object holds
		// nothing beyond what the loader said: no message, no "out of date" verdict,
		// no severity this library is not entitled to.
		const {get} = servingFetch({[REMOTE]: new TypeError('Failed to fetch')});
		const client = await appSeededByTheHook({locations: [REMOTE], fetch: get});

		await client.indexer.init({provider: fakeChain().provider, source: SOURCE, config: PROVIDED_CONFIG});

		const published = client.indexer.syncing.$state.streamSeed;
		expect(published).toEqual({status: 'refused', reason: 'unreachable'});
		expect(Object.keys(published ?? {})).toEqual(['status', 'reason']);
		client.indexer.dispose();
	});
});

describe('an application may drive the install itself, before init or after it', () => {
	/** The direct path, exactly as an app writes it: the keeper, the locations, the RESOLVED config. */
	function installDirectly(keeper: unknown, get: typeof globalThis.fetch) {
		return installStreamSeed(keeper as never, [REMOTE], {
			source: SOURCE,
			// the same value `IndexerGeneration.reinit` hands the keeper, and never the
			// config as a user spelled it: the digest half of the address depends on it
			streamConfig: STREAM_CONFIG,
			fetch: get,
		});
	}

	it('installs BEFORE `init`, and the generation folds the stream that is already there', async () => {
		const seed = await publishedSeed(SOURCE);
		const {get} = serving(seed);
		const name = freshName();
		const definition = applyingProcessor();
		const keeper = keepStreamOnIndexedDB<TestABI>(name);

		const outcome = await installDirectly(keeper, get);

		expect(outcome).toMatchObject({status: 'installed', at: SEED_TO, reachesBackTo: START_BLOCK});
		expect(await streamKeysUnder(name)).toHaveLength(2);

		const chain = fakeChain();
		const indexer = indexerOver(definition, await createBrowserStateStore(definition.entities, {databaseName: name}), {
			keepStream: keeper,
		});
		await indexer.init({provider: chain.provider, source: SOURCE, config: PROVIDED_CONFIG});
		await indexToTip(indexer as never);

		const applied = await appliedIn(indexer.state.$state);
		expect(applied).toHaveLength(BRANCH_A.length);
		expect(applied.map((row) => row.times)).toEqual(applied.map(() => 1));
		// the half of this test's own name that `times` cannot prove: the fold FOUND the
		// installed stream rather than re-fetching what it already had, so the node is
		// only ever asked for the tail ABOVE the seed's coverage end. Without this the
		// case passes just as well against a generation that backfilled from block 100.
		expect(chain.ranges).toEqual([{from: SEED_TO + 1, to: BRANCH_A_TIP}]);
		// the hook publishes nothing, because the hook installed nothing: this field
		// reports the install IT ran
		expect(indexer.syncing.$state.streamSeed).toBeUndefined();
		indexer.dispose();
	});

	it('installs AFTER `init` too, because the install carries its own resolved stream config', async () => {
		// ADR-0067: the install SETS the config it was handed on the keeper before it
		// addresses anything, so it is correct whether or not a generation exists and
		// whether or not one has configured that keeper. This is the case the hook
		// option was once justified by -- an app installing at the "wrong" moment --
		// and it is asserted rather than assumed, because it is why that option is
		// ergonomics and not a safety mechanism.
		const seed = await publishedSeed(SOURCE);
		const {get} = serving(seed);
		const name = freshName();
		const definition = applyingProcessor();
		const keeper = keepStreamOnIndexedDB<TestABI>(name);
		const indexer = indexerOver(definition, await createBrowserStateStore(definition.entities, {databaseName: name}), {
			keepStream: keeper,
		});
		await indexer.init({provider: fakeChain().provider, source: SOURCE, config: PROVIDED_CONFIG});

		const outcome = await installDirectly(keeper, get);

		expect(outcome).toMatchObject({status: 'installed', at: SEED_TO});
		expect(await streamKeysUnder(name)).toHaveLength(2);
		await indexToTip(indexer as never);
		const applied = await appliedIn(indexer.state.$state);
		expect(applied).toHaveLength(BRANCH_A.length);
		expect(applied.map((row) => row.times)).toEqual(applied.map(() => 1));
		indexer.dispose();
	});

	it('is REFUSED once indexing has started, loudly and as data, leaving that stream intact', async () => {
		// The ordering hazard that DOES remain, and it needs no hook to prevent
		// because it is not silent: a tab that indexed first owns a subtree, and
		// nothing can tell a stream a client indexed itself from a half-written
		// install of the seed being offered (ADR-0067). So it is refused, and the
		// refusal must not be what deletes what is there.
		const seed = await publishedSeed(SOURCE);
		const {get, asked} = serving(seed);
		const name = freshName();
		const definition = applyingProcessor();
		const keeper = keepStreamOnIndexedDB<TestABI>(name);
		const indexer = indexerOver(definition, await createBrowserStateStore(definition.entities, {databaseName: name}), {
			keepStream: keeper,
		});
		await indexer.init({provider: fakeChain().provider, source: SOURCE, config: PROVIDED_CONFIG});
		await indexToTip(indexer as never);
		const before = await streamKeysUnder(name);
		expect(before.length).toBeGreaterThan(0);

		const outcome = await installDirectly(keeper, get);

		expect(outcome).toEqual({status: 'not-installed', reason: 'subtree-not-empty'});
		// intact, and still a STREAM rather than merely bytes: it reads back
		expect(await streamKeysUnder(name)).toEqual(before);
		expect(await keeper.fetchFrom(SOURCE, START_BLOCK)).toBeDefined();
		// and nothing was even downloaded: a client that already has a stream pays no
		// download to be told it may not install over it
		expect(asked).toEqual([]);
		indexer.dispose();
	});
});
