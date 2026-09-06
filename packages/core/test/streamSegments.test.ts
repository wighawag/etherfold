import {describe, expect, it, vi} from 'vitest';
import type {Abi} from 'abitype';
import {
	createSegmentedStream,
	type StreamCursorRecord,
	type StreamSegmentPort,
	type StoredSegment,
} from '../src/stream/segments.js';
import type {IndexingSource, LastSync, StoredLastSync, StoredLogEvent} from '../src/types.js';

// ---------------------------------------------------------------------------
// THE SEGMENTATION HELPER, against a memory port.
// ---------------------------------------------------------------------------
// This is the substrate-neutral half: one segment per batch, the ordinal and the
// start block carried in the CURSOR RECORD, and one rule for damage -- clear the
// subtree and let it rebuild. The IndexedDB keeper's own concerns (the array
// address, the key ranges, the one `readwrite` transaction, the legacy blob) are
// asserted in `@etherfold/browser`, against `fake-indexeddb`.
//
// The port is deliberately dumb here: it records what it was asked to do and in
// which order, because "a save allocated its ordinal from the cursor" and "a save
// scanned the keyspace to find one" produce the same stored bytes and differ only
// in the calls made.

const SOURCE: IndexingSource<Abi> = {chainId: '1', contracts: []};

function event(blockNumber: number, logIndex = 0, removed = false): StoredLogEvent {
	return {
		blockNumber,
		logIndex,
		removed,
		blockHash: `0x${blockNumber.toString(16)}`,
		transactionHash: `0x${blockNumber.toString(16)}${logIndex}`,
	} as unknown as StoredLogEvent;
}

function cursor(lastFromBlock: number, lastToBlock: number, latestBlock = lastToBlock): StoredLastSync {
	return {
		context: {source: [{startBlock: 0, hash: 'src'}], config: 'cfg', processor: 'proc'},
		latestBlock,
		lastFromBlock,
		lastToBlock,
		unconfirmedBlocks: [{number: lastToBlock, hash: '0xtip', events: []}],
	} as unknown as StoredLastSync;
}

type Call = {op: string; detail?: unknown};

/**
 * A port over one `Map`, plus a log of every operation.
 *
 * `commitSegmentWithCursor` reads the stored cursor and applies the helper's
 * decision in one step, which is what an IndexedDB `readwrite` transaction and a
 * SQL transaction both give it for free.
 */
function memoryPort() {
	const rows = new Map<string, unknown>();
	const calls: Call[] = [];
	const port: StreamSegmentPort<Abi> = {
		async readCursor() {
			calls.push({op: 'readCursor'});
			return rows.get('cursor') as StreamCursorRecord<Abi> | undefined;
		},
		async readSegments() {
			calls.push({op: 'readSegments'});
			const stored: StoredSegment[] = [];
			for (const [key, value] of rows) {
				if (key === 'cursor') continue;
				stored.push({ordinal: Number(key), value});
			}
			return stored.sort((a, b) => a.ordinal - b.ordinal);
		},
		async commitSegmentWithCursor(_source, allocate) {
			const commit = allocate(rows.get('cursor') as StreamCursorRecord<Abi> | undefined);
			calls.push({op: 'commitSegmentWithCursor', detail: commit && commit.ordinal});
			if (!commit) return;
			rows.set(String(commit.ordinal), commit.segment);
			rows.set('cursor', commit.cursor);
		},
		async writeCursorOnly(_source, next) {
			const record = next(rows.get('cursor') as StreamCursorRecord<Abi> | undefined);
			calls.push({op: 'writeCursorOnly', detail: record !== undefined});
			if (!record) return;
			rows.set('cursor', record);
		},
		async clearSubtree() {
			const removed = rows.size;
			calls.push({op: 'clearSubtree', detail: removed});
			rows.clear();
			return removed;
		},
	};
	return {port, rows, calls};
}

