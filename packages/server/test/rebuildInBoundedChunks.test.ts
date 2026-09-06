import {createClient} from '@libsql/client';
import {
	GenerationRebuild,
	StreamBuilder,
	resolveStreamConfig,
	streamDigestOf,
	type Abi,
	type EventProcessor,
	type IndexingSource,
	type LastSync,
	type LogEvent,
	type RebuildReport,
	type WireBatch,
} from '@etherfold/core';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL} from 'remote-sql';
import {beforeEach, describe, expect, it} from 'vitest';
import {readStreamHighWaterMark} from '../src/emissions.js';
import {
	applySchema,
	emissionAppenderFor,
	storedEmissionReplaySource,
	EMISSION_STREAM_TABLE,
	STREAM_COVERAGE_TABLE,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// THE REBUILD READS `_emissions` IN BOUNDED SLICES, AND FOLDS THEM RESUMABLY
// ---------------------------------------------------------------------------
// `storedStreamRefold.test.ts` asserts the UNBOUNDED view: the whole stream from
// a block, which is what a LOAD wants. This asserts the other read of the same
// rows -- the one a serverless rebuild can afford (ADR-0008, ADR-0022) -- and the
// driver over it.
//
// Two things are under test and they are deliberately separate:
//
//  - the BOUNDED READ's cut, which is the part that can be silently wrong: the
//    budget is in emissions and the cut is on a BLOCK boundary, because this
//    stream is `seq`-ordered and a reorg puts an application, its retraction and
//    its replacement at ONE block at arbitrarily separated `seq` values. A chunk
//    that ended mid-block would leave rows BELOW its own resume point, and the
//    next chunk resumes above them -- silent, permanent loss.
//  - the DRIVER over it, chunk after chunk through a FRESH object graph, landing
//    on the state the original fold produced over a stream containing a REORG.
//
// The writer here is a real `StreamBuilder` fed real batches, so what is read
// back is what a deployment actually stores.
// ---------------------------------------------------------------------------

const CONTRACT = '0x0000000000000000000000000000000000000099' as const;
const OTHER_CONTRACT = '0x0000000000000000000000000000000000000088' as const;
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;

const START_BLOCK = 100;
const FINALITY = 3;
const STREAM_CONFIG = {finality: FINALITY};

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

type TestABI = typeof abi;

const SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
};

/** A DIFFERENT FILTER, so a DIFFERENT stream: its logs were never requested under the first. */
const OTHER_SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: OTHER_CONTRACT, startBlock: START_BLOCK}],
};

const STREAM_DIGEST = streamDigestOf(SOURCE, resolveStreamConfig(STREAM_CONFIG));
const OTHER_STREAM_DIGEST = streamDigestOf(OTHER_SOURCE, resolveStreamConfig(STREAM_CONFIG));

let logCounter = 0;

