import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import type {ExistingStream, LastSync} from '@etherfold/core';
import {keepStreamOnIndexedDB} from '../src/index.js';
import {appliedIn, applyingProcessor, browserStore, indexerOver, keysOf} from './utils/applied.js';
import {
	BRANCH_A,
	BRANCH_A_EXTENDED,
	BRANCH_A_TIP,
	fakeChain,
	FINALITY,
	indexToTip,
	SOURCE,
	START_BLOCK,
	type TestABI,
	streamOrAbsent,
} from '../browser/workload.js';

/**
 * The stream cache against the REAL keeper, on `fake-indexeddb`.
 *
 * The engine's arithmetic is pinned in `@etherfold/core`'s own suite against an
 * in-memory keeper; what these add is the deployment shape the fix exists for --
 * a browser tab that goes away between the stream write and the state write, and
 * a browser store that refuses to be written to. The claim is about what the
 * NODE was asked for, so every assertion here reads the ranges the fake chain
 * recorded, the way `invalidation.test.ts` does: a replay and a re-fetch land on
 * identical state and cannot be told apart by reading it.
 */

let counter = 0;
const freshName = () => `stream-cache-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/** A stream keeper that can be told to refuse its writes, wrapping the real one. */
function failableStream(name: string) {
	const real = keepStreamOnIndexedDB<TestABI>(name);
	let failWith: (() => Error) | undefined;
	const keeper = {
		...real,
		saveNewEvents: async (source: never, data: never) => {
			if (failWith) {
				throw failWith();
			}
			return real.saveNewEvents(source, data);
		},
	};
	return {
		keeper: keeper as unknown as ExistingStream<TestABI>,
		failEvery(error: () => Error) {
			failWith = error;
		},
		succeed() {
			failWith = undefined;
		},
		async storedEvents(): Promise<string[]> {
			// From the source's own first block, not 0: `fetchFrom` reports
			// `does-not-reach-back` for a stream that starts above what was asked for, so
			// an inspection asking below the start would read as absent. (It no longer
			// DESTROYS what it came to read -- ADR-0069 -- but it still would not see it.)
			// And with the WHOLE source, not a stand-in carrying its `chainId`: the
			// stream is ADDRESSED by a digest of its filter, so a stand-in reads an
			// empty subtree rather than the stream under inspection.
			const stored = streamOrAbsent(await real.fetchFrom(SOURCE, START_BLOCK));
			return (stored?.eventStream ?? []).map((event: any) => `${event.blockHash}:${event.logIndex}`);
		},
		async storedCursor(): Promise<LastSync<TestABI> | undefined> {
			const stored = streamOrAbsent(await real.fetchFrom(SOURCE, START_BLOCK));
			return stored?.lastSync as LastSync<TestABI> | undefined;
		},
	};
}

const CONFIG = {stream: {finality: FINALITY}};

/** Far enough above the last log that the finality re-read cannot reach the missing blocks. */
const DIVERGED_TIP = 120;

describe('a tab that dies between the two writes', () => {
	it('replays the missing blocks from the cache instead of re-fetching them, once, landing where a from-scratch index lands', async () => {
		const tag = freshName();
		const chain = fakeChain();
		const control: {failFromBlock?: number} = {};
		const definition = applyingProcessor(control);
		const stream = keepStreamOnIndexedDB<TestABI>(tag);
		const store = await browserStore(tag, definition);

		// a healthy run to the tip, the stream cached beside the state
		const first = indexerOver(definition, store, {keepStream: stream});
		await first.init({provider: chain.provider, source: SOURCE, config: CONFIG});
		await indexToTip(first as never);
		expect(await appliedIn(first.state.$state)).toHaveLength(BRANCH_A.length);

		// The chain moves on well past the finality window, and the handler dies on
		// the new block: the STREAM write has landed by then, the state write never
		// happens. The tip is far above the last log so that "the missing range was
		// re-fetched" and "the window was re-read" are two different ranges.
		chain.serve(BRANCH_A_EXTENDED, DIVERGED_TIP);
		control.failFromBlock = 106;
		await expect(first.indexMore()).rejects.toThrow('handler blew up');
		first.dispose();

		// a new tab, the same two stores, a handler that works again
		control.failFromBlock = undefined;
		const rangesBefore = chain.ranges.length;
		const reloaded = indexerOver(definition, store, {keepStream: stream});
		await reloaded.init({provider: chain.provider, source: SOURCE, config: CONFIG});
		await indexToTip(reloaded as never);

		// block 106 came out of the CACHE: no range reaches back to the blocks the
		// state was missing. What IS re-read is the finality window at the tip, which
		// every cycle does and which is an overlap rather than a re-fetch.
		for (const range of chain.ranges.slice(rangesBefore)) {
			expect(range.from).toBeGreaterThan(BRANCH_A_TIP);
		}

		// exactly once, in the stream and in the state
		const applied = await appliedIn(reloaded.state.$state);
		expect(applied.map((row) => row.times)).toEqual(applied.map(() => 1));
		expect(applied).toHaveLength(BRANCH_A_EXTENDED.length);

		// and a from-scratch index of the same chain agrees
		const scratchChain = fakeChain(BRANCH_A_EXTENDED, DIVERGED_TIP);
		const scratchDefinition = applyingProcessor();
		const scratch = indexerOver(scratchDefinition, await browserStore(freshName(), scratchDefinition));
		await scratch.init({provider: scratchChain.provider, source: SOURCE, config: CONFIG});
		await indexToTip(scratch as never);
		expect(keysOf(applied)).toEqual(keysOf(await appliedIn(scratch.state.$state)));

		reloaded.dispose();
		scratch.dispose();
	});
});

describe('a store that refuses to be written to', () => {
	it('freezes the cache, keeps indexing, and leaves a prefix a reload replays', async () => {
		const tag = freshName();
		const chain = fakeChain();
		const stream = failableStream(tag);
		const definition = applyingProcessor();
		const store = await browserStore(tag, definition);

		const first = indexerOver(definition, store, {keepStream: stream.keeper});
		await first.init({
			provider: chain.provider,
			source: SOURCE,
			config: {...CONFIG, streamWriteRetry: {maxConsecutiveFailures: 2, delaySeconds: 0}},
		});
		await indexToTip(first as never);
		const prefix = await stream.storedEvents();
		expect(prefix).toHaveLength(BRANCH_A.length);

		// the store breaks for good, and the chain moves on
		stream.failEvery(() => new Error('the store is broken'));
		chain.serve(BRANCH_A_EXTENDED, DIVERGED_TIP);
		await indexToTip(first as never);

		// indexing RESUMED, and what was on disk survived untouched
		expect(await appliedIn(first.state.$state)).toHaveLength(BRANCH_A_EXTENDED.length);
		expect(await stream.storedEvents()).toEqual(prefix);
		first.dispose();

		// a reload whose STATE is gone replays that prefix and re-fetches only the
		// remainder, landing where a from-scratch index lands
		stream.succeed();
		const rangesBefore = chain.ranges.length;
		const reloadedDefinition = applyingProcessor();
		const reloaded = indexerOver(reloadedDefinition, await browserStore(freshName(), reloadedDefinition), {
			keepStream: stream.keeper,
		});
		await reloaded.init({provider: chain.provider, source: SOURCE, config: CONFIG});
		await indexToTip(reloaded as never);

		for (const range of chain.ranges.slice(rangesBefore)) {
			expect(range.from).toBeGreaterThan(START_BLOCK);
		}
		const scratchChain = fakeChain(BRANCH_A_EXTENDED, DIVERGED_TIP);
		const scratchDefinition = applyingProcessor();
		const scratch = indexerOver(scratchDefinition, await browserStore(freshName(), scratchDefinition));
		await scratch.init({provider: scratchChain.provider, source: SOURCE, config: CONFIG});
		await indexToTip(scratch as never);
		expect(keysOf(await appliedIn(reloaded.state.$state))).toEqual(keysOf(await appliedIn(scratch.state.$state)));

		reloaded.dispose();
		scratch.dispose();
	});
});

describe('a stream with a cursor and no events, and NO state of its own yet', () => {
	it('resumes from the stored cursor rather than the start block, and keeps advancing', async () => {
		const tag = freshName();
		const stream = keepStreamOnIndexedDB<TestABI>(tag);

		/** One tab's whole life: open over the same stream store, scan to the tip, go away. */
		async function scanTo(tip: number) {
			const chain = fakeChain([], tip);
			const definition = applyingProcessor();
			const indexer = indexerOver(definition, await browserStore(freshName(), definition), {keepStream: stream});
			await indexer.init({provider: chain.provider, source: SOURCE, config: CONFIG});
			await indexToTip(indexer as never);
			indexer.dispose();
			return chain.ranges;
		}

		const first = await scanTo(200);
		expect(first[0].from).toBe(START_BLOCK);

		const second = await scanTo(300);
		expect(second[0].from).toBeGreaterThan(START_BLOCK);

		// and it keeps ADVANCING: a cursor adopted once but never afterwards looks
		// identical on the run above and fails here
		const third = await scanTo(400);
		expect(third[0].from).toBeGreaterThan(second[0].from);
	});
});

describe('the WINDOW still lives on the state side', () => {
	it('answers checkTxInclusion across a reload with no stream keeper configured', async () => {
		const tag = freshName();
		const chain = fakeChain();
		const tx = BRANCH_A[BRANCH_A.length - 1].transactionHash as `0x${string}`;
		const definition = applyingProcessor();
		const store = await browserStore(tag, definition);

		const first = indexerOver(definition, store);
		await first.init({provider: chain.provider, source: SOURCE, config: CONFIG});
		await indexToTip(first as never);
		expect(first.checkTxInclusion([{txHash: tx}])[tx].status).toBe('included');
		first.dispose();

		const reloaded = indexerOver(definition, store);
		await reloaded.init({provider: chain.provider, source: SOURCE, config: CONFIG});
		await reloaded.indexMore();

		const verdict = reloaded.checkTxInclusion([{txHash: tx}])[tx];
		expect(verdict.status).toBe('included');
		expect(verdict.blockNumber).toBe(104);
		reloaded.dispose();
	});
});
