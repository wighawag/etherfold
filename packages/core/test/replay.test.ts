import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {IndexerGeneration} from '../src/indexer.js';
import type {IndexingSource, LastSync, LogEvent} from '../src/types.js';
import {identityOf} from './utils/processorIdentity.js';

/**
 * THE IDENTITY EVERY FOLD IN THIS FILE ARRIVED WITH.
 *
 * ADR-0086: a processor cannot state its own identity, so a host derives one from
 * the bytes it was handed and gives it to the engine. Nothing here asserts on the
 * value -- it only has to be the SAME one a persisted cursor carries -- so
 * synthetic bytes are exactly right and a bundler would buy nothing.
 */
const PROCESSOR_IDENTITY = identityOf('proc');

// ---------------------------------------------------------------------------
// A REPLAY honours the verdicts the stream already carries
// ---------------------------------------------------------------------------
// `feed()` takes a FETCH: raw logs, complete over a range, carrying no verdicts,
// so every retraction is derived from the cursor's unconfirmed WINDOW.
// `replay()` takes a STORED EMISSION STREAM, which already carries its own: the
// superseded events are in it, at their original block, flagged `removed`.
//
// Routing the second through the first is what this file pins shut. A rebuild
// starts from a fresh cursor whose window is EMPTY, so a stream containing a
// reorg was replayed with its retractions discarded -- both branches applied as
// live blocks, no revert anywhere -- and the window it left behind was missing
// the replacement block, so the very next tip cycle applied that block AGAIN.
//
// The claim asserted here is an EQUALITY against the live run, not an absence of
// throw: the same applies and reverts, in the same order, and the same cursor.
// ---------------------------------------------------------------------------

const FINALITY = 3;
const START_BLOCK = 100;

const SOURCE: IndexingSource<Abi> = {
	chainId: '1',
	contracts: [
		{abi: [] as unknown as Abi, address: '0x0000000000000000000000000000000000000001', startBlock: START_BLOCK},
	],
};

