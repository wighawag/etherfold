import 'fake-indexeddb/auto';
import {describe, expect, it, vi} from 'vitest';
import type {UseStore} from 'idb-keyval';
import {keepStreamOnIndexedDB} from '../src/index.js';
import {appliedIn, applyingProcessor, browserStore, indexerOver, keysOf} from './utils/applied.js';
import {BRANCH_A, fakeChain, FINALITY, indexToTip, SOURCE, START_BLOCK, type TestABI} from '../browser/workload.js';

/**
 * STORY 12: A GENERATION WHOSE STREAM IS UNUSABLE FALLS BACK TO A FULL
 * RE-INDEX, which is today's behaviour, so the feature degrades rather than
 * breaks.
 *
 * The rule itself is asserted against the core helper and the load path
 * (`@etherfold/core`'s `streamSegments.test.ts` and
 * `anUnreadableCacheDoesNotWedgeOrCorrupt.test.ts`).
 * What is only observable HERE is the ROUND TRIP through the one stream keeper
 * that actually exists -- the browser's IndexedDB keeper over core's segmented
 * helper -- and, more to the point, what an APP experiences when the store under
 * it is gone: an indexer that still loads, still indexes and still answers,
 * paying one re-fetch for a cache it could not read.
 *
 * The failure this pins is not hypothetical: a browser can and does refuse to
 * open IndexedDB (private browsing, storage evicted or blocked, a database at a
 * version this build cannot open). `fetchFrom` and `clear` are called on the
 * load path, so a keeper that raised into a load path which did not catch would
 * leave the indexer permanently unloadable. Since ADR-0068 the keeper DOES raise
 * and the load path catches (`IndexerGeneration.readStoredStream`), which is the
 * same outcome decided by the caller the policy is about -- so the app-level case
 * below is what pins it, and it is unchanged.
 */

let counter = 0;
const freshName = () => `degrades-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * A store that is simply not there: every transaction is refused.
 *
 * `UseStore` is the seam `keepStreamOnIndexedDB` takes, so this is the whole
 * substrate failing -- the reads, the writes and the scoped delete alike -- which
 * is what "unavailable" means as opposed to the damage a keeper can inspect.
 */
const unavailableStore: UseStore = () => Promise.reject(new Error('IndexedDB is unavailable'));

/** The `named-logs` channel this package logs on, silenced and recorded. */
async function captureLogs() {
	const {logs} = await import('named-logs');
	const messages: string[] = [];
	const record = (...args: unknown[]) => {
		messages.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
	};
	const spies = ['@etherfold/browser', '@etherfold/core'].flatMap((channel) => {
		const namedLogger = logs(channel);
		return [
			vi.spyOn(namedLogger, 'error').mockImplementation(record),
			vi.spyOn(namedLogger, 'info').mockImplementation(record),
		];
	});
	return {messages, restore: () => spies.forEach((spy) => spy.mockRestore())};
}

describe('the keeper RAISES when its store is gone, and the caller decides what that means', () => {
	it('raises from `fetchFrom` and from `clear`, rather than calling an unreadable store empty', async () => {
		const logged = await captureLogs();
		const keeper = keepStreamOnIndexedDB<TestABI>(freshName(), {store: unavailableStore});

		// What an APP experiences over this keeper -- it still loads, still indexes and
		// still answers -- is asserted below in 'an app whose stream store is unusable',
		// which is where the rule now lives and which is unchanged by the relocation.
		await expect(keeper.fetchFrom(SOURCE, START_BLOCK)).rejects.toThrow(/unavailable/);
		await expect(keeper.clear(SOURCE)).rejects.toThrow(/unavailable/);
		logged.restore();
	});

	it('still REPORTS a failed write, which the engine acts on', async () => {
		const logged = await captureLogs();
		const keeper = keepStreamOnIndexedDB<TestABI>(freshName(), {store: unavailableStore});

		// not swallowed: `promiseToSave` counts it, paces the retry and freezes the
		// cache, and until it does it does NOT process the batch. Reporting success
		// here would let the state advance past events the stream never received.
		await expect(
			keeper.saveNewEvents(SOURCE, {
				eventStream: [],
				lastSync: {lastFromBlock: START_BLOCK, lastToBlock: START_BLOCK} as never,
			}),
		).rejects.toThrow(/unavailable/);
		logged.restore();
	});
});

describe('an app whose stream store is unusable', () => {
	it('indexes from the chain and answers, instead of becoming permanently unloadable', async () => {
		const logged = await captureLogs();
		const chain = fakeChain();
		const definition = applyingProcessor();
		const store = await browserStore(freshName(), definition);
		const indexer = indexerOver(definition, store, {
			keepStream: keepStreamOnIndexedDB<TestABI>(freshName(), {store: unavailableStore}),
		});

		await indexer.init({
			provider: chain.provider,
			source: SOURCE,
			config: {
				stream: {finality: FINALITY},
				// the write half of the same failure, and its degradation is the engine's
				// (it freezes the cache after this many consecutive failures and carries
				// on WITHOUT it). Tightened here only so the test does not pay the paced
				// retry twice over; the default reaches the same place more slowly.
				streamWriteRetry: {maxConsecutiveFailures: 1, delaySeconds: 0},
			},
		});
		await indexToTip(indexer);

		// a FULL RE-INDEX, which is today's behaviour: every log came from the node and
		// every event was applied exactly once
		const applied = await appliedIn(indexer.state.$state);
		expect(keysOf(applied)).toEqual(BRANCH_A.map((log) => `${log.blockHash}:${parseInt(log.logIndex, 16)}`));
		expect(applied.every((row) => row.times === 1)).toBe(true);
		expect(chain.ranges.length).toBeGreaterThan(0);

		// and it is NOT wedged: the same indexer loads and advances again
		await expect(indexer.indexMore()).resolves.toBeDefined();
		expect(indexer.syncing.$state.error).toBeUndefined();
		indexer.dispose();
		logged.restore();
	});
});
