import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import type {LogEvent} from '../src/types.js';
import {
	BRANCH_A,
	BRANCH_A_TIP,
	fakeChain,
	fakeProcessor,
	indexToTip,
	makeIndexer,
	makeLog,
	memoryStream,
	shapeOf,
	type ProcessorStore,
} from './utils/streamCacheWorld.js';

// ---------------------------------------------------------------------------
// THE STREAM IS SAVED WITHOUT ITS DECODED HALF
// ---------------------------------------------------------------------------
// What a keeper is handed to persist is the raw log plus the reorg verdict, and
// NOTHING an ABI made of those bytes: `args` / `eventName` are one ABI's reading
// of a log and `decodeError` is one ABI's failure to read it, all three
// re-derived on read against the source running now (ADR-0034). The strip lives
// ONCE, in core, on the way into `saveNewEvents` -- the seam is
// third-party-implementable with several implementations already, so a rule each
// keeper had to remember would drift.
//
// Two traps this codebase has already paid for once, and each has its own test
// below rather than a careful reading:
//
//   1. A new ARRAY over the same references strips NOTHING, and those references
//      are the very event objects the processor is about to fold. So the events
//      have to be rebuilt, and what the processor holds must still be decoded
//      after the save.
//   2. A MUTATING `lastSync` strip empties the LIVE reorg window, because the
//      same object is handed to the STATE keeper on the same tick (the stream is
//      written first, `process` is called with that very cursor immediately
//      after). So a new `LastSync` with new blocks, and the state keeper's copy
//      still carries its window, decoded.
//
// Asserted at the keeper seam -- what the fake was HANDED -- because none of it
// is visible in the state that comes out.
// ---------------------------------------------------------------------------

/** The three fields that are a DECODE and not a fact about the log. */
const DECODED_HALF = ['args', 'eventName', 'decodeError'] as const;

/** Which of them an object actually carries; `[]` is what a stored event has. */
function decodedKeysOf(event: object): string[] {
	return DECODED_HALF.filter((key) => key in event);
}

/**
 * The same log, DECODED, which is what the fetch path hands the engine.
 *
 * The world's `makeLog` is a raw log because the engine tests replace the log
 * fetcher and decode nothing; here the decoded half is the whole subject, so it
 * is put on deliberately. It stays JSON-safe (no bigint) because the fakes
 * round-trip a cursor through `JSON.stringify` exactly as a real keeper does.
 */
function decoded(log: LogEvent<Abi>): LogEvent<Abi> {
	return {
		...log,
		eventName: 'Transfer',
		args: {id: shapeOf(log)},
	} as unknown as LogEvent<Abi>;
}

/** What the node said, and only that: the comparison the strip must preserve. */
function rawHalfOf(event: LogEvent<Abi>) {
	return {
		blockNumber: event.blockNumber,
		blockHash: event.blockHash,
		logIndex: event.logIndex,
		transactionHash: event.transactionHash,
		transactionIndex: event.transactionIndex,
		address: event.address,
		data: event.data,
		topics: event.topics,
		removed: !!event.removed,
	};
}

const DECODED_A = BRANCH_A.map(decoded);
/** The same chain after a reorg at 104: same 100 and 102, a DIFFERENT 104. */
const DECODED_B = [DECODED_A[0], DECODED_A[1], DECODED_A[2], decoded(makeLog(104, '0xb104'))];

/** One indexed run over a decoded chain, driven to the tip. */
async function indexedRun(logs: LogEvent<Abi>[] = DECODED_A, tip = BRANCH_A_TIP) {
	const chain = fakeChain([...logs], tip);
	const store: ProcessorStore = {};
	const subject = fakeProcessor(store);
	const stream = memoryStream();
	const indexer = makeIndexer(chain, subject.processor, stream.keeper);
	await indexer.load();
	await indexToTip(indexer);
	return {chain, store, subject, stream, indexer};
}

