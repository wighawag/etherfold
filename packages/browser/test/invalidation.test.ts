import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {get, set} from 'idb-keyval';
import {resolveStreamConfig, simple_hash, type LastSync} from '@etherfold/core';
import {
	deserializeLastSync,
	EntityEventProcessor,
	serializeLastSync,
	SYNC_CURSOR_KEY,
	type EntityProcessor,
	type EntityStateView,
	type MutationContext,
} from '@etherfold/processor-entities';
import {openForWriting, type WritableStateStore} from '@etherfold/state-store';
import {createBrowserStateStore, createIndexerState, keepStreamOnIndexedDB, streamAddress} from '../src/index.js';
import {
	EXPECTED_A,
	fakeChain,
	FINALITY,
	indexerForProcessor,
	indexToTip,
	processor,
	readState,
	SOURCE,
	SOURCE_RENAMED_PARAMETER,
	SOURCE_V2,
	SOURCE_WITH_NON_EVENT_MEMBERS,
	START_BLOCK,
	type TestABI,
} from '../browser/workload.js';

/**
 * INVALIDATION IS COMPUTED ON WHAT EACH THING ACTUALLY DEPENDS ON.
 *
 * An ABI is REGENERATED, not hand-edited, so the members that move in it most
 * often are the ones no log depends on. Adding a view function used to cost a
 * complete re-fetch of all history, and nothing about that function can affect a
 * log.
 *
 * The claim is about RE-FETCHING, and state cannot make it: a re-index and a
 * resume land on identical rows. So every case here is asserted on what the fake
 * node was asked for, with `{stateDiscarded}` as the second reading rather than
 * the first -- the same shape `eventRanges.test.ts` uses for the ranged path,
 * which this generalises.
 */

