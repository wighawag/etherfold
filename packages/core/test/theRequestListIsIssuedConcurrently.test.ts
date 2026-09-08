import {describe, expect, it} from 'vitest';
import {
	MAX_CONCURRENT_LOG_REQUESTS,
	getLogsWithVariousFilters,
	type ExtraFilters,
} from '../src/internal/engine/ethereum.js';
import type {IncludedEIP1193Log} from '../src/types.js';

// ---------------------------------------------------------------------------
// THE REQUEST LIST IS ISSUED CONCURRENTLY, BOUNDED
// ---------------------------------------------------------------------------
// With argument filters configured the planner turns ONE logical fetch into
// several `eth_getLogs` calls, and they used to be awaited one at a time, so N
// filters cost N round trips of LATENCY in sequence. They are independent
// questions about the same block range and their answers are unioned, sorted
// and de-duplicated afterwards -- precisely because overlapping filters can
// return one log twice or out of order -- so issuing them together changes no
// answer and only removes the waiting.
//
// Three properties are asserted here and none of them is speed:
//
//   - the ANSWER is identical to what the sequential loop produced: same order,
//     same de-duplication;
//   - the SINGLE-request path is untouched, returned exactly as the node
//     answered it, with no sort and no de-duplication acquired by accident;
//   - the concurrency is BOUNDED by a stated limit rather than by the length of
//     the request list, which is caller-controlled (one request per filter) and
//     which a public provider answers with a rate limit.
//
// And the one with teeth: a PARTIAL union must never be returned. Under
// ADR-0004 a range delivered with logs missing is read by the receiver as an
// absence, an absence is concluded as a reorg, and a reorg reverts state. The
// sequential loop failed the whole fetch on the first rejection; so does this.
// ---------------------------------------------------------------------------

const ADDRESS_A = '0x0000000000000000000000000000000000000001' as const;
const ADDRESS_B = '0x0000000000000000000000000000000000000002' as const;
const ME = `0x${'0'.repeat(24)}${'11'.repeat(20)}`.slice(0, 66) as `0x${string}`;

const TOPIC_A = `0x${'aa'.repeat(32)}` as const;
const TOPIC_B = `0x${'bb'.repeat(32)}` as const;
const TOPIC_C = `0x${'cc'.repeat(32)}` as const;

const ALL_TOPICS = [TOPIC_A, TOPIC_B, TOPIC_C];

const RANGE = {fromBlock: 100, toBlock: 110};
const passThrough = <T>(p: Promise<T>) => p;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A log identified by the pair the de-duplication keys on (`blockHash`,
 * `logIndex`), with the block hash derived from the block number so that two
 * requests answering the SAME log answer the same bytes.
 */
function logAt(blockNumber: number, logIndex: number): IncludedEIP1193Log {
	return {
		blockNumber: `0x${blockNumber.toString(16)}`,
		blockHash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
		transactionIndex: '0x0',
		removed: false,
		address: ADDRESS_A,
		data: '0x',
		topics: [TOPIC_A],
		transactionHash: `0x${'1'.repeat(64)}`,
		logIndex: `0x${logIndex.toString(16)}`,
	} as unknown as IncludedEIP1193Log;
}

/**
 * The four requests the planner emits for the filters below, keyed by the shape
 * of the `topics` array so a test can answer each one differently.
 *
 * ONE leftover request (the topic0 no rule mentions, unscoped) followed by three
 * scoped ones, which is the planner's stated order.
 */
const FILTERS: ExtraFilters = [
	{kind: 'leftover', topic0: TOPIC_C, contractAddresses: null},
	{kind: 'match', topic0: TOPIC_A, contractAddresses: [ADDRESS_A], match: [ME]},
	{kind: 'match', topic0: TOPIC_A, contractAddresses: [ADDRESS_A], match: [null, ME]},
	{kind: 'match', topic0: TOPIC_B, contractAddresses: [ADDRESS_B], match: [ME]},
];

/** A key for one planned request, so a fixture can be written per request. */
function requestKey(params: {topics?: unknown}): string {
	return JSON.stringify(params.topics);
}

const LEFTOVER_C = JSON.stringify([[TOPIC_C]]);
const A_FROM_ME = JSON.stringify([TOPIC_A, ME]);
const A_TO_ME = JSON.stringify([TOPIC_A, null, ME]);
const B_FROM_ME = JSON.stringify([TOPIC_B, ME]);

type Answer = {logs?: IncludedEIP1193Log[]; error?: Error; afterMs?: number};

/**
 * A provider that records CONCURRENCY as it happens: how many `eth_getLogs`
 * calls are in flight at once, the high-water mark of that, and how many have
 * settled.
 *
 * `settled` is what makes "the fetch waited for the requests it had already
 * issued" checkable: a gather that rejects while leaving calls in flight leaves
 * orphaned promises behind it, and their rejections have nowhere to go.
 */
