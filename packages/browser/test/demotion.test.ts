import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {openForWriting, type StateStoreBackend} from '@etherfold/state-store';
import {createBrowserStateStore, demoteToReader} from '../src/index.js';
import {
	BRANCH_A_TIP,
	EXPECTED_A,
	FINALITY,
	SOURCE,
	fakeChain,
	indexerFor,
	indexToTip,
	processor,
	readState,
} from '../browser/workload.js';

/**
 * A TAB THAT LOST THE STORE STOPS BEING A WRITER, AND GOES ON BEING AN APP.
 *
 * The writer guard (ADR-0075) refuses the mutation of a writer whose claim was
 * taken, and that refusal is NOT an application error: it is a writer learning it
 * lost a race it could not have avoided. What it must do about it is drop the
 * in-memory `LastSync` that is now a lie, stop fetching, and go on answering
 * reads from the store the winner is writing -- which is what these cases
 * assert, from the outside, through the hook an application actually holds.
 *
 * The contention is REAL rather than mocked: a second `createBrowserStateStore`
 * on the same `databaseName` is what two tabs of one app have, and its first
 * write claims the store out from under the hook. Nothing here uses a timer,
 * because the guard needs none: the claim is swapped inside the same
 * `readwrite` transaction as the write it guards.
 */

let counter = 0;
const freshName = () => `demotion-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/** The block a rival tab writes in order to take the claim. Above every height the hook wrote. */
const RIVAL_BLOCK = {number: 400, hash: '0x400', timestamp: 1_700_000_000 + 400 * 12};

/** Wait for a condition the auto-index loop reaches on its own, or fail saying it never did. */
async function until(reached: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!reached()) {
		if (Date.now() > deadline) {
			throw new Error(`the auto-index loop never reached the expected state within ${timeoutMs}ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** The five verbs a store REFUSES once this writer's claim has been taken (ADR-0075). */
const GUARDED = ['applyBlock', 'revertTo', 'writeCursor', 'clearCursor', 'prune'] as const;

/**
 * The same store, recording every GUARDED call made through it.
 *
 * "issues no further mutation" is the claim, so it is counted rather than
 * inferred from a state that happens not to have moved: a demoted writer that
 * went on calling `writeCursor` and being refused would leave exactly the same
 * rows behind.
 */
function recordingMutations(store: StateStoreBackend): {store: StateStoreBackend; mutations: string[]} {
	const mutations: string[] = [];
	const recording = new Proxy(store, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (typeof value !== 'function') {
				return value;
			}
			const method = value.bind(target) as (...args: unknown[]) => unknown;
			if (!(GUARDED as readonly (string | symbol)[]).includes(property)) {
				return method;
			}
			return (...args: unknown[]) => {
				mutations.push(String(property));
				return method(...args);
			};
		},
	}) as StateStoreBackend;
	return {store: recording, mutations};
}

/** A hook indexed to the tip, and the rival handle that is about to take its store. */
async function indexedThenTaken(options: {databaseName?: string} = {}) {
	const databaseName = options.databaseName ?? freshName();
	const chain = fakeChain();
	const recorded = recordingMutations(await createBrowserStateStore(processor.entities, {databaseName}));
	const indexer = indexerFor(await openForWriting(recorded.store));
	await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
	await indexToTip(indexer);

	// a second tab, writing. Its first mutation CLAIMS, which invalidates the
	// claim the hook's store has been writing under.
	const rival = await createBrowserStateStore(processor.entities, {databaseName});
	await rival.applyBlock(RIVAL_BLOCK, []);

	return {indexer, chain, rival, mutations: recorded.mutations};
}

