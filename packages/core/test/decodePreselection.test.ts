import type {Abi, AbiEvent} from 'abitype';
import {describe, expect, it} from 'vitest';
import {decodeEventLog} from 'viem';
import {LogEventFetcher} from '../src/internal/decoding/LogEventFetcher.js';
import {taggedBnReplacer} from '../src/utils/bigint.js';
import type {LogParseConfig} from '../src/types.js';

// ---------------------------------------------------------------------------
// DECODING IS PRESELECTED BY topic0, AND THAT MUST CHANGE NOTHING
// ---------------------------------------------------------------------------
// `decodeOnto` used to hand viem the WHOLE ABI of the log's address, once per
// log, and viem re-derived every candidate's event selector to find the one the
// log's topic0 names. Preselecting the member from a `${address}:${topic0}` map
// built once cuts that ~3.2x
// (`work/notes/findings/decoding-is-3x-faster-with-a-memoised-topic0-map.md`).
//
// It is a PURE optimisation, so this file is a PIN and not a feature test:
// every assertion below holds identically before and after the map exists, and
// the point of the file is that it keeps holding. Two independent pins, because
// they fail differently:
//
//   - a GOLDEN table of `eventName` / `args` / `decodeError`, canonicalised to
//     a string so ARGUMENT KEY ORDER is pinned too, not just the values;
//   - an ORACLE: the whole-ABI algorithm the optimisation replaces, transcribed
//     here and run over the same logs, so the check is against the ALGORITHM
//     rather than against a snapshot of one run.
//
// The two cases a map-only implementation would silently break, both present:
//
//   - an ANONYMOUS event carries no topic0, so it cannot be in the map and must
//     keep taking the whole-ABI route;
//   - a topic0 the address's ABI does not declare MISSES the map, and must fall
//     back to exactly the call that was made before.
//
// The map is only unambiguous because ADR-0031 REFUSES a topic0 collision at
// construction. That is a guarantee borrowed from another decision, so it is
// asserted here rather than trusted.
// ---------------------------------------------------------------------------

const A = '0x0000000000000000000000000000000000000001' as const;
const B = '0x0000000000000000000000000000000000000002' as const;
/** An address no contract in the source declares. */
const C = '0x0000000000000000000000000000000000000003' as const;

// topic0s, as viem encodes them, of the signatures used below
const TRANSFER_V1 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256)
const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'; // Approval(address,address,uint256)
const TRANSFER_OTHER = '0x69ca02dd4edd7bf0a4abb9ed3b7af3f14778db5d61921c7dc7cd545266326de2'; // Transfer(address,uint256)
const MINTED = '0x0845b188f67e41ce9dca65449b10fcf4b331553172abb19dbd22e7d9068de734'; // Minted(uint256,address,bytes)
/** What an anonymous event's topic0 WOULD be if it had one. It has none, so nothing carries this. */
const WHISPER_IF_IT_HAD_ONE = '0xac8e5929aa2a04e270e55835cae877dacec92dc5754442ec5d513adeddcd4cd2'; // Whisper(address,uint256)

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

/**
 * ANONYMOUS: no topic0, so its logs put an indexed ARGUMENT in `topics[0]` and
 * there is nothing to key a map entry by.
 */
const whisper = {
	type: 'event',
	name: 'Whisper',
	anonymous: true,
	inputs: [
		{indexed: true, name: 'who', type: 'address'},
		{indexed: false, name: 'amount', type: 'uint256'},
	],
} as const;

/** Another contract's `Transfer`: same NAME, different topic0. */
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
 * Declared `(id, to, memo)` and decoded `(to, id, memo)`, because viem writes
 * the INDEXED arguments first. Deliberate: argument key order is part of what
 * "byte-identical" means, so the fixture has to contain a case where the
 * declaration order and the decoded order differ.
 */