/** The `named-logs` channel this package logs on, silenced and recorded. */
async function captureLogs() {
	const {logs} = await import('named-logs');
	const namedLogger = logs('@etherfold/core');
	const messages: string[] = [];
	const record = (...args: unknown[]) => {
		messages.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
	};
	const spies = [
		vi.spyOn(namedLogger, 'error').mockImplementation(record),
		vi.spyOn(namedLogger, 'info').mockImplementation(record),
	];
	return {messages, restore: () => spies.forEach((spy) => spy.mockRestore())};
}

describe('one segment per batch, and nothing already written is touched', () => {
	it('writes the batch and the cursor, and never rewrites a segment', async () => {
		const {port, rows, calls} = memoryPort();
		const stream = createSegmentedStream<Abi>(port);

		await stream.saveNewEvents(SOURCE, {eventStream: [event(100), event(101)], lastSync: cursor(100, 101)});
		await stream.saveNewEvents(SOURCE, {eventStream: [event(102)], lastSync: cursor(102, 102)});
		await stream.saveNewEvents(SOURCE, {eventStream: [event(103)], lastSync: cursor(103, 103)});

		expect([...rows.keys()].sort()).toEqual(['0', '1', '2', 'cursor']);
		// the ordinal each save took, in order: 0, 1, 2 -- never one already written
		expect(calls.filter((c) => c.op === 'commitSegmentWithCursor').map((c) => c.detail)).toEqual([0, 1, 2]);
		expect(rows.get('0')).toEqual({events: [event(100), event(101)]});
		expect(rows.get('2')).toEqual({events: [event(103)]});
	});

	it('allocates from the CURSOR RECORD, never from a scan of the segments', async () => {
		const {port, rows, calls} = memoryPort();
		const stream = createSegmentedStream<Abi>(port);

		await stream.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursor(100, 100)});
		await stream.saveNewEvents(SOURCE, {eventStream: [event(101)], lastSync: cursor(101, 101)});

		expect((rows.get('cursor') as StreamCursorRecord<Abi>).nextOrdinal).toBe(2);
		// an in-memory counter breaks across tabs and a range scan is O(segments) per
		// save; the record is what makes the allocation both safe and O(1)
		expect(calls.some((call) => call.op === 'readSegments')).toBe(false);
		expect(calls.some((call) => call.op === 'readCursor')).toBe(false);
	});

	it('an EMPTY save writes only the cursor record', async () => {
		const {port, rows, calls} = memoryPort();
		const stream = createSegmentedStream<Abi>(port);

		await stream.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursor(100, 100)});
		await stream.saveNewEvents(SOURCE, {eventStream: [], lastSync: cursor(101, 140)});

		expect([...rows.keys()].sort()).toEqual(['0', 'cursor']);
		expect(calls.filter((call) => call.op === 'writeCursorOnly')).toHaveLength(1);
		const record = rows.get('cursor') as StreamCursorRecord<Abi>;
		expect(record.lastToBlock).toBe(140);
		// no segment was written, so the next one still takes ordinal 1
		expect(record.nextOrdinal).toBe(1);
	});
});

describe('the cursor record is the only place the block numbers live', () => {
	it('stores no unconfirmed window and returns an empty one', async () => {
		const {port, rows} = memoryPort();
		const stream = createSegmentedStream<Abi>(port);

		await stream.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursor(100, 104, 107)});

		expect(JSON.stringify([...rows.values()])).not.toContain('unconfirmedBlocks');
		const fetched = await stream.fetchFrom(SOURCE, 100);
		expect(fetched?.lastSync.unconfirmedBlocks).toEqual([]);
		expect(fetched?.lastSync.lastToBlock).toBe(104);
		expect(fetched?.lastSync.latestBlock).toBe(107);
		expect(fetched?.lastSync.context).toEqual(cursor(100, 104).context);
	});

	it('records the START BLOCK once, from the first save, and never moves it', async () => {
		const {port, rows} = memoryPort();
		const stream = createSegmentedStream<Abi>(port);

		await stream.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursor(100, 100)});
		await stream.saveNewEvents(SOURCE, {eventStream: [event(120)], lastSync: cursor(101, 120)});

		expect((rows.get('cursor') as StreamCursorRecord<Abi>).startBlock).toBe(100);
	});
});

