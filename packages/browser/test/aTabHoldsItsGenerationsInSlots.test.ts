import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {
	CanonicalGenerationNotHeldError,
	GenerationCapReachedError,
	openIndexer,
	type AnyGenerationSpec,
	type GenerationId,
	type GenerationRecord,
	type GenerationRegistry,
	type Indexer,
	type IndexingSource,
} from '@etherfold/core';
import {MemoryStateStore, openForWriting, type WritableStateStore} from '@etherfold/state-store';
import type {EntityProcessor, EntityEventProcessor, EntityStateView} from '@etherfold/processor-entities';
import {IndexedDBStateStore} from '@etherfold/state-store-indexeddb';
import {
	BROWSER_GENERATION_CAPS,
	createIndexerState,
	keepStreamOnIndexedDB,
	openGenerationRegistryOnIndexedDB,
} from '../src/index.js';
import {
	BRANCH_A_EXTENDED,
	BRANCH_A_EXTENDED_TIP,
	BOB,
	CAROL,
	DAN,
	entityProcessorOver,
	EXPECTED_A,
	fakeChain,
	FINALITY,
	indexToTip,
	processor,
	processorVariant,
	readState,
	SOURCE,
	SOURCE_FROM_LATER_BLOCK,
	START_BLOCK,
	streamOf,
	type TestABI,
} from '../browser/workload.js';
import {identityOf, markerOf} from './utils/processorIdentity.js';

/**
 * A GENERATION IS HELD BY A DURABLE NAMED SLOT, in the twin a browser tab runs
 * (ADR-0084).
 *
 * The rule itself is pinned in `@etherfold/core` over a memory registry, and the
 * receiving twin's half is pinned beside it. What is only observable HERE is the
 * runtime the rule was written FOR:
 *
 * - a tab reconfigures constantly (every save is a reconfigure), so the pending
 *   successor must be REPLACED rather than added beside;
 * - a page reload is a FRESH PROCESS WITH AN EMPTY MEMORY, which is why the fact
 *   has to be a ROW -- so a SECOND CONTAINER over the same IndexedDB stands in
 *   for the reload, and replaces what it finds in the slot having registered
 *   nothing and remembered nothing;
 * - the caps here are the tightest in the system (`BROWSER_GENERATION_CAPS`, two
 *   of each), so what the numbers MEAN under three slots is arithmetic a test has
 *   to state rather than prose;
 * - and there is a UI attached, so the canonical generation goes on answering
 *   complete reads through all of it.
 *
 * The registry is the REAL one (`openGenerationRegistryOnIndexedDB`), because the
 * claim is about what survives a reload and a memory registry cannot make it.
 */