const minted = {
	type: 'event',
	name: 'Minted',
	anonymous: false,
	inputs: [
		{indexed: false, name: 'id', type: 'uint256'},
		{indexed: true, name: 'to', type: 'address'},
		{indexed: false, name: 'memo', type: 'bytes'},
	],
} as const;

/**
 * The SAME signature as `transferV1`, so the SAME topic0, decoding into
 * something else. ADR-0031 refuses this at construction, which is the whole
 * reason a one-member ABI may stand in for the whole one.
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

const CONTRACTS = [
	{address: A, abi: [transferV1, approval, whisper] as unknown as Abi},
	{address: B, abi: [transferOther, minted] as unknown as Abi},
];

const provider = {request: async () => undefined} as any;

const word = (value: number) => value.toString(16).padStart(64, '0');
const addressTopic = (address: `0x${string}`) => `0x${'0'.repeat(24)}${address.slice(2)}` as `0x${string}`;

/** A stored event as the stream cache holds it: the raw log, plus a decoded half that `reparse` drops. */
function stored(
	logIndex: number,
	address: `0x${string}`,
	topics: `0x${string}`[],
	data: `0x${string}`,
): Record<string, unknown> {
	return {
		blockNumber: 100,
		blockHash: '0xaaa',
		transactionIndex: 0,
		removed: false,
		address,
		data,
		topics,
		transactionHash: `0x${String(logIndex).padStart(64, '0')}`,
		logIndex,
		// what SOME earlier ABI made of those bytes: `reparse` must drop it and
		// recompute, never merge with it
		eventName: 'StaleFromAnOlderAbi',
		args: {stale: true},
	};
}

/** `(uint256 id, bytes memo)` as non-indexed data: head, offset, length, padded bytes. */
const MINTED_DATA = `0x${word(9)}${word(64)}${word(2)}beef${'0'.repeat(60)}` as const;

/**
 * One log of every kind `decodeOnto` can meet, over two addresses.
 *
 * Ordered so the table below reads as the case list: a plain decode, a second
 * event at the same address, an anonymous event, a map MISS, a decode that
 * FAILS on its data, the other address's two events, and an address the source
 * does not declare at all.
 */
const STORED_LOGS = [
	stored(0, A, [TRANSFER_V1, addressTopic(A), addressTopic(B)], `0x${word(7)}`),
	stored(1, A, [APPROVAL, addressTopic(B), addressTopic(A)], `0x${word(42)}`),
	// anonymous: topics[0] is the indexed `who` argument, not a selector
	stored(2, A, [addressTopic(B)], `0x${word(5)}`),
	// a topic0 that is real, but belongs to the OTHER address's ABI: a genuine miss
	stored(3, A, [TRANSFER_OTHER, addressTopic(A)], `0x${word(11)}`),
	// a HIT whose data cannot be decoded against the member it names
	stored(4, A, [TRANSFER_V1, addressTopic(A), addressTopic(B)], '0x1234'),
	stored(5, B, [TRANSFER_OTHER, addressTopic(A)], `0x${word(11)}`),
	stored(6, B, [MINTED, addressTopic(A)], MINTED_DATA),
	// an address no contract declares
	stored(7, C, [TRANSFER_V1, addressTopic(A), addressTopic(B)], `0x${word(7)}`),
];

/**
 * The DECODED HALF of an event, canonicalised.
 *
 * A string rather than an object, because the claim is byte-identity: two
 * `args` with the same entries in a different order are not the same answer,
 * and `toEqual` would not notice.
 */
const decodedHalfOf = (events: readonly unknown[]): string[] =>
	events.map((event) => {
		const {eventName, args, decodeError} = event as Record<string, unknown>;
		return JSON.stringify({eventName, args, decodeError}, taggedBnReplacer);
	});

/** The same canonicalisation over a hand-written expectation, so the two are compared identically. */
const expectedHalf = (entries: readonly Record<string, unknown>[]): string[] =>
	entries.map((entry) => JSON.stringify(entry, taggedBnReplacer));