function log(
	blockNumber: number,
	blockHash: string,
	options: {address?: string; logIndex?: number} = {},
): LogEvent<TestABI> {
	logCounter++;
	return {
		blockNumber,
		blockHash: blockHash as `0x${string}`,
		transactionIndex: 0,
		removed: false,
		address: (options.address ?? CONTRACT) as `0x${string}`,
		data: `0x${logCounter.toString(16).padStart(64, '0')}`,
		topics: [TRANSFER_TOPIC0, pad(CONTRACT), pad(CONTRACT)],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}` as `0x${string}`,
		logIndex: options.logIndex ?? 0,
		extra: undefined,
	} as unknown as LogEvent<TestABI>;
}

function pad(address: string): `0x${string}` {
	return `0x${address.slice(2).padStart(64, '0')}` as `0x${string}`;
}

/** What ONE emission is, for comparing a fold against a re-fold. */
function idOf(event: {blockNumber: number; blockHash: string; logIndex: number}): string {
	return `${event.blockNumber}:${event.blockHash}:${event.logIndex}`;
}

/**
 * A fold that keeps its state and its CHECKPOINT together, which is the minimum
 * a resumable rebuild needs: the driver holds no position of its own, so what
 * survives a call is exactly what this persisted.
 *
 * Hand-rolled rather than a real entity processor because what is asserted here
 * is that two folds over one stream land on the SAME state, and a plain list of
 * emission ids says that directly. The revert is exact, which is what makes "the
 * re-fold reproduces it" a real claim rather than one an approximate revert
 * could pass by luck.
 */
function foldingProcessor(version = 'proc-v2') {
	const store: {rows: string[]; lastSync?: string} = {rows: []};
	const processor: EventProcessor<TestABI, string[]> = {
		getVersionHash: () => version,
		getCodeFingerprint: () => undefined,
		load: async () =>
			store.lastSync ? {state: store.rows, lastSync: JSON.parse(store.lastSync) as LastSync<TestABI>} : undefined,
		process: async (eventStream, lastSync) => {
			for (const event of eventStream) {
				if (event.removed) {
					const at = store.rows.lastIndexOf(idOf(event));
					if (at >= 0) store.rows.splice(at, 1);
				} else {
					store.rows.push(idOf(event));
				}
			}
			store.lastSync = serialize(lastSync);
			return store.rows;
		},
		reset: async () => {
			store.rows.length = 0;
			store.lastSync = undefined;
		},
		clear: async () => {
			store.rows.length = 0;
			store.lastSync = undefined;
		},
	};
	return {processor, store};
}

/** The window holds DECODED events, and every `uint256` in one is a BigInt. */
function serialize(lastSync: LastSync<TestABI>): string {
	return JSON.stringify(lastSync, (_key, value) => (typeof value === 'bigint' ? `${value}n` : value));
}

async function freshDB(): Promise<RemoteSQL> {
	const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
	await applySchema(db);
	return db;
}

/** A receiver bound to one database and one NAME, exactly as a host binds one (ADR-0052). */
function receiverOn(db: RemoteSQL, indexer: string, source: IndexingSource<TestABI> = SOURCE) {
	const fold = foldingProcessor('proc-v1');
	const builder = new StreamBuilder<TestABI, string[]>(fold.processor, source, {
		stream: STREAM_CONFIG,
		appendEmissions: emissionAppenderFor(db, indexer),
	});
	return {
		builder,
		fold,
		async push(range: {toBlock: number; latestBlock: number; logs: LogEvent<TestABI>[]}) {
			const fromBlock = await builder.expectedFromBlock();
			const batch: WireBatch<TestABI> = {
				context: builder.context,
				fromBlock,
				toBlock: range.toBlock,
				latestBlock: range.latestBlock,
				logs: range.logs.map((event) => ({...event})),
			};
			return builder.receive(batch);
		},
	};
}

// The fixture: a history, a REORG that retracts a block and replaces it, and
// then a QUIET range that carries no logs at all.
const REORGED = log(104, '0xb104');
const AT_101 = log(101, '0xa101');
const DEAD_104 = log(104, '0xa104');
const AT_106 = log(106, '0xa106');

async function foldTheFixture(db: RemoteSQL, indexer: string) {
	const writer = receiverOn(db, indexer);
	// [100, 105]: the history
	await writer.push({toBlock: 105, latestBlock: 105, logs: [AT_101, DEAD_104]});
	// [102, 106]: 104 comes back with a different hash -- a contradiction, so the
	// dead block is retracted and the replacement applied
	await writer.push({toBlock: 106, latestBlock: 106, logs: [REORGED, AT_106]});
	// [103, 110]: the window re-delivered unchanged and nothing new
	await writer.push({toBlock: 110, latestBlock: 110, logs: [REORGED, AT_106]});
	return writer;
}

/** What the whole table looks like, so "the rebuild wrote nothing" is a byte comparison. */
async function tableSnapshot(db: RemoteSQL): Promise<string> {
	const emissions = (
		await db
			.prepare(`SELECT seq, removed, alive, blockNumber, blockHash FROM ${EMISSION_STREAM_TABLE} ORDER BY indexer, seq`)
			.all()
	).results;
	const coverage = (
		await db
			.prepare(
				`SELECT indexer, stream, startBlock, latestBlock, lastFromBlock, lastToBlock FROM ${STREAM_COVERAGE_TABLE}
				 ORDER BY indexer, stream`,
			)
			.all()
	).results;
	return JSON.stringify({emissions, coverage});
}

/** How the emissions read back, so a chunk's contents can be quoted rather than counted. */
function marksOf(events: readonly LogEvent<TestABI>[]): string[] {
	return events.map((event) => `${event.removed ? '-' : '+'}${event.blockNumber}:${event.blockHash}`);
}

// ---------------------------------------------------------------------------

describe('the bounded read cuts on a BLOCK boundary, never inside a block', () => {
	let db: RemoteSQL;

	beforeEach(async () => {
		db = await freshDB();
	});

	it('serves the whole tail and the stream`s own claim when the budget does not bite', async () => {
		await foldTheFixture(db, 'alpha');

		const chunk = await storedEmissionReplaySource<TestABI>(db, 'alpha').readChunk({
			stream: STREAM_DIGEST,
			fromBlock: START_BLOCK,
			foldedThrough: START_BLOCK - 1,
			maxEmissions: 100,
		});

		expect(marksOf(chunk?.eventStream ?? [])).toEqual([
			'+101:0xa101',
			'+104:0xa104',
			'-104:0xa104',
			'+104:0xb104',
			'+106:0xa106',
		]);
		expect(chunk?.truncated).toBe(false);
		// 110 and not 106: the quiet range carried no logs, and only the COVERAGE CLAIM
		// can say the stream reached past its last one (ADR-0055)
		expect(chunk?.lastToBlock).toBe(110);
		expect(chunk?.latestBlock).toBe(110);
		expect(chunk?.highWater).toBe(await readStreamHighWaterMark(db, {indexer: 'alpha', stream: STREAM_DIGEST}));
	});

	it('cuts BELOW the block the budget landed in, so no block is ever half folded', async () => {
		await foldTheFixture(db, 'alpha');

		// the budget stops inside block 104, which carries three emissions
		const chunk = await storedEmissionReplaySource<TestABI>(db, 'alpha').readChunk({
			stream: STREAM_DIGEST,
			fromBlock: START_BLOCK,
			foldedThrough: START_BLOCK - 1,
			maxEmissions: 2,
		});

		expect(marksOf(chunk?.eventStream ?? [])).toEqual(['+101:0xa101']);
		expect(chunk?.truncated).toBe(true);
		// and the claim is the last COMPLETE block, so the next chunk resumes at 104
		// with all three of its rows still ahead of it
		expect(chunk?.lastToBlock).toBe(103);
	});

	it('spends a budget that lands inside ONE block on the whole block rather than half of it', async () => {
		await foldTheFixture(db, 'alpha');

		const chunk = await storedEmissionReplaySource<TestABI>(db, 'alpha').readChunk({
			stream: STREAM_DIGEST,
			fromBlock: 104,
			foldedThrough: 103,
			maxEmissions: 1,
		});

		// all three rows of 104, in `seq` order: the application, the retraction that
		// took it back, and the replacement. Serving one of them and claiming block 104
		// would lose the other two for ever.
		expect(marksOf(chunk?.eventStream ?? [])).toEqual(['+104:0xa104', '-104:0xa104', '+104:0xb104']);
		expect(chunk).toMatchObject({truncated: true, lastToBlock: 104});
	});

	it('hands the slice back in `seq` order, which is the order the fold concluded it in', async () => {
		await foldTheFixture(db, 'alpha');

		const chunk = await storedEmissionReplaySource<TestABI>(db, 'alpha').readChunk({
			stream: STREAM_DIGEST,
			fromBlock: START_BLOCK,
			foldedThrough: START_BLOCK - 1,
			maxEmissions: 100,
		});

		// the retraction sits AFTER the emission it takes back and BEFORE the
		// replacement: any other order would have a processor revert past what it had
		// just applied
		const marks = marksOf(chunk?.eventStream ?? []);
		expect(marks.indexOf('+104:0xa104')).toBeLessThan(marks.indexOf('-104:0xa104'));
		expect(marks.indexOf('-104:0xa104')).toBeLessThan(marks.indexOf('+104:0xb104'));
	});

	it('never cuts AT OR BELOW what the fold already covers, so a fold in the reorg window advances', async () => {
		const writer = receiverOn(db, 'alpha');
		await writer.push({
			toBlock: 110,
			latestBlock: 110,
			logs: [log(108, '0xa108'), log(109, '0xa109'), log(110, '0xa110')],
		});

		// A fold that has covered 109 resumes at `latestBlock - finality` -- the reach
		// back that lets a replay see a retraction appended below its own cursor. With a
		// budget of one, a cut on the budget alone would land at 108, the fold would
		// claim nothing new, and the very same chunk would be asked for for ever.
		const chunk = await storedEmissionReplaySource<TestABI>(db, 'alpha').readChunk({
			stream: STREAM_DIGEST,
			fromBlock: 107,
			foldedThrough: 109,
			maxEmissions: 1,
		});

		expect(chunk?.lastToBlock).toBeGreaterThan(109);
		expect(chunk?.truncated).toBe(false);
		// the extra work is bounded by the reorg window, which is what one cycle of a
		// live indexer already pays
		expect(marksOf(chunk?.eventStream ?? [])).toEqual(['+108:0xa108', '+109:0xa109', '+110:0xa110']);
	});

	it('reads across a HOLE in `seq` without stalling on it', async () => {
		await foldTheFixture(db, 'alpha');
		// what pair-compaction leaves behind (ADR-0006): the retracted entry and its
		// retraction gone, the surrounding numbers exactly where they were
		await db.prepare(`DELETE FROM ${EMISSION_STREAM_TABLE} WHERE indexer = ?1 AND seq IN (2, 3)`).bind('alpha').all();

		const chunk = await storedEmissionReplaySource<TestABI>(db, 'alpha').readChunk({
			stream: STREAM_DIGEST,
			fromBlock: START_BLOCK,
			foldedThrough: START_BLOCK - 1,
			maxEmissions: 100,
		});

		expect(marksOf(chunk?.eventStream ?? [])).toEqual(['+101:0xa101', '+104:0xb104', '+106:0xa106']);
		expect(chunk?.lastToBlock).toBe(110);
	});
});

