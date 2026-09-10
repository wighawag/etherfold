import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {openIndexer, type GenerationContext, type GenerationSpec} from '@etherfold/core';
import {MemoryStateStore, openForWriting, type WritableStateStore} from '@etherfold/state-store';
import type {EntityEventProcessor, EntityProcessor, EntityStateView} from '@etherfold/processor-entities';
import {createIndexerState, openGenerationRegistryOnIndexedDB} from '../src/index.js';
import {
	BRANCH_A_TIP,
	EXPECTED_A,
	entityProcessorOver,
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
 * THE GENERATION CONTAINER, from the browser side: the factories, and the handle
 * that follows the canonical pointer.
 *
 * An indexer holds any number of GENERATIONS -- a stream plus a fold over it --
 * and one of them is canonical and answers every read. This file asserts the two
 * things that are only observable here, on the ENTITY path with real stores:
 *
 * - `createIndexerState` is handed the two FACTORIES a generation is built from,
 *   calls them once each in that order, and indexes.
 * - the state handle a consumer holds is INDIRECT, so holding it across a
 *   pointer move is never a way to read a retired generation (story 6).
 *
 * The container's own rules -- the pointer applied AT a notification, one
 * generation per read interval, a discard PUBLISHED -- are asserted where they
 * live, in `@etherfold/core`'s `container.test.ts`.
 */

let counter = 0;
const freshName = () => `generation-container-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/** A registry on the substrate a browser really uses, so the container is exercised over it. */
function browserRegistry() {
	return openGenerationRegistryOnIndexedDB(freshName(), {
		// Nothing to drop: every store in this file is a memory store the test owns.
		dropState: async () => {},
	});
}

describe('createIndexerState takes the factories a generation is built from', () => {
	it('indexes when handed the FACTORIES that build one', async () => {
		const chain = fakeChain();
		const built: {states: number; processors: number; context: GenerationContext | undefined} = {
			states: 0,
			processors: 0,
			context: undefined,
		};

		const indexer = createIndexerState<TestABI, EntityStateView>({
			registry: await browserRegistry(),
			createState: async (context) => {
				built.states++;
				built.context = context;
				const store = await openForWriting(new MemoryStateStore(processor.entities));
				return store;
			},
			createProcessor: (store, context) => {
				built.processors++;
				expect(context).toEqual(built.context);
				return entityProcessorOver(store, processor);
			},
		});
		await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
		await indexToTip(indexer);

		// the state the fold lands on, from factories the hook called itself: state
		// first, then the fold over it, once each
		expect(await readState(indexer.state.$state)).toEqual(EXPECTED_A);
		expect(built).toMatchObject({states: 1, processors: 1});
		// the context names the STREAM, which is the half of a generation's identity
		// that is known before the fold exists
		expect(built.context?.stream).toMatch(/^[0-9a-f]{32}$/);
		indexer.dispose();
	});

	it('publishes a handle whose identity is stable, so a subscriber may keep it', async () => {
		const chain = fakeChain();
		const indexer = createIndexerState<TestABI, EntityStateView>({
			registry: await browserRegistry(),
			createState: async () => {
				const store = await openForWriting(new MemoryStateStore(processor.entities));
				return store;
			},
			createProcessor: (store) => entityProcessorOver(store, processor),
		});
		await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});

		const handle = indexer.state.$state;
		await indexToTip(indexer);

		expect(indexer.state.$state).toBe(handle);
		expect(await readState(handle)).toEqual(EXPECTED_A);
		indexer.dispose();
	});
});

/**
 * One generation over a store the test already owns: the two factories, plus the
 * entity path's read HANDLE.
 *
 * `stateOf` is what lets the container answer from a generation that has folded
 * nothing yet -- which is what a just-promoted generation is, and the whole
 * reason the entity path hands back a handle rather than a state object.
 */
function generationOver(
	store: WritableStateStore,
	definition: EntityProcessor<TestABI>,
): GenerationSpec<TestABI, EntityStateView, WritableStateStore> {
	let fold: EntityEventProcessor<TestABI> | undefined;
	return {
		createState: () => store,
		createProcessor: (state) => (fold = entityProcessorOver(state, definition)),
		stateOf: () => (fold as EntityEventProcessor<TestABI>).state,
	};
}

describe('the entities-path handle is INDIRECT', () => {
	/**
	 * Story 6, on real stores: a reader holding a state handle across a pointer
	 * move keeps answering, from whichever generation is NOW canonical.
	 *
	 * The second generation's state is FOLDED SEPARATELY beforehand, under logic
	 * that counts by two, so the two generations disagree about a number a read
	 * can quote. A handle that had stayed bound to the generation it was created
	 * against would go on answering 5 after the promotion, which is precisely the
	 * silent staleness this indirection removes -- and an empty second store would
	 * not have told the two apart from "the promotion broke the read".
	 */
	it('keeps answering across a pointer move, from the newly canonical generation', async () => {
		const definitionV2 = processorVariant({version: '2.0.0', countBy: 2});

		// generation B's state, folded on its own: same events, different fold
		const storeB = await openForWriting(new MemoryStateStore(definitionV2.entities));
		const seeding = createIndexerState<TestABI, EntityStateView>({
			createState: () => storeB,
			createProcessor: (state) => entityProcessorOver(state, definitionV2),
		});
		await seeding.init({provider: fakeChain().provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
		await indexToTip(seeding);
		expect((await readState(seeding.state.$state)).transfers).toBe(EXPECTED_A.transfers * 2);
		seeding.dispose();

		const storeA = await openForWriting(new MemoryStateStore(processor.entities));

		const chain = fakeChain();
		const container = await openIndexer<TestABI, EntityStateView>({
			registry: await browserRegistry(),
			provider: chain.provider,
			source: SOURCE,
			config: {stream: {finality: FINALITY}},
			generations: [generationOver(storeA, processor), generationOver(storeB, definitionV2)],
		});

		await container.load();
		let lastSync = await container.indexMore();
		while (lastSync.lastToBlock < BRANCH_A_TIP) {
			lastSync = await container.indexMore();
		}

		// the reader takes the handle ONCE and never asks for it again
		const handle = container.state;
		expect(await readState(handle)).toEqual(EXPECTED_A);

		await container.promote(container.generations[1].record);

		expect(await readState(handle)).toMatchObject({transfers: EXPECTED_A.transfers * 2});
		expect(container.state).toBe(handle);

		// ...and back, because moving the pointer BACK is how a promotion is reverted
		await container.promote(container.generations[0].record);
		expect(await readState(handle)).toEqual(EXPECTED_A);
	});
});