// ---------------------------------------------------------------------------
// THE ORACLE: the algorithm preselection replaces
// ---------------------------------------------------------------------------

/**
 * What `decodeOnto` did BEFORE the map: viem, handed the WHOLE event ABI that
 * applies at the log's address, once per log.
 *
 * Transcribed rather than snapshotted so that the optimisation is checked
 * against the rule it claims to preserve. The fixture declares no duplicate
 * event, so the de-duplication `LogEventFetcher` runs over its lists is a
 * no-op here and this transcription is faithful.
 */
function decodedTheWholeAbiWay(
	contracts: {address: `0x${string}`; abi: Abi}[],
	logs: readonly Record<string, unknown>[],
	parseConfig?: LogParseConfig,
): string[] {
	const abiPerAddress = new Map<string, AbiEvent[]>();
	const allABIEvents: AbiEvent[] = [];
	for (const contract of contracts) {
		const events = contract.abi.filter((item) => item.type === 'event') as AbiEvent[];
		abiPerAddress.set(contract.address, [...(abiPerAddress.get(contract.address) ?? []), ...events]);
		allABIEvents.push(...events);
	}
	const useAllABIEvents = abiPerAddress.size === 0 || parseConfig?.parseAllEventsIrrespectiveOfAddresses;

	return logs.map((log) => {
		const abi = useAllABIEvents ? allABIEvents : abiPerAddress.get(log.address as `0x${string}`);
		if (!abi) {
			return JSON.stringify({decodeError: `event triggered at a different address`}, taggedBnReplacer);
		}
		try {
			const parsed = decodeEventLog({abi, data: log.data as `0x${string}`, topics: log.topics as any});
			return JSON.stringify({eventName: parsed.eventName, args: parsed.args}, taggedBnReplacer);
		} catch {
			return JSON.stringify({decodeError: `parsing did not return any results`}, taggedBnReplacer);
		}
	});
}

// ---------------------------------------------------------------------------