function concurrencyRecordingProvider(answerFor: (key: string) => Answer) {
	const state = {started: 0, settled: 0, inFlight: 0, maxInFlight: 0, keys: [] as string[]};
	const provider = {
		async request(args: {method: string; params?: any}): Promise<any> {
			if (args.method !== 'eth_getLogs') throw new Error(`unexpected method ${args.method}`);
			const key = requestKey(args.params[0]);
			state.keys.push(key);
			state.started++;
			state.inFlight++;
			state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
			const answer = answerFor(key);
			try {
				await delay(answer.afterMs === undefined ? 5 : answer.afterMs);
				if (answer.error) {
					throw answer.error;
				}
				return answer.logs || [];
			} finally {
				state.inFlight--;
				state.settled++;
			}
		},
	};
	return {provider: provider as any, state};
}

// ---------------------------------------------------------------------------

describe('the planner request list is issued concurrently', () => {
	it('issues every planned request at once rather than one await at a time', async () => {
		const {provider, state} = concurrencyRecordingProvider(() => ({logs: []}));

		await getLogsWithVariousFilters(provider, [ADDRESS_A, ADDRESS_B], ALL_TOPICS, FILTERS, RANGE, passThrough);

		// four planned requests, and all four in flight together: sequentially this
		// would never exceed one
		expect(state.started).toBe(4);
		expect(state.maxInFlight).toBe(4);
	});

	it('is bounded by a STATED limit rather than by the length of the request list', async () => {
		// one `match` entry per request, so the caller's configuration alone decides
		// how long the list is -- which is why the bound cannot be the list
		const many: ExtraFilters = [];
		for (let i = 0; i < MAX_CONCURRENT_LOG_REQUESTS * 3; i++) {
			many.push({
				kind: 'match',
				topic0: TOPIC_A,
				contractAddresses: [ADDRESS_A],
				match: [`0x${i.toString(16).padStart(64, '0')}` as `0x${string}`],
			});
		}
		const {provider, state} = concurrencyRecordingProvider(() => ({logs: []}));

		await getLogsWithVariousFilters(provider, [ADDRESS_A], [TOPIC_A], many, RANGE, passThrough);

		expect(state.started).toBe(many.length);
		expect(state.maxInFlight).toBe(MAX_CONCURRENT_LOG_REQUESTS);
		expect(state.maxInFlight).toBeLessThan(many.length);
	});
});

describe('the union is the same answer the sequential loop gave', () => {
	it('sorts by block then log index and de-duplicates across overlapping requests', async () => {
		// the two `Transfer` entries OVERLAP on a self-transfer, which is the case
		// the de-duplication exists for, and the node answers them out of order
		const {provider} = concurrencyRecordingProvider((key) => {
			switch (key) {
				case LEFTOVER_C:
					return {logs: [logAt(12, 1)], afterMs: 1};
				case A_FROM_ME:
					return {logs: [logAt(10, 2), logAt(12, 0)], afterMs: 9};
				case A_TO_ME:
					return {logs: [logAt(10, 2), logAt(11, 0)], afterMs: 3};
				case B_FROM_ME:
					return {logs: [logAt(9, 5)], afterMs: 7};
				default:
					throw new Error(`unplanned request ${key}`);
			}
		});

		const result = await getLogsWithVariousFilters(
			provider,
			[ADDRESS_A, ADDRESS_B],
			ALL_TOPICS,
			FILTERS,
			RANGE,
			passThrough,
		);

		// exactly what the sequential loop produced: ascending by (block, logIndex),
		// with the doubly-matched log delivered once
		expect(result.map((log) => [log.blockNumber, log.logIndex])).toEqual([
			['0x9', '0x5'],
			['0xa', '0x2'],
			['0xb', '0x0'],
			['0xc', '0x0'],
			['0xc', '0x1'],
		]);
	});

	it('does not depend on which request answers first', async () => {
		// the same fixture with the completion order reversed: a gather that let
		// arrival order into the result would differ here
		const timings: Record<string, number> = {
			[LEFTOVER_C]: 9,
			[A_FROM_ME]: 1,
			[A_TO_ME]: 7,
			[B_FROM_ME]: 3,
		};
		const {provider} = concurrencyRecordingProvider((key) => {
			switch (key) {
				case LEFTOVER_C:
					return {logs: [logAt(12, 1)], afterMs: timings[key]};
				case A_FROM_ME:
					return {logs: [logAt(10, 2), logAt(12, 0)], afterMs: timings[key]};
				case A_TO_ME:
					return {logs: [logAt(10, 2), logAt(11, 0)], afterMs: timings[key]};
				case B_FROM_ME:
					return {logs: [logAt(9, 5)], afterMs: timings[key]};
				default:
					throw new Error(`unplanned request ${key}`);
			}
		});

		const result = await getLogsWithVariousFilters(
			provider,
			[ADDRESS_A, ADDRESS_B],
			ALL_TOPICS,
			FILTERS,
			RANGE,
			passThrough,
		);

		expect(result.map((log) => [log.blockNumber, log.logIndex])).toEqual([
			['0x9', '0x5'],
			['0xa', '0x2'],
			['0xb', '0x0'],
			['0xc', '0x0'],
			['0xc', '0x1'],
		]);
	});
});