let logCounter = 0;
function makeEvent(blockNumber: number, blockHash: string, logIndex = 0): LogEvent<Abi> {
	logCounter++;
	return {
		blockNumber,
		blockHash,
		transactionIndex: 0,
		removed: false,
		address: '0x0000000000000000000000000000000000000001',
		data: '0x',
		topics: [],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}`,
		logIndex,
		extra: undefined,
	} as unknown as LogEvent<Abi>;
}

/**
 * The same fixture every other reorg test in this repository quotes: blocks 100,
 * 102 and 104 carry logs, and 104 is replaced.
 *
 * Block 100 sits outside the finality window at that tip, so it is CONFIRMED by
 * the time the reorg lands and cannot be part of what is retracted.
 */
const BRANCH_A: LogEvent<Abi>[] = [
	makeEvent(100, '0xa100', 0),
	makeEvent(100, '0xa100', 1),
	makeEvent(102, '0xa102', 0),
	makeEvent(104, '0xa104', 0),
	makeEvent(104, '0xa104', 1),
];
const BRANCH_A_TIP = 105;

/** The same chain after a reorg at 104: same 100 and 102, a DIFFERENT 104. */
const BRANCH_B: LogEvent<Abi>[] = [BRANCH_A[0], BRANCH_A[1], BRANCH_A[2], makeEvent(104, '0xb104', 0)];
const BRANCH_B_TIP = 106;

/** What a node serves for one `eth_getLogs` range, out of one branch. */
function logsIn(branch: LogEvent<Abi>[], fromBlock: number, toBlock: number): LogEvent<Abi>[] {
	return branch.filter((event) => event.blockNumber >= fromBlock && event.blockNumber <= toBlock);
}

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

function makeIndexer(processor: any) {
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
		{stream: {finality: FINALITY}},
		{processorIdentity: PROCESSOR_IDENTITY},
	);
}

function cursor(over: Partial<LastSync<Abi>>): LastSync<Abi> {
	return {
		context: {source: [{startBlock: START_BLOCK, hash: 'h'}], config: 'cfg', processor: PROCESSOR_IDENTITY},
		latestBlock: 0,
		lastFromBlock: START_BLOCK,
		lastToBlock: 0,
		unconfirmedBlocks: [],
		...over,
	};
}

/** One emission, as an assertion can quote it: block, log index, and the verdict. */
const marks = (events: LogEvent<Abi>[]) =>
	events.map((event) => `${event.blockHash}:${event.logIndex}${event.removed ? ':removed' : ''}`);

/**
 * The LIVE run this replay has to reproduce: branch A to its tip, then the
 * reorged branch B.
 *
 * What it hands back is what the stream keeper would have stored (every batch
 * the processor was given, in order, retractions included) plus the cursor the
 * live run ended on.
 */
async function liveRunThroughAReorg() {
	const {processor, batches} = recordingProcessor();
	const indexer = makeIndexer(processor);
	await indexer.load();

	await indexer.feed(
		logsIn(BRANCH_A, START_BLOCK, BRANCH_A_TIP),
		cursor({lastFromBlock: START_BLOCK, lastToBlock: BRANCH_A_TIP, latestBlock: BRANCH_A_TIP}),
	);
	const secondFrom = indexer.expectedFromBlock;
	const lastSync = await indexer.feed(
		logsIn(BRANCH_B, secondFrom, BRANCH_B_TIP),
		cursor({lastFromBlock: secondFrom, lastToBlock: BRANCH_B_TIP, latestBlock: BRANCH_B_TIP}),
	);

	return {indexer, batches, lastSync, stream: batches.flat()};
}

describe('replay() reproduces the live run off the stored stream', () => {
	it('stores the retraction in the stream, so the replay has something to honour', async () => {
		const live = await liveRunThroughAReorg();

		// the superseded 104 comes back at its ORIGINAL block, flagged `removed`,
		// AFTER the events it supersedes and BEFORE the replacement branch
		expect(marks(live.stream)).toEqual([
			'0xa100:0',
			'0xa100:1',
			'0xa102:0',
			'0xa104:0',
			'0xa104:1',
			'0xa104:0:removed',
			'0xa104:1:removed',
			'0xb104:0',
		]);
	});

	it('delivers the SAME applies and reverts, in the same order, against a FRESH cursor', async () => {
		const live = await liveRunThroughAReorg();

		const {processor, batches} = recordingProcessor();
		const rebuilt = makeIndexer(processor);
		await rebuilt.load();

		// exactly what `promiseToLoad` does on a rebuild: the whole stored stream,
		// against a cursor whose window is EMPTY and whose `lastFromBlock` is the
		// block the rebuild asked the keeper for
		await rebuilt.replay(
			live.stream,
			cursor({lastFromBlock: START_BLOCK, lastToBlock: BRANCH_B_TIP, latestBlock: BRANCH_B_TIP}),
		);

		expect(marks(batches.flat())).toEqual(marks(live.stream));
		// and the replacement block is applied EXACTLY ONCE
		expect(marks(batches.flat()).filter((mark) => mark === '0xb104:0')).toHaveLength(1);
	});

	it('leaves the cursor, WINDOW included, where the live run left it', async () => {
		const live = await liveRunThroughAReorg();

		const {processor} = recordingProcessor();
		const rebuilt = makeIndexer(processor);
		await rebuilt.load();
		const replayed = await rebuilt.replay(
			live.stream,
			cursor({lastFromBlock: START_BLOCK, lastToBlock: BRANCH_B_TIP, latestBlock: BRANCH_B_TIP}),
		);

		// the SUPERSEDED block is not in it, and the replacement is: a window
		// reconstructed by skipping the `removed` entries alone would hold two blocks
		// at height 104, which is a window no live run ever held
		expect(replayed.unconfirmedBlocks.map((block) => block.hash)).toEqual(['0xb104']);
		expect(replayed.unconfirmedBlocks).toEqual(live.lastSync.unconfirmedBlocks);
		expect(rebuilt.expectedFromBlock).toBe(live.indexer.expectedFromBlock);
	});

	it('does not apply the replacement block again on the FIRST tip cycle after the replay', async () => {
		const live = await liveRunThroughAReorg();

		const {processor, batches} = recordingProcessor();
		const rebuilt = makeIndexer(processor);
		await rebuilt.load();
		await rebuilt.replay(
			live.stream,
			cursor({lastFromBlock: START_BLOCK, lastToBlock: BRANCH_B_TIP, latestBlock: BRANCH_B_TIP}),
		);
		batches.length = 0;

		// the next cycle re-reads the finality window, exactly as the live one does
		const from = rebuilt.expectedFromBlock;
		expect(from).toBe(BRANCH_B_TIP - FINALITY);
		await rebuilt.feed(
			logsIn(BRANCH_B, from, BRANCH_B_TIP),
			cursor({lastFromBlock: from, lastToBlock: BRANCH_B_TIP, latestBlock: BRANCH_B_TIP}),
		);

		// 0xb104 is IN the window, so it is recognised rather than re-applied
		expect(batches.flat()).toEqual([]);
	});
});

describe('replay() of a stream with NO reorg', () => {
	it('applies every block once and rebuilds the same window a live run holds', async () => {
		const liveRecorder = recordingProcessor();
		const live = makeIndexer(liveRecorder.processor);
		await live.load();
		const liveLastSync = await live.feed(
			logsIn(BRANCH_A, START_BLOCK, BRANCH_A_TIP),
			cursor({lastFromBlock: START_BLOCK, lastToBlock: BRANCH_A_TIP, latestBlock: BRANCH_A_TIP}),
		);

		const {processor, batches} = recordingProcessor();
		const rebuilt = makeIndexer(processor);
		await rebuilt.load();
		const replayed = await rebuilt.replay(
			liveRecorder.batches.flat(),
			cursor({lastFromBlock: START_BLOCK, lastToBlock: BRANCH_A_TIP, latestBlock: BRANCH_A_TIP}),
		);

		expect(marks(batches.flat())).toEqual(marks(BRANCH_A));
		expect(replayed.unconfirmedBlocks).toEqual(liveLastSync.unconfirmedBlocks);
	});
});

describe('a replay that CATCHES UP a kept state does not re-apply what it holds', () => {
	it('skips the blocks already in the window and applies only what is above them', async () => {
		// The other shape `promiseToLoad` replays: the state is KEPT and the stream
		// is AHEAD of it, which is what a tab closed between the write and the
		// process leaves behind. The replayed portion reaches back over the finality
		// window, so it re-offers blocks the state already applied.
		const {processor, batches} = recordingProcessor();
		const indexer = makeIndexer(processor);
		await indexer.load();
		await indexer.feed(
			logsIn(BRANCH_A, START_BLOCK, BRANCH_A_TIP),
			cursor({lastFromBlock: START_BLOCK, lastToBlock: BRANCH_A_TIP, latestBlock: BRANCH_A_TIP}),
		);
		const applied = batches.flat();
		batches.length = 0;

		// the stream holds one batch more than the state: the same events, plus a
		// block 106 the processor never accepted
		const ahead = [...applied, makeEvent(106, '0xa106', 0)];
		const from = indexer.expectedFromBlock;
		await indexer.replay(
			ahead.filter((event) => event.blockNumber >= from),
			cursor({lastFromBlock: from, lastToBlock: 106, latestBlock: 107}),
		);

		expect(marks(batches.flat())).toEqual(['0xa106:0']);
	});
});

describe('feed() refuses a stream that carries its own verdicts', () => {
	it('names replay() rather than silently dropping the retractions', async () => {
		const {processor} = recordingProcessor();
		const indexer = makeIndexer(processor);
		await indexer.load();

		const retracted = {...makeEvent(100, '0xa100', 0), removed: true} as LogEvent<Abi>;
		await expect(
			indexer.feed([retracted], cursor({lastFromBlock: START_BLOCK, lastToBlock: 100, latestBlock: 100})),
		).rejects.toThrow(/replay\(\)/);
	});
});
