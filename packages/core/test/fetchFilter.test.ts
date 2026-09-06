import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {LogEventFetcher} from '../src/internal/decoding/LogEventFetcher.js';
import type {LogFetcherConfig} from '../src/internal/engine/RangeLogFetcher.js';
import type {LogParseConfig} from '../src/types.js';

// ---------------------------------------------------------------------------
// AN EVENT IS NEVER SILENTLY DROPPED FROM THE FETCH FILTER
// ---------------------------------------------------------------------------
// `deleteDuplicateEvents` used to key on the event NAME, and the two call sites
// disagreed about what to do with a clash: the per-address merge threw, and the
// global list -- the one the fetch filter is built from -- spliced the second
// event out with no error, no log and no metric. Afterwards nothing could tell
// "the chain had none" from "we never asked", because the dropped event's
// topic0 was not in the filter to check with. That is the same failure class as
// `absence` vs `contradiction` in the reorg model, and as
// `SuspectedTruncationError`: an absence inferred from a request never made.
//
// So the assertions here are on the topics the fetcher REQUESTS, not on the ABI
// it accepted. What it accepted was never the thing that was wrong.
//
// The rule is now keyed on topic0 and is the SAME on both paths:
//
//   - different topic0  -> both events kept, whatever their names;
//   - same topic0, identical definition -> collapsed to one, no error;
//   - same topic0, different definition -> REFUSED at construction, naming the
//     events, because nothing on the wire can tell those two apart.
// ---------------------------------------------------------------------------

const A = '0x0000000000000000000000000000000000000001' as const;
const B = '0x0000000000000000000000000000000000000002' as const;

// topic0s, as viem encodes them, of the signatures used below
const TRANSFER_V1 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256)
const TRANSFER_V2 = '0xe19260aff97b920c7df27010903aeb9c8d2be5d310a2c67824cf3f15396e4c16'; // Transfer(address,address,uint256,bytes)
const TRANSFER_OTHER = '0x69ca02dd4edd7bf0a4abb9ed3b7af3f14778db5d61921c7dc7cd545266326de2'; // Transfer(address,uint256)
const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'; // Approval(address,address,uint256)
const APPROVAL_FOR_ALL = '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31'; // ApprovalForAll(address,address,bool)

/** `Transfer(address,address,uint256)` -- the pre-upgrade signature. */
const transferV1 = {
	type: 'event',
	name: 'Transfer',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'from', type: 'address'},
		{indexed: true, name: 'to', type: 'address'},
		{indexed: false, name: 'id', type: 'uint256'},
	],
} as const;

/** `Transfer(address,address,uint256,bytes)` -- the post-upgrade signature, a different topic0. */
const transferV2 = {
	type: 'event',
	name: 'Transfer',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'from', type: 'address'},
		{indexed: true, name: 'to', type: 'address'},
		{indexed: false, name: 'id', type: 'uint256'},
		{indexed: false, name: 'memo', type: 'bytes'},
	],
} as const;

/** An event that declares NO range, used to check that nothing undeclared is ever narrowed away. */
const approval = {
	type: 'event',
	name: 'Approval',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'owner', type: 'address'},
		{indexed: true, name: 'spender', type: 'address'},
		{indexed: false, name: 'value', type: 'uint256'},
	],
} as const;

/** The third event of an ordinary ERC-721, so a filtered source has TWO topic0s left over. */
const approvalForAll = {
	type: 'event',
	name: 'ApprovalForAll',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'owner', type: 'address'},
		{indexed: true, name: 'operator', type: 'address'},
		{indexed: false, name: 'approved', type: 'bool'},
	],
} as const;

/** Another contract's `Transfer`, same NAME and a different topic0. Nothing to do with upgrades. */
const transferOther = {
	type: 'event',
	name: 'Transfer',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'to', type: 'address'},
		{indexed: false, name: 'amount', type: 'uint256'},
	],
} as const;

/**
 * The SAME signature as `transferV1`, so the SAME topic0, but decoding into
 * something else: no `indexed` flags, so the values ride in `data`. A log
 * carrying that topic0 is genuinely ambiguous.
 */
const transferV1Colliding = {
	type: 'event',
	name: 'Transfer',
	anonymous: false,
	inputs: [
		{indexed: false, name: 'from', type: 'address'},
		{indexed: false, name: 'to', type: 'address'},
		{indexed: false, name: 'id', type: 'uint256'},
	],
} as const;

const passThrough = <T>(p: Promise<T>) => p;