describe('reparse decodes byte-identically, whichever route decodeOnto takes', () => {
	it('pins eventName, args and decodeError for every log of a multi-event, multi-address ABI', () => {
		const fetcher = new LogEventFetcher(provider, CONTRACTS as any);

		const reparsed = fetcher.reparse(STORED_LOGS as any);

		expect(reparsed).toBeDefined();
		expect(decodedHalfOf(reparsed!)).toEqual(
			expectedHalf([
				{eventName: 'Transfer', args: {from: A, to: B, id: 7n}},
				{eventName: 'Approval', args: {owner: B, spender: A, value: 42n}},
				// ANONYMOUS: `decodeEventLog` selects a member by matching topics[0]
				// against a computed selector, and an anonymous event's topics[0] is an
				// argument, so no member is found and the log records the failure. The
				// pin is that this ANSWER does not move, whatever route it takes.
				{decodeError: 'parsing did not return any results'},
				// a MISS: the topic0 belongs to the other address's ABI
				{decodeError: 'parsing did not return any results'},
				// a HIT whose data does not decode against the member its topic0 names
				{decodeError: 'parsing did not return any results'},
				{eventName: 'Transfer', args: {to: A, amount: 11n}},
				// declared (id, to, memo), decoded (to, id, memo): indexed arguments first
				{eventName: 'Minted', args: {to: A, id: 9n, memo: '0xbeef'}},
				{decodeError: 'event triggered at a different address'},
			]),
		);
	});

	it('agrees with the whole-ABI decode it replaces, log for log', () => {
		const fetcher = new LogEventFetcher(provider, CONTRACTS as any);

		const reparsed = fetcher.reparse(STORED_LOGS as any);

		expect(decodedHalfOf(reparsed!)).toEqual(decodedTheWholeAbiWay(CONTRACTS as any, STORED_LOGS));
	});

	it('drops the decoded half a previous ABI wrote rather than merging with it', () => {
		const fetcher = new LogEventFetcher(provider, CONTRACTS as any);

		const reparsed = fetcher.reparse(STORED_LOGS as any) as any[];

		for (const event of reparsed) {
			expect(event.eventName).not.toBe('StaleFromAnOlderAbi');
			expect(event.args?.stale).toBeUndefined();
		}
		// and the raw half it decodes FROM is untouched
		expect(reparsed.map((event) => event.topics)).toEqual(STORED_LOGS.map((log) => log.topics));
	});

	it('decodes a topic0 that IS declared at the address and one that is NOT, so the fallback is exercised', () => {
		const fetcher = new LogEventFetcher(provider, CONTRACTS as any);

		const [hit, miss] = fetcher.reparse([STORED_LOGS[0], STORED_LOGS[3]] as any) as any[];

		// a hit: preselected once the map exists, whole-ABI before it
		expect(hit.eventName).toBe('Transfer');
		expect(hit.args).toEqual({from: A, to: B, id: 7n});
		expect(hit.decodeError).toBeUndefined();
		// a miss: `Transfer(address,uint256)` is declared at B and not at A, so
		// nothing can be preselected and the call made is the one made before
		expect(miss.eventName).toBeUndefined();
		expect(miss.decodeError).toBe('parsing did not return any results');
	});

	it('keeps an ANONYMOUS event on the whole-ABI route, since it carries no topic0 to preselect by', () => {
		const fetcher = new LogEventFetcher(provider, CONTRACTS as any);
		const anonymousLog = STORED_LOGS[2];

		const [reparsed] = fetcher.reparse([anonymousLog] as any) as any[];

		// its topics[0] is an ARGUMENT, so it can never key a preselection entry
		expect(anonymousLog.topics).toEqual([addressTopic(B)]);
		expect((anonymousLog.topics as string[])[0]).not.toBe(WHISPER_IF_IT_HAD_ONE);
		// and the answer is the same one the whole-ABI route gives
		expect(decodedHalfOf([reparsed])).toEqual(decodedTheWholeAbiWay(CONTRACTS as any, [anonymousLog]));
	});

	it('gives the fetch path and the replay path the same decoded half', () => {
		// `decodeOnto` exists so both paths decode through ONE rule; preselecting
		// inside it must not split them again
		const fetcher = new LogEventFetcher(provider, CONTRACTS as any);
		const rawLogs = STORED_LOGS.map((log) => ({
			...log,
			blockNumber: `0x${(log.blockNumber as number).toString(16)}`,
			transactionIndex: '0x0',
			logIndex: `0x${(log.logIndex as number).toString(16)}`,
		}));

		const fetched = fetcher.parse(rawLogs as any);
		const replayed = fetcher.reparse(STORED_LOGS as any);

		expect(decodedHalfOf(fetched)).toEqual(decodedHalfOf(replayed!));
	});
});

describe('parseAllEventsIrrespectiveOfAddresses keeps its whole-ABI route', () => {
	// ADR-0031: the flag decides which ABI DECODES a log and must never decide
	// which events exist. It is deliberately NOT given a map of its own.
	const AGNOSTIC: LogParseConfig = {parseAllEventsIrrespectiveOfAddresses: true};

	it('decodes a log at an address whose own ABI does not declare it, which the per-address route refuses', () => {
		const agnostic = new LogEventFetcher(provider, CONTRACTS as any, {}, AGNOSTIC);
		const perAddress = new LogEventFetcher(provider, CONTRACTS as any);
		// B's `Transfer(address,uint256)`, arriving at A
		const crossed = [STORED_LOGS[3]];

		const [viaFlag] = agnostic.reparse(crossed as any) as any[];
		const [viaAddress] = perAddress.reparse(crossed as any) as any[];

		expect(viaFlag.eventName).toBe('Transfer');
		expect(viaFlag.args).toEqual({to: A, amount: 11n});
		expect(viaAddress.decodeError).toBe('parsing did not return any results');
	});

	it('decodes every log exactly as the whole-ABI route does under the flag', () => {
		const fetcher = new LogEventFetcher(provider, CONTRACTS as any, {}, AGNOSTIC);

		const reparsed = fetcher.reparse(STORED_LOGS as any);

		expect(decodedHalfOf(reparsed!)).toEqual(decodedTheWholeAbiWay(CONTRACTS as any, STORED_LOGS, AGNOSTIC));
	});

	it('decodes a log at an UNDECLARED address under the flag, and refuses it without', () => {
		const agnostic = new LogEventFetcher(provider, CONTRACTS as any, {}, AGNOSTIC);
		const perAddress = new LogEventFetcher(provider, CONTRACTS as any);

		const [viaFlag] = agnostic.reparse([STORED_LOGS[7]] as any) as any[];
		const [viaAddress] = perAddress.reparse([STORED_LOGS[7]] as any) as any[];

		expect(viaFlag.eventName).toBe('Transfer');
		expect(viaFlag.args).toEqual({from: A, to: B, id: 7n});
		expect(viaAddress.decodeError).toBe('event triggered at a different address');
	});
});

