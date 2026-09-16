import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {
	GenerationCapReachedError,
	openIndexer,
	type AnyGenerationSpec,
	type GenerationId,
	type GenerationRecord,
	type GenerationRegistry,
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
	entityProcessorOver,
	EXPECTED_A,
	fakeChain,
	FINALITY,
	indexToTip,
	processor,
	processorVariant,
	readState,
	SOURCE,
	type TestABI,
} from '../browser/workload.js';

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

/** The fold a save produces: the same events, counted differently, so a READ says which one answered. */
const editedTo = (countBy: number) => processorVariant({version: `${countBy}.0.0`, countBy});

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
): AnyGenerationSpec<TestABI, EntityStateView> {
	let fold: EntityEventProcessor<TestABI> | undefined;
	return {
		createState: () => store,
		createProcessor: (state) => (fold = entityProcessorOver(state as WritableStateStore, definition)),
		stateOf: () => (fold as EntityEventProcessor<TestABI>).state,
	};
}

/** What each slot holds, as the `countBy` of the fold it names, so an assertion reads as a sentence. */
async function slotsBy(registry: GenerationRegistry): Promise<Record<string, string | undefined>> {
	const held = await registry.slots();
	const version = (record: GenerationRecord | undefined) => record?.processor.split('-')[0];
	return {
		canonical: version(held.canonical),
		successor: version(held.successor),
		predecessor: version(held.predecessor),
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
			});
			saved.push(held.record);

			// ONE pending successor at a time, whatever the developer did before it
			expect(await slotsBy(registry)).toEqual({
				canonical: '1.0.0',
				successor: `${countBy}.0.0`,
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
			generations: [generationOver(await memoryStore(), processor)],
		});
		const abandoned = await beforeReload.add(generationOver(await memoryStore(editedTo(2)), editedTo(2)));
		expect(await slotsBy(registry)).toEqual({canonical: '1.0.0', successor: '2.0.0', predecessor: undefined});

		// THE RELOAD: a container that has registered nothing and remembers nothing,
		// over the same records, arriving with the fold the developer saved last. It
		// opens the registry AFRESH as a new page load does, so nothing but the
		// IndexedDB under it is shared.
		const reloaded = await durableRegistry(name);
		const afterReload = await openIndexer<TestABI, EntityStateView>({
			registry: reloaded.registry,
			provider: fakeChain().provider,
			source: SOURCE,
			config: {keepStream, stream: {finality: FINALITY}},
			generations: [
				generationOver(await memoryStore(), processor),
				generationOver(await memoryStore(editedTo(3)), editedTo(3)),
			],
		});

		// the slot holds the fold this session arrived with, and the one the PREVIOUS
		// session left is gone -- row and state both
		expect(await slotsBy(registry)).toEqual({canonical: '1.0.0', successor: '3.0.0', predecessor: undefined});
		expect((await registry.list()).length).toBe(2);
		expect(reloaded.dropped).toEqual([{stream: abandoned.record.stream, processor: abandoned.record.processor}]);
		// ...and the generation that answers reads is untouched by any of it
		expect(afterReload.canonical.record.processor).toBe(beforeReload.canonical.record.processor);
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
			generations: [generationOver(await memoryStore(), processor)],
		});
		const before = await registry.list();

		const reloaded = await durableRegistry(name);
		await openIndexer<TestABI, EntityStateView>({
			registry: reloaded.registry,
			provider: fakeChain().provider,
			source: SOURCE,
			config,
			generations: [generationOver(await memoryStore(), processor)],
		});

		expect((await registry.list()).map((record) => record.processor)).toEqual(before.map((record) => record.processor));
		expect(await slotsBy(registry)).toEqual({canonical: '1.0.0', successor: undefined, predecessor: undefined});
		expect(reloaded.dropped).toEqual([]);
		expect(first.canonical.record).toEqual(before[0]);
	});
});

describe('a replacement can never reach the canonical generation or the revert target', () => {
	/**
	 * THE SAFETY PROPERTY, asserted directly as it is in the receiving twin.
	 *
	 * "Not canonical right now" is not the test, and this is why: after a promotion
	 * the REVERT TARGET is not canonical either, and a rule that dropped what was
	 * merely not canonical would silently destroy the way back. The test is the
	 * SLOT -- a generation `canonical` or `predecessor` names is unreachable from a
	 * replacement.
	 *
	 * It needs room for THREE generations, because three slots occupied at once is
	 * three generations; what the browser's own two mean is the next test.
	 */
	it('leaves canonical and predecessor exactly where they are', async () => {
		const name = freshName();
		const {registry, dropped} = await durableRegistry(name, {maxGenerations: 3});
		const keepStream = keepStreamOnIndexedDB<TestABI>(name);

		const container = await openIndexer<TestABI, EntityStateView>({
			registry,
			provider: fakeChain().provider,
			source: SOURCE,
			config: {keepStream, stream: {finality: FINALITY}},
			generations: [generationOver(await memoryStore(), processor)],
		});
		const promoted = await container.add(generationOver(await memoryStore(editedTo(2)), editedTo(2)));
		await container.promote(promoted.record);
		// the pointer moved, so the generation it moved OFF is what `predecessor`
		// names: the one a revert returns to
		expect(await slotsBy(registry)).toEqual({canonical: '2.0.0', successor: undefined, predecessor: '1.0.0'});

		const pending = await container.add(generationOver(await memoryStore(editedTo(3)), editedTo(3)));
		expect(await slotsBy(registry)).toEqual({canonical: '2.0.0', successor: '3.0.0', predecessor: '1.0.0'});
		expect(dropped).toEqual([]);

		// ...and a save on top of it replaces the PENDING one and reaches neither of
		// the other two
		await container.add(generationOver(await memoryStore(editedTo(4)), editedTo(4)));

		expect(await slotsBy(registry)).toEqual({canonical: '2.0.0', successor: '4.0.0', predecessor: '1.0.0'});
		expect(dropped).toEqual([{stream: pending.record.stream, processor: pending.record.processor}]);
		// the way back is still there, and still exact
		await container.promote((await registry.slots()).predecessor as GenerationRecord);
		expect((await slotsBy(registry)).canonical).toBe('1.0.0');
	});
});

