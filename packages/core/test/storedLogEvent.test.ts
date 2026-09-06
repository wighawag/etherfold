import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {LogEventFetcher} from '../src/internal/decoding/LogEventFetcher.js';
import type {BaseLogEvent, LogEvent, LogEventWithParsingFailure, ParsedLogEvent, StoredLogEvent} from '../src/types.js';

// ---------------------------------------------------------------------------
// THE STORED EVENT REFUSES A DECODED ONE
// ---------------------------------------------------------------------------
// What the stream stores is what the node said -- the raw log plus the reorg
// flag the indexer derived -- and NOTHING an ABI made of those bytes: `args` /
// `eventName` are one ABI's reading of them and `decodeError` is one ABI's
// failure to read them, all three re-derived on read by `reparse` against the
// source running now (ADR-0034).
//
// `StoredLogEvent` is the shape that SAYS so. The refusal is a TYPE claim, so
// it is asserted the only way a type claim can be: `pnpm typecheck` runs the
// first half of this file, and each `@ts-expect-error` FAILS it if the line it
// guards ever starts compiling. Note the trap this repo has already hit -- the
// browser tests pass their keeper through as `never` at several call sites, so
// a stored-event break is INVISIBLE there and those tests passing proves
// nothing about the compile-time half.
//
// The second half is ordinary vitest over the one consumer that widened here:
// the re-decode takes a stored array as readily as a decoded one, and does the
// same thing with both.
// ---------------------------------------------------------------------------

const ADDRESS = '0x0000000000000000000000000000000000000001';
/** `Transfer(address,address,uint256)`, as viem encodes its selector. */
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

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
type WithInputs = typeof abi;

/**
 * An event declaring NO inputs, asserted separately because it is the case a
 * refusal could plausibly miss: it decodes to a THINNER shape than a
 * parameterised event does, so "a parsed event is refused" has to be checked at
 * both ends of that range rather than at the fat end only.
 */
const abiWithoutInputs = [{type: 'event', name: 'Paused', anonymous: false, inputs: []}] as const satisfies Abi;
type WithoutInputs = typeof abiWithoutInputs;

const word = (value: number) => value.toString(16).padStart(64, '0');
const addressTopic = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}` as `0x${string}`;

/** The raw log the node reported, as a keeper holds it: no decoded half, statically. */
function storedEvent(over: Partial<StoredLogEvent> = {}): StoredLogEvent {
	return {
		blockNumber: 100,
		blockHash: '0xaaa',
		transactionIndex: 2,
		removed: false,
		address: ADDRESS,
		data: `0x${word(7)}`,
		topics: [TRANSFER, addressTopic(ADDRESS), addressTopic(ADDRESS)],
		transactionHash: `0x${'1'.padStart(64, '0')}`,
		logIndex: 3,
		extra: undefined,
		...over,
	};
}

// -- the refusal, evaluated by `pnpm typecheck` ------------------------------

/** A seam that takes what a keeper STORES: one event, and the array of them. */
function storesOne(event: StoredLogEvent) {
	return event;
}
function storesMany(events: readonly StoredLogEvent[]) {
	return events;
}

describe('the shape a stored event may take', () => {
	it('refuses every decoded event and accepts the raw one', () => {
		// Deliberately never CALLED: the assertions here are the `@ts-expect-error`
		// comments. Vitest strips types, so running the body would prove nothing.
		function refusals(
			parsed: ParsedLogEvent<WithInputs>,
			parsedWithoutInputs: ParsedLogEvent<WithoutInputs>,
			failed: LogEventWithParsingFailure,
			decoded: LogEvent<WithInputs>,
			decodedStream: readonly LogEvent<WithInputs>[],
			widened: BaseLogEvent,
		) {
			// @ts-expect-error a PARSED event carries `args` and `eventName`: one ABI's reading of the bytes
			storesOne(parsed);
			// @ts-expect-error and one whose event declares no inputs is refused too, thinner shape and all
			storesOne(parsedWithoutInputs);
			// @ts-expect-error a parsing FAILURE carries `decodeError`, which is equally a decode's opinion
			storesOne(failed);
			// @ts-expect-error the UNION is refused through its members: an event carrying neither half is in neither
			storesOne(decoded);
			// @ts-expect-error and so is an ARRAY of them, which is the shape a keeper is actually handed
			storesMany(decodedStream);

			// what a keeper stores is ACCEPTED, both as a fresh literal (where excess
			// property checks fire) and as the array
			storesOne(storedEvent());
			storesMany([storedEvent(), storedEvent({logIndex: 4})]);

			// THE KNOWN HOLE, asserted rather than hidden: a value whose STATIC type has
			// already been widened to the supertype still assigns, because nothing is
			// left for the `?: never` clauses to catch. The guard is at the SEAM and not
			// through a widening. If this line ever stops compiling the hole has been
			// closed, which is an improvement and a reason to rewrite this comment.
			storesOne(widened);

			return {parsed, parsedWithoutInputs, failed, decoded, decodedStream, widened};
		}

		expect(typeof refusals).toBe('function');
	});
});

// -- the re-decode takes both shapes -----------------------------------------

const provider = {request: async () => undefined} as any;

function rawLog(over: Record<string, unknown> = {}) {
	return {
		blockNumber: '0x64',
		blockHash: '0xaaa',
		transactionIndex: '0x2',
		removed: false,
		address: ADDRESS,
		data: `0x${word(7)}`,
		topics: [TRANSFER, addressTopic(ADDRESS), addressTopic(ADDRESS)],
		transactionHash: `0x${'1'.padStart(64, '0')}`,
		logIndex: '0x3',
		...over,
	} as any;
}

const decodedHalfOf = (events: readonly unknown[]) =>
	events.map((event) => {
		const {args, eventName, decodeError} = event as Record<string, unknown>;
		return {args, eventName, decodeError};
	});

describe('the re-decode of a cached stream', () => {
	const fetcher = new LogEventFetcher(provider, [{abi, address: ADDRESS}]);

	it('takes a STORED array, whose static type carries no decoded half at all, and returns decoded events', () => {
		// no cast: this is the point of the widening, and a cast here would assert
		// exactly what the test exists to check
		const stored: StoredLogEvent[] = [storedEvent(), storedEvent({logIndex: 4})];

		const reparsed = fetcher.reparse(stored);

		expect(reparsed).toHaveLength(2);
		expect(reparsed!.map((event) => (event as any).eventName)).toEqual(['Transfer', 'Transfer']);
		expect((reparsed![0] as any).args.id).toBe(7n);
		// the raw half is carried through untouched
		expect(reparsed!.map((event) => event.logIndex)).toEqual([3, 4]);
	});

	it('still takes a DECODED array and does exactly the same thing with it', () => {
		const decoded = fetcher.parse([rawLog(), rawLog({logIndex: '0x4'})]);

		const fromDecoded = fetcher.reparse(decoded);
		const fromStored = fetcher.reparse([storedEvent(), storedEvent({logIndex: 4})]);

		expect(decodedHalfOf(fromDecoded!)).toEqual(decodedHalfOf(fromStored!));
		expect(fromDecoded!.map((event) => event.logIndex)).toEqual(fromStored!.map((event) => event.logIndex));
	});

	it('still answers "cannot re-read" for a stored event with no raw log left, whichever shape it arrives as', () => {
		// the ADR-0034 guard is about the RAW half, so widening what the parameter
		// accepts must not have moved it
		const noTopics = storedEvent({topics: undefined as unknown as StoredLogEvent['topics']});

		expect(fetcher.reparse([noTopics])).toBeUndefined();
	});
});