/**
 * A provider that answers no logs and records what it was ASKED for.
 *
 * The point of the whole file: an event that never enters the filter produces an
 * empty result that looks exactly like a quiet chain.
 */
function recordingProvider() {
	const requests: {address?: string[]; topics?: (string | string[])[]}[] = [];
	const provider = {
		async request(args: {method: string; params?: any}): Promise<any> {
			if (args.method !== 'eth_getLogs') throw new Error(`unexpected method ${args.method}`);
			requests.push(args.params[0]);
			return [];
		},
	};
	return {provider: provider as any, requests};
}

/**
 * The topic0s ONE request asks for, read from the WHOLE topics array rather than
 * from slot 0 alone, and REFUSING a request that is not well formed.
 *
 * Reading `request.topics?.[0]` and stopping there is what let a real defect live
 * in this file's blind spot for as long as it did. An `eth_getLogs` topics array
 * is POSITIONAL: slot 0 is the event selector, every later slot constrains an
 * INDEXED ARGUMENT, an array WITHIN a slot is an OR list and the slots are ANDed.
 * The shared request used to be built by pushing the unfiltered topic0s FLAT into
 * one array, so `{topics: [t0a, t0b]}` asked for "selector t0a AND first indexed
 * argument t0b" -- unsatisfiable, so both events were silently never fetched.
 * Read through slot 0 alone, that malformed request looks exactly like one topic0
 * with an argument filter, and every assertion in this file passed over it.
 *
 * So the check is that no DECLARED event selector ever appears below slot 0. The
 * planner only ever writes caller-supplied argument values there, and a test's
 * argument values are never event selectors, so a hit means a topic0 escaped into
 * a positional slot -- which is the failure this file is named after.
 */
function topic0sOf(request: {topics?: (string | string[] | null)[]}, declaredTopic0s: ReadonlySet<string>): string[] {
	const topics = request.topics || [];
	for (let slot = 1; slot < topics.length; slot++) {
		const constraint = topics[slot];
		const values = Array.isArray(constraint) ? constraint : constraint === null ? [] : [constraint];
		for (const value of values) {
			if (declaredTopic0s.has(value)) {
				throw new Error(
					`malformed eth_getLogs request: the event selector ${value} sits at topics[${slot}], where an ` +
						`INDEXED ARGUMENT goes. A topics array is positional, so that is a conjunction and not an OR list, ` +
						`and no log can satisfy it. Several topic0s belong NESTED in slot 0. Got ${JSON.stringify(topics)}`,
				);
			}
		}
	}
	const slot0 = topics[0];
	return Array.isArray(slot0) ? slot0 : slot0 ? [slot0] : [];
}

/**
 * Every `eth_getLogs` call the fetcher made for one block range, in order, each
 * one CHECKED for the positional-shape defect above.
 *
 * The COUNT is an assertion of its own: with argument filters configured the
 * fetcher issues one request per (topic x filter), sequentially, so a topic that
 * cannot occur in the range costs its own round trips.
 */
async function requestsMade(
	contractsData: any,
	parseConfig?: LogParseConfig,
	range: {fromBlock: number; toBlock: number} = {fromBlock: 100, toBlock: 110},
	fetcherConfig: LogFetcherConfig = {},
): Promise<{address?: string[]; topics?: (string | string[])[]}[]> {
	const {provider, requests} = recordingProvider();
	const fetcher = new LogEventFetcher(provider, contractsData, fetcherConfig, parseConfig);
	await fetcher.getLogEvents({...range, retry: 0}, passThrough);
	// the topic0s this fetcher was BUILT to request (`RangeLogFetcher`'s own list),
	// which is what makes "a selector escaped into an argument slot" checkable
	const declaredTopic0s = new Set(
		((fetcher as unknown as {eventNameTopics: string[] | null}).eventNameTopics || []) as string[],
	);
	for (const request of requests) {
		topic0sOf(request, declaredTopic0s);
	}
	return requests;
}

/**
 * Every topic0 the fetcher put in front of the node for one block range, across
 * every request it made (a filtered config issues one request per topic).
 */
async function topicsRequested(
	contractsData: any,
	parseConfig?: LogParseConfig,
	range: {fromBlock: number; toBlock: number} = {fromBlock: 100, toBlock: 110},
	fetcherConfig: LogFetcherConfig = {},
): Promise<string[]> {
	const {provider, requests} = recordingProvider();
	const fetcher = new LogEventFetcher(provider, contractsData, fetcherConfig, parseConfig);
	await fetcher.getLogEvents({...range, retry: 0}, passThrough);
	const declaredTopic0s = new Set(
		((fetcher as unknown as {eventNameTopics: string[] | null}).eventNameTopics || []) as string[],
	);
	const topics: string[] = [];
	for (const request of requests) {
		for (const topic of topic0sOf(request, declaredTopic0s)) {
			if (topics.indexOf(topic) === -1) topics.push(topic);
		}
	}
	return topics;
}