describe('the single-request path is what it always was', () => {
	const unsortedWithADuplicate = [logAt(12, 1), logAt(9, 5), logAt(12, 1)];

	it('returns the node answer as the node gave it, with no sort and no de-duplication', async () => {
		// the unfiltered case, which is most deployments: one request, and the array
		// that comes back is the array the node sent. Only MULTIPLE overlapping
		// filters can hand back one log twice or out of order, so this path has
		// nothing to merge and must acquire nothing.
		const {provider, state} = concurrencyRecordingProvider(() => ({logs: unsortedWithADuplicate}));

		const result = await getLogsWithVariousFilters(provider, [ADDRESS_A], ALL_TOPICS, null, RANGE, passThrough);

		expect(state.started).toBe(1);
		expect(result).toEqual(unsortedWithADuplicate);
	});

	it('leaves the no-topics path alone too', async () => {
		const {provider, state} = concurrencyRecordingProvider(() => ({logs: unsortedWithADuplicate}));

		const result = await getLogsWithVariousFilters(provider, [ADDRESS_A], null, null, RANGE, passThrough);

		expect(state.started).toBe(1);
		expect(result).toEqual(unsortedWithADuplicate);
	});
});

describe('a failed request fails the whole fetch, never a partial union', () => {
	it('rejects rather than returning the logs it managed to collect', async () => {
		// ADR-0004: a range delivered with logs missing is read as an absence,
		// concluded as a reorg, and paid for by deleting state. A union missing one
		// request's logs is exactly that shape, so it must never be returned.
		const boom = new Error('provider refused');
		const {provider, state} = concurrencyRecordingProvider((key) =>
			key === A_TO_ME ? {error: boom} : {logs: [logAt(10, 2)]},
		);

		await expect(
			getLogsWithVariousFilters(provider, [ADDRESS_A, ADDRESS_B], ALL_TOPICS, FILTERS, RANGE, passThrough),
		).rejects.toThrow('provider refused');

		// and nothing was left in flight: every request it issued has settled before
		// the rejection surfaced, so no orphaned rejection is left behind it
		expect(state.settled).toBe(state.started);
	});

	it('reports the failure the sequential loop would have reported, the lowest-index one', async () => {
		// two requests fail and the LATER one in the list fails FIRST. The sequential
		// loop would have thrown at the earlier request and never issued the later
		// one, and the error it throws is read for hints upstream
		// (`RangeLogFetcher.getLogs`), so which error surfaces is not arbitrary.
		const {provider} = concurrencyRecordingProvider((key) => {
			if (key === A_FROM_ME) return {error: new Error('the earlier request'), afterMs: 20};
			if (key === B_FROM_ME) return {error: new Error('the later request'), afterMs: 1};
			return {logs: []};
		});

		await expect(
			getLogsWithVariousFilters(provider, [ADDRESS_A, ADDRESS_B], ALL_TOPICS, FILTERS, RANGE, passThrough),
		).rejects.toThrow('the earlier request');
	});

	it('stops issuing further requests once one has failed', async () => {
		// the sequential loop never issued the requests after the failing one, and
		// there is no reason to spend those round trips on an answer that cannot be
		// returned
		const many: ExtraFilters = [];
		for (let i = 0; i < MAX_CONCURRENT_LOG_REQUESTS * 3; i++) {
			many.push({
				kind: 'match',
				topic0: TOPIC_A,
				contractAddresses: [ADDRESS_A],
				match: [`0x${i.toString(16).padStart(64, '0')}` as `0x${string}`],
			});
		}
		const {provider, state} = concurrencyRecordingProvider(() => ({error: new Error('provider refused')}));

		await expect(getLogsWithVariousFilters(provider, [ADDRESS_A], [TOPIC_A], many, RANGE, passThrough)).rejects.toThrow(
			'provider refused',
		);

		expect(state.started).toBeLessThanOrEqual(MAX_CONCURRENT_LOG_REQUESTS);
		expect(state.started).toBeLessThan(many.length);
	});
});
