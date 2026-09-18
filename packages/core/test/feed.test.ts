import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {IndexerGeneration} from '../src/indexer.js';
import {groupStreamPerBlock} from '../src/internal/engine/utils.js';
import type {IndexingSource, LastSync, LogEvent} from '../src/types.js';
import {identityOf} from './utils/processorIdentity.js';

/**
 * THE IDENTITY EVERY FOLD IN THIS FILE ARRIVED WITH.
 *
 * ADR-0086: a processor cannot state its own identity, so a host derives one from
 * the bytes it was handed and gives it to the engine. Nothing here asserts on the
 * value -- it only has to be the SAME one the persisted cursor carries -- so
 * synthetic bytes are exactly right and a bundler would buy nothing.
 */
const PROCESSOR_IDENTITY = identityOf('proc');

// ---------------------------------------------------------------------------
// The feed path must deliver retractions
// ---------------------------------------------------------------------------
// `feed()` is how a processor is driven from a FETCH this indexer did not make
// itself: a host hands over raw logs, complete over a range, and every retraction
// is derived here. (A stored STREAM, which carries its own, goes through
// `replay()` instead -- see `replay.test.ts` and ADR-0042. The kept-stream replay
// on load used to come through here, which is the defect that split them.)
// It used to batch the generated stream with `groupLogsPerBlock`, which SKIPS
// `removed` events because it is written for logs coming IN from a fetch, where
// a retraction has no business existing.
//
// On the way OUT to a processor a `removed` marker is the retraction itself, and
// it is the only instruction a processor ever gets to revert. Dropping it meant
// the very same stream produced two different states depending on which entry
// point delivered it: correct through `indexMore()`, silently derived from a
// dead branch through `feed()`.
// ---------------------------------------------------------------------------