/**
 * Enough blocks per fetch that the range a test asks for is the range that
 * reaches the node. `RangeLogFetcher` clamps `toBlock` to
 * `fromBlock + numBlocksToFetchAtStart - 1` (50 by default), and the narrowing
 * is computed on the range actually REQUESTED, not on the one asked for.
 */
const WIDE_ENOUGH: LogFetcherConfig = {numBlocksToFetchAtStart: 100_000};

/** The same source, asked for under both readings of the parse config. */
const BOTH_PATHS: {label: string; parse: LogParseConfig}[] = [
	{label: 'per-address', parse: {}},
	{label: 'address-agnostic', parse: {parseAllEventsIrrespectiveOfAddresses: true}},
];

// ---------------------------------------------------------------------------

describe('an event is never silently dropped from the fetch filter', () => {
	it('REGRESSION: two contracts declaring same-named events with different inputs both reach the request', async () => {
		// This is the silent path. Keyed on NAME, the second contract's `Transfer`
		// was spliced out of the global list, so its topic0 never entered the
		// filter and its logs were never asked for -- with no error to notice.
		const contracts = [
			{address: A, abi: [transferV1] as unknown as Abi},
			{address: B, abi: [transferOther] as unknown as Abi},
		];

		const topics = await topicsRequested(contracts);

		expect(topics).toContain(TRANSFER_V1);
		expect(topics).toContain(TRANSFER_OTHER);
	});

	it('requests both topic0s whether or not parseAllEventsIrrespectiveOfAddresses is set', async () => {
		const contracts = [
			{address: A, abi: [transferV1] as unknown as Abi},
			{address: B, abi: [transferOther] as unknown as Abi},
		];

		const perAddress = await topicsRequested(contracts, BOTH_PATHS[0].parse);
		const agnostic = await topicsRequested(contracts, BOTH_PATHS[1].parse);

		// the flag chooses which ABI DECODES a log; it must never choose which
		// events exist, and so never which logs are fetched at all
		expect(agnostic).toEqual(perAddress);
		expect(perAddress.sort()).toEqual([TRANSFER_V1, TRANSFER_OTHER].sort());
	});

	it('carries every topic0 into the filter even when a filter list is configured for the name', async () => {
		// with argument filters, one request per (topic x filter): a name covering
		// two topic0s must produce a request for each, or one version is filtered
		// and the other silently unrequested
		const contracts = [{address: A, abi: [transferV1, transferV2] as unknown as Abi}];
		const holder = `0x${'11'.repeat(20)}`.padEnd(66, '0') as `0x${string}`;

		const topics = await topicsRequested(contracts, {filters: {Transfer: [[holder]]}});

		expect(topics.sort()).toEqual([TRANSFER_V1, TRANSFER_V2].sort());
	});

	it('REGRESSION: the topic0s NOBODY filtered are OR-ed in slot 0, not ANDed across slots', async () => {
		// One ordinary ERC-721 and a filter on `Transfer` alone. The shared request
		// carried its leftover topic0s FLAT (`{topics: [APPROVAL, APPROVAL_FOR_ALL]}`),
		// which a node reads as "selector Approval AND first indexed argument
		// ApprovalForAll": unsatisfiable, so BOTH events were silently never fetched.
		// The trigger is any filter at all plus two or more leftover topic0s -- with
		// exactly one left over the flat form is accidentally correct, which is why
		// this survived.
		const nft = [{address: A, abi: [transferV1, approval, approvalForAll] as unknown as Abi}];
		const holder = `0x${'11'.repeat(20)}`.padEnd(66, '0') as `0x${string}`;

		const requests = await requestsMade(nft, {filters: {Transfer: [[holder]]}});

		// the SHARED request comes first and is ONE slot holding an OR list, exactly
		// the shape the no-filter path emits
		expect(requests[0].topics).toEqual([[APPROVAL, APPROVAL_FOR_ALL]]);
		expect(requests[0].topics).toHaveLength(1);
		// and the filtered one is the only request with a positional argument slot
		expect(requests[1].topics).toEqual([TRANSFER_V1, holder]);
		expect(requests).toHaveLength(2);
	});

	it('asks for exactly the same topic0s whether or not another event is filtered', async () => {
		// the property the shape above exists for: a filter narrows the event it names
		// and NOTHING else, so the set of topic0s reaching the node is invariant
		const nft = [{address: A, abi: [transferV1, approval, approvalForAll] as unknown as Abi}];
		const holder = `0x${'11'.repeat(20)}`.padEnd(66, '0') as `0x${string}`;

		const unfiltered = await topicsRequested(nft, {});
		const filtered = await topicsRequested(nft, {filters: {Transfer: [[holder]]}});

		expect(filtered.sort()).toEqual(unfiltered.sort());
		expect(unfiltered.sort()).toEqual([TRANSFER_V1, APPROVAL, APPROVAL_FOR_ALL].sort());
	});
});

