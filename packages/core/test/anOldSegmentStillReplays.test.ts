import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {LogEventFetcher} from '../src/internal/decoding/LogEventFetcher.js';
import {
	createSegmentedStream,
	type StoredSegment,
	type StreamCursorRecord,
	type StreamSegmentPort,
} from '../src/stream/segments.js';
import type {ExistingStream, LogEvent, StoredLogEvent} from '../src/types.js';
import {
	fakeChain,
	fakeProcessor,
	idOf,
	indexToTip,
	makeIndexer,
	makeLog,
	SOURCE,
	START_BLOCK,
} from './utils/streamCacheWorld.js';

// ---------------------------------------------------------------------------
// THE STORED TYPE GOVERNS WRITES; A READ TOLERATES A DECODED HALF
// ---------------------------------------------------------------------------
// The keeper seam now takes `StoredLogEvent`, so nothing this version writes can
// carry `args` or `eventName`. Segments written BEFORE it narrowed carry them
// forever: no migration rewrites a byte, and adopting a stricter stored type
// must therefore cost an existing deployment no rebuild.
//
// That is a claim about bytes already on disk, so it is asserted against bytes
// written the way the previous version wrote them rather than left to be
// discovered. The stream is indexed once for real -- which is what makes the
// stored CURSOR's context the one the load path will accept -- and the segments
// are then put back the way the old saver would have left them, with the decoded
// half on every event.
//
// Two levels, because the tolerance has to hold at both:
//
//   1. THE KEEPER serves such a segment instead of treating it as damage. The
//      unparseable-segment rule (`streamSegments.test.ts`) is about a segment
//      that is not a segment; an extra key on an event is not that.
//   2. THE LOAD PATH replays it end to end, out of the cache, with the stale
//      decoded half DROPPED and re-derived against the source running now
//      (ADR-0034) rather than trusted.
// ---------------------------------------------------------------------------

const LOGS = [makeLog(100, '0xa100'), makeLog(102, '0xa102'), makeLog(104, '0xa104')];
const TIP = 105;

/** A segment port over one `Map`, whose rows the test can put back the OLD way. */
function memoryPort() {
	const rows = new Map<string, unknown>();
	const port: StreamSegmentPort<Abi> = {
		async readCursor() {
			return rows.get('cursor') as StreamCursorRecord<Abi> | undefined;
		},
		async readSegments() {
			const stored: StoredSegment[] = [];
			for (const [key, value] of rows) {
				if (key === 'cursor') continue;
				stored.push({ordinal: Number(key), value});
			}
			return stored.sort((a, b) => a.ordinal - b.ordinal);
		},
		async commitSegmentWithCursor(_source, allocate) {
			const commit = allocate(rows.get('cursor') as StreamCursorRecord<Abi> | undefined);
			if (!commit) return;
			rows.set(String(commit.ordinal), commit.segment);
			rows.set('cursor', commit.cursor);
		},
		async writeCursorOnly(_source, next) {
			const record = next(rows.get('cursor') as StreamCursorRecord<Abi> | undefined);
			if (!record) return;
			rows.set('cursor', record);
		},
		async clearSubtree() {
			const removed = rows.size;
			rows.clear();
			return removed;
		},
	};
	return {port, rows};
}

/**
 * ONE EVENT AS THE PREVIOUS VERSION STORED IT: the same raw log, plus the decoded
 * half that version put next to it.
 *
 * `args` is deliberately a value no current decode could produce, so "the stale
 * one was trusted" and "a fresh one was derived" are distinguishable rather than
 * merely both plausible.
 */
function asAnOlderVersionWrote(event: StoredLogEvent): StoredLogEvent {
	return {...event, eventName: 'Transfer', args: {stale: true}} as unknown as StoredLogEvent;
}

/** Every segment in the store, put back carrying the decoded half. */
function rewriteSegmentsTheOldWay(rows: Map<string, unknown>): void {
	for (const [key, value] of rows) {
		if (key === 'cursor') continue;
		const segment = value as {events: StoredLogEvent[]};
		rows.set(key, {events: segment.events.map(asAnOlderVersionWrote)});
	}
}

/** The decoded keys an object actually carries; `[]` is what this version writes. */
function decodedKeysOf(event: object): string[] {
	return (['args', 'eventName', 'decodeError'] as const).filter((key) => key in event);
}

/**
 * Index once, for real, then put the segments back the OLD way.
 *
 * Indexing first is what makes the stored CURSOR honest: its `context` is the one
 * this source and this stream config hash to, so the load path adopts the stream
 * instead of clearing it for a reason that has nothing to do with the shape of
 * its events.
 */