describe('a refused writer demotes itself to a reader', () => {
	it('reports the demotion instead of raising the refusal at the application', async () => {
		const {indexer} = await indexedThenTaken();

		// the advance that meets the refusal RESOLVES: an app driving the loop is not
		// handed a stack trace for an outcome it could not have avoided.
		const lastSync = await indexer.indexMore();

		expect(lastSync).toBeUndefined();
		expect(indexer.syncing.$state.demotion?.reason).toBe('write-refused');
		// and it holds what it may still do with the store: a READ handle per state it
		// was folding into.
		expect(indexer.syncing.$state.demotion?.reading).toHaveLength(1);
		// not an `error`: an app rendering that field as a fault would render a crash
		// for a state change, exactly as it must not for a refused stream seed.
		expect(indexer.syncing.$state.error).toBeUndefined();

		indexer.dispose();
	});

	it('drops the in-memory cursor, which is now a lie', async () => {
		const {indexer} = await indexedThenTaken();
		expect(indexer.syncing.$state.lastSync?.lastToBlock).toBe(BRANCH_A_TIP);

		await indexer.indexMore();

		// `checkTxInclusion` answers from this window, and the window belongs to a
		// generation that is no longer the one moving the store on.
		expect(indexer.syncing.$state.lastSync).toBeUndefined();
		expect(indexer.checkTxInclusion([{txHash: '0xdead'}])['0xdead']?.status).not.toBe('included');

		indexer.dispose();
	});

	it('issues no further mutation on any guarded path, however it is driven', async () => {
		const {indexer, mutations} = await indexedThenTaken();
		await indexer.indexMore();

		mutations.length = 0;
		expect(await indexer.indexMore()).toBeUndefined();
		expect(await indexer.indexToLatest()).toBeUndefined();
		expect(await indexer.indexMoreAndCatchupIfNeeded()).toBeUndefined();
		// and it does not resume on its own either: becoming a writer again is
		// CLAIMING again, which is a new store and a new `init`.
		expect(await indexer.startAutoIndexing(0.001)).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(mutations).toEqual([]);
		expect(indexer.syncing.$state.autoIndexing).toBe(false);

		indexer.dispose();
	});

	it('stops FETCHING: a demoted tab is not a tab that indexes into nothing', async () => {
		const {indexer, chain} = await indexedThenTaken();
		await indexer.indexMore();

		const fetched = chain.ranges.length;
		await indexer.indexMore();
		await indexer.indexToLatest();

		expect(chain.ranges.length).toBe(fetched);

		indexer.dispose();
	});

	it('keeps answering reads, so the tab that lost goes on showing correct data', async () => {
		const {indexer} = await indexedThenTaken();
		await indexer.indexMore();

		// the whole point of demoting rather than erroring: the app is still an app.
		expect(await readState(indexer.state.$state)).toEqual(EXPECTED_A);

		indexer.dispose();
	});

	it('stops the AUTO-INDEX loop, which is the path an app actually drives', async () => {
		const databaseName = freshName();
		const chain = fakeChain();
		const store = await openForWriting(await createBrowserStateStore(processor.entities, {databaseName}));
		const indexer = indexerFor(store);
		await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});

		// a short interval so a tick that KEPT re-arming would be caught rather than
		// waited for: the failure this replaces is a loop retrying a refusal for ever.
		await indexer.startAutoIndexing(0.01);
		expect(indexer.syncing.$state.autoIndexing).toBe(true);
		// the loop CLAIMS by writing, so the rival takes the store from a writer that
		// has one rather than from one that never wrote.
		await until(() => indexer.syncing.$state.lastSync?.lastToBlock === BRANCH_A_TIP);

		const rival = await createBrowserStateStore(processor.entities, {databaseName});
		await rival.applyBlock(RIVAL_BLOCK, []);

		// WAITED FOR rather than slept past: how many ticks a loaded machine fits into a
		// fixed sleep is not what is being asserted, and a sleep long enough to be safe
		// there is a sleep this file pays on every run.
		await until(() => indexer.syncing.$state.demotion !== undefined);
		expect(indexer.syncing.$state.demotion?.reason).toBe('write-refused');
		expect(indexer.syncing.$state.autoIndexing).toBe(false);

		// and the loop is not re-armed: a tick that came back would fetch a chain in
		// order to be refused by every write it made.
		const fetched = chain.ranges.length;
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(chain.ranges.length).toBe(fetched);

		indexer.dispose();
	});

	it('is NOT a follower: a follower re-folds and would be refused on every block', async () => {
		const {indexer, mutations} = await indexedThenTaken();
		await indexer.indexMore();
		mutations.length = 0;

		// a follower fetches nothing and writes no SEGMENT, and it is a full writer of
		// STATE: it re-folds a stored stream through `EventProcessor.process`, so it
		// calls `applyBlock` constantly. Modelling demotion on one would produce a
		// generation that keeps mutating, keeps being refused, and loops.
		for (let round = 0; round < 3; round++) {
			await indexer.indexMore();
		}

		expect(mutations).toEqual([]);
		expect(indexer.generations.every((generation) => !generation.follows)).toBe(true);

		indexer.dispose();
	});
});

describe('the same demotion, asked for by a caller', () => {
	it('demotes on a LEASE LOSS through the one function the refusal handler uses', async () => {
		const chain = fakeChain();
		const recorded = recordingMutations(await createBrowserStateStore(processor.entities, {databaseName: freshName()}));
		const indexer = indexerFor(await openForWriting(recorded.store));
		await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
		await indexToTip(indexer);

		// nothing has been refused here: this tab was TOLD it no longer holds the
		// write duty, which is what a lost Web Locks lease is
		// (`work/specs/proposed/one-tab-indexes-and-the-others-read.md`).
		const demotion = indexer.demoteToReader('lease-lost');
		expect(demotion.reason).toBe('lease-lost');
		expect(indexer.syncing.$state.demotion?.reason).toBe('lease-lost');
		expect(indexer.syncing.$state.lastSync).toBeUndefined();

		const fetched = chain.ranges.length;
		recorded.mutations.length = 0;
		expect(await indexer.indexMore()).toBeUndefined();
		expect(chain.ranges.length).toBe(fetched);
		expect(recorded.mutations).toEqual([]);
		expect(await readState(indexer.state.$state)).toEqual(EXPECTED_A);

		indexer.dispose();
	});

	it('hands back the stores as READ handles, and stops folding before it does', async () => {
		const order: string[] = [];
		const store = await openForWriting(await createBrowserStateStore(processor.entities, {databaseName: freshName()}));

		const demotion = demoteToReader(
			{
				stopFolding: () => order.push('stopFolding'),
				forgetCursor: () => order.push('forgetCursor'),
				stores: () => {
					order.push('stores');
					return [store];
				},
			},
			'lease-lost',
		);

		// the ORDER is the function's to guarantee and not each caller's to remember:
		// a writer that narrowed its handle while its loop was still folding would
		// keep issuing the very mutations the demotion exists to stop.
		expect(order).toEqual(['stopFolding', 'forgetCursor', 'stores']);
		expect(demotion.reading).toHaveLength(1);
		// `openForReading` returns the store it was handed, narrowed: the TYPE is the
		// whole guard (ADR-0077), so this is the same object and reads still work.
		expect(await demotion.reading[0]?.getCurrent('token', {id: '1'})).toBeUndefined();
	});
});