let counter = 0;
const freshName = () => `slots-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * The fold a save produces: the same events, counted differently, so a READ says
 * which one answered.
 *
 * It declares the SAME version as the fold it replaces, deliberately: what NAMES
 * a generation is the identity its arrival supplied (ADR-0086), and an author
 * cannot state one. `identityFor` is the value a save arrives with.
 */
const editedTo = (countBy: number) => processorVariant({countBy});

/** What a save's ARRIVAL derived: new bytes, so a new generation, with no author action. */
const identityFor = (countBy: number) => identityOf(`edited-by-${countBy}`);

/** What the app itself arrived as: the bundle the tab was loaded with. */
const APP_IDENTITY = identityOf('the-app');

async function memoryStore(definition: EntityProcessor<TestABI> = processor): Promise<WritableStateStore> {
	return openForWriting(new MemoryStateStore(definition.entities));
}

/** A durable registry under this tab's name, with what it was asked to drop recorded. */
async function durableRegistry(
	name: string,
	caps?: {maxGenerations?: number; maxStreams?: number},
): Promise<{registry: GenerationRegistry; dropped: GenerationId[]}> {
	const dropped: GenerationId[] = [];
	const registry = await openGenerationRegistryOnIndexedDB(name, {
		...(caps ? {caps} : {}),
		dropState: async (id) => {
			dropped.push(id);
		},
	});
	return {registry, dropped};
}

/** One generation's two factories, over a store the test can read back. */
function generationOver(
	store: WritableStateStore,
	definition: EntityProcessor<TestABI>,
	/** What the ARRIVAL that produced this fold derived: the identity it is registered under. */
	processorIdentity: string,
	/** ITS OWN FETCH FILTER, where the case is a reconfigure rather than a handler edit: a different filter is a different STREAM. */
	source?: IndexingSource<TestABI>,
): AnyGenerationSpec<TestABI, EntityStateView> {
	let fold: EntityEventProcessor<TestABI> | undefined;
	return {
		createState: () => store,
		createProcessor: (state) => (fold = entityProcessorOver(state as WritableStateStore, definition)),
		stateOf: () => (fold as EntityEventProcessor<TestABI>).state,
		processorIdentity,
		...(source ? {source} : {}),
	};
}

/**
 * What each slot holds, as the MARKER of the fold it names, so an assertion reads
 * as a sentence.
 *
 * It used to read the declared version off the front of the identity. Nothing may
 * look inside one (ADR-0086) and after this batch there is nothing in there to
 * read, so the suite asks which bytes it hashed instead (`markerOf`).
 */
/**
 * Drive the container the way a TAB's driver does: `load()` once, then
 * `indexMore()` to the tip.
 *
 * The `load()` is not decoration. `setupIndexing` calls `indexer.load()` before
 * it ever advances, so a case measuring what a reloaded tab asks the chain for
 * has to open the same way the thing it is measuring does.
 */
async function driveToTip(container: Indexer<TestABI, EntityStateView>, rounds = 20): Promise<void> {
	await container.load();
	for (let round = 0; round < rounds; round++) {
		const lastSync = await container.indexMore();
		if (lastSync.lastToBlock >= lastSync.latestBlock) return;
	}
}

/**
 * WHAT THE TAB LEFT IN THE STREAM, which is the half neither a flag nor a count
 * of chain reads can say.
 *
 * A fix for a stall is judged on the DUPLICATE-OR-HOLE question ADR-0087
 * measured on the receiving side -- `_emissions` holding four rows where two are
 * correct -- so the stored stream is read back and both are looked for by name: a
 * log delivered twice, and what the stream's own cursor claims to cover.
 */
async function storedStream(keepStream: {
	fetchFrom: (source: typeof SOURCE, fromBlock: number) => Promise<unknown>;
}): Promise<{events: number; blocksPresent: number[]; deliveredTwice: string[]; coversTo: number}> {
	const read = (await keepStream.fetchFrom(SOURCE, START_BLOCK)) as {status: string};
	if (read.status !== 'stream') {
		throw new Error(`expected a stored stream, got '${read.status}'`);
	}
	const {eventStream, lastSync} = streamOf(read as never);
	const seen = new Map<string, number>();
	for (const event of eventStream) {
		const key = `${event.blockHash}:${event.logIndex}:${event.removed ? 'removed' : 'applied'}`;
		seen.set(key, (seen.get(key) ?? 0) + 1);
	}
	return {
		events: eventStream.length,
		blocksPresent: [...new Set(eventStream.map((event) => Number(event.blockNumber)))],
		deliveredTwice: [...seen.entries()].filter(([, count]) => count > 1).map(([key, count]) => `${key} x${count}`),
		coversTo: lastSync.lastToBlock,
	};
}

/**
 * SESSION ONE, which every case after a promotion starts from: index on the app's
 * fold, save an edited one beside it, and let the default `on-catch-up` policy
 * promote it once it is level.
 *
 * **It RETAINS what the promotion superseded, and that is now something it has to
 * SAY.** This runtime discards it by default (ADR-0090), so a session that said
 * nothing would leave the previous generation's row gone and the cases below with
 * no survivor to be wrong about. `{dropOnPromotion: false}` is the embedder that
 * turned the drop off -- a supported configuration, and the one these cases are
 * about: what a tab does when it OPENS onto a record it holds no fold for
 * (ADR-0088) and when a save then needs that row's room (ADR-0090, point 3).
 *
 * What it leaves behind is therefore the shape those cases need: the pointer on
 * the saved fold, and the previous generation named by NO slot (ADR-0089) with
 * its row and its state still there.
 */
async function aTabThatSavedAndPromoted(name: string, chain: ReturnType<typeof fakeChain>) {
	const {registry} = await durableRegistry(name);
	const keepStream = keepStreamOnIndexedDB<TestABI>(name);
	const session = await openIndexer<TestABI, EntityStateView>({
		registry,
		provider: chain.provider,
		source: SOURCE,
		config: {keepStream, stream: {finality: FINALITY}},
		promotion: {dropOnPromotion: false},
		generations: [generationOver(await memoryStore(), processor, APP_IDENTITY)],
	});
	await driveToTip(session);
	// THE SAVE: the developer edits the handler, the tab registers the new fold
	// beside the live one, and the default policy promotes it once it is level.
	const savedState = await memoryStore(editedTo(3));
	await session.add(generationOver(savedState, editedTo(3), identityFor(3)));
	await driveToTip(session);
	return {registry, keepStream, savedState};
}

async function slotsBy(registry: GenerationRegistry): Promise<Record<string, string | undefined>> {
	const held = await registry.slots();
	const marker = (record: GenerationRecord | undefined) => markerOf(record?.processor);
	return {
		canonical: marker(held.canonical),
		successor: marker(held.successor),
		predecessor: marker(held.predecessor),
	};
}

describe('a tab that reconfigures over and over holds ONE successor', () => {
	/**
	 * THE PRACTICAL DELIVERABLE: five saves, two generations, and a cap of two
	 * never met.
	 *
	 * Before slots each save REGISTERED a generation beside the live one and
	 * nothing retired it, so at `BROWSER_GENERATION_CAPS` the second save was
	 * refused -- a developer iterating on a fold had to delete a generation by hand
	 * to carry on. `successor` holds AT MOST ONE, so the newer save REPLACES the
	 * pending one and the count is bounded by what is WANTED rather than by a bound
	 * that refuses.
	 */
	it('replaces the pending successor rather than adding beside it, so the cap is never met', async () => {
		const name = freshName();
		const {registry, dropped} = await durableRegistry(name);
		expect(registry.caps).toEqual(BROWSER_GENERATION_CAPS);

		const chain = fakeChain();
		const app = createIndexerState<TestABI, EntityStateView>(
			{
				registry,
				createState: () => memoryStore(),
				createProcessor: (state) => entityProcessorOver(state, processor),
				processorIdentity: APP_IDENTITY,
			},
			{keepStream: keepStreamOnIndexedDB<TestABI>(name)},
		);
		await app.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
		await indexToTip(app);
		expect(await readState(app.state.$state)).toEqual(EXPECTED_A);

		const saved: GenerationRecord[] = [];
		for (const countBy of [2, 3, 4, 5, 6]) {
			const definition = editedTo(countBy);
			const held = await app.addGeneration({
				createState: () => memoryStore(definition),
				createProcessor: (state) => entityProcessorOver(state, definition),
				processorIdentity: identityFor(countBy),
			});
			saved.push(held.record);

			// ONE pending successor at a time, whatever the developer did before it
			expect(await slotsBy(registry)).toEqual({
				canonical: 'the-app',
				successor: `edited-by-${countBy}`,
				predecessor: undefined,
			});
			// ...so the count never climbs: the incumbent, plus one
			expect((await registry.list()).length).toBe(2);
			expect(registry.caps.maxGenerations).toBe(2);
			// ...and there is a UI attached to this one, so it goes on answering
			// COMPLETE answers from the generation that is not being churned
			expect(await readState(app.state.$state)).toEqual(EXPECTED_A);
		}

		// every save but the last replaced its predecessor in the slot, and each
		// replaced generation's STATE went with its row rather than being orphaned
		expect(dropped).toEqual(saved.slice(0, -1).map((record) => ({stream: record.stream, processor: record.processor})));
		app.dispose();
	});
});

describe('a RELOAD replaces what it finds in the slot, having remembered nothing', () => {
	/**
	 * THE CASE NO IN-MEMORY RULE COULD REACH, and the reason the fact is a ROW.
	 *
	 * A page reload is a fresh process with an empty memory: the predicate that
	 * used to drop an abandoned successor was "what has THIS container registered
	 * and seen since it opened", which after a reload is nothing, so nothing was
	 * dropped and every reload left a generation behind. The second container here
	 * is that reload -- it shares only the IndexedDB under it -- and it replaces
	 * what the previous session left in `successor` without ever having been told
	 * about it.
	 */
	it('a second container over the same storage drops the successor the first one left', async () => {
		const name = freshName();
		const {registry} = await durableRegistry(name);
		const chain = fakeChain();
		const keepStream = keepStreamOnIndexedDB<TestABI>(name);

		const beforeReload = await openIndexer<TestABI, EntityStateView>({
			registry,
			provider: chain.provider,
			source: SOURCE,
			config: {keepStream, stream: {finality: FINALITY}},
			generations: [generationOver(await memoryStore(), processor, APP_IDENTITY)],
		});
		const abandoned = await beforeReload.add(
			generationOver(await memoryStore(editedTo(2)), editedTo(2), identityFor(2)),
		);
		expect(await slotsBy(registry)).toEqual({canonical: 'the-app', successor: 'edited-by-2', predecessor: undefined});

		// THE RELOAD: a container that has registered nothing and remembers nothing,
		// over the same records, arriving with the fold the developer saved last. It
		// opens the registry AFRESH as a new page load does, so nothing but the
		// IndexedDB under it is shared.
		const reloaded = await durableRegistry(name);
		const reloadedChain = fakeChain();
		const afterReload = await openIndexer<TestABI, EntityStateView>({
			registry: reloaded.registry,
			provider: reloadedChain.provider,
			source: SOURCE,
			config: {keepStream, stream: {finality: FINALITY}},
			generations: [
				generationOver(await memoryStore(), processor, APP_IDENTITY),
				generationOver(await memoryStore(editedTo(3)), editedTo(3), identityFor(3)),
			],
		});

		// the slot holds the fold this session arrived with, and the one the PREVIOUS
		// session left is gone -- row and state both
		expect(await slotsBy(registry)).toEqual({canonical: 'the-app', successor: 'edited-by-3', predecessor: undefined});
		expect((await registry.list()).length).toBe(2);
		expect(reloaded.dropped).toEqual([{stream: abandoned.record.stream, processor: abandoned.record.processor}]);
		// ...and the generation that answers reads is untouched by any of it
		expect(afterReload.canonical.record.processor).toBe(beforeReload.canonical.record.processor);

		// AND IT STILL FETCHES, which is the half the slot contents cannot say.
		//
		// A reloaded tab that opens, reports healthy and answers a plausible-looking
		// state while fetching NOTHING is the worst failure this container has, because
		// there is a UI attached to it and nothing about it looks wrong. It is reachable
		// only because slots made it reachable: before them a reload with a changed fold
		// registered a THIRD generation and the cap REFUSED, loudly, so the container
		// never opened. Replacing what `successor` holds is what lets it open -- so the
		// test that the reload REPLACES has to be the test that the reload still WORKS,
		// or this change trades a refusal for a silent stall.
		//
		// It is asserted HERE on the configuration this case needs -- BOTH folds, which
		// is the only way a container opens while the incumbent is still canonical -- and
		// that configuration is one no entry point produces, since a tab can only supply
		// the fold in the bundle that just loaded. The shape a real tab HAS is one fold
		// after a PROMOTION, it is where the stall actually lived, and it is the next
		// describe (ADR-0088).
		for (let round = 0; round < 20; round++) {
			const lastSync = await afterReload.indexMore();
			if (lastSync.lastToBlock >= lastSync.latestBlock) break;
		}
		expect(reloadedChain.ranges.length).toBeGreaterThan(0);
		expect(await readState(afterReload.state)).toEqual(EXPECTED_A);
	});

	/**
	 * A reload that changed NOTHING is not a reload that replaces something: the
	 * fold it arrives with is the one the pointer already names, so it stays
	 * canonical and takes nobody's place.
	 */
	it('leaves the slots exactly where they were when the reload changed nothing', async () => {
		const name = freshName();
		const {registry} = await durableRegistry(name);
		const keepStream = keepStreamOnIndexedDB<TestABI>(name);
		const config = {keepStream, stream: {finality: FINALITY}};

		const first = await openIndexer<TestABI, EntityStateView>({
			registry,
			provider: fakeChain().provider,
			source: SOURCE,
			config,
			generations: [generationOver(await memoryStore(), processor, APP_IDENTITY)],
		});
		const before = await registry.list();

		const reloaded = await durableRegistry(name);
		await openIndexer<TestABI, EntityStateView>({
			registry: reloaded.registry,
			provider: fakeChain().provider,
			source: SOURCE,
			config,
			generations: [generationOver(await memoryStore(), processor, APP_IDENTITY)],
		});

		expect((await registry.list()).map((record) => record.processor)).toEqual(before.map((record) => record.processor));
		expect(await slotsBy(registry)).toEqual({canonical: 'the-app', successor: undefined, predecessor: undefined});
		expect(reloaded.dropped).toEqual([]);
		expect(first.canonical.record).toEqual(before[0]);
	});
});

/**
 * A TAB THAT RELOADS AFTER A PROMOTION GOES ON INDEXING (ADR-0088).
 *
 * This is the shape a real tab HAS, and it is the one the stall lived in. A save
 * registers the edited fold beside the live one, the `on-catch-up` policy
 * promotes it, and this session RETAINS what that promotion superseded -- the
 * embedder turned the drop off (`aTabThatSavedAndPromoted`) -- so the previous
 * generation SURVIVES, named by no slot at all since ADR-0089. The reload then
 * supplies exactly ONE fold, because that is all a tab can supply: the previous
 * handler's code is not in the bundle that just loaded. Nothing collects that
 * survivor while the tab merely indexes; what collects it is the next SAVE, which
 * is the describe after the caps (ADR-0090 point 3).
 *
 * **On the DEFAULT there is no survivor at all**, because a promotion discards
 * what it superseded and hands it the stream in the same act (ADR-0090, points 1
 * and 2, asserted in the save-loop describe below). This describe is deliberately
 * the retained configuration: the rule it pins -- the fetcher is a fold the tab
 * actually HOLDS -- has to stay true for an embedder that keeps a way back, and
 * that is precisely the configuration the stall was measured on.
 *
 * The generation that fetches a stream used to be the oldest one REGISTERED on
 * it, so it was the one this tab does not hold -- and the tab's only fold became
 * a follower of a stream nothing writes. It opened healthy, answered reads and
 * reported `at-tip` while the chain moved on without it, because a follower never
 * calls `eth_blockNumber` and the host's pacing rule compared its frozen
 * `latestBlock` with itself. Measured, with the harness and the raw numbers kept
 * at `docs/spikes/the-reloaded-tab-stall-is-measured-on-the-configuration-a-tab-actually-has/`.
 *
 * **Asserted on the CHAIN READS, and never on the `follows` flag.** Every flag
 * and every status looked correct while the tab asked the node for nothing, so a
 * flag is precisely what this defect already had: the methods, the `eth_getLogs`
 * ranges, the cursor against the node's tip, and what the stored stream holds
 * afterwards are the evidence.
 */
describe('a tab that reloads AFTER A PROMOTION goes on FETCHING', () => {
	/** The state the extended branch folds to under the saved handler: six transfers counted by three. */
	const EXPECTED_AFTER_THE_RELOAD = {owners: {'1': BOB, '2': CAROL, '3': DAN, '4': undefined}, transfers: 18};

	it.each([
		{carriesItsState: false, what: 'a FRESH state, so it re-folds the stored stream from the start'},
		{carriesItsState: true, what: "the tab's OWN state, which survived the reload in IndexedDB"},
	])('fetches the blocks that arrived while it was closed, with $what', async ({carriesItsState}) => {
		const name = freshName();
		const chain = fakeChain();
		const {registry, keepStream, savedState} = await aTabThatSavedAndPromoted(name, chain);
		// the promotion happened and NOTHING is slotted behind it (ADR-0089); the previous
		// generation survives anyway, unslotted, and it is the one this tab is about to
		// NOT hold -- which is the configuration the stall lived in
		expect(await slotsBy(registry)).toEqual({
			canonical: 'edited-by-3',
			successor: undefined,
			predecessor: undefined,
		});
		expect((await registry.list()).map((record) => markerOf(record.processor))).toEqual(['the-app', 'edited-by-3']);

		// THE CHAIN MOVES ON while the tab is closed. Without it, "asked for nothing"
		// means "already at the tip" and the measurement says nothing.
		chain.serve(BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP);
		const callMark = chain.calls.length;
		const rangeMark = chain.ranges.length;

		// THE RELOAD: a fresh process over the same IndexedDB, holding exactly ONE fold.
		const reloaded = await durableRegistry(name);
		const afterReload = await openIndexer<TestABI, EntityStateView>({
			registry: reloaded.registry,
			provider: chain.provider,
			source: SOURCE,
			config: {keepStream, stream: {finality: FINALITY}},
			generations: [
				generationOver(carriesItsState ? savedState : await memoryStore(editedTo(3)), editedTo(3), identityFor(3)),
			],
		});
		await driveToTip(afterReload);

		// THE METHODS: the identity handshake is what a stalled tab made too, so what
		// separates the two is `eth_blockNumber` and `eth_getLogs` being there at all.
		expect(chain.callsByMethod(callMark)).toEqual({eth_chainId: 2, eth_blockNumber: 1, eth_getLogs: 1});
		// THE RANGES: one request, resuming above the stored cursor, up to the node's tip
		expect(chain.ranges.slice(rangeMark)).toEqual([{from: 102, to: BRANCH_A_EXTENDED_TIP}]);
		// ...so the tab is AT the tip rather than reporting that it is: a follower's
		// `latestBlock` is frozen where the last fetch left it, which is what made the
		// host's pacing rule answer `at-tip` two blocks behind
		expect(afterReload.canonical.lastSync?.lastToBlock).toBe(BRANCH_A_EXTENDED_TIP);
		expect(afterReload.canonical.lastSync?.latestBlock).toBe(BRANCH_A_EXTENDED_TIP);
		// ...the block that arrived while it was closed is FOLDED...
		expect(await readState(afterReload.state)).toEqual(EXPECTED_AFTER_THE_RELOAD);
		// ...and the stream it wrote has the new block ONCE and no hole under it
		expect(await storedStream(keepStream)).toEqual({
			events: 6,
			blocksPresent: [100, 102, 104, 106],
			deliveredTwice: [],
			coversTo: BRANCH_A_EXTENDED_TIP,
		});
		// the tab still holds exactly what a tab can hold, and the superseded generation
		// is still registered and still named by no slot: fetching is not bought by
		// dropping it, and a tab that reloads and then INDEXES collects nothing at all --
		// no timer, no sweep at `open`, and the fold this session arrived with is the one
		// the pointer already names, so it takes nobody's place (ADR-0090 point 3)
		expect(afterReload.generations.length).toBe(1);
		expect((await reloaded.registry.list()).map((record) => markerOf(record.processor))).toEqual([
			'the-app',
			'edited-by-3',
		]);
		expect(reloaded.dropped).toEqual([]);
		expect(await slotsBy(reloaded.registry)).toEqual({
			canonical: 'edited-by-3',
			successor: undefined,
			predecessor: undefined,
		});
	});

	/**
	 * THE ORDER PROBE, and the reason this task was not a one-line predicate.
	 *
	 * `open` populates the held set INCREMENTALLY -- one `add` per spec -- and `add`
	 * freezes the read-only stream view into the engine's config at construction. So
	 * a derivation that reads a HALF-BUILT held set answers differently depending on
	 * the order the caller listed its specs in, and the measured cost of that is two
	 * generations deciding they fetch, the same range requested twice and block 106's
	 * log stored twice: seven rows where six are correct.
	 *
	 * The property is therefore ONE FETCHER whichever way the same set is listed, and
	 * it is asserted on what reached the node and what reached the stream. The
	 * rejected candidate patch passes the case above and fails this one.
	 */
	it.each([
		{first: 'the app', edited: false},
		{first: 'the EDITED fold', edited: true},
	])('asks the node once and stores each log once, with $first listed first', async ({edited}) => {
		const name = freshName();
		const chain = fakeChain();
		const {registry} = await durableRegistry(name);
		const keepStream = keepStreamOnIndexedDB<TestABI>(name);
		const session = await openIndexer<TestABI, EntityStateView>({
			registry,
			provider: chain.provider,
			source: SOURCE,
			config: {keepStream, stream: {finality: FINALITY}},
			generations: [generationOver(await memoryStore(), processor, APP_IDENTITY)],
		});
		await driveToTip(session);
		await session.add(generationOver(await memoryStore(editedTo(2)), editedTo(2), identityFor(2)));
		chain.serve(BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP);
		const rangeMark = chain.ranges.length;

		const theApp = generationOver(await memoryStore(), processor, APP_IDENTITY);
		const theEdit = generationOver(await memoryStore(editedTo(3)), editedTo(3), identityFor(3));
		const reloaded = await durableRegistry(name);
		const afterReload = await openIndexer<TestABI, EntityStateView>({
			registry: reloaded.registry,
			provider: chain.provider,
			source: SOURCE,
			config: {keepStream, stream: {finality: FINALITY}},
			generations: edited ? [theEdit, theApp] : [theApp, theEdit],
		});
		await driveToTip(afterReload);

		// ONE generation fetches this stream, and it is the same one either way round:
		// the oldest PRESENT fold, which both orders agree about because the records
		// they are ranked by outlived the reload
		expect(afterReload.generations.filter((generation) => !generation.follows).length).toBe(1);
		// ONE request of the node, not one per fold that thinks it fetches
		expect(chain.ranges.slice(rangeMark)).toEqual([{from: 102, to: BRANCH_A_EXTENDED_TIP}]);
		// ...and the stream holds each log ONCE, which is the half a range count misses
		expect(await storedStream(keepStream)).toEqual({
			events: 6,
			blocksPresent: [100, 102, 104, 106],
			deliveredTwice: [],
			coversTo: BRANCH_A_EXTENDED_TIP,
		});
	});

	/**
	 * THE OTHER RELOAD IS STILL A LOUD REFUSAL, and it is a different bug class.
	 *
	 * With no promotion the incumbent is still canonical, so a tab arriving with the
	 * edited fold alone holds no fold for the generation that answers reads. That is
	 * refused at `open` and always was; narrowing the fetcher's candidate set to the
	 * folds the container HOLDS must not turn that refusal into an open container
	 * answering from a generation the registry says is not canonical.
	 */
	it('still REFUSES the changed-handler reload, which no promotion made legal', async () => {
		const name = freshName();
		const chain = fakeChain();
		const {registry} = await durableRegistry(name);
		const keepStream = keepStreamOnIndexedDB<TestABI>(name);
		const session = await openIndexer<TestABI, EntityStateView>({
			registry,
			provider: chain.provider,
			source: SOURCE,
			config: {keepStream, stream: {finality: FINALITY}},
			generations: [generationOver(await memoryStore(), processor, APP_IDENTITY)],
		});
		await driveToTip(session);
		chain.serve(BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP);

		const reloaded = await durableRegistry(name);
		await expect(
			openIndexer<TestABI, EntityStateView>({
				registry: reloaded.registry,
				provider: chain.provider,
				source: SOURCE,
				config: {keepStream, stream: {finality: FINALITY}},
				generations: [generationOver(await memoryStore(editedTo(3)), editedTo(3), identityFor(3))],
			}),
		).rejects.toThrow(CanonicalGenerationNotHeldError);
	});
});

describe('a replacement can never reach the canonical generation, and a promotion slots NOTHING behind it', () => {
	/**
	 * THE SAFETY PROPERTY, and the one axis on which this twin differs (ADR-0089).
	 *
	 * "Not canonical right now" is not the test on the receiving runtime, because
	 * there the REVERT TARGET is not canonical either and a rule that dropped what
	 * was merely not canonical would destroy the way back. HERE there is no revert
	 * target to protect: a pointer move in a tab assigns no `predecessor`, since the
	 * code that fold needs is not in the build. So what this asserts is the half that
	 * survives -- `canonical` is unreachable from a replacement -- plus the new fact,
	 * which is that the superseded generation is named by NOTHING and is dropped by
	 * nothing here either.
	 *
	 * It keeps room for THREE generations so the replacement has a pending successor
	 * to reach past; what the browser's own two mean is the next describe. And it
	 * RETAINS what the promotion superseded, because that generation is what a
	 * replacement must be shown not to reach: on the default it would simply have gone
	 * at the promotion (ADR-0090), which is a different claim, asserted below.
	 */
	it('leaves canonical where it is, and names the superseded generation by no slot', async () => {
		const name = freshName();
		const {registry, dropped} = await durableRegistry(name, {maxGenerations: 3});
		const keepStream = keepStreamOnIndexedDB<TestABI>(name);

		const container = await openIndexer<TestABI, EntityStateView>({
			registry,
			provider: fakeChain().provider,
			source: SOURCE,
			config: {keepStream, stream: {finality: FINALITY}},
			promotion: {dropOnPromotion: false},
			generations: [generationOver(await memoryStore(), processor, APP_IDENTITY)],
		});
		const promoted = await container.add(generationOver(await memoryStore(editedTo(2)), editedTo(2), identityFor(2)));
		await container.promote(promoted.record);
		// the pointer moved, and the generation it moved OFF is named by no slot: this
		// runtime can never instantiate it, so reserving a seat for it reserves nothing
		expect(await slotsBy(registry)).toEqual({canonical: 'edited-by-2', successor: undefined, predecessor: undefined});
		// ...and it is COLLECTABLE, not collected: nothing here deletes it
		expect((await registry.list()).map((record) => markerOf(record.processor))).toEqual(['the-app', 'edited-by-2']);
		expect(dropped).toEqual([]);

		const pending = await container.add(generationOver(await memoryStore(editedTo(3)), editedTo(3), identityFor(3)));
		expect(await slotsBy(registry)).toEqual({
			canonical: 'edited-by-2',
			successor: 'edited-by-3',
			predecessor: undefined,
		});
		expect(dropped).toEqual([]);

		// ...and a save on top of it replaces the PENDING one and reaches neither the
		// generation that answers reads nor the superseded one, which is retained here
		// for a reason that is no longer a slot: it FETCHES the stream all three are on
		// (ADR-0044), so dropping it would leave them folding a stream nothing appends to
		await container.add(generationOver(await memoryStore(editedTo(4)), editedTo(4), identityFor(4)));

		expect(await slotsBy(registry)).toEqual({
			canonical: 'edited-by-2',
			successor: 'edited-by-4',
			predecessor: undefined,
		});
		expect(dropped).toEqual([{stream: pending.record.stream, processor: pending.record.processor}]);
		expect(markerOf((await registry.fetcherOf(promoted.record.stream))?.processor)).toBe('the-app');
		// ...so while this session still holds its fold, the pointer can still be moved
		// back to it -- by NAMING it, which is what a revert in a browser always was
		await container.promote({stream: promoted.record.stream, processor: APP_IDENTITY});
		expect((await slotsBy(registry)).canonical).toBe('the-app');
	});
});

describe('what a cap of TWO means after a promotion', () => {
	/**
	 * THE ARITHMETIC, stated as a test because prose cannot settle it -- and
	 * MEASURED twice, because it has been wrong twice.
	 *
	 * `BROWSER_GENERATION_CAPS` is two generations. A promotion here slots NOTHING
	 * behind the pointer (ADR-0089), and it now also DISCARDS what it superseded and
	 * takes that generation's stream in the same act (ADR-0090, points 1 and 2). So
	 * after any promotion this tab holds exactly what it can use, and the second seat
	 * is free for the next save -- on BOTH kinds of save, which is what the two cases
	 * below are:
	 *
	 * 1. a CROSS-STREAM save (a source or filter edit) leaves the superseded
	 *    generation alone on its old stream, so the drop needs no hand-over at all;
	 * 2. a SAME-STREAM save loop -- the developer editing a handler, the common case
	 *    -- leaves it as the FETCHER of the stream the promoted fold is on, so the
	 *    promotion hands the stream over and then drops it. This is the case that
	 *    used to WALL: the drop was declined, the save met `maxGenerations` and the
	 *    only remedy was a page reload, which could not clear it either.
	 *
	 * The caps are UNCHANGED by any of this and nothing is evicted at the bound
	 * (ADR-0084): what frees the seat is a promotion finishing, not pressure.
	 */
	it('FREES the seat on a cross-stream save, because the superseded generation is alone on its stream', async () => {
		const name = freshName();
		const {registry, dropped} = await durableRegistry(name);
		const keepStream = keepStreamOnIndexedDB<TestABI>(name);

		const container = await openIndexer<TestABI, EntityStateView>({
			registry,
			provider: fakeChain().provider,
			source: SOURCE,
			config: {keepStream, stream: {finality: FINALITY}},
			generations: [generationOver(await memoryStore(), processor, APP_IDENTITY)],
		});
		// a RECONFIGURE, not a handler edit: a different fetch filter is a different
		// stream, so the app's generation is the only one left on the old one
		const reconfigured = await container.add(
			generationOver(await memoryStore(editedTo(2)), editedTo(2), identityFor(2), SOURCE_FROM_LATER_BLOCK),
		);
		await container.promote(reconfigured.record);
		expect(await slotsBy(registry)).toEqual({canonical: 'edited-by-2', successor: undefined, predecessor: undefined});
		// the promotion FINISHED: nothing on the old stream is left to hand anything to,
		// so the drop needed no hand-over and took the row and the state at the move
		expect(dropped.map((id) => markerOf(id.processor))).toEqual(['the-app']);

		// THE REGISTRATION THAT USED TO BE REFUSED: under `predecessor` the app's
		// generation was untouchable, so this third save met `maxGenerations` and threw
		const saved = await container.add(
			generationOver(await memoryStore(editedTo(3)), editedTo(3), identityFor(3), SOURCE_FROM_LATER_BLOCK),
		);

		expect(await slotsBy(registry)).toEqual({
			canonical: 'edited-by-2',
			successor: 'edited-by-3',
			predecessor: undefined,
		});
		expect((await registry.list()).map((record) => markerOf(record.processor))).toEqual(['edited-by-2', 'edited-by-3']);
		expect(registry.caps.maxGenerations).toBe(2);
		expect(saved.record.stream).toBe(reconfigured.record.stream);
	});

	/**
	 * THE SAVE LOOP, which is the behaviour the whole decision exists for.
	 *
	 * A developer editing a handler stays on ONE stream, so every successor is built
	 * as a FOLLOWER of the generation it will replace. That is what used to end the
	 * session: the drop was declined -- rightly, since dropping a stream's writer
	 * would leave its follower folding a stream nothing appends to (ADR-0044) -- so
	 * the second save met `GenerationCapReachedError` and no reload could clear it.
	 *
	 * Now the promotion HANDS THE STREAM OVER and drops the writer in the same act,
	 * so the loop keeps going: save, promote, save, promote, save. Asserted on what
	 * the tab ASKS THE CHAIN after each promotion, because "it still fetches" is the
	 * half a slot listing cannot say and the half a flag has already got wrong
	 * (ADR-0088).
	 */
	it('LANDS a same-stream save loop at the cap, because the promotion took the stream with it', async () => {
		const name = freshName();
		const chain = fakeChain();
		const {registry, dropped} = await durableRegistry(name);
		const keepStream = keepStreamOnIndexedDB<TestABI>(name);

		const container = await openIndexer<TestABI, EntityStateView>({
			registry,
			provider: chain.provider,
			source: SOURCE,
			config: {keepStream, stream: {finality: FINALITY}},
			generations: [generationOver(await memoryStore(), processor, APP_IDENTITY)],
		});
		await driveToTip(container);
		expect(await readState(container.state)).toEqual(EXPECTED_A);

		// THE FIRST SAVE: the edited fold follows the stream the app fetches, catches up,
		// and the default policy promotes it
		await container.add(generationOver(await memoryStore(editedTo(2)), editedTo(2), identityFor(2)));
		await driveToTip(container);
		expect(await slotsBy(registry)).toEqual({canonical: 'edited-by-2', successor: undefined, predecessor: undefined});
		expect(dropped.map((id) => markerOf(id.processor))).toEqual(['the-app']);
		expect((await registry.list()).map((record) => markerOf(record.processor))).toEqual(['edited-by-2']);

		// AND THE TAB GOES ON ASKING THE CHAIN, which is the fetch duty and not a flag:
		// the chain moves on and the promoted generation is what requests the new range
		chain.serve(BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP);
		const callMark = chain.calls.length;
		const rangeMark = chain.ranges.length;
		await driveToTip(container);
		expect(chain.callsByMethod(callMark)).toMatchObject({eth_blockNumber: expect.any(Number), eth_getLogs: 1});
		expect(chain.ranges.slice(rangeMark)).toEqual([{from: 102, to: BRANCH_A_EXTENDED_TIP}]);
		expect(container.canonical.lastSync?.lastToBlock).toBe(BRANCH_A_EXTENDED_TIP);
		expect(container.canonical.lastSync?.latestBlock).toBe(BRANCH_A_EXTENDED_TIP);
		// ...and it wrote what it fetched ONCE: two writers on one stream is the measured
		// data-loss defect this must not reintroduce
		expect(await storedStream(keepStream)).toEqual({
			events: 6,
			blocksPresent: [100, 102, 104, 106],
			deliveredTwice: [],
			coversTo: BRANCH_A_EXTENDED_TIP,
		});

		// THE SECOND SAVE, which is where this used to end in `GenerationCapReachedError`
		await container.add(generationOver(await memoryStore(editedTo(3)), editedTo(3), identityFor(3)));
		await driveToTip(container);
		expect(await slotsBy(registry)).toEqual({canonical: 'edited-by-3', successor: undefined, predecessor: undefined});
		expect(dropped.map((id) => markerOf(id.processor))).toEqual(['the-app', 'edited-by-2']);

		// AND A THIRD, with no reload anywhere in this test
		await container.add(generationOver(await memoryStore(editedTo(4)), editedTo(4), identityFor(4)));
		await driveToTip(container);

		// the count never climbed and the cap was never met: the seat was freed by a
		// promotion finishing, not by an eviction at the bound
		expect(registry.caps.maxGenerations).toBe(2);
		expect((await registry.list()).map((record) => markerOf(record.processor))).toEqual(['edited-by-4']);
		expect(await slotsBy(registry)).toEqual({canonical: 'edited-by-4', successor: undefined, predecessor: undefined});
		// the app is still indexing, the fold that answers is the one the developer just
		// saved, and every log is still in the stream exactly once (ADR-0087 keeps it)
		expect(await readState(container.state)).toEqual({
			owners: {'1': BOB, '2': CAROL, '3': DAN, '4': undefined},
			transfers: 24,
		});
		expect(await storedStream(keepStream)).toEqual({
			events: 6,
			blocksPresent: [100, 102, 104, 106],
			deliveredTwice: [],
			coversTo: BRANCH_A_EXTENDED_TIP,
		});
		expect(await registry.keptStreams()).toEqual([container.canonical.record.stream]);
		// ...and the tab is still the one fetching that stream, after two hand-overs
		const afterTheLoop = chain.ranges.length;
		chain.serve(BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP + 2);
		await driveToTip(container);
		expect(chain.ranges.length).toBeGreaterThan(afterTheLoop);
		expect(container.canonical.lastSync?.lastToBlock).toBe(BRANCH_A_EXTENDED_TIP + 2);
	});
});

/**
 * A RELOADED TAB COLLECTS THE GENERATION IT CAN NEVER RUN, ON A SAVE AND ONLY ON A
 * SAVE (ADR-0090, point 3).
 *
 * This is the wall a page reload could not clear, and it is the case the caps
 * arithmetic above ends in. After a promotion the superseded generation is named by
 * no slot (ADR-0089); after a RELOAD it is also a generation this tab holds no fold
 * for, because its code is not in the bundle that just loaded -- so it can never
 * answer a read and can never fetch, and until ADR-0090 nothing on this runtime ever
 * collected it: the developer's next save met `GenerationCapReachedError` with a row
 * no reload could remove, which is the wall this test is the fix for.
 *
 * **It is collected at a REGISTRATION and at no other moment.** Nothing fires on a
 * timer, nothing sweeps at `open`, and there is no new background deleter: the
 * reload above collects nothing at all, because the fold it arrives with is the one
 * `canonical` already names and so takes nobody's place. The deletion is a
 * consequence of an act the developer just performed, which is exactly the property
 * ADR-0084 refused an automatic reclaim for lacking.
 *
 * The STREAM is kept (ADR-0087), which is what makes the loss cheap: supplying the
 * old code again derives the same identity (ADR-0086) and re-folds bytes already on
 * disk, rather than asking a public node for history it may refuse.
 */
describe('a RELOADED tab COLLECTS the generation it holds no fold for, when a save needs room', () => {
	it('collects it on the SAVE, so the save that used to be REFUSED lands', async () => {
		const name = freshName();
		const chain = fakeChain();
		const {registry, keepStream} = await aTabThatSavedAndPromoted(name, chain);
		const streamBefore = await storedStream(keepStream);

		// THE RELOAD: a fresh process over the same IndexedDB, holding the ONE fold the
		// bundle carries -- and the superseded generation's row is still there, because
		// opening collects nothing
		const reloaded = await durableRegistry(name);
		const afterReload = await openIndexer<TestABI, EntityStateView>({
			registry: reloaded.registry,
			provider: chain.provider,
			source: SOURCE,
			config: {keepStream, stream: {finality: FINALITY}},
			generations: [generationOver(await memoryStore(editedTo(3)), editedTo(3), identityFor(3))],
		});
		await driveToTip(afterReload);
		expect(afterReload.generations.length).toBe(1);
		expect((await reloaded.registry.list()).map((record) => markerOf(record.processor))).toEqual([
			'the-app',
			'edited-by-3',
		]);
		expect(reloaded.dropped).toEqual([]);
		const answeredBeforeTheSave = await readState(afterReload.state);

		// THE NEXT SAVE, which is where this used to end in `GenerationCapReachedError`
		const saved = await afterReload.add(generationOver(await memoryStore(editedTo(4)), editedTo(4), identityFor(4)));

		// the row went, and its state namespace went with it...
		expect((await reloaded.registry.list()).map((record) => markerOf(record.processor))).toEqual([
			'edited-by-3',
			'edited-by-4',
		]);
		expect(reloaded.dropped.map((id) => markerOf(id.processor))).toEqual(['the-app']);
		// ...the save landed in the slot, under a cap nothing raised and nothing evicted
		// at the bound: what freed the seat is a generation that could never run, not
		// pressure
		expect(await slotsBy(reloaded.registry)).toEqual({
			canonical: 'edited-by-3',
			successor: 'edited-by-4',
			predecessor: undefined,
		});
		expect(reloaded.registry.caps.maxGenerations).toBe(2);
		expect(markerOf(saved.record.processor)).toBe('edited-by-4');
		// ...the UI is untouched: the canonical generation answers exactly what it
		// answered before the collection, and it is still the one that FETCHES
		expect(await readState(afterReload.state)).toEqual(answeredBeforeTheSave);
		expect(afterReload.canonical.follows).toBe(false);
		expect(markerOf((await reloaded.registry.fetcherOf(saved.record.stream))?.processor)).toBe('edited-by-3');
		// ...and the STREAM is KEPT, every event of it: no drop reaps one (ADR-0087), so
		// the fold that just arrived re-folds bytes already on disk
		expect(await storedStream(keepStream)).toEqual(streamBefore);
		expect(await reloaded.registry.keptStreams()).toEqual([saved.record.stream]);
	});
});

describe('the replaced generation is RECLAIMED in this runtime storage shape', () => {
	/**
	 * A generation's state here is a KEYSPACE OF ITS OWN -- an IndexedDB database
	 * the app named -- rather than the receiving twin's table namespace (ADR-0053),
	 * and that contrast is why this is a port and not a copy. So the claim worth
	 * asserting in this package is the one the substrate answers: the replaced
	 * generation's database really GOES, and a fresh handle on it reads nothing
	 * back. Unregistering it alone would leave a tab paying for every fold it ever
	 * abandoned, in the runtime with the least room to pay.
	 */
	it('deletes the replaced generation own database, not merely its record', async () => {
		const name = freshName();
		const databaseNameOf = (marker: string) => `${name}-${marker}`;
		const connections = new Map<string, IndexedDBStateStore>();

		const registry = await openGenerationRegistryOnIndexedDB(name, {
			// what a host's `dropState` really is on the IndexedDB default: close the
			// connection, then delete the database that generation folded into. A host
			// looks the database up BY THE IDENTITY it was handed and never by reading
			// anything out of it -- nothing parses a generation identity (ADR-0086) --
			// so this fixture keys its connections on the identity too.
			dropState: async (id) => {
				const store = connections.get(id.processor);
				if (!store) return;
				await store.close();
				await new Promise<void>((resolve, reject) => {
					const request = indexedDB.deleteDatabase(store.databaseName);
					request.onsuccess = () => resolve();
					request.onerror = () => reject(request.error);
				});
			},
		});

		const realStore = async (
			definition: EntityProcessor<TestABI>,
			processorIdentity: string,
		): Promise<WritableStateStore> => {
			const store = new IndexedDBStateStore(definition.entities, {
				databaseName: databaseNameOf(markerOf(processorIdentity) as string),
			});
			await store.migrate();
			connections.set(processorIdentity, store);
			return openForWriting(store);
		};

		const container = await openIndexer<TestABI, EntityStateView>({
			registry,
			provider: fakeChain().provider,
			source: SOURCE,
			config: {keepStream: keepStreamOnIndexedDB<TestABI>(name), stream: {finality: FINALITY}},
			generations: [generationOver(await realStore(processor, APP_IDENTITY), processor, APP_IDENTITY)],
		});

		const abandoned = editedTo(2);
		const pendingState = await realStore(abandoned, identityFor(2));
		const pending = await container.add(generationOver(pendingState, abandoned, identityFor(2)));
		// something of its own is in there, so "it went" is a claim about rows
		await pendingState.applyBlock({number: 1, hash: '0x1', timestamp: 1}, [
			{type: 'upsert', entity: 'counter', id: {name: 'transfers'}, values: {value: 99}},
		]);
		expect(await pendingState.getCurrent('counter', {name: 'transfers'})).toBeDefined();

		const replacement = editedTo(3);
		await container.add(generationOver(await realStore(replacement, identityFor(3)), replacement, identityFor(3)));

		// the record is gone...
		expect((await registry.list()).map((record) => record.processor)).not.toContain(pending.record.processor);
		// ...and so is the keyspace it folded into: a fresh handle on that database
		// reads nothing back
		const reopened = new IndexedDBStateStore(abandoned.entities, {
			databaseName: databaseNameOf(markerOf(identityFor(2)) as string),
		});
		await reopened.migrate();
		expect(await reopened.getCurrent('counter', {name: 'transfers'})).toBeUndefined();
	});
});
