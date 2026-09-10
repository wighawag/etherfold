import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import type {Abi} from '@etherfold/core';
import {EntityEventProcessor, type EntityStateView} from '@etherfold/processor-entities';
import {MemoryStateStore, openForWriting, type StateStore, type WritableStateStore} from '@etherfold/state-store';
import {createBrowserStateStore, createIndexerState} from '../src/index.js';
import {processor as entityProcessor, fakeChain, FINALITY, SOURCE, type TestABI} from '../browser/workload.js';

/**
 * WHAT THE HOOK ACCEPTS AND WHAT IT REFUSES. Every call below is a SUBJECT, not
 * a caller.
 *
 * It used to take a union -- a `{kind, processor}` tag, or a free-form
 * `EventProcessorWithInitialState` bare, which meant `'js-object'`. That second
 * authoring path is deleted (ADR-0037); so is the third, a processor already
 * built over a store, which meant exactly ONE generation and which an indexer
 * holding several can never be handed. What is left is the FACTORIES.
 *
 * **`pnpm typecheck` is what runs half of this file.** Each `@ts-expect-error`
 * FAILS the typecheck if the line it guards starts compiling, which is the only
 * way to assert that something is NOT accepted.
 */

type State = {count: number};

describe('the shape createIndexerState takes', () => {
	it('takes the two FACTORIES a generation is built from, and seeds its store from the processor READ HANDLE', async () => {
		const indexer = createIndexerState<TestABI, EntityStateView>({
			createState: async () => openForWriting(new MemoryStateStore(entityProcessor.entities)),
			createProcessor: (store) => new EntityEventProcessor<TestABI>(store, entityProcessor),
		});
		// the generation is BUILT at init -- state first, then the fold over it --
		// which is why the handle is asked for afterwards and not before
		await indexer.init({provider: fakeChain().provider, source: SOURCE, config: {stream: {finality: FINALITY}}});

		// there is no initial state to CREATE: the state lives in the store and is
		// read back through a handle that exists the moment the processor does
		expect(typeof indexer.state.$state.getCurrent).toBe('function');
		indexer.dispose();
	});

	it('does not compile the shapes the retired paths used', () => {
		// Deliberately never CALLED: the assertions here are the `@ts-expect-error`
		// comments, which `pnpm typecheck` evaluates. Vitest strips types, so running
		// the body would only construct indexers nobody drives.
		function refusals(entity: EntityEventProcessor<TestABI>, store: StateStore) {
			// @ts-expect-error the KIND TAG is gone: the argument is the factories, not a wrapper around a processor
			createIndexerState<TestABI, EntityStateView>({kind: 'entities', processor: entity});
			// the free-form processor the retired path produced, as a value so the
			// refusal below lands on the CALL rather than on one property of a literal
			const freeForm = {
				getVersionHash: () => 'v1',
				getCodeFingerprint: () => undefined,
				createInitialState: () => ({count: 0}),
				configure: () => {},
				load: async () => undefined,
				process: async () => ({count: 0}),
				reset: async () => {},
				clear: async () => {},
			};
			// @ts-expect-error it builds no generation, so it is not something this hook takes
			createIndexerState<Abi, State>(freeForm);
			// A processor ALREADY BUILT over a store, which is the one-generation shape
			// `the-old-indexer-shape-is-deleted` removed: an indexer holds any number of
			// generations and each folds into its OWN state, so a value handed over once
			// can never be what the next generation folds into.
			// @ts-expect-error it is the fold itself and not the factory that builds one
			createIndexerState<TestABI, EntityStateView>(entity);
			const spec = {createState: () => store, createProcessor: () => entity};
			// @ts-expect-error and the `keepState` option went with the keeper family it configured
			createIndexerState<TestABI, EntityStateView>(spec, {keepState: store});
		}

		expect(typeof refusals).toBe('function');
	});
});

/**
 * A store is built by a FACTORY over declarations, and there is nothing else it
 * could be.
 *
 * `createBrowserStateStore` used to sit beside `keepStateOnIndexedDB`, which
 * wrote to the same database through a completely different seam; the pair was
 * the one place a "simplification" could collapse two models into one. The
 * keeper is gone, and this is what keeps the surviving one typed.
 */
describe('where a browser deployment says its state lives', () => {
	it('does not accept anything but a StateStore factory as the backend', () => {
		// typecheck-only, as above.
		function refusals() {
			createBrowserStateStore(entityProcessor.entities, {
				// @ts-expect-error a `{fetch, save, clear}` keeper is not a `StateStore` factory
				backend: () => ({fetch: async () => undefined, save: async () => {}, clear: async () => {}}),
			});
		}

		expect(typeof refusals).toBe('function');
	});
});