describe('a full ordered scan, in APPEND order', () => {
	it('replays a reorg`s retractions where they were appended, not where their blocks are', async () => {
		const {port} = memoryPort();
		const stream = createSegmentedStream<Abi>(port);

		await stream.saveNewEvents(SOURCE, {eventStream: [event(100), event(104)], lastSync: cursor(100, 104)});
		// the reorg: 104 is retracted at its ORIGINAL block, then the new branch
		// continues at a LOWER block than the retraction carries
		await stream.saveNewEvents(SOURCE, {
			eventStream: [event(104, 0, true), event(103)],
			lastSync: cursor(102, 105),
		});

		const fetched = await stream.fetchFrom(SOURCE, 100);
		expect(fetched?.eventStream.map((e) => [e.blockNumber, e.removed])).toEqual([
			[100, false],
			[104, false],
			[104, true],
			[103, false],
		]);
	});

	it('filters on the requested fromBlock, exactly as the shipped keeper did', async () => {
		const {port} = memoryPort();
		const stream = createSegmentedStream<Abi>(port);

		await stream.saveNewEvents(SOURCE, {eventStream: [event(100), event(104)], lastSync: cursor(100, 104)});

		const fetched = await stream.fetchFrom(SOURCE, 102);
		expect(fetched?.eventStream.map((e) => e.blockNumber)).toEqual([104]);
	});
});

describe('a forward JUMP is refused; an overlap is ordinary', () => {
	it('writes nothing, keeps everything, and logs once rather than once per cycle', async () => {
		const {port, rows} = memoryPort();
		const stream = createSegmentedStream<Abi>(port);
		const logged = await captureLogs();

		await stream.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursor(100, 104)});
		const before = new Map(rows);

		// 200 is above `lastToBlock + 1`: appending it would leave a HOLE nothing can
		// see afterwards, because the ordinals stay contiguous
		await stream.saveNewEvents(SOURCE, {eventStream: [event(200)], lastSync: cursor(200, 200)});
		await stream.saveNewEvents(SOURCE, {eventStream: [event(201)], lastSync: cursor(201, 201)});

		expect([...rows.entries()]).toEqual([...before.entries()]);
		expect(logged.messages.filter((m) => m.includes('would leave a hole'))).toHaveLength(1);
		logged.restore();
	});

	it('SAYS it declined, rather than reporting the write it did not make', async () => {
		// The caller's next move depends on this answer. The indexer tracks how far the
		// stored stream reaches, and a decline read as a write moves that mark past
		// blocks the stream never received -- after which its own hole-check compares
		// against a mark that has already lied, so every later decline is invisible
		// too. A log line cannot carry that; a return value can.
		const {port} = memoryPort();
		const stream = createSegmentedStream<Abi>(port);
		const logged = await captureLogs();

		const accepted = await stream.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursor(100, 104)});
		const refused = await stream.saveNewEvents(SOURCE, {eventStream: [event(200)], lastSync: cursor(200, 200)});

		expect(accepted).toBeUndefined();
		expect(refused).toBe('declined');
		logged.restore();
	});

	it('says nothing again once a contiguous batch is accepted', async () => {
		const {port} = memoryPort();
		const stream = createSegmentedStream<Abi>(port);
		const logged = await captureLogs();

		await stream.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursor(100, 104)});
		expect(await stream.saveNewEvents(SOURCE, {eventStream: [event(200)], lastSync: cursor(200, 200)})).toBe(
			'declined',
		);
		// the batch that continues what is stored
		expect(await stream.saveNewEvents(SOURCE, {eventStream: [event(105)], lastSync: cursor(105, 105)})).toBeUndefined();
		logged.restore();
	});

	it('accepts a tip re-fetch that dips back into the finality window', async () => {
		const {port, rows} = memoryPort();
		const stream = createSegmentedStream<Abi>(port);

		await stream.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursor(100, 104)});
		// every cycle at the tip re-reads the last `finality` blocks, so an overlap is
		// the ordinary case and refusing it would refuse almost every save
		await stream.saveNewEvents(SOURCE, {
			eventStream: [event(104, 0, true), event(104, 1)],
			lastSync: cursor(102, 106),
		});

		expect([...rows.keys()].sort()).toEqual(['0', '1', 'cursor']);
		expect((rows.get('cursor') as StreamCursorRecord<Abi>).lastToBlock).toBe(106);
	});

	it('REVIVES: a contiguous batch after a refused one is accepted and the stream is whole', async () => {
		const {port, rows} = memoryPort();
		const stream = createSegmentedStream<Abi>(port);
		const logged = await captureLogs();

		await stream.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursor(100, 104)});
		await stream.saveNewEvents(SOURCE, {eventStream: [event(200)], lastSync: cursor(200, 200)});
		await stream.saveNewEvents(SOURCE, {eventStream: [event(105)], lastSync: cursor(105, 105)});

		expect([...rows.keys()].sort()).toEqual(['0', '1', 'cursor']);
		const fetched = await stream.fetchFrom(SOURCE, 100);
		expect(fetched?.eventStream.map((e) => e.blockNumber)).toEqual([100, 105]);
		logged.restore();
	});
});

