import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {MemoryStateStore, openForWriting, type WritableStateStore} from '@etherfold/state-store';
import {IndexedDBStateStore} from '@etherfold/state-store-indexeddb';
import {PatchStateStore} from '@etherfold/state-store-patch';
import {createBrowserStateStore} from '../src/index.js';
import {
	BRANCH_A_TIP,
	BRANCH_B,
	BRANCH_B_TIP,
	EXPECTED_A,
	EXPECTED_B,
	fakeChain,
	FINALITY,
	indexerFor,
	indexToTip,
	processor,
	readState,
	runWorkload,
	SOURCE,
	START_BLOCK,
} from '../browser/workload.js';

/**
 * A browser tab indexing with an ENTITY processor, on a backend the application
 * chose.
 *
 * This is the join the spec's headline needed and nothing had: `@etherfold/browser`
 * could build a `StateStore` (`createBrowserStateStore`) and could run an
 * indexer (`createIndexerState`), and the two could not be connected, because the
 * hook's processor type was the free-form `EventProcessorWithInitialState` and an
 * entity processor is not one.
 *
 * What runs in a REAL engine, through the same workload object, is
 * `browser/indexing.spec.ts`; these are the same claims under `fake-indexeddb`,
 * on every commit, because the browser run needs three browser binaries a clean
 * CI checkout does not have.
 */

