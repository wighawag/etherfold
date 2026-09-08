import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {LogEventFetcher, parseLogBlockTimestamp} from '../src/internal/decoding/LogEventFetcher.js';

// ---------------------------------------------------------------------------
// READING `blockTimestamp` OFF THE LOG IS THE SURVIVING PATH
// ---------------------------------------------------------------------------
// `ethereum/execution-apis#639` (merged 2025-08-25) puts `blockTimestamp` on
// every log object. geth >= 1.16.0, reth, besu, erigon, anvil and
// `@nomicfoundation/edr >= 0.20.0` all serve it, so the time axis costs zero
// extra requests and the `alwaysFetchTimestamps` fallback that once paid one
// `eth_getBlockByHash` per event-bearing block is DELETED (ADR-0073).
//
// This file guards the half of that deletion which is easy to sweep away by
// accident. The engine no longer FETCHES a timestamp; it still READS one, and
// TOLERANTLY. Deleting the reading path along with the fetching path would look
// like tidying and would remove the feature the deletion rests on.
//
// The line held here is what an unreadable value becomes. It becomes
// `undefined`, never a number: not 0, not an interpolation, not the previous
// block's. A missing timestamp is REFUSED, loudly and one round trip in
// (`aTimestamplessLogIsRefusedAtTheFetchBoundary.test.ts`); a wrong one is not
// refused at all, and answers confidently about the wrong block for as long as
// the store lives, because `getAsOf({timestamp})` has no way to tell a caller it
// was lied to.
// ---------------------------------------------------------------------------

const abi = [
	{
		type: 'event',
		name: 'Transfer',
		anonymous: false,
		inputs: [
			{indexed: true, name: 'from', type: 'address'},
			{indexed: true, name: 'to', type: 'address'},
			{indexed: false, name: 'id', type: 'uint256'},
		],
	},
] as const satisfies Abi;

const ADDRESS = '0x0000000000000000000000000000000000000001';

function rawLog(over: Record<string, unknown> = {}) {
	return {
		blockNumber: '0x64',
		blockHash: '0xaaa',
		transactionIndex: '0x0',
		removed: false,
		address: ADDRESS,
		data: '0x',
		topics: [],
		transactionHash: `0x${'1'.padStart(64, '0')}`,
		logIndex: '0x0',
		...over,
	} as any;
}

describe('parseLogBlockTimestamp', () => {
	it('reads a 0x-prefixed hex QUANTITY, which is what the spec says', () => {
		// exactly the shape anvil 1.5.1 returns
		expect(parseLogBlockTimestamp('0x6a886a9d')).toBe(0x6a886a9d);
	});

	it('reads a bare decimal string, because at least one client serves it that way', () => {
		expect(parseLogBlockTimestamp('1700000000')).toBe(1700000000);
	});

	it('reads a plain number', () => {
		expect(parseLogBlockTimestamp(1700000000)).toBe(1700000000);
	});

	it('keeps hex and decimal APART, since the prefix is the only signal', () => {
		// `'1705366720'` is a valid hex string as well as a valid decimal one, and the
		// two readings are millennia apart. Coercing on a guess is exactly the wrong
		// timestamp this whole path refuses to invent.
		expect(parseLogBlockTimestamp('1705366720')).toBe(1705366720);
		expect(parseLogBlockTimestamp('0x1705366720')).not.toBe(1705366720);
	});

	it('treats anything else as ABSENT rather than coercing it to a number', () => {
		// There is no fallback that could recover a missing one any more, so this is
		// the whole of the tolerance: what it cannot read becomes `undefined`, the
		// fetch boundary refuses the range, and the operator is told about their node.
		// A `0` here would sort before every block and poison time addressing in
		// silence instead.
		for (const unreadable of [undefined, null, '', '   ', 'later', '0x', '0xzz', '-1', '1.5', -1, 1.5, Number.NaN]) {
			expect(parseLogBlockTimestamp(unreadable), JSON.stringify(unreadable)).toBeUndefined();
		}
	});
});

describe('LogEventFetcher.parse', () => {
	const fetcher = new LogEventFetcher({request: async () => undefined} as any, [{abi, address: ADDRESS}]);

	it('keeps the timestamp the node put on the log', () => {
		const [event] = fetcher.parse([rawLog({blockTimestamp: '0x6a886a9d'})]);
		expect(event.blockTimestamp).toBe(0x6a886a9d);
	});

	it('leaves it undefined when the node omits it, rather than inventing one', () => {
		const [event] = fetcher.parse([rawLog()]);
		expect(event.blockTimestamp).toBeUndefined();
	});

	it('leaves it undefined when the node serves something UNREADABLE, too', () => {
		// "unreadable" and "absent" are one outcome by design, and neither may become
		// a number on the way through the decoder.
		for (const unreadable of ['later', '0x', -1]) {
			const [event] = fetcher.parse([rawLog({blockTimestamp: unreadable})]);
			expect(event.blockTimestamp, JSON.stringify(unreadable)).toBeUndefined();
			expect(typeof event.blockTimestamp).not.toBe('number');
		}
	});

	it('does not carry a NEIGHBOUR\u2019s timestamp onto a log that has none', () => {
		// The interpolation failure, stated as a test: a decoder that filled a gap
		// from the log beside it would produce a plausible number for a block the
		// node said nothing about, and nothing downstream could tell.
		const [stamped, bare] = fetcher.parse([
			rawLog({blockTimestamp: '0x6a886a9d', logIndex: '0x0'}),
			rawLog({blockHash: '0xbbb', blockNumber: '0x65', logIndex: '0x1'}),
		]);
		expect(stamped.blockTimestamp).toBe(0x6a886a9d);
		expect(bare.blockTimestamp).toBeUndefined();
	});
});