describe('the bounded read sees its OWN (indexer, stream) and nothing else', () => {
	let db: RemoteSQL;

	beforeEach(async () => {
		db = await freshDB();
	});

	it('never returns another NAMED INDEXER`s rows, even on a byte-identical stream', async () => {
		await foldTheFixture(db, 'alpha');
		await receiverOn(db, 'beta').push({toBlock: 105, latestBlock: 105, logs: [log(103, '0xbeta103')]});

		const chunk = await storedEmissionReplaySource<TestABI>(db, 'alpha').readChunk({
			stream: STREAM_DIGEST,
			fromBlock: START_BLOCK,
			foldedThrough: START_BLOCK - 1,
			maxEmissions: 100,
		});

		expect(chunk?.eventStream.some((event) => event.blockHash === '0xbeta103')).toBe(false);
	});

	it('reports ABSENT for a stream nothing has ever been stored under', async () => {
		await foldTheFixture(db, 'alpha');
		const source = storedEmissionReplaySource<TestABI>(db, 'alpha');

		expect(
			await source.readChunk({
				stream: OTHER_STREAM_DIGEST,
				fromBlock: START_BLOCK,
				foldedThrough: START_BLOCK - 1,
				maxEmissions: 10,
			}),
		).toBeUndefined();
		expect(
			await storedEmissionReplaySource<TestABI>(db, 'gamma').readChunk({
				stream: STREAM_DIGEST,
				fromBlock: START_BLOCK,
				foldedThrough: START_BLOCK - 1,
				maxEmissions: 10,
			}),
		).toBeUndefined();
	});

	it('reports ABSENT rather than serving a history that does not reach back far enough', async () => {
		const writer = receiverOn(db, 'alpha');
		await writer.push({toBlock: 105, latestBlock: 105, logs: [AT_101]});

		const chunk = await storedEmissionReplaySource<TestABI>(db, 'alpha').readChunk({
			stream: STREAM_DIGEST,
			fromBlock: START_BLOCK - 1,
			foldedThrough: START_BLOCK - 2,
			maxEmissions: 10,
		});

		// replaying this as though it were the whole history would silently drop
		// everything under it, and nothing is deleted in response: this reader owns
		// none of these rows
		expect(chunk).toBeUndefined();
		const rows = await db.prepare(`SELECT COUNT(*) AS records FROM ${EMISSION_STREAM_TABLE}`).all<{records: number}>();
		expect(Number(rows.results[0]?.records)).toBe(1);
	});
});