describe('two versions of one contract event across an upgrade', () => {
	const upgraded = [{address: A, abi: [transferV1, transferV2] as unknown as Abi}];

	for (const {label, parse} of BOTH_PATHS) {
		it(`keeps both versions and requests both topic0s (${label})`, async () => {
			const topics = await topicsRequested(upgraded, parse);
			expect(topics.sort()).toEqual([TRANSFER_V1, TRANSFER_V2].sort());
		});
	}

	it('requests both versions together at a SINGLE block, since the upgrade tx sits mid-block', async () => {
		// a transaction earlier in the upgrade block still fires the old event, so
		// the two versions overlap on exactly one block and both must be asked for
		const topics = await topicsRequested(upgraded, {}, {fromBlock: 900, toBlock: 900});
		expect(topics.sort()).toEqual([TRANSFER_V1, TRANSFER_V2].sort());
	});

	it('decodes each version by its own topic0, with no block axis', () => {
		const fetcher = new LogEventFetcher({request: async () => undefined} as any, upgraded as any);
		const from = `0x${'0'.repeat(24)}${A.slice(2)}` as const;
		const to = `0x${'0'.repeat(24)}${B.slice(2)}` as const;
		const [v1, v2] = fetcher.parse([
			{
				blockNumber: '0x64',
				blockHash: '0xaaa',
				transactionIndex: '0x0',
				removed: false,
				address: A,
				data: `0x${(7).toString(16).padStart(64, '0')}`,
				topics: [TRANSFER_V1, from, to],
				transactionHash: `0x${'1'.padStart(64, '0')}`,
				logIndex: '0x0',
			},
			{
				blockNumber: '0x64',
				blockHash: '0xaaa',
				transactionIndex: '0x1',
				removed: false,
				address: A,
				// (uint256 id, bytes memo): head, offset, length, padded bytes
				data:
					`0x${(9).toString(16).padStart(64, '0')}` +
					`${(64).toString(16).padStart(64, '0')}` +
					`${(2).toString(16).padStart(64, '0')}` +
					`beef${'0'.repeat(60)}`,
				topics: [TRANSFER_V2, from, to],
				transactionHash: `0x${'2'.padStart(64, '0')}`,
				logIndex: '0x1',
			},
		] as any);

		expect((v1 as any).eventName).toBe('Transfer');
		expect((v1 as any).args).toMatchObject({id: 7n});
		expect((v1 as any).args.memo).toBeUndefined();
		expect((v2 as any).eventName).toBe('Transfer');
		expect((v2 as any).args).toMatchObject({id: 9n, memo: '0xbeef'});
	});
});