let logCounter = 0;
function makeEvent(blockNumber: number, blockHash: string, extra: Partial<LogEvent<Abi>> = {}): LogEvent<Abi> {
	logCounter++;
	return {
		blockNumber,
		blockHash,
		transactionIndex: 0,
		removed: false,
		address: '0x0000000000000000000000000000000000000000',
		data: '0x',
		topics: [],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}`,
		logIndex: 0,
		extra: undefined,
		...(extra as any),
	} as unknown as LogEvent<Abi>;
}

describe('groupStreamPerBlock', () => {
	it('keeps retractions instead of dropping them', () => {
		const groups = groupStreamPerBlock([
			makeEvent(100, '0xAAA', {removed: true}),
			makeEvent(100, '0xBBB'),
		] as LogEvent<Abi>[]);
		expect(groups.map((g) => `${g.removed ? 'removed' : 'applied'}:${g.hash}`)).toEqual([
			'removed:0xAAA',
			'applied:0xBBB',
		]);
	});

	it('keeps a retracted and a re-applied block APART when they share a hash', () => {
		// Real shape: a reorg detected at the FIRST unconfirmed block retracts every
		// later one too, and a re-fetch that still contains one of them re-applies it
		// under the same hash. Merging by hash alone would produce a single group
		// that is both retracted and applied.
		const groups = groupStreamPerBlock([
			makeEvent(100, '0xAAA', {removed: true}),
			makeEvent(105, '0xBBB', {removed: true}),
			makeEvent(100, '0xZZZ'),
			makeEvent(105, '0xBBB'),
		] as LogEvent<Abi>[]);
		expect(groups).toHaveLength(4);
		expect(groups.map((g) => `${g.removed ? 'R' : 'A'}:${g.hash}`)).toEqual([
			'R:0xAAA',
			'R:0xBBB',
			'A:0xZZZ',
			'A:0xBBB',
		]);
	});

	it('groups several events of one block together, preserving order', () => {
		const groups = groupStreamPerBlock([
			makeEvent(10, '0xa'),
			makeEvent(10, '0xa'),
			makeEvent(11, '0xb'),
		] as LogEvent<Abi>[]);
		expect(groups).toHaveLength(2);
		expect(groups[0].events).toHaveLength(2);
		expect(groups[1].hash).toBe('0xb');
	});
});

// -- the feed path end to end ------------------------------------------------

const SOURCE: IndexingSource<Abi> = {
	chainId: '1',
	contracts: [{abi: [] as unknown as Abi, address: '0x0000000000000000000000000000000000000001', startBlock: 0}],
};

/** A processor that records exactly what it was handed, per `process` call. */
function recordingProcessor() {
	const batches: LogEvent<Abi>[][] = [];
	const processor: any = {
		getCodeFingerprint: () => undefined,
		load: async () => undefined,
		process: async (list: LogEvent<Abi>[]) => {
			batches.push(list);
		},
		reset: async () => {},
		clear: async () => {},
	};
	return {processor, batches};
}

function makeIndexer(processor: any, feedBatchSize?: number) {
	const provider = {
		async request({method}: {method: string}) {
			if (method === 'eth_chainId') return '0x1';
			throw new Error(`unexpected ${method}`);
		},
	};
	return new IndexerGeneration<Abi>(
		provider as any,
		processor,
		SOURCE,
		{
			stream: {finality: 12},
			...(feedBatchSize === undefined ? {} : {feedBatchSize}),
		},
		{processorIdentity: PROCESSOR_IDENTITY},
	);
}

function lastSyncFor(over: Partial<LastSync<Abi>>): LastSync<Abi> {
	return {
		context: {source: [{startBlock: 0, hash: 'h'}], config: 'cfg', processor: PROCESSOR_IDENTITY},
		latestBlock: 0,
		lastFromBlock: 0,
		lastToBlock: 0,
		unconfirmedBlocks: [],
		...over,
	};
}

describe('feed() delivers retractions to the processor', () => {
	it('hands the processor the removed marker for a reorged block', async () => {
		const {processor, batches} = recordingProcessor();
		const indexer = makeIndexer(processor);
		await indexer.load();

		// round 1: block 100 (0xAAA) is fed and becomes unconfirmed
		await indexer.feed([makeEvent(100, '0xAAA')], lastSyncFor({latestBlock: 100, lastToBlock: 100}));
		expect(batches[0].map((e) => e.blockHash)).toEqual(['0xAAA']);

		// round 2: the re-fetch says block 100 is now 0xBBB -> a contradiction
		const from = Math.max(Math.min(101, 100 - 12), 0);
		await indexer.feed(
			[makeEvent(100, '0xBBB')],
			lastSyncFor({latestBlock: 101, lastToBlock: 101, lastFromBlock: from}),
		);

		const delivered = batches.flat();
		const retractions = delivered.filter((e) => e.removed);
		expect(retractions).toHaveLength(1);
		expect(retractions[0].blockHash).toBe('0xAAA');
		// and the canonical replacement still arrives
		expect(delivered.filter((e) => !e.removed).map((e) => e.blockHash)).toEqual(['0xAAA', '0xBBB']);
	});

	it('delivers a retraction that has NO replacement (the d24872f shape)', async () => {
		const {processor, batches} = recordingProcessor();
		const indexer = makeIndexer(processor);
		await indexer.load();

		await indexer.feed([makeEvent(100, '0xAAA')], lastSyncFor({latestBlock: 100, lastToBlock: 100}));
		batches.length = 0;

		// block 100's log is gone and nothing replaces it: the re-fetch is EMPTY.
		const from = Math.max(Math.min(101, 100 - 12), 0);
		await indexer.feed([], lastSyncFor({latestBlock: 101, lastToBlock: 101, lastFromBlock: from}));

		const delivered = batches.flat();
		expect(delivered).toHaveLength(1);
		expect(delivered[0].removed).toBe(true);
		expect(delivered[0].blockHash).toBe('0xAAA');
	});

	it('keeps every retraction in ONE batch, whatever feedBatchSize says', async () => {
		// A revert is a single decision about a fork point. Split across two
		// `process` calls, a processor that reverts to the LOWEST retracted block
		// would compute that fork point from a partial view of the stream.
		const {processor, batches} = recordingProcessor();
		const indexer = makeIndexer(processor, 1); // smallest possible batch
		await indexer.load();

		await indexer.feed(
			[makeEvent(100, '0xAAA'), makeEvent(101, '0xBBB'), makeEvent(102, '0xCCC')],
			lastSyncFor({latestBlock: 102, lastToBlock: 102}),
		);
		batches.length = 0;

		// all three blocks vanish at once
		const from = Math.max(Math.min(103, 102 - 12), 0);
		await indexer.feed([], lastSyncFor({latestBlock: 103, lastToBlock: 103, lastFromBlock: from}));

		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(3);
		expect(batches[0].every((e) => e.removed)).toBe(true);
		expect(batches[0].map((e) => e.blockHash)).toEqual(['0xAAA', '0xBBB', '0xCCC']);
	});

	it('does not drag lastToBlock backwards on a retraction-only batch', async () => {
		// The cursor must keep meaning "how far we have synced". A batch containing
		// only retractions has no applied block to advance to, and taking the
		// retracted block's number would rewind it below where the sync actually is.
		const seen: number[] = [];
		const processor: any = {
			getCodeFingerprint: () => undefined,
			load: async () => undefined,
			process: async (_list: LogEvent<Abi>[], ls: LastSync<Abi>) => {
				seen.push(ls.lastToBlock);
			},
			reset: async () => {},
			clear: async () => {},
		};
		const indexer = makeIndexer(processor);
		await indexer.load();

		await indexer.feed([makeEvent(100, '0xAAA')], lastSyncFor({latestBlock: 100, lastToBlock: 100}));
		const from = Math.max(Math.min(101, 100 - 12), 0);
		await indexer.feed([], lastSyncFor({latestBlock: 101, lastToBlock: 101, lastFromBlock: from}));

		expect(seen[seen.length - 1]).toBe(101);
	});
});

// -- the receiver's own cursor ------------------------------------------------

describe('expectedFromBlock', () => {
	// ADR-0004: the receiver is authoritative about where the next batch starts.
	// A log-fetcher holds no cursor, so it has to be able to ASK; without this the
	// stateless half would have to compute the cursor itself, which is precisely
	// the state it must not hold.

	it('is the source start block before anything has been fed', () => {
		const {processor} = recordingProcessor();
		expect(makeIndexer(processor).expectedFromBlock).toBe(0);
	});

	it('reaches back over the unconfirmed window rather than to lastToBlock + 1', async () => {
		const {processor} = recordingProcessor();
		const indexer = makeIndexer(processor); // finality 12
		await indexer.load();

		await indexer.feed([makeEvent(100, '0xAAA')], lastSyncFor({latestBlock: 100, lastToBlock: 100}));

		// not 101: the window a reorg can still reach has to be re-fetched, which is
		// how a reorg is detected at all.
		expect(indexer.expectedFromBlock).toBe(88);
	});

	it('is the value feed() refuses a batch against', async () => {
		const {processor} = recordingProcessor();
		const indexer = makeIndexer(processor);
		await indexer.load();

		await indexer.feed([makeEvent(100, '0xAAA')], lastSyncFor({latestBlock: 100, lastToBlock: 100}));
		const expected = indexer.expectedFromBlock;

		await expect(
			indexer.feed([], lastSyncFor({latestBlock: 101, lastToBlock: 101, lastFromBlock: expected + 1})),
		).rejects.toThrow(new RegExp(`not as expected \\(${expected}\\)`));

		// and a batch that does start there is applied
		await indexer.feed([], lastSyncFor({latestBlock: 101, lastToBlock: 101, lastFromBlock: expected}));
		expect(indexer.expectedFromBlock).toBe(Math.max(Math.min(102, 101 - 12), 0));
	});
});

// ---------------------------------------------------------------------------
// AN INTERMEDIATE CURSOR DESCRIBES WHAT HAS BEEN FOLDED, NOT WHAT WILL BE
// ---------------------------------------------------------------------------
// `feed`/`replay` hand the processor one batch at a time, and every batch is
// handed a cursor the processor PERSISTS (`applyEventStream` writes it verbatim
// for the last block of the batch). So each of those cursors has to be true on
// its own: if a batch is interrupted, the last one written is what the next run
// resumes from.
//
// The rule the cursor must satisfy is the one `syncedThrough` states: the
// unconfirmed window is the set of blocks already folded, and the engine treats
// the top of it as the boundary above which events are NEW. So a cursor whose
// window reaches ABOVE its own `lastToBlock` makes the blocks in between
// invisible to the next round -- they are neither below the resume point nor
// above the window, so nothing ever delivers them. That is silent, permanent
// loss, bounded by the finality window.
// ---------------------------------------------------------------------------

/** The reorg shape these all use: three blocks on branch A, replaced by branch B. */
async function reorgedFeed(processor: any, feedBatchSize = 1) {
	const indexer = makeIndexer(processor, feedBatchSize);
	await indexer.load();
	await indexer.feed(
		[makeEvent(101, '0xA1'), makeEvent(102, '0xB1'), makeEvent(103, '0xC1')],
		lastSyncFor({latestBlock: 103, lastToBlock: 103, lastFromBlock: 0}),
	);
	// the same three heights on a different branch
	await indexer.feed(
		[makeEvent(101, '0xA2'), makeEvent(102, '0xB2'), makeEvent(103, '0xC2')],
		lastSyncFor({latestBlock: 103, lastToBlock: 103, lastFromBlock: 91}),
	);
	return indexer;
}

describe('the cursor handed to each batch is true on its own', () => {
	it('never carries an unconfirmed block ABOVE its own lastToBlock', async () => {
		const seen: {lastToBlock: number; window: number[]}[] = [];
		const processor: any = {
			getCodeFingerprint: () => undefined,
			load: async () => undefined,
			process: async (_list: LogEvent<Abi>[], ls: LastSync<Abi>) => {
				seen.push({lastToBlock: ls.lastToBlock, window: ls.unconfirmedBlocks.map((b) => b.number)});
			},
			reset: async () => {},
			clear: async () => {},
		};
		await reorgedFeed(processor);

		// asserted on EVERY cursor, not just the last: each one is persisted, so each
		// one has to be resumable
		for (const {lastToBlock, window} of seen) {
			expect(Math.max(-1, ...window)).toBeLessThanOrEqual(lastToBlock);
		}
	});

	it('does not hand a retraction batch the extent of a scan it has not folded', async () => {
		// The retraction batch reverts 101-103 and applies nothing, so the fold is
		// back at 100. Handing it `lastToBlock: 103` (the end of the whole stream)
		// claims three blocks whose replacements are still queued behind it.
		const seen: {removed: boolean; lastToBlock: number}[] = [];
		const processor: any = {
			getCodeFingerprint: () => undefined,
			load: async () => undefined,
			process: async (list: LogEvent<Abi>[], ls: LastSync<Abi>) => {
				seen.push({removed: list.every((e) => e.removed), lastToBlock: ls.lastToBlock});
			},
			reset: async () => {},
			clear: async () => {},
		};
		await reorgedFeed(processor);

		const retraction = seen.find((s) => s.removed);
		expect(retraction).toBeDefined();
		expect(retraction!.lastToBlock).toBe(100);
	});

	it('loses nothing when a batch is INTERRUPTED and the run resumes from what was persisted', async () => {
		// The whole point, end to end: the processor throws part-way, the last cursor
		// it accepted is what a restart resumes from, and the replacement blocks must
		// still be delivered. This is the shape that silently drops them.
		const applied: string[] = [];
		let persisted: LastSync<Abi> | undefined;
		// Die on the batch immediately AFTER the retraction, which is the moment the
		// retraction's cursor is the last thing on disk. Detected from the stream rather
		// than by counting calls, so the test does not silently move if batching changes.
		let retracted = false;
		let armed = true;
		const processor: any = {
			getCodeFingerprint: () => undefined,
			load: async () => (persisted ? {state: {}, lastSync: persisted} : undefined),
			process: async (list: LogEvent<Abi>[], ls: LastSync<Abi>) => {
				const isRetraction = list.every((e) => e.removed);
				if (armed && retracted && !isRetraction) {
					throw new Error('processor died mid-stream');
				}
				if (isRetraction) {
					retracted = true;
				}
				for (const e of list) {
					applied.push(`${e.removed ? 'R' : 'A'}${e.blockNumber}`);
				}
				// what `applyEventStream` would have written for this batch
				persisted = ls;
			},
			reset: async () => {},
			clear: async () => {},
		};

		await expect(reorgedFeed(processor)).rejects.toThrow('processor died mid-stream');
		expect(retracted).toBe(true);
		expect(persisted).toBeDefined();
		const interrupted = applied.length;

		// the restart: a fresh generation loading exactly the cursor that was persisted
		armed = false;
		const resumed = makeIndexer(processor, 1);
		await resumed.load();
		await resumed.feed(
			[makeEvent(101, '0xA2'), makeEvent(102, '0xB2'), makeEvent(103, '0xC2')],
			lastSyncFor({latestBlock: 103, lastToBlock: 103, lastFromBlock: resumed.expectedFromBlock}),
		);

		// every replacement block landed after the restart. Asserted as the exact set,
		// not `arrayContaining`: the failure here is blocks going MISSING.
		const delivered = applied.slice(interrupted).filter((e) => e.startsWith('A'));
		expect(delivered).toEqual(['A101', 'A102', 'A103']);
	});
});

// ---------------------------------------------------------------------------
// A PAYLOAD OUT OF ORDER IS REFUSED, NOT QUIETLY REPAIRED
// ---------------------------------------------------------------------------
// The engine reads a payload in order: with an empty window the FIRST group's
// number becomes the boundary above which events are new, and the next window is
// built in payload order. So a block arriving after a higher-numbered one was
// DROPPED, silently, and left the window unordered so the following cycle's
// boundary was wrong too.
//
// Refused rather than sorted, deliberately. `eth_getLogs` answers in ascending
// order and nothing legitimate reorders it, so an unordered payload means
// something upstream is wrong; sorting would hide that and let it resurface later
// as missing data. If a provider is ever found doing it legitimately, the
// decision gets revisited with the evidence.
// ---------------------------------------------------------------------------

describe('a payload whose blocks do not ascend', () => {
	it('is REFUSED by feed(), naming both blocks', async () => {
		const {processor, batches} = recordingProcessor();
		const indexer = makeIndexer(processor);
		await indexer.load();

		await expect(
			indexer.feed([makeEvent(105, '0xC'), makeEvent(101, '0xA')], lastSyncFor({latestBlock: 105, lastToBlock: 105})),
		).rejects.toThrow(/log at block 101 after one at block 105/);

		// and nothing was folded from the payload it refused
		expect(batches).toEqual([]);
	});

	it('accepts EQUAL block numbers, because a block holds many logs', async () => {
		const {processor, batches} = recordingProcessor();
		const indexer = makeIndexer(processor);
		await indexer.load();

		await indexer.feed(
			[makeEvent(101, '0xA'), makeEvent(101, '0xA'), makeEvent(102, '0xB')],
			lastSyncFor({latestBlock: 102, lastToBlock: 102}),
		);
		expect(batches.flat()).toHaveLength(3);
	});

	it('would otherwise have DROPPED the late block rather than folding it', async () => {
		// the shape of the loss, stated as the reason the refusal exists: in payload
		// order the first group sets the boundary, so 101 is below it and disappears
		const ascending = groupStreamPerBlock([makeEvent(101, '0xA'), makeEvent(105, '0xC')] as LogEvent<Abi>[]);
		expect(ascending.map((g) => g.number)).toEqual([101, 105]);
	});
});