describe('the events a keeper is handed', () => {
	it('carry no `args`, no `eventName` and no `decodeError`', async () => {
		const {stream} = await indexedRun();

		const handed = stream.writes.flatMap((write) => write.events);
		expect(handed.length).toBeGreaterThan(0);
		expect(handed.flatMap(decodedKeysOf)).toEqual([]);
	});

	it('are NEW objects: what the processor was handed on the same tick is still decoded', async () => {
		const {subject} = await indexedRun();

		// the processor's own copies, taken INSIDE `process` -- which runs after the
		// save on that same tick, so a strip over the shared references would show here
		const folded = subject.batches.flat();
		expect(folded.length).toBeGreaterThan(0);
		for (const event of folded) {
			expect(decodedKeysOf(event)).toEqual(['args', 'eventName']);
		}
		// and the objects the chain served are untouched too
		expect(decodedKeysOf(DECODED_A[0])).toEqual(['args', 'eventName']);
	});

	it('answer the same membership, order and raw halves as what was fetched', async () => {
		const {stream} = await indexedRun();

		expect(stream.events.map(shapeOf)).toEqual(DECODED_A.map(shapeOf));
		expect(stream.events.map(rawHalfOf)).toEqual(DECODED_A.map(rawHalfOf));
	});

	it('are stripped when they are RETRACTIONS the chain reorged away', async () => {
		const {chain, indexer, stream} = await indexedRun();

		chain.serve([...DECODED_B], 106);
		await indexToTip(indexer);

		const shapes = stream.events.map(shapeOf);
		expect(shapes).toContain('R:0xa104:0');
		expect(shapes).toContain('A:0xb104:0');
		expect(stream.writes.flatMap((write) => write.events).flatMap(decodedKeysOf)).toEqual([]);
	});

	it('are stripped when they are retractions of a batch the processor never accepted', async () => {
		// The other producer of events at the save path: a batch that was written and
		// then refused by the fold, retracted at its original block on the next cycle.
		// Those markers are built by spreading the events the processor was handed --
		// decoded ones -- so they are exactly where an unstripped event slips through.
		const chain = fakeChain([...DECODED_A], BRANCH_A_TIP);
		const subject = fakeProcessor();
		const stream = memoryStream();
		const indexer = makeIndexer(chain, subject.processor, stream.keeper);
		await indexer.load();

		subject.throwOnProcess(true);
		await expect(indexer.indexMore()).rejects.toThrow();
		chain.serve([...DECODED_B], 106);
		subject.throwOnProcess(false);
		await indexToTip(indexer);

		const shapes = stream.events.map(shapeOf);
		expect(shapes).toContain('R:0xa104:0');
		expect(stream.writes.flatMap((write) => write.events).flatMap(decodedKeysOf)).toEqual([]);
	});
});

describe('the `lastSync` a keeper is handed', () => {
	it('carries a stripped unconfirmed window', async () => {
		const {stream} = await indexedRun();

		const windowed = stream.writes.flatMap((write) =>
			write.lastSync.unconfirmedBlocks.flatMap((block) => block.events),
		);
		expect(windowed.length).toBeGreaterThan(0);
		expect(windowed.flatMap(decodedKeysOf)).toEqual([]);
		// the cursor NUMBERS are untouched: the window is the only thing that changed
		const last = stream.writes[stream.writes.length - 1].lastSync;
		expect(last.lastToBlock).toBe(BRANCH_A_TIP);
		expect(last.latestBlock).toBe(BRANCH_A_TIP);
	});

	it('does not MUTATE: the state keeper still holds its window, decoded, after the stream save', async () => {
		const {store, indexer} = await indexedRun();

		// what the STATE keeper persisted, from the very object the stream save was
		// handed one line earlier
		const stateWindow = store.saved?.lastSync.unconfirmedBlocks.flatMap((block) => block.events) ?? [];
		expect(stateWindow.length).toBeGreaterThan(0);
		for (const event of stateWindow) {
			expect(decodedKeysOf(event)).toEqual(['args', 'eventName']);
		}

		// and the LIVE window the engine reads is still populated: an in-place strip
		// would have emptied it, and the next cycle derives its retractions from it
		const live = await indexer.indexMore();
		expect(live.unconfirmedBlocks.flatMap((block) => block.events).length).toBe(stateWindow.length);
	});
});