describe('an upgrade declared as block ranges', () => {
	// The ranges narrow what a range REQUESTS (see the next describe), and they
	// must never change what DECODES a log: that is topic0 and nothing else.
	const UPGRADE_BLOCK = 900;
	const ranged = [
		{
			address: A,
			abi: [
				{...transferV1, firstBlock: 100, lastBlock: UPGRADE_BLOCK},
				{...transferV2, firstBlock: UPGRADE_BLOCK},
			] as unknown as Abi,
			startBlock: 100,
		},
	];

	it('accepts the same number on both sides of the upgrade and requests BOTH topics at that block', async () => {
		// `A.lastBlock = b` together with `B.firstBlock = b` is the CORRECT
		// declaration, because a transaction earlier in block b still fires A.
		const topics = await topicsRequested(ranged, {}, {fromBlock: UPGRADE_BLOCK, toBlock: UPGRADE_BLOCK});
		expect(topics.sort()).toEqual([TRANSFER_V1, TRANSFER_V2].sort());
	});

	for (const {label, parse} of BOTH_PATHS) {
		it(`requests both topics over a range that spans the boundary (${label})`, async () => {
			const topics = await topicsRequested(ranged, parse, {fromBlock: 890, toBlock: 910}, WIDE_ENOUGH);
			expect(topics.sort()).toEqual([TRANSFER_V1, TRANSFER_V2].sort());
		});
	}

	it('decodes by topic0 with no block axis, ranges or not', () => {
		const fetcher = new LogEventFetcher({request: async () => undefined} as any, ranged as any);
		const from = `0x${'0'.repeat(24)}${A.slice(2)}` as const;
		const to = `0x${'0'.repeat(24)}${B.slice(2)}` as const;
		// a PRE-upgrade log decoded well AFTER the boundary, and a POST-upgrade log
		// decoded well before it: the block number is not consulted either way
		const [v1, v2] = fetcher.parse([
			{
				blockNumber: '0x3e8',
				blockHash: '0xaaa',
				transactionIndex: '0x0',
				removed: false,
				address: A,
				data: `0x${(7).toString(16).padStart(64, '0')}`,
				topics: [TRANSFER_V1, from, to],
				transactionHash: `0x${'1'.padStart(64, '0')}`,
				logIndex: '0x0',
			},
			{
				blockNumber: '0x64',
				blockHash: '0xbbb',
				transactionIndex: '0x0',
				removed: false,
				address: A,
				data:
					`0x${(9).toString(16).padStart(64, '0')}` +
					`${(64).toString(16).padStart(64, '0')}` +
					`${(2).toString(16).padStart(64, '0')}` +
					`beef${'0'.repeat(60)}`,
				topics: [TRANSFER_V2, from, to],
				transactionHash: `0x${'2'.padStart(64, '0')}`,
				logIndex: '0x0',
			},
		] as any);

		expect((v1 as any).args).toMatchObject({id: 7n});
		expect((v2 as any).args).toMatchObject({id: 9n, memo: '0xbeef'});
	});
});

// ---------------------------------------------------------------------------
// A BLOCK RANGE REQUESTS ONLY THE EVENTS THAT CAN OCCUR IN IT
// ---------------------------------------------------------------------------
// This is the ONE operation in the ranged design that REMOVES a topic from a
// request, so it is the one that can reintroduce the failure the top of this
// file exists to prevent. Every omission below must follow from a DECLARED
// range and from nothing else: never from an observed first appearance, never
// from a contract's `startBlock`, never from "we have not seen it".
// ---------------------------------------------------------------------------

