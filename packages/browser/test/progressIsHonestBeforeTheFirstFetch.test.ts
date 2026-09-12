import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {EntityEventProcessor, type EntityStateView} from '@etherfold/processor-entities';
import {openForWriting} from '@etherfold/state-store';
import {createBrowserStateStore, createIndexerState} from '../src/index.js';
import {BRANCH_A_TIP, FINALITY, fakeChain, processor, SOURCE, type TestABI} from '../browser/workload.js';

/**
 * THE HOOK'S PROGRESS FIGURES, BEFORE THERE IS ANYTHING TO BE PROGRESSING
 * THROUGH.
 *
 * A container publishes its cursor once at LOAD, before it has fetched anything,
 * and that cursor is `lastToBlock: 0, latestBlock: 0` -- it has learnt no tip yet.
 * The hook derived its three figures from those numbers directly, so at that
 * moment an app subscribing to `syncing` was handed:
 *
 * - `totalPercentage` = `0 / 0` = **`NaN`**, and
 * - `syncPercentage` computed over a NEGATIVE span, because the denominator is
 *   `latestBlock - startingBlock` and `startingBlock` is the source's start block.
 *
 * An app binding a progress bar to either rendered something meaningless until the
 * first fetch landed. The port side already refused to publish figures below a
 * learnt tip (`derivedProgress`); this pins that the hook now shares that one
 * derivation instead of keeping a second, wrong copy of it.
 *
 * ## Why `0` and not `100`
 *
 * With no tip, an EMPTY span and a FINISHED one are indistinguishable. `100` would
 * tell an app it is done before a single log has been asked for, which is the worse
 * of the two lies -- so the fields read `0`, meaning "nothing known yet".
 */

let counter = 0;
const freshName = () => `honest-progress-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * A chain whose LOAD works and whose FETCH never answers.
 *
 * Only `eth_getLogs` is gated, deliberately: gating everything would block `load()`
 * itself, and the publication being asserted here is the one the container makes AT
 * load, with a cursor of `0` of `0`. That is the exact moment the old arithmetic
 * divided by zero, so it is the moment the fixture has to be able to hold open.
 */
function gatedChain() {
	const chain = fakeChain();
	const never = new Promise<never>(() => {});
	const underlying = chain.provider.request.bind(chain.provider);
	return {
		provider: {
			async request(args: {method: string; params?: unknown}): Promise<unknown> {
				if (args.method === 'eth_getLogs') await never;
				return underlying(args as never);
			},
		} as never,
	};
}

describe('the figures an app binds a progress bar to', () => {
	it('are numbers, not NaN, before a tip has been learnt', async () => {
		const databaseName = freshName();
		const chain = gatedChain();
		const indexer = createIndexerState<TestABI, EntityStateView>({
			createState: async () => openForWriting(await createBrowserStateStore(processor.entities, {databaseName})),
			createProcessor: (store) => new EntityEventProcessor<TestABI>(store, processor),
		});

		try {
			// Collect what the hook publishes, from the first value onwards, so the
			// pre-fetch cursor is CAUGHT rather than raced past.
			const seen: {syncPercentage: number; totalPercentage: number; numBlocksProcessedSoFar: number}[] = [];
			const unsubscribe = indexer.syncing.subscribe((state) => {
				if (state.lastSync) {
					seen.push({
						syncPercentage: state.lastSync.syncPercentage,
						totalPercentage: state.lastSync.totalPercentage,
						numBlocksProcessedSoFar: state.lastSync.numBlocksProcessedSoFar,
					});
				}
			});

			await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
			// `indexToLatest` publishes the LOAD's cursor before it advances anything
			// (`setLastSync(loaded)`), and then hangs on the gated fetch. That publication
			// is the one that used to carry `NaN`, so it is deliberately never awaited.
			void indexer.indexToLatest();

			// Wait for that publication. Nothing has been fetched: the chain is gated.
			for (let attempt = 0; attempt < 200 && seen.length === 0; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			expect(seen.length).toBeGreaterThan(0);
			for (const published of seen) {
				// The whole point: an app renders these, so none of them may be NaN --
				// which is not the same check as "is a number", since `NaN` is one.
				expect(Number.isNaN(published.syncPercentage)).toBe(false);
				expect(Number.isNaN(published.totalPercentage)).toBe(false);
				expect(published.syncPercentage).toBeGreaterThanOrEqual(0);
				expect(published.totalPercentage).toBeGreaterThanOrEqual(0);
				// ...and never a FULL bar before anything has been indexed, which is the
				// failure that `100`-on-an-empty-span would have introduced instead.
				expect(published.numBlocksProcessedSoFar).toBe(0);
				expect(published.syncPercentage).toBe(0);
				expect(published.totalPercentage).toBe(0);
			}

			unsubscribe();
		} finally {
			indexer.dispose();
		}
	});

	it('reach 100 once the fold really has reached the tip', async () => {
		// Not vacuous: the same fields that read `0` above are the ones that must read
		// `100` when the fold is genuinely done, so `0` is "nothing known yet" rather
		// than a field that never moves.
		const databaseName = freshName();
		const chain = fakeChain();
		const indexer = createIndexerState<TestABI, EntityStateView>({
			createState: async () => openForWriting(await createBrowserStateStore(processor.entities, {databaseName})),
			createProcessor: (store) => new EntityEventProcessor<TestABI>(store, processor),
		});

		try {
			await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
			await indexer.indexToLatest();

			const lastSync = indexer.syncing.$state.lastSync;
			expect(lastSync?.lastToBlock).toBe(BRANCH_A_TIP);
			expect(lastSync?.syncPercentage).toBe(100);
			expect(lastSync?.numBlocksProcessedSoFar).toBeGreaterThan(0);
		} finally {
			indexer.dispose();
		}
	});
});