let counter = 0;
const freshName = () => `entity-indexing-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * The lowest block a resumed round may ask for.
 *
 * `getFromBlock` deliberately re-scans back to `latestBlock - finality` on every
 * round, because that is the window a reorg can still reach. Resuming means
 * asking from inside THAT window; re-indexing means asking from the start block.
 */
const RESUME_FLOOR = BRANCH_A_TIP - FINALITY;

describe('indexing through the hook with an entity processor', () => {
	it('lands on the expected state, on the IndexedDB default', async () => {
		const store = await openForWriting(await createBrowserStateStore(processor.entities, {databaseName: freshName()}));

		const {state, lastSync} = await runWorkload(store);

		expect(state).toEqual(EXPECTED_A);
		expect(lastSync.lastToBlock).toBe(lastSync.latestBlock);
	});

	/**
	 * The backend is a line of configuration and the processor is untouched.
	 *
	 * Demonstrated rather than asserted: the SAME `processor` object from the
	 * workload is handed to three stores that were never told about each other,
	 * and the three runs are compared to one another rather than each to a
	 * hand-written expectation.
	 */
	it('lands on the same state whichever backend the deployment picked', async () => {
		const backends: {name: string; open(): Promise<WritableStateStore>}[] = [
			{
				name: 'indexeddb (the default)',
				open: async () =>
					openForWriting(await createBrowserStateStore(processor.entities, {databaseName: freshName()})),
			},
			{
				name: 'the light patch store',
				open: async () =>
					openForWriting(
						await createBrowserStateStore(processor.entities, {
							backend: (declarations) => new PatchStateStore(declarations, {finalityDepth: FINALITY}),
						}),
					),
			},
			{
				name: 'memory',
				open: async () =>
					openForWriting(await createBrowserStateStore(processor.entities, {backend: (d) => new MemoryStateStore(d)})),
			},
		];

		for (const backend of backends) {
			const {state} = await runWorkload(await backend.open());
			expect(state, backend.name).toEqual(EXPECTED_A);
		}
	});

	/**
	 * A reorg through the browser path, with the counter that must come DOWN.
	 *
	 * The canonical bug this design exists to make impossible is a stored counter
	 * that does not decrease when its block is reverted, so it gets its own
	 * assertion on both a versioned-rows backend and the patch log.
	 */
	it.each([
		[
			'indexeddb',
			async () => openForWriting(await createBrowserStateStore(processor.entities, {databaseName: freshName()})),
		],
		[
			'patch',
			async () =>
				openForWriting(
					await createBrowserStateStore(processor.entities, {
						backend: (d) => new PatchStateStore(d, {finalityDepth: FINALITY}),
					}),
				),
		],
	])('reverts a reorg and the counter decreases (%s)', async (_name, open) => {
		const chain = fakeChain();
		const store = await open();
		const indexer = indexerFor(store);
		await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});

		await indexToTip(indexer);
		expect(await readState(indexer.state.$state)).toEqual(EXPECTED_A);

		chain.serve(BRANCH_B, BRANCH_B_TIP);
		await indexToTip(indexer);

		const after = await readState(indexer.state.$state);
		expect(after).toEqual(EXPECTED_B);
		expect(after.transfers).toBeLessThan(EXPECTED_A.transfers);
		indexer.dispose();
	});
});

/**
 * Reload continuity, which is the risk that is specific to a browser.
 *
 * A server keeps its cursor next to its state in one database and restarts into
 * it. A tab is CLOSED, and what it finds when it opens again is the whole
 * question. The cursor lives behind the storage seam (ADR-0027), so it survives
 * exactly as far as the store it was written into does -- which is the reason
 * these two cases have different right answers rather than one being a bug.
 */
describe('closing the tab and opening it again', () => {
	it('resumes from the cursor on the persistent backend, instead of re-indexing', async () => {
		const databaseName = freshName();
		const chain = fakeChain();

		const first = await runWorkload(
			await openForWriting(await createBrowserStateStore(processor.entities, {databaseName})),
			chain,
		);
		expect(first.state).toEqual(EXPECTED_A);
		expect(first.ranges[0].from).toBe(START_BLOCK);

		// the tab is gone: a NEW store over the same database, a NEW processor, a
		// NEW hook. Nothing but IndexedDB carries anything across.
		const reopenedChain = fakeChain();
		const second = await runWorkload(
			await openForWriting(await createBrowserStateStore(processor.entities, {databaseName})),
			reopenedChain,
		);

		expect(second.state).toEqual(EXPECTED_A);
		// the point: the second tab never asked for the start block again. It asked
		// from inside the unconfirmed window it had recorded, which is the re-scan
		// every round does, not a re-index.
		expect(second.ranges[0].from).toBeGreaterThan(START_BLOCK);
		expect(second.ranges[0].from).toBeGreaterThanOrEqual(RESUME_FLOOR);
	});

	/**
	 * On the light store a reload legitimately starts over, and an app author can
	 * read that off the store BEFORE it happens.
	 *
	 * `durability: 'memory-only'` is on `PatchStateStore`'s capability report and
	 * the capability report is on the read handle, so "will this survive a
	 * reload" is answerable at startup rather than from a support ticket. ADR-0023
	 * is why the answer is no.
	 */
	it('starts over on the memory-only patch store, and says so before it does', async () => {
		const openLightStore = async () =>
			openForWriting(
				await createBrowserStateStore(processor.entities, {
					backend: (d) => new PatchStateStore(d, {finalityDepth: FINALITY}),
				}),
			);

		const first = await runWorkload(await openLightStore(), fakeChain());
		expect(first.state).toEqual(EXPECTED_A);
		expect(first.indexer.state.$state.capabilities).toMatchObject({durability: 'memory-only'});

		// a new process, which for this backend is a new everything
		const second = await runWorkload(await openLightStore(), fakeChain());

		expect(second.state).toEqual(EXPECTED_A);
		expect(second.ranges[0].from).toBe(START_BLOCK);
	});
});

describe('what a browser deployment gets when it names its storage', () => {
	it('createBrowserStateStore builds a store behind the seam, and not a whole-blob keeper', async () => {
		// deliberately NOT claimed: what this asserts is what the FACTORY hands back,
		// which is the backend itself. A claim wraps it (ADR-0077), so wrapping here
		// would have the `instanceof` below answer about the handle instead.
		const store = await createBrowserStateStore(processor.entities, {databaseName: freshName()});

		expect(store).toBeInstanceOf(IndexedDBStateStore);
		// There were two IndexedDB seams here until ADR-0037: this one, and a
		// `KeepState` keeper (`fetch` / `save` / `clear`) that wrote the whole state
		// object under one key. Only the seam is left, and it has none of the keeper's
		// verbs -- which is what stops the two being read as one thing again.
		expect((store as unknown as {save?: unknown}).save).toBeUndefined();
		expect(typeof store.applyBlock).toBe('function');
	});
});