describe('a block range requests only the events that can occur in it', () => {
	const UPGRADE_BLOCK = 900;
	const ranged = [
		{
			address: A,
			abi: [
				{...transferV1, firstBlock: 100, lastBlock: UPGRADE_BLOCK},
				{...transferV2, firstBlock: UPGRADE_BLOCK},
			] as unknown as Abi,
			startBlock: 100,
		},
	];

	/** One holder, so `Transfer` carries an argument filter and the shape splits per topic. */
	const holder = `0x${'11'.repeat(20)}`.padEnd(66, '0') as `0x${string}`;
	const FILTERED: LogParseConfig = {filters: {Transfer: [[holder]]}};

	for (const {label, parse} of BOTH_PATHS) {
		it(`does not carry a topic below its firstBlock (${label})`, async () => {
			const topics = await topicsRequested(ranged, parse, {fromBlock: 100, toBlock: 200}, WIDE_ENOUGH);
			expect(topics).toEqual([TRANSFER_V1]);
		});

		it(`does not carry a topic above its lastBlock (${label})`, async () => {
			const topics = await topicsRequested(ranged, parse, {fromBlock: 901, toBlock: 1000}, WIDE_ENOUGH);
			expect(topics).toEqual([TRANSFER_V2]);
		});
	}

	it('narrows identically whether or not parseAllEventsIrrespectiveOfAddresses is set', async () => {
		// the flag chooses which ABI DECODES a log; it must never choose which logs
		// are fetched at all, and that holds for the narrowed filter too
		const range = {fromBlock: 100, toBlock: 200};
		const perAddress = await topicsRequested(ranged, BOTH_PATHS[0].parse, range, WIDE_ENOUGH);
		const agnostic = await topicsRequested(ranged, BOTH_PATHS[1].parse, range, WIDE_ENOUGH);
		expect(agnostic).toEqual(perAddress);
	});

	it('requests the UNION over a range that crosses the boundary', async () => {
		// splitting at the boundary is allowed; the union is what must never be undercut
		const topics = await topicsRequested(ranged, {}, {fromBlock: 800, toBlock: 1000}, WIDE_ENOUGH);
		expect(topics.sort()).toEqual([TRANSFER_V1, TRANSFER_V2].sort());
	});

	it('requests BOTH versions at the upgrade block itself, keeping the one-block overlap', async () => {
		// a transaction earlier in block 900 still fires the old event
		const topics = await topicsRequested(ranged, {}, {fromBlock: UPGRADE_BLOCK, toBlock: UPGRADE_BLOCK}, WIDE_ENOUGH);
		expect(topics.sort()).toEqual([TRANSFER_V1, TRANSFER_V2].sort());
	});

	it('never drops an event with no lastBlock, at any height at or above its firstBlock', async () => {
		// open-ended is the default and the safe case: there is no height at which
		// "we have not seen it lately" may take it out of the filter
		for (const fromBlock of [UPGRADE_BLOCK, 1_000, 50_000, 10_000_000]) {
			const topics = await topicsRequested(ranged, {}, {fromBlock, toBlock: fromBlock + 10}, WIDE_ENOUGH);
			expect(topics).toContain(TRANSFER_V2);
		}
	});

	it('never drops an event that DECLARED no range, at any height, even below its contract startBlock', async () => {
		// `Approval` declares nothing while `Transfer` declares ranges. An omission
		// must follow from a DECLARATION, and `startBlock` is not one: it means "do
		// not look before here" per contract, which is a different statement.
		const mixed = [
			{
				address: A,
				abi: [{...transferV1, firstBlock: 100, lastBlock: UPGRADE_BLOCK}, approval] as unknown as Abi,
				startBlock: 100,
			},
		];
		for (const fromBlock of [0, 50, 500, 10_000]) {
			const topics = await topicsRequested(mixed, {}, {fromBlock, toBlock: fromBlock + 10}, WIDE_ENOUGH);
			expect(topics).toContain(APPROVAL);
		}
	});

	it('asks for NOTHING when no declared event can occur in the range', async () => {
		// the honest end of the same rule: not an empty topic list (which a node
		// reads as "anything"), and not a request nobody can answer -- no call at all
		const dead = [
			{
				address: A,
				abi: [{...transferV1, firstBlock: 100, lastBlock: UPGRADE_BLOCK}] as unknown as Abi,
				startBlock: 100,
			},
		];
		expect(await requestsMade(dead, {}, {fromBlock: 901, toBlock: 950}, WIDE_ENOUGH)).toEqual([]);
		expect(await requestsMade(dead, FILTERED, {fromBlock: 901, toBlock: 950}, WIDE_ENOUGH)).toEqual([]);
	});

	it('narrows a single merged ABI too, which names no address at all', async () => {
		const merged = {
			abi: [
				{...transferV1, firstBlock: 100, lastBlock: UPGRADE_BLOCK},
				{...transferV2, firstBlock: UPGRADE_BLOCK},
			] as unknown as Abi,
		};
		expect(await topicsRequested(merged, {}, {fromBlock: 100, toBlock: 200}, WIDE_ENOUGH)).toEqual([TRANSFER_V1]);
		expect(await topicsRequested(merged, {}, {fromBlock: 901, toBlock: 1000}, WIDE_ENOUGH)).toEqual([TRANSFER_V2]);
	});

	describe('two contracts declaring the same event have independent lifetimes', () => {
		// The topic filter of a request is global to the request while a range is
		// declared per contract, so the ranges of one topic0 are UNIONED across
		// contracts. One address going quiet is not a hole in another's coverage.
		it('keeps the topic above one contract lastBlock while another declares it open-ended', async () => {
			const contracts = [
				{address: A, abi: [{...transferV1, firstBlock: 100, lastBlock: 200}] as unknown as Abi},
				{address: B, abi: [{...transferV1, firstBlock: 100}] as unknown as Abi},
			];
			const topics = await topicsRequested(contracts, {}, {fromBlock: 5_000, toBlock: 5_010}, WIDE_ENOUGH);
			expect(topics).toEqual([TRANSFER_V1]);
		});

		it('keeps the topic where either contract declares it live, and accepts the hole between them', async () => {
			// a hole BETWEEN two contracts is not a gap in an event coverage, so it is
			// not refused; and inside it BOTH declarations say the event cannot occur
			const contracts = [
				{address: A, abi: [{...transferV1, firstBlock: 100, lastBlock: 200}] as unknown as Abi},
				{address: B, abi: [{...transferV1, firstBlock: 400, lastBlock: 500}] as unknown as Abi},
			];
			expect(await topicsRequested(contracts, {}, {fromBlock: 150, toBlock: 160}, WIDE_ENOUGH)).toEqual([TRANSFER_V1]);
			expect(await topicsRequested(contracts, {}, {fromBlock: 450, toBlock: 460}, WIDE_ENOUGH)).toEqual([TRANSFER_V1]);
			expect(await requestsMade(contracts, {}, {fromBlock: 250, toBlock: 300}, WIDE_ENOUGH)).toEqual([]);
		});

		it('never narrows a topic one contract declared and another did not', async () => {
			const contracts = [
				{address: A, abi: [{...transferV1, firstBlock: 100, lastBlock: 200}] as unknown as Abi},
				{address: B, abi: [transferV1] as unknown as Abi, startBlock: 300},
			];
			for (const fromBlock of [0, 250, 10_000]) {
				const topics = await topicsRequested(contracts, {}, {fromBlock, toBlock: fromBlock + 10}, WIDE_ENOUGH);
				expect(topics).toEqual([TRANSFER_V1]);
			}
		});
	});

	describe('the request-count saving, which IS measured here', () => {
		// `generateLogRequestForTopicsAndFiltersCombinations` puts every topic in ONE
		// request when no argument filter is configured, and emits one request per
		// (topic x filter) when one is. So under filters a version that cannot occur
		// in a range costs its own round trip -- until it is narrowed away.
		//
		// (The NODE's own work -- a topic that cannot match still widens the
		// `logsBloom` screen, and so the set of blocks whose receipts are loaded --
		// is how nodes implement the method and is NOT measured here.)
		it('issues one request per live topic under argument filters, and one in total without', async () => {
			const acrossBoundary = {fromBlock: 895, toBlock: 905};
			expect(await requestsMade(ranged, FILTERED, acrossBoundary, WIDE_ENOUGH)).toHaveLength(2);

			const unfiltered = await requestsMade(ranged, {}, acrossBoundary, WIDE_ENOUGH);
			expect(unfiltered).toHaveLength(1);
			expect(unfiltered[0].topics?.[0]).toEqual([TRANSFER_V1, TRANSFER_V2]);
		});

		it('issues STRICTLY FEWER requests for a range that cannot contain one of the versions', async () => {
			const acrossBoundary = await requestsMade(ranged, FILTERED, {fromBlock: 895, toBlock: 905}, WIDE_ENOUGH);
			const belowTheUpgrade = await requestsMade(ranged, FILTERED, {fromBlock: 100, toBlock: 200}, WIDE_ENOUGH);

			expect(belowTheUpgrade.length).toBeLessThan(acrossBoundary.length);
			expect(belowTheUpgrade).toHaveLength(1);
			expect(belowTheUpgrade[0].topics?.[0]).toEqual(TRANSFER_V1);
		});
	});

	describe('a source declaring no range', () => {
		const unranged = [{address: A, abi: [transferV1, transferV2] as unknown as Abi, startBlock: 100}];
		const everywhere = [
			{fromBlock: 0, toBlock: 10},
			{fromBlock: 100, toBlock: 200},
			{fromBlock: 900, toBlock: 900},
			{fromBlock: 10_000, toBlock: 10_010},
		];

		it('requests exactly what it requests today, topic for topic, at every height', async () => {
			for (const range of everywhere) {
				const requests = await requestsMade(unranged, {}, range, WIDE_ENOUGH);
				expect(requests).toHaveLength(1);
				expect(requests[0].topics?.[0]).toEqual([TRANSFER_V1, TRANSFER_V2]);
			}
		});

		it('costs exactly as many requests as today under argument filters', async () => {
			for (const range of everywhere) {
				expect(await requestsMade(unranged, FILTERED, range, WIDE_ENOUGH)).toHaveLength(2);
			}
		});
	});
});

