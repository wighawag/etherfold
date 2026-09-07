import {describe, expect, it} from 'vitest';
import {
	storedEventOf,
	storedStreamOf,
	type IndexingSource,
	type LogEvent,
	type StoredLastSync,
	type StoredLogEvent,
	type StreamSaver,
} from '@etherfold/core';
import {abi, type TestABI} from '../browser/workload.js';

/**
 * THE STORED-EVENT STRIP, REACHED THE WAY A CONSUMER REACHES IT.
 *
 * The claim is about the PACKAGE ENTRY and about nothing else, which is why it
 * is asserted from a consumer's suite rather than beside the function: this file
 * resolves `@etherfold/core` as an installed dependency does, through the
 * package `exports` and `dist/`, so a refactor that un-publishes either function
 * fails HERE instead of breaking a downstream build nobody in this repository
 * runs. A test inside core would import the internal module by relative path and
 * stay green with the entry closed, which is exactly the gap this fills.
 *
 * WHY THE EXPORT EXISTS is ADR-0060 plus ADR-0063's build item: the keeper seam
 * takes only what the node said, and something OUTSIDE core -- a seed PRODUCER,
 * or a consumer writing its own installer over `saveNewEvents` -- has to reduce a
 * decoded event to a stored one through the ONE implementation of that rule. The
 * evidence that it could not is committed:
 * `docs/spikes/pin-the-seam-a-published-stream-arrives-through/install.mjs`
 * COPIED the three-key destructure, and its own comment says a real
 * implementation must not.
 *
 * **`pnpm typecheck` runs half of this file.** Every annotation below is
 * imported from the entry too, so a signature naming a type the entry does not
 * publish would fail to compile here rather than at a consumer's install.
 */

/** The three fields that are a DECODE and not a fact about the log. */
const DECODED_HALF = ['args', 'eventName', 'decodeError'] as const;

/** Which of them an object actually carries; `[]` is what a stored event has. */
function decodedKeysOf(event: object): string[] {
	return DECODED_HALF.filter((key) => key in event);
}

const CONTRACT = '0x0000000000000000000000000000000000000099' as const;
const ALICE = '0x0000000000000000000000000000000000000011' as const;
const BOB = '0x0000000000000000000000000000000000000022' as const;

const SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: 100}],
};

/**
 * ONE DECODED EVENT, which is what a producer or an installer holds.
 *
 * Written out rather than fetched through the decoder: what the strip is asked
 * about is an event that carries its decoded half, and the shortest honest way
 * to hold one is to build it.
 */
function decodedTransfer(logIndex: number): LogEvent<TestABI> {
	return {
		blockNumber: 100,
		blockHash: '0xa100',
		transactionIndex: 0,
		removed: false,
		address: CONTRACT,
		data: '0x0000000000000000000000000000000000000000000000000000000000000001',
		topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'],
		transactionHash: '0x0000000000000000000000000000000000000000000000000000000000000abc',
		logIndex,
		extra: undefined,
		eventName: 'Transfer',
		args: {from: ALICE, to: BOB, id: 1n},
	};
}

/** What the node said, and only that: the half the strip must preserve whole. */
function rawHalfOf(event: LogEvent<TestABI> | StoredLogEvent): object {
	return {
		blockNumber: event.blockNumber,
		blockHash: event.blockHash,
		transactionIndex: event.transactionIndex,
		removed: event.removed,
		address: event.address,
		data: event.data,
		topics: event.topics,
		transactionHash: event.transactionHash,
		logIndex: event.logIndex,
	};
}

describe('the stored-event strip is reachable from outside @etherfold/core', () => {
	it('drops the decoded half and keeps everything the node said', () => {
		const event = decodedTransfer(0);

		const stored: StoredLogEvent = storedEventOf(event);

		expect(decodedKeysOf(stored)).toEqual([]);
		expect(rawHalfOf(stored)).toEqual(rawHalfOf(event));
	});

	it('builds a NEW event rather than deleting keys off the one the caller holds', () => {
		// The caller's event is the very one a processor is about to fold, so a
		// strip in place would corrupt what the fold reads. A consumer reaching the
		// published function gets that guarantee rather than re-deriving it.
		const event = decodedTransfer(0);

		const stored = storedEventOf(event);

		expect(stored).not.toBe(event);
		expect(decodedKeysOf(event)).toEqual(['args', 'eventName']);
	});

	it('rebuilds every event of a batch, not merely the array around them', () => {
		const events = [decodedTransfer(0), decodedTransfer(1)];

		const stream: StoredLogEvent[] = storedStreamOf(events);

		// Held as a set of `object`, because comparing a `StoredLogEvent` against a
		// `LogEvent` directly is a type error: the two have no overlap, which is the
		// seam's refusal showing up in the test that uses it.
		const handedIn = new Set<object>(events);
		expect(stream.map(decodedKeysOf)).toEqual([[], []]);
		expect(stream.map((stored) => handedIn.has(stored))).toEqual([false, false]);
		expect(events.map(decodedKeysOf)).toEqual([
			['args', 'eventName'],
			['args', 'eventName'],
		]);
	});

	it('produces exactly what the public keeper seam takes', async () => {
		// The shape an installer outside core writes through (ADR-0063): the strip's
		// output IS a `saveNewEvents` batch, with no cast at the call site. The
		// assertion that matters is that this compiles; the fake keeper is here so
		// the call is real rather than a type-level sketch.
		let handed: {lastSync: StoredLastSync; eventStream: StoredLogEvent[]} | undefined;
		const saveNewEvents: StreamSaver<TestABI> = async (_source, stream) => {
			handed = stream;
		};

		await saveNewEvents(SOURCE, {
			eventStream: storedStreamOf([decodedTransfer(0)]),
			lastSync: {
				context: {source: [], config: 'config-hash', processor: 'processor-hash'},
				latestBlock: 105,
				lastFromBlock: 100,
				lastToBlock: 104,
				unconfirmedBlocks: [],
			},
		});

		expect(handed?.eventStream.map(decodedKeysOf)).toEqual([[]]);
	});
});