describe('inconsistency is CLEARED, not repaired', () => {
	it('clears a GAP in the ordinals, logs it, and reports absent', async () => {
		const {port, rows} = memoryPort();
		const stream = createSegmentedStream<Abi>(port);
		const logged = await captureLogs();

		await stream.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursor(100, 100)});
		await stream.saveNewEvents(SOURCE, {eventStream: [event(101)], lastSync: cursor(101, 101)});
		await stream.saveNewEvents(SOURCE, {eventStream: [event(102)], lastSync: cursor(102, 102)});
		rows.delete('1');

		await expect(stream.fetchFrom(SOURCE, 100)).resolves.toBeUndefined();
		expect(rows.size).toBe(0);
		expect(logged.messages.some((m) => m.includes('being cleared'))).toBe(true);
		logged.restore();
	});

	it('clears SEGMENTS WITH NO CURSOR, which look exactly like a never-written stream', async () => {
		const {port, rows} = memoryPort();
		const stream = createSegmentedStream<Abi>(port);
		const logged = await captureLogs();

		await stream.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursor(100, 100)});
		rows.delete('cursor');

		await expect(stream.fetchFrom(SOURCE, 100)).resolves.toBeUndefined();
		// left in place, the next save would take ordinal 0 again, overwrite it, and
		// leave every higher ordinal to be replayed as part of a stream it is not in
		expect(rows.size).toBe(0);
		expect(logged.messages.some((m) => m.includes('being cleared'))).toBe(true);
		logged.restore();
	});

	it('clears an UNPARSEABLE segment', async () => {
		const {port, rows} = memoryPort();
		const stream = createSegmentedStream<Abi>(port);
		const logged = await captureLogs();

		await stream.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursor(100, 100)});
		rows.set('0', 'not a segment');

		await expect(stream.fetchFrom(SOURCE, 100)).resolves.toBeUndefined();
		expect(rows.size).toBe(0);
		expect(logged.messages.some((m) => m.includes('being cleared'))).toBe(true);
		logged.restore();
	});

	it('does NOT raise, because `fetchFrom` has no caller that catches', async () => {
		const {port, rows} = memoryPort();
		const stream = createSegmentedStream<Abi>(port);
		const logged = await captureLogs();

		await stream.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursor(100, 100)});
		rows.set('0', {events: 'not an array'});

		await expect(stream.fetchFrom(SOURCE, 100)).resolves.toBeUndefined();
		logged.restore();
	});

	it('a never-written stream reports absent and logs nothing', async () => {
		const {port} = memoryPort();
		const stream = createSegmentedStream<Abi>(port);
		const logged = await captureLogs();

		await expect(stream.fetchFrom(SOURCE, 100)).resolves.toBeUndefined();
		expect(logged.messages).toEqual([]);
		logged.restore();
	});
});