let counter = 0;
const freshName = () => `invalidation-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/** Index branch A to the tip on a fresh IndexedDB database, against `source`. */
async function indexed(source = SOURCE, chain = fakeChain()) {
	const store = await openForWriting(await createBrowserStateStore(processor.entities, {databaseName: freshName()}));
	const indexer = indexerForProcessor(store, processor);
	await indexer.init({provider: chain.provider, source: source as never, config: {stream: {finality: FINALITY}}});
	await indexToTip(indexer);
	return {store, indexer, chain};
}

describe('a regenerated ABI that gained a view function, an error and a constructor', () => {
	it('re-fetches nothing, which is the claim the state cannot make', async () => {
		const {indexer, chain} = await indexed();
		const rangesBefore = chain.ranges.length;

		await indexer.updateIndexer({source: SOURCE_WITH_NON_EVENT_MEMBERS as never});
		await indexToTip(indexer);

		// it RESUMED: nothing already indexed was asked for a second time
		for (const range of chain.ranges.slice(rangesBefore)) {
			expect(range.from).toBeGreaterThan(START_BLOCK);
		}

		indexer.dispose();
	});

	it('discards nothing, and the rows are the ones that were already there', async () => {
		const {indexer} = await indexed();

		const outcome = await indexer.updateIndexer({source: SOURCE_WITH_NON_EVENT_MEMBERS as never});

		expect(outcome.stateDiscarded).toBe(false);
		expect(await readState(indexer.state.$state)).toEqual(EXPECTED_A);

		indexer.dispose();
	});
});

describe('an event ADDED to a source that declares no range', () => {
	it('still discards and re-fetches, because the topic set GREW', async () => {
		// Those blocks were fetched under a filter that was missing a topic, and
		// nothing after the fact can tell a missing log from an absent one.
		const {indexer, chain} = await indexed();
		const rangesBefore = chain.ranges.length;

		const outcome = await indexer.updateIndexer({source: SOURCE_V2 as never});
		await indexToTip(indexer);

		expect(outcome.stateDiscarded).toBe(true);
		expect(chain.ranges.slice(rangesBefore)[0].from).toBe(START_BLOCK);

		indexer.dispose();
	});
});

// ---------------------------------------------------------------------------
// The half that needs a CACHED STREAM to be visible at all.
// ---------------------------------------------------------------------------
// "The stream survived" is only observable where there is a stream to survive,
// so these wire a stream keeper beside the store, exactly as
// `reconfigure.test.ts` does for the replay case.

/**
 * A processor that reports WHICH parameter name its events arrived under.
 *
 * The rename is invisible in the rows a normal handler writes, so the fixture
 * makes it visible: an event decoded under the old ABI carries `args.id`, one
 * decoded under the new ABI carries `args.tokenId`, and the state says which.
 * That is what turns "the stream was replayed" into "the stream was replayed and
 * decoded against the source running now".
 */
type NamesState = {underOldName: number; underNewName: number; transfers: number};

async function bump(state: MutationContext, name: string): Promise<void> {
	const row = await state.get<{value: number}>('names', {name});
	state.set('names', {name}, {value: (row?.value ?? 0) + 1});
}

const namesProcessor = (version: string): EntityProcessor<TestABI> => ({
	version,
	entities: [{name: 'names', id: ['name'], fields: {value: 'integer'}}],
	async onTransfer(state, event) {
		const args = event.args as {id?: bigint; tokenId?: bigint};
		if (args.tokenId !== undefined) {
			await bump(state, 'underNewName');
		} else if (args.id !== undefined) {
			await bump(state, 'underOldName');
		}
		await bump(state, 'transfers');
	},
});

/** The three counters, read back through the processor's own handle. */
async function namesIn(view: EntityStateView): Promise<NamesState> {
	const read = async (name: string) => Number((await view.getCurrent<{value: number}>('names', {name}))?.value ?? 0);
	return {
		underOldName: await read('underOldName'),
		underNewName: await read('underNewName'),
		transfers: await read('transfers'),
	};
}

/** A store and a stream keeper under one name, indexed to the tip against branch A. */
async function indexedWithKeptStream(tag = freshName(), chain = fakeChain()) {
	const store = await openForWriting(
		await createBrowserStateStore(namesProcessor('1.0.0').entities, {databaseName: tag}),
	);
	const indexer = createIndexerState<TestABI, EntityStateView>(
		{
			createState: () => store,
			createProcessor: (state) => new EntityEventProcessor<TestABI>(state, namesProcessor('1.0.0')),
		},
		{keepStream: keepStreamOnIndexedDB(tag) as never},
	);
	await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
	await indexToTip(indexer as never);
	return {indexer, chain, tag, store};
}

describe('a renamed NON-INDEXED parameter', () => {
	it('keeps the stream and discards the state, which is the pair that could not be said before', async () => {
		const {indexer, chain} = await indexedWithKeptStream();
		expect(await namesIn(indexer.state.$state)).toEqual({underOldName: 5, underNewName: 0, transfers: 5});
		const fetchesBefore = chain.ranges.length;

		const outcome = await indexer.updateIndexer({source: SOURCE_RENAMED_PARAMETER as never});

		// the fold is stale: it was computed by reading a key that no longer exists
		expect(outcome.stateDiscarded).toBe(true);
		// and the rebuild came out of the cache, without going back to the node at all
		expect(chain.ranges.length).toBe(fetchesBefore);

		// which is only observable once indexing goes on: a kept stream RESUMES above
		// the start block, a cleared one starts again from it. `topic0` hashes types,
		// not names, so there is nothing down there to ask for.
		await indexToTip(indexer as never);
		for (const range of chain.ranges.slice(fetchesBefore)) {
			expect(range.from).toBeGreaterThan(START_BLOCK);
		}

		indexer.dispose();
	});

	it('re-decodes the kept stream, so the rebuild speaks the NEW parameter names', async () => {
		// The stream is raw logs plus a decode of them, and only the first half
		// survives an ABI change. Replaying the stored `args` would rebuild the state
		// out of keys the current ABI does not have -- correct-looking, and silently
		// derived from a contract description that is no longer in force.
		const {indexer} = await indexedWithKeptStream();

		await indexer.updateIndexer({source: SOURCE_RENAMED_PARAMETER as never});

		expect(await namesIn(indexer.state.$state)).toEqual({underOldName: 0, underNewName: 5, transfers: 5});

		indexer.dispose();
	});
});

describe('a context persisted by the SHIPPED code, read by this one', () => {
	/**
	 * Rewrite both keepers' stored context into the shape the shipped code wrote:
	 * ONE entry, at block 0, hashing the whole source.
	 *
	 * This is the trap the change had to clear. `ContextIdentifier` is persisted,
	 * so an upgrade that misread its own predecessor's bytes would silently
	 * re-index every existing deployment once -- charging exactly the cost
	 * per-event hashing exists to remove, at exactly the moment nobody is looking.
	 */
	async function agePersistedContextsToTheShippedShape(tag: string, store: WritableStateStore) {
		const wholeSource = [{startBlock: 0, hash: simple_hash(SOURCE)}];

		// The STATE side keeps its cursor behind the storage seam, as an opaque string
		// under one key (ADR-0027), so the ageing goes through the cursor port.
		const stored = await store.readCursor(SYNC_CURSOR_KEY);
		expect(stored).toBeDefined();
		const lastSync = deserializeLastSync<TestABI>(stored as string);
		// what the new code wrote is the per-event list, so this is a real ageing
		expect(lastSync.context.source.length).toBeGreaterThan(1);
		await store.writeCursor(
			SYNC_CURSOR_KEY,
			serializeLastSync({...lastSync, context: {...lastSync.context, source: wholeSource as never}}),
		);

		// The STREAM keeper's cursor now lives ONCE, in the cursor record inside the
		// stream's subtree, at the hierarchical address. Same ageing, deliberately
		// re-aimed: the trap this test exists for is a persisted `ContextIdentifier`
		// misread by its successor, and moving where it is stored does not retire it.
		// at the address the INDEXER's own stream config resolves to: the digest
		// level covers the filter AND the config, so naming a different one here
		// would age a subtree nothing reads
		const cursorKey = streamAddress(tag, SOURCE, resolveStreamConfig({finality: FINALITY})).cursor;
		const cursor = await get<{context: LastSync<TestABI>['context']}>(cursorKey);
		expect(cursor).toBeDefined();
		expect(cursor!.context.source.length).toBeGreaterThan(1);
		await set(cursorKey, {...cursor, context: {...cursor!.context, source: wholeSource}});
	}

	it('resumes rather than re-indexing, on a source that did not move', async () => {
		const {indexer, chain, tag, store} = await indexedWithKeptStream();
		expect((await namesIn(indexer.state.$state)).transfers).toBe(5);
		indexer.dispose();
		await agePersistedContextsToTheShippedShape(tag, store);

		// a new tab, the same stores, the upgraded library
		const rangesBefore = chain.ranges.length;
		const reopened = await openForWriting(
			await createBrowserStateStore(namesProcessor('1.0.0').entities, {databaseName: tag}),
		);
		const reloaded = createIndexerState<TestABI, EntityStateView>(
			{
				createState: () => reopened,
				createProcessor: (state) => new EntityEventProcessor<TestABI>(state, namesProcessor('1.0.0')),
			},
			{keepStream: keepStreamOnIndexedDB(tag) as never},
		);
		await reloaded.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
		await indexToTip(reloaded as never);

		// it ADOPTED the aged state and resumed: no block already indexed was asked
		// for a second time
		for (const range of chain.ranges.slice(rangesBefore)) {
			expect(range.from).toBeGreaterThan(START_BLOCK);
		}
		expect((await namesIn(reloaded.state.$state)).transfers).toBe(5);

		reloaded.dispose();
	});
});

describe('an event REMOVED from the ABI', () => {
	it('discards the state derived from it while keeping the stream, since a shrunken topic set leaves a SUPERSET', async () => {
		const {indexer, chain} = await indexedWithKeptStream();
		// the source gains an event and pays for it, so that dropping it again is a
		// genuine REMOVAL from what the stream was fetched under
		await indexer.updateIndexer({source: SOURCE_V2 as never});
		await indexToTip(indexer as never);
		const fetchesBefore = chain.ranges.length;

		const outcome = await indexer.updateIndexer({source: SOURCE as never});
		await indexToTip(indexer as never);

		expect(outcome.stateDiscarded).toBe(true);
		for (const range of chain.ranges.slice(fetchesBefore)) {
			expect(range.from).toBeGreaterThan(START_BLOCK);
		}
		// and the rebuild lands on the same numbers, from the cache alone
		expect((await namesIn(indexer.state.$state)).transfers).toBe(5);

		indexer.dispose();
	});
});