describe('a genuinely ambiguous ABI is refused, loudly, on every path', () => {
	// One topic0 meaning two things cannot be resolved by anything on the wire, and
	// no block boundary helps either: the upgrade tx sits mid-block, so both
	// meanings share a block.
	//
	// Every arrangement here puts the two declarations where NOTHING resolves
	// between them: at ONE address, or in a merged ABI that names no address at
	// all. The cross-ADDRESS arrangement is a different case and is no longer
	// here: `decodeOnto` resolves the ABI by the log's address, so there the wire
	// DOES tell the two apart, and ADR-0061 tolerates it (and refuses it again
	// under `parseAllEventsIrrespectiveOfAddresses`, where the address is
	// ignored). See `sharedTopic0AtDifferentAddresses.test.ts`.
	const arrangements: {label: string; contractsData: any}[] = [
		{
			label: 'one contract declaring both',
			contractsData: [{address: A, abi: [transferV1, transferV1Colliding] as unknown as Abi}],
		},
		{
			label: 'the same address twice',
			contractsData: [
				{address: A, abi: [transferV1] as unknown as Abi},
				{address: A, abi: [transferV1Colliding] as unknown as Abi},
			],
		},
		{
			label: 'a single merged ABI',
			contractsData: {abi: [transferV1, transferV1Colliding] as unknown as Abi},
		},
		{
			// a boundary resolves nothing: the upgrade transaction sits mid-block, so
			// both meanings share block 900 whatever the ranges say
			label: 'the two declarations given disjoint block ranges',
			contractsData: [
				{
					address: A,
					abi: [
						{...transferV1, firstBlock: 100, lastBlock: 900},
						{...transferV1Colliding, firstBlock: 900},
					] as unknown as Abi,
				},
			],
		},
	];

	for (const {label, contractsData} of arrangements) {
		for (const {label: pathLabel, parse} of BOTH_PATHS) {
			it(`refuses at construction, naming the events (${label}, ${pathLabel})`, () => {
				const build = () => new LogEventFetcher({request: async () => undefined} as any, contractsData, {}, parse);
				expect(build).toThrow(/Transfer\(address,address,uint256\)/);
				// the topic0 they collide on, so an operator can find them in the ABI
				expect(build).toThrow(new RegExp(TRANSFER_V1));
			});
		}
	}

	it('and a shared topic0 at TWO addresses is tolerated per-address, refused address-agnostically', () => {
		// the one arrangement whose verdict is CONDITIONAL, kept here so the boundary
		// of the refusal is readable from the file that owns it (ADR-0061)
		const acrossAddresses = [
			{address: A, abi: [transferV1] as unknown as Abi},
			{address: B, abi: [transferV1Colliding] as unknown as Abi},
		];
		const provider = {request: async () => undefined} as any;

		expect(() => new LogEventFetcher(provider, acrossAddresses as any, {}, BOTH_PATHS[0].parse)).not.toThrow();
		expect(() => new LogEventFetcher(provider, acrossAddresses as any, {}, BOTH_PATHS[1].parse)).toThrow(
			/ambiguous ABI/,
		);
	});

	it('still asks for the shared topic0, exactly once, when it is tolerated', async () => {
		// the event SET is what ADR-0031 protects and it is untouched: a tolerated
		// collision is still requested, and a request written down twice is not a
		// second event
		const acrossAddresses = [
			{address: A, abi: [transferV1] as unknown as Abi},
			{address: B, abi: [transferV1Colliding, transferV2] as unknown as Abi},
		];

		const requests = await requestsMade(acrossAddresses, {});

		expect(requests).toHaveLength(1);
		expect(requests[0].topics?.[0]).toEqual([TRANSFER_V1, TRANSFER_V2]);
	});
});