async function anOldShapeStreamOnDisk(): Promise<{keeper: ExistingStream<Abi>; rows: Map<string, unknown>}> {
	const {port, rows} = memoryPort();
	const keeper = createSegmentedStream<Abi>(port);
	const chain = fakeChain([...LOGS], TIP);
	const indexer = makeIndexer(chain, fakeProcessor().processor, keeper);
	await indexer.load();
	await indexToTip(indexer);

	// what this version wrote: the raw half and nothing else
	expect([...rows.keys()].filter((key) => key !== 'cursor').length).toBeGreaterThan(0);
	rewriteSegmentsTheOldWay(rows);

	return {keeper, rows};
}

/**
 * The real re-decode, over the stream-cache world's fake chain.
 *
 * That world replaces the log fetcher wholesale and its `reparse` is a
 * pass-through, which would carry the stale `args` straight through to the
 * processor and prove the opposite of what is claimed here. The RULE is
 * `LogEventFetcher.reparse`, so it is what the load path is driven with.
 */
function withRealReparse(indexer: any, chain: ReturnType<typeof fakeChain>) {
	const decoder = new LogEventFetcher<Abi>(chain.provider, SOURCE.contracts as any);
	indexer.logEventFetcher = {
		...chain.fetcher,
		reparse: (events: (LogEvent<Abi> | StoredLogEvent)[]) => decoder.reparse(events),
	};
	return indexer;
}

describe('a segment written before the seam narrowed', () => {
	it('is SERVED rather than refused, membership, order and raw halves intact', async () => {
		const {keeper, rows} = await anOldShapeStreamOnDisk();

		const served = await keeper.fetchFrom(SOURCE, START_BLOCK);

		expect(served).toBeDefined();
		expect(served!.eventStream.map(idOf)).toEqual(LOGS.map(idOf));
		expect(served!.eventStream.map((event) => event.blockNumber)).toEqual(LOGS.map((log) => log.blockNumber));
		// nothing was cleared: the cursor and its segments are all still there
		expect(rows.has('cursor')).toBe(true);
		expect([...rows.keys()].filter((key) => key !== 'cursor').length).toBeGreaterThan(0);
	});

	it('is NOT rewritten: the decoded half is still on disk after a read', async () => {
		const {keeper, rows} = await anOldShapeStreamOnDisk();

		await keeper.fetchFrom(SOURCE, START_BLOCK);

		const onDisk = [...rows.entries()]
			.filter(([key]) => key !== 'cursor')
			.flatMap(([, value]) => (value as {events: StoredLogEvent[]}).events);
		expect(onDisk.length).toBe(LOGS.length);
		for (const event of onDisk) {
			expect(decodedKeysOf(event)).toEqual(['args', 'eventName']);
		}
	});
});

describe('the load path, over a stream an older version wrote', () => {
	it('replays it out of the CACHE, so an upgrade costs no re-index', async () => {
		const {keeper} = await anOldShapeStreamOnDisk();

		const chain = fakeChain([...LOGS], TIP);
		const reloaded = fakeProcessor({});
		const indexer = withRealReparse(makeIndexer(chain, reloaded.processor, keeper), chain);
		await indexer.load();

		expect(reloaded.state).toEqual(LOGS.map(idOf));
		// the node was asked for nothing at all: no rebuild, no migration
		expect(chain.ranges).toHaveLength(0);
	});

	it('IGNORES the decoded half it carried rather than refusing it or trusting it', async () => {
		const {keeper} = await anOldShapeStreamOnDisk();

		const chain = fakeChain([...LOGS], TIP);
		const reloaded = fakeProcessor({});
		const indexer = withRealReparse(makeIndexer(chain, reloaded.processor, keeper), chain);
		await indexer.load();

		const folded = reloaded.batches.flat();
		expect(folded.length).toBe(LOGS.length);
		for (const event of folded) {
			// re-derived against the source running now, whatever that produced -- what it
			// must NOT be is the value the older version filed next to those bytes
			expect((event as any).args).not.toEqual({stale: true});
		}
	});

	it('appends to it in the NEW shape, leaving the old events as they are', async () => {
		const {keeper, rows} = await anOldShapeStreamOnDisk();

		const chain = fakeChain([...LOGS, makeLog(106, '0xa106')], 107);
		const reloaded = fakeProcessor({});
		const indexer = withRealReparse(makeIndexer(chain, reloaded.processor, keeper), chain);
		await indexer.load();
		await indexToTip(indexer);

		const bySegment = [...rows.entries()]
			.filter(([key]) => key !== 'cursor')
			.sort(([a], [b]) => Number(a) - Number(b))
			.map(([, value]) => (value as {events: StoredLogEvent[]}).events);
		const appended = bySegment.flat().filter((event) => event.blockNumber === 106);

		expect(appended).toHaveLength(1);
		// the batch this version wrote carries no decoded half, and the ones it did not
		// write still carry theirs: writes narrowed, nothing was migrated
		expect(appended.flatMap(decodedKeysOf)).toEqual([]);
		expect(
			bySegment
				.flat()
				.filter((event) => event.blockNumber < 106)
				.flatMap(decodedKeysOf),
		).toEqual(LOGS.flatMap(() => ['args', 'eventName']));
	});
});