describe('a rebuild over the stored stream, chunk after chunk through a FRESH driver', () => {
	let db: RemoteSQL;

	beforeEach(async () => {
		db = await freshDB();
	});

	/**
	 * Drive one generation to completion, building a NEW driver for every chunk.
	 *
	 * That is the resumability claim made concrete: the driver holds no position
	 * between calls, so a new object graph over the same store resumes from what
	 * the store committed and from nothing else.
	 */
	async function rebuildInChunks(
		fold: ReturnType<typeof foldingProcessor>,
		indexer: string,
		maxEmissions: number,
	): Promise<RebuildReport[]> {
		const reports: RebuildReport[] = [];
		for (let call = 0; call < 50; call++) {
			const driver = new GenerationRebuild<TestABI, string[]>(fold.processor, SOURCE, {
				stream: STREAM_DIGEST,
				streamConfig: resolveStreamConfig(STREAM_CONFIG),
				replay: storedEmissionReplaySource<TestABI>(db, indexer),
				maxEmissions,
			});
			const report = await driver.more();
			reports.push(report);
			if (report.complete) return reports;
		}
		throw new Error('the rebuild did not finish within 50 chunks');
	}

	it('lands on the state the original fold produced, over a stream holding a REORG', async () => {
		const writer = await foldTheFixture(db, 'alpha');
		expect(writer.fold.store.rows).toEqual([idOf(AT_101), idOf(REORGED), idOf(AT_106)]);

		const successor = foldingProcessor();
		const reports = await rebuildInChunks(successor, 'alpha', 1);

		// compare STATE, not row counts
		expect(successor.store.rows).toEqual(writer.fold.store.rows);
		expect(successor.store.rows).not.toContain(idOf(DEAD_104));
		// and it took more than one chunk to get there, so the resumption really was
		// exercised
		expect(reports.length).toBeGreaterThan(1);
		expect(reports.slice(0, -1).every((report) => !report.complete)).toBe(true);
	});

	it('resumes at the coverage the stream CLAIMS, which is beyond its last log', async () => {
		await foldTheFixture(db, 'alpha');

		const successor = foldingProcessor();
		const reports = await rebuildInChunks(successor, 'alpha', 1);

		// 110 and not 106: a cursor derived from the rows would leave this generation
		// permanently behind the incumbent, and the promotion trigger would never fire
		expect(reports[reports.length - 1]?.toBlock).toBe(110);
	});

	it('writes NOTHING to the stream it folds: the table is byte for byte as the writer left it', async () => {
		await foldTheFixture(db, 'alpha');
		const before = await tableSnapshot(db);

		await rebuildInChunks(foldingProcessor(), 'alpha', 1);

		expect(await tableSnapshot(db)).toBe(before);
	});

	it('reaches the same state whatever the chunk size, so the bound is a cost and not a meaning', async () => {
		await foldTheFixture(db, 'alpha');

		const oneAtATime = foldingProcessor();
		await rebuildInChunks(oneAtATime, 'alpha', 1);
		const inOneGo = foldingProcessor();
		await rebuildInChunks(inOneGo, 'alpha', 1000);

		expect(oneAtATime.store.rows).toEqual(inOneGo.store.rows);
	});

	it('finishes over a stream whose whole tail sits inside the reorg window', async () => {
		// every log inside `[latestBlock - finality, latestBlock]`, so every resume
		// point reaches back over all of them: the case a budget-shaped `complete` would
		// report as unfinished for ever
		const writer = receiverOn(db, 'alpha');
		await writer.push({
			toBlock: 110,
			latestBlock: 110,
			logs: [log(108, '0xb108'), log(109, '0xb109'), log(110, '0xb110')],
		});

		const successor = foldingProcessor();
		const reports = await rebuildInChunks(successor, 'alpha', 1);

		expect(successor.store.rows).toEqual(writer.fold.store.rows);
		expect(reports[reports.length - 1]).toMatchObject({complete: true, toBlock: 110});
	});

	it('costs nothing once level, and stays complete', async () => {
		await foldTheFixture(db, 'alpha');
		const successor = foldingProcessor();
		await rebuildInChunks(successor, 'alpha', 1);
		const level = [...successor.store.rows];

		const [again] = await rebuildInChunks(successor, 'alpha', 1000);

		expect(again).toMatchObject({complete: true, replayed: 0});
		expect(successor.store.rows).toEqual(level);
	});
});