describe('the legitimate de-duplication still works', () => {
	const shared = [
		{address: A, abi: [transferV1] as unknown as Abi},
		{address: B, abi: [transferV1] as unknown as Abi},
	];

	for (const {label, parse} of BOTH_PATHS) {
		it(`collapses an IDENTICAL event declared by two contracts, without error (${label})`, async () => {
			const topics = await topicsRequested(shared, parse);
			expect(topics).toEqual([TRANSFER_V1]);
		});
	}

	it('collapses it in the per-address list too, when both entries are the same address', () => {
		const fetcher = new LogEventFetcher(
			{request: async () => undefined} as any,
			[
				{address: A, abi: [transferV1] as unknown as Abi},
				{address: A, abi: [transferV1, transferV2] as unknown as Abi},
			] as any,
		);

		const log = {
			blockNumber: '0x64',
			blockHash: '0xaaa',
			transactionIndex: '0x0',
			removed: false,
			address: A,
			data: `0x${(7).toString(16).padStart(64, '0')}`,
			topics: [TRANSFER_V1, `0x${'0'.repeat(24)}${A.slice(2)}`, `0x${'0'.repeat(24)}${B.slice(2)}`],
			transactionHash: `0x${'1'.padStart(64, '0')}`,
			logIndex: '0x0',
		};

		// a duplicated declaration must not make the log undecodable
		const [event] = fetcher.parse([log] as any);
		expect((event as any).eventName).toBe('Transfer');
	});
});