describe('the preselection map', () => {
	/** The private map, read structurally: what it holds is the claim, not how fast it is. */
	const mapOf = (fetcher: LogEventFetcher<Abi>) =>
		(fetcher as unknown as {abiEventPerAddressAndTopic: Map<string, AbiEvent>}).abiEventPerAddressAndTopic;

	it('REFUSES a topic0 collision at construction, which is what makes preselection unambiguous', () => {
		// ADR-0031. Borrowed guarantee, asserted rather than trusted: a one-member
		// ABI and the whole ABI are only interchangeable because no two members of
		// one ABI can answer to one topic0.
		expect(
			() =>
				new LogEventFetcher(provider, [{address: A, abi: [transferV1, transferV1Colliding] as unknown as Abi}] as any),
		).toThrow(/ambiguous ABI/);
	});

	it('holds every non-anonymous member under its address and topic0, and no anonymous one', () => {
		const fetcher = new LogEventFetcher(provider, CONTRACTS as any);

		expect([...mapOf(fetcher).keys()].sort()).toEqual(
			[`${A}:${TRANSFER_V1}`, `${A}:${APPROVAL}`, `${B}:${TRANSFER_OTHER}`, `${B}:${MINTED}`].sort(),
		);
		// the anonymous member is absent under every key it could plausibly take
		expect(mapOf(fetcher).get(`${A}:${WHISPER_IF_IT_HAD_ONE}`)).toBeUndefined();
		expect(mapOf(fetcher).get(`${A}:${addressTopic(B)}`)).toBeUndefined();
	});

	it('preselects the member the whole-ABI search would have found', () => {
		const fetcher = new LogEventFetcher(provider, CONTRACTS as any);

		expect(mapOf(fetcher).get(`${A}:${TRANSFER_V1}`)).toBe(transferV1 as unknown as AbiEvent);
		expect(mapOf(fetcher).get(`${B}:${MINTED}`)).toBe(minted as unknown as AbiEvent);
		// keyed per ADDRESS: B's Transfer is not reachable at A
		expect(mapOf(fetcher).get(`${A}:${TRANSFER_OTHER}`)).toBeUndefined();
	});

	it('is built ONCE per fetcher and never rebuilt by a decode', () => {
		// structural, not timed: the map is the same instance after two passes and
		// nothing wrote to it in between
		const fetcher = new LogEventFetcher(provider, CONTRACTS as any);
		const map = mapOf(fetcher);
		let writes = 0;
		map.set = function (this: Map<string, AbiEvent>, key: string, value: AbiEvent) {
			writes++;
			return Map.prototype.set.call(this, key, value);
		};

		fetcher.reparse(STORED_LOGS as any);
		fetcher.reparse(STORED_LOGS as any);

		expect(writes).toBe(0);
		expect(mapOf(fetcher)).toBe(map);
	});
});