describe('what a cap of TWO means under three slots', () => {
	/**
	 * THE ARITHMETIC, stated as a test because prose cannot settle it.
	 *
	 * There are three slots and `BROWSER_GENERATION_CAPS` is two generations, so a
	 * tab holds `canonical` + `successor` (the reconfigure loop above, which this
	 * change makes unbounded) OR `canonical` + `predecessor` (the revert window a
	 * promotion opens), and never all three. A registration that would need all
	 * three meets the cap and is REFUSED.
	 *
	 * The refusal is the right end of that trade and is deliberately not softened:
	 * dropping the revert target to make room would be an EVICTION, and no policy
	 * can know which generation was being kept -- while a refusal costs one action
	 * and cannot lose a state that may not be re-indexable at all from a public
	 * node. The caps are unchanged by this change (ADR-0084).
	 */
	it('REFUSES a third generation rather than dropping the revert target', async () => {
		const name = freshName();
		const {registry, dropped} = await durableRegistry(name);
		const keepStream = keepStreamOnIndexedDB<TestABI>(name);

		const container = await openIndexer<TestABI, EntityStateView>({
			registry,
			provider: fakeChain().provider,
			source: SOURCE,
			config: {keepStream, stream: {finality: FINALITY}},
			generations: [generationOver(await memoryStore(), processor)],
		});
		const successor = await container.add(generationOver(await memoryStore(editedTo(2)), editedTo(2)));
		await container.promote(successor.record);
		expect(await slotsBy(registry)).toEqual({canonical: '2.0.0', successor: undefined, predecessor: '1.0.0'});

		await expect(container.add(generationOver(await memoryStore(editedTo(3)), editedTo(3)))).rejects.toThrow(
			GenerationCapReachedError,
		);

		// nothing was evicted to make room, and the thing that was NOT evicted is
		// precisely the generation a revert needs
		expect(dropped).toEqual([]);
		expect(await slotsBy(registry)).toEqual({canonical: '2.0.0', successor: undefined, predecessor: '1.0.0'});
		expect((await registry.list()).length).toBe(2);
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
		const databaseNameOf = (version: string) => `${name}-${version}`;
		const connections = new Map<string, IndexedDBStateStore>();

		const registry = await openGenerationRegistryOnIndexedDB(name, {
			// what a host's `dropState` really is on the IndexedDB default: close the
			// connection, then delete the database that generation folded into. The
			// version is the head of the version hash, which is how this app named its
			// databases.
			dropState: async (id) => {
				const store = connections.get(id.processor.split('-')[0] as string);
				if (!store) return;
				await store.close();
				await new Promise<void>((resolve, reject) => {
					const request = indexedDB.deleteDatabase(store.databaseName);
					request.onsuccess = () => resolve();
					request.onerror = () => reject(request.error);
				});
			},
		});

		const realStore = async (definition: EntityProcessor<TestABI>): Promise<WritableStateStore> => {
			const store = new IndexedDBStateStore(definition.entities, {databaseName: databaseNameOf(definition.version)});
			await store.migrate();
			connections.set(definition.version, store);
			return openForWriting(store);
		};

		const container = await openIndexer<TestABI, EntityStateView>({
			registry,
			provider: fakeChain().provider,
			source: SOURCE,
			config: {keepStream: keepStreamOnIndexedDB<TestABI>(name), stream: {finality: FINALITY}},
			generations: [generationOver(await realStore(processor), processor)],
		});

		const abandoned = editedTo(2);
		const pendingState = await realStore(abandoned);
		const pending = await container.add(generationOver(pendingState, abandoned));
		// something of its own is in there, so "it went" is a claim about rows
		await pendingState.applyBlock({number: 1, hash: '0x1', timestamp: 1}, [
			{type: 'upsert', entity: 'counter', id: {name: 'transfers'}, values: {value: 99}},
		]);
		expect(await pendingState.getCurrent('counter', {name: 'transfers'})).toBeDefined();

		const replacement = editedTo(3);
		await container.add(generationOver(await realStore(replacement), replacement));

		// the record is gone...
		expect((await registry.list()).map((record) => record.processor)).not.toContain(pending.record.processor);
		// ...and so is the keyspace it folded into: a fresh handle on that database
		// reads nothing back
		const reopened = new IndexedDBStateStore(abandoned.entities, {databaseName: databaseNameOf(abandoned.version)});
		await reopened.migrate();
		expect(await reopened.getCurrent('counter', {name: 'transfers'})).toBeUndefined();
	});
});