describe('a CURSOR WITH NO SEGMENTS is legal', () => {
	it('survives, reports PRESENT, and returns a defined result with no events', async () => {
		const {port, rows} = memoryPort();
		const stream = createSegmentedStream<Abi>(port);

		await stream.saveNewEvents(SOURCE, {eventStream: [], lastSync: cursor(100, 200)});

		const fetched = await stream.fetchFrom(SOURCE, 100);
		expect(fetched).toBeDefined();
		expect(fetched?.eventStream).toEqual([]);
		expect(fetched?.lastSync.lastToBlock).toBe(200);
		expect(rows.has('cursor')).toBe(true);
	});

	it('keeps ADVANCING across reloads, rather than re-scanning from the start block', async () => {
		const {port} = memoryPort();
		const stream = createSegmentedStream<Abi>(port);

		await stream.saveNewEvents(SOURCE, {eventStream: [], lastSync: cursor(100, 200)});
		await stream.saveNewEvents(SOURCE, {eventStream: [], lastSync: cursor(201, 300)});

		expect((await stream.fetchFrom(SOURCE, 100))?.lastSync.lastToBlock).toBe(300);
	});
});

describe('a stream that does not reach back to the requested fromBlock', () => {
	it('is CLEARED rather than served, and the clear is logged', async () => {
		const {port, rows} = memoryPort();
		const stream = createSegmentedStream<Abi>(port);
		const logged = await captureLogs();

		// a subtree opened mid-history, which is what a self-clear followed by more
		// indexing leaves behind
		await stream.saveNewEvents(SOURCE, {eventStream: [event(500)], lastSync: cursor(500, 500)});

		// the resume point: the stream serves it and is kept
		expect(await stream.fetchFrom(SOURCE, 500)).toBeDefined();
		expect(await stream.fetchFrom(SOURCE, 501)).toBeDefined();
		expect(rows.size).toBeGreaterThan(0);

		// a REBUILD asks from the source's first block, which this stream cannot serve
		await expect(stream.fetchFrom(SOURCE, 100)).resolves.toBeUndefined();
		expect(rows.size).toBe(0);
		expect(logged.messages.some((m) => m.includes('does not reach back'))).toBe(true);
		logged.restore();
	});
});

describe('a substrate that is GONE degrades to a re-index, like the damage it can see', () => {
	/** Every read raises: an object store that will not open, a database that was evicted. */
	function unreadablePort(): StreamSegmentPort<Abi> {
		const gone = async () => {
			throw new Error('the object store could not be opened');
		};
		return {
			readCursor: gone,
			readSegments: gone,
			commitSegmentWithCursor: gone,
			writeCursorOnly: gone,
			clearSubtree: gone,
		} as unknown as StreamSegmentPort<Abi>;
	}

	it('reports absent instead of raising, so `load()` re-indexes rather than failing forever', async () => {
		const logged = await captureLogs();
		const stream = createSegmentedStream<Abi>(unreadablePort());

		// the rules live in this helper, so EVERY keeper over the port inherits this
		// one: a second keeper supplies five substrate operations and nothing else
		await expect(stream.fetchFrom(SOURCE, 100)).resolves.toBeUndefined();
		await expect(stream.clear(SOURCE)).resolves.toBeUndefined();
		logged.restore();
	});

	it('still REPORTS a failed write, which is what stops the state advancing past it', async () => {
		const logged = await captureLogs();
		const stream = createSegmentedStream<Abi>(unreadablePort());

		await expect(stream.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursor(100, 100)})).rejects.toThrow(
			/could not be opened/,
		);
		logged.restore();
	});
});

describe('clear', () => {
	it('removes the subtree, so presence reads FALSE afterwards', async () => {
		const {port, rows} = memoryPort();
		const stream = createSegmentedStream<Abi>(port);

		await stream.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursor(100, 100)});
		await stream.clear(SOURCE);

		expect(rows.size).toBe(0);
		expect(await stream.fetchFrom(SOURCE, 0)).toBeUndefined();
	});
});
