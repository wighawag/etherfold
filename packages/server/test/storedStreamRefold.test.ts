import {createClient} from '@libsql/client';
import {
	StreamBuilder,
	resolveStreamConfig,
	streamConfigHashOf,
	streamDigestOf,
	IndexerGeneration,
	type Abi,
	type EventProcessor,
	type ExistingStream,
	type IndexingSource,
	type LastSync,
	type LogEvent,
	type StoredLogEvent,
	type WireBatch,
} from '@etherfold/core';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL, SQLPreparedStatement} from 'remote-sql';
import {beforeEach, describe, expect, it} from 'vitest';
import {
	applySchema,
	emissionAppenderFor,
	readStreamCoverage,
	storedEmissionStream,
	EMISSION_STREAM_TABLE,
	STREAM_COVERAGE_TABLE,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// THE STORED EMISSION STREAM IS A STREAM A SUCCESSOR CAN RE-FOLD, READ-ONLY
// ---------------------------------------------------------------------------
// ADR-0006's table is what the fold produced. This asserts that a GENERATION can
// fold it: `storedEmissionStream` is an `ExistingStream` over `_emissions`, so a
// processor-only upgrade rebuilds from local disk instead of going back to the
// chain -- zero `eth_getLogs`, zero writes to the stream (ADR-0044, ADR-0055).
//
// Three things are under test and they are deliberately separate:
//
//  - the READER: what it returns, what it refuses, and that it never reaches
//    another named indexer's or another stream's rows;
//  - the FOLD driven through it, over a fixture containing a REORG, so the
//    RETRACTION path is exercised and not just the happy one (ADR-0042: the rows
//    carry the fold's own verdicts and a replay honours them);
//  - the COVERAGE CLAIM, which is what makes the reader possible at all: the
//    rows cannot say how far a stream reaches, because a range that carried no
//    logs moves the cursor without adding one.
//
// The writer here is a real `StreamBuilder` fed real batches, so what is read
// back is what a deployment actually stores, and not a fixture written by the
// test to suit the reader.
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

/** The same log as the STREAM SEAM speaks it: the raw half, with no decode on it. */
function storedLog(blockNumber: number, blockHash: string): StoredLogEvent {
	return log(blockNumber, blockHash) as unknown as StoredLogEvent;
}

function pad(address: string): `0x${string}` {
	return `0x${address.slice(2).padStart(64, '0')}` as `0x${string}`;
}

/** What ONE emission is, for comparing a fold against a re-fold. */
function idOf(event: {blockNumber: number; blockHash: string; logIndex: number}): string {
	return `${event.blockNumber}:${event.blockHash}:${event.logIndex}`;
}

/**
 * A fold that keeps its state in memory and PERSISTS its cursor, which is the
 * minimum a `StreamBuilder` needs to advance across batches.
 *
 * Hand-rolled rather than a real entity processor because what is asserted here
 * is that two folds over one stream land on the SAME state, and a plain list of
 * emission ids says that directly. The revert is exact (a retraction removes the
 * emission it names), which is what makes "the re-fold reproduces it" a real
 * claim rather than one an approximate revert could pass by luck.
 */
function foldingProcessor() {
	let state: string[] = [];
	let saved: {lastSync: LastSync<TestABI>; state: string[]} | undefined;
	const processor: EventProcessor<TestABI, string[]> = {
		getVersionHash: () => 'proc-v1',
		getCodeFingerprint: () => undefined,
		load: async () => {
			if (!saved) return undefined;
			state = [...saved.state];
			return {lastSync: JSON.parse(JSON.stringify(saved.lastSync)) as LastSync<TestABI>, state};
		},
		process: async (eventStream, lastSync) => {
			for (const event of eventStream) {
				if (event.removed) {
					const at = state.lastIndexOf(idOf(event));
					if (at >= 0) state.splice(at, 1);
				} else {
					state.push(idOf(event));
				}
			}
			saved = {lastSync: JSON.parse(JSON.stringify(lastSync)) as LastSync<TestABI>, state: [...state]};
			return state;
		},
		reset: async () => {
			state = [];
			saved = undefined;
		},
		clear: async () => {
			state = [];
			saved = undefined;
		},
	};
	return {
		processor,
		get state() {
			return state;
		},
	};
}

async function freshDB(): Promise<RemoteSQL> {
	const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
	await applySchema(db);
	return db;
}

/** A receiver bound to one database and one NAME, exactly as a host binds one (ADR-0052). */
function receiverOn(db: RemoteSQL, indexer: string, source: IndexingSource<TestABI> = SOURCE) {
	const fold = foldingProcessor();
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
				// copied, because the fixture logs are shared across cases and a receiver is
				// entitled to do what it likes with the array it is handed
				logs: range.logs.map((event) => ({...event})),
			};
			return builder.receive(batch);
		},
	};
}

/**
 * The fixture every fold-level case runs on: a history, a REORG that retracts a
 * block and replaces it, and then a QUIET range that carries no logs at all.
 *
 * The quiet range is not padding. It is the case that decides whether the stored
 * stream can report its own coverage: it moves the fold's cursor from 106 to 110
 * while adding no row, so anything derived from the rows (`MAX(blockNumber)`)
 * answers 106 for ever after.
 */
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
	// [103, 110]: the window re-delivered unchanged and nothing new. The cursor
	// moves to 110 and the stream gains no row.
	await writer.push({toBlock: 110, latestBlock: 110, logs: [REORGED, AT_106]});
	return writer;
}

type EmissionRowShape = {seq: number; removed: number; alive: number; blockNumber: number; blockHash: string};

async function emissionRows(db: RemoteSQL, indexer?: string): Promise<EmissionRowShape[]> {
	const statement = indexer
		? db
				.prepare(
					`SELECT seq, removed, alive, blockNumber, blockHash FROM ${EMISSION_STREAM_TABLE} WHERE indexer = ?1 ORDER BY seq`,
				)
				.bind(indexer)
		: db.prepare(
				`SELECT seq, removed, alive, blockNumber, blockHash FROM ${EMISSION_STREAM_TABLE} ORDER BY indexer, stream, seq`,
			);
	return (await statement.all<EmissionRowShape>()).results;
}

/** What the whole table looks like, so "the re-fold wrote nothing" is a byte comparison and not a count. */
async function tableSnapshot(db: RemoteSQL): Promise<string> {
	const emissions = await emissionRows(db);
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

/**
 * Re-fold a stored stream into a NEW generation, with no node and no writer.
 *
 * This is the whole promise in one function: the stream comes off local disk
 * through the read-only view, the chain is unreachable by construction (the
 * provider answers `eth_chainId` and refuses everything else, and the fetch is
 * replaced by a throw), and `load()` IS the rebuild.
 */
async function refold(db: RemoteSQL, indexer: string, source: IndexingSource<TestABI> = SOURCE) {
	const fold = foldingProcessor();
	const fetches: unknown[] = [];
	const provider = {
		async request(args: {method: string}): Promise<unknown> {
			if (args.method === 'eth_chainId') return '0x1';
			throw new Error(`a re-fold must not reach the node: ${args.method}`);
		},
	} as never;
	const generation = new IndexerGeneration<TestABI, string[]>(provider, fold.processor, source, {
		stream: STREAM_CONFIG,
		keepStream: storedEmissionStream<TestABI>(db, indexer),
	});
	// Only the FETCH is replaced; `reparse` stays the real one, because a replayed
	// stream is re-decoded against the source running now (ADR-0034) and stubbing
	// that would be testing a decode this path does not perform.
	const fetcher = (generation as unknown as {logEventFetcher: {getLogEvents: unknown}}).logEventFetcher;
	fetcher.getLogEvents = async (range: unknown) => {
		fetches.push(range);
		throw new Error('a re-fold must not fetch');
	};
	const lastSync = await generation.load();
	return {state: fold.state, fetches, lastSync};
}

/** The read-only view on its own, for the cases that are about the READER and not about a fold. */
function viewOn(db: RemoteSQL, indexer: string): ExistingStream<TestABI> {
	const view = storedEmissionStream<TestABI>(db, indexer);
	view.setStreamConfig?.(resolveStreamConfig(STREAM_CONFIG));
	return view;
}

// ---------------------------------------------------------------------------

describe('a generation re-folds the stored stream, from `_emissions` alone', () => {
	let db: RemoteSQL;

	beforeEach(async () => {
		db = await freshDB();
	});

	it('reproduces the state the original fold produced, over a fixture holding a REORG', async () => {
		const writer = await foldTheFixture(db, 'alpha');

		// the writer took the reorg: the dead 104 is gone and its replacement is in
		expect(writer.fold.state).toEqual([idOf(AT_101), idOf(REORGED), idOf(AT_106)]);

		const rebuilt = await refold(db, 'alpha');
		expect(rebuilt.state).toEqual(writer.fold.state);
	});

	it('issues NO `eth_getLogs` AT ALL: zero, not fewer', async () => {
		await foldTheFixture(db, 'alpha');

		const rebuilt = await refold(db, 'alpha');
		expect(rebuilt.fetches).toEqual([]);
	});

	it('honours the stored VERDICTS rather than re-deriving them from a window it does not have', async () => {
		await foldTheFixture(db, 'alpha');

		// the retraction is IN the stored stream, at the block it took back, and the
		// row it superseded is flagged rather than deleted
		expect(
			(await emissionRows(db, 'alpha')).map((row) => [row.blockNumber, row.blockHash, row.removed, row.alive]),
		).toEqual([
			[101, '0xa101', 0, 1],
			[104, '0xa104', 0, 0],
			[104, '0xa104', 1, 0],
			[104, '0xb104', 0, 1],
			[106, '0xa106', 0, 1],
		]);

		// and a rebuild whose window starts EMPTY still lands on the live branch,
		// which is only possible by honouring them (ADR-0042)
		const rebuilt = await refold(db, 'alpha');
		expect(rebuilt.state).not.toContain(idOf(DEAD_104));
		expect(rebuilt.state).toContain(idOf(REORGED));
	});

	it('resumes at the coverage the stream claims, which is BEYOND its last log', async () => {
		await foldTheFixture(db, 'alpha');

		const rebuilt = await refold(db, 'alpha');
		// 110 and not 106: the quiet range carried no logs, so a cursor derived from
		// the rows would leave this generation permanently behind the incumbent
		expect(rebuilt.lastSync.lastToBlock).toBe(110);
		expect(rebuilt.lastSync.latestBlock).toBe(110);
	});
});

describe('the re-fold is READ-ONLY: it appends nothing and deletes nothing', () => {
	let db: RemoteSQL;

	beforeEach(async () => {
		db = await freshDB();
	});

	it('leaves the table byte for byte as the writer left it', async () => {
		await foldTheFixture(db, 'alpha');
		const before = await tableSnapshot(db);

		await refold(db, 'alpha');

		expect(await tableSnapshot(db)).toBe(before);
	});

	it('swallows a `saveNewEvents` that reaches it, so a second writer is unreachable', async () => {
		await foldTheFixture(db, 'alpha');
		const before = await tableSnapshot(db);

		await viewOn(db, 'alpha').saveNewEvents(SOURCE, {
			// STORED and not decoded, because that is what the seam takes now: a keeper is
			// handed the raw log plus the reorg verdict and nothing an ABI made of it
			eventStream: [storedLog(199, '0xdead')],
			lastSync: {
				context: {source: [], config: 'c', processor: 'p'},
				latestBlock: 200,
				lastFromBlock: 199,
				lastToBlock: 199,
				unconfirmedBlocks: [],
			},
		});

		expect(await tableSnapshot(db)).toBe(before);
	});

	it('swallows a `clear`, which the load path calls on every shape it cannot use', async () => {
		await foldTheFixture(db, 'alpha');
		const before = await tableSnapshot(db);

		await viewOn(db, 'alpha').clear(SOURCE);

		// the live generation's history is still there: a view that passed `clear`
		// through would have deleted the stream out from under its writer
		expect(await tableSnapshot(db)).toBe(before);
	});
});

describe('the reader sees its OWN (indexer, stream) and nothing else', () => {
	let db: RemoteSQL;

	beforeEach(async () => {
		db = await freshDB();
	});

	it('never returns another NAMED INDEXER\u2019s rows, even on a byte-identical stream', async () => {
		await foldTheFixture(db, 'alpha');
		// the same source, so the SAME stream digest: only the name tells them apart
		const beta = receiverOn(db, 'beta');
		await beta.push({toBlock: 105, latestBlock: 105, logs: [log(103, '0xbeta103')]});

		const alphaStream = await viewOn(db, 'alpha').fetchFrom(SOURCE, START_BLOCK);
		expect(alphaStream?.eventStream.map(idOf)).toEqual([
			idOf(AT_101),
			idOf(DEAD_104),
			idOf(DEAD_104),
			idOf(REORGED),
			idOf(AT_106),
		]);
		expect(alphaStream?.eventStream.some((event) => event.blockHash === '0xbeta103')).toBe(false);

		// and the fold lands where the writer's did, unmoved by the neighbour
		expect((await refold(db, 'alpha')).state).toEqual([idOf(AT_101), idOf(REORGED), idOf(AT_106)]);
	});

	it('never returns another STREAM\u2019s rows under the same name', async () => {
		await foldTheFixture(db, 'alpha');
		const other = receiverOn(db, 'alpha', OTHER_SOURCE);
		await other.push({
			toBlock: 105,
			latestBlock: 105,
			logs: [log(102, '0xother102', {address: OTHER_CONTRACT})],
		});

		// two streams under one name, and they are two rows and two claims
		expect(STREAM_DIGEST).not.toBe(OTHER_STREAM_DIGEST);
		const view = viewOn(db, 'alpha');
		const mine = await view.fetchFrom(SOURCE, START_BLOCK);
		const theirs = await view.fetchFrom(OTHER_SOURCE, START_BLOCK);

		expect(mine?.eventStream.some((event) => event.blockHash === '0xother102')).toBe(false);
		expect(theirs?.eventStream.map((event) => event.blockHash)).toEqual(['0xother102']);
	});

	it('reports ABSENT for a stream nothing has ever been stored under', async () => {
		await foldTheFixture(db, 'alpha');

		expect(await viewOn(db, 'alpha').fetchFrom(OTHER_SOURCE, START_BLOCK)).toBeUndefined();
		expect(await viewOn(db, 'gamma').fetchFrom(SOURCE, START_BLOCK)).toBeUndefined();
	});
});

describe('the reader hands back the stream in `seq` order, holes tolerated', () => {
	let db: RemoteSQL;

	beforeEach(async () => {
		db = await freshDB();
	});

	it('delivers retractions INCLUDED, at their original block, in the order they were appended', async () => {
		await foldTheFixture(db, 'alpha');

		const read = await viewOn(db, 'alpha').fetchFrom(SOURCE, START_BLOCK);
		expect(
			read?.eventStream.map((event) => `${event.removed ? '-' : '+'}${event.blockNumber}:${event.blockHash}`),
		).toEqual(['+101:0xa101', '+104:0xa104', '-104:0xa104', '+104:0xb104', '+106:0xa106']);
	});

	it('reads across a HOLE in `seq` without stalling on it', async () => {
		await foldTheFixture(db, 'alpha');
		// what pair-compaction leaves behind: the retracted entry and its retraction
		// gone, the surrounding numbers exactly where they were (ADR-0006)
		await db.prepare(`DELETE FROM ${EMISSION_STREAM_TABLE} WHERE indexer = ?1 AND seq IN (2, 3)`).bind('alpha').all();

		const read = await viewOn(db, 'alpha').fetchFrom(SOURCE, START_BLOCK);
		expect(read?.eventStream.map((event) => event.blockHash)).toEqual(['0xa101', '0xb104', '0xa106']);
		// the claim is untouched: a hole is legal and is not damage
		expect(read?.lastSync.lastToBlock).toBe(110);
	});

	it('serves from the block it is ASKED for, and no lower', async () => {
		await foldTheFixture(db, 'alpha');

		const read = await viewOn(db, 'alpha').fetchFrom(SOURCE, 104);
		expect(read?.eventStream.map((event) => event.blockNumber)).toEqual([104, 104, 104, 106]);
	});

	it('reports ABSENT rather than replaying a history that does not reach back far enough', async () => {
		const writer = receiverOn(db, 'alpha');
		await writer.push({toBlock: 105, latestBlock: 105, logs: [AT_101]});

		// asked from BELOW the first block ever stored: replaying this as though it
		// were the whole history would silently drop everything under it
		expect(await viewOn(db, 'alpha').fetchFrom(SOURCE, START_BLOCK - 1)).toBeUndefined();
		// ...and it deleted nothing in response, unlike the segment keeper's identical
		// check: these rows belong to the generation still appending to them
		expect(await emissionRows(db, 'alpha')).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// THE COVERAGE CLAIM, AND THE CURSOR CONTRACT IT ANSWERS (ADR-0035, ADR-0055)
// ---------------------------------------------------------------------------
// ADR-0035's contract is three PROPERTIES rather than a layout, and each keeper
// satisfies them however its substrate allows. The three are asserted here
// against this keeper's own claim: exactly ONE authoritative claim per stream, a
// claim that can never cover events the store lacks, and an empty save that
// costs nothing proportional to the history.
//
// What does NOT apply is the segment-port conformance material, because this
// implementation deliberately does not ride `createSegmentedStream`: there are no
// ordinals to allocate and therefore no GAP to detect. `_emissions` is already
// `seq`-addressed.
// ---------------------------------------------------------------------------

/** A handle that records every `batch()` it is asked to run, and can refuse them. */
function recordingDB(inner: RemoteSQL) {
	const batches: string[][] = [];
	let refuse = false;

	type Tagged = SQLPreparedStatement & {inner: SQLPreparedStatement; sql: string};
	const tag = (statement: SQLPreparedStatement, sql: string): Tagged => ({
		inner: statement,
		sql,
		bind: (...values: unknown[]) => tag(statement.bind(...values), sql),
		all: <T>() => statement.all<T>(),
	});

	const db: RemoteSQL = {
		prepare: (sql: string) => tag(inner.prepare(sql), sql),
		batch: async (list: SQLPreparedStatement[]) => {
			batches.push(list.map((statement) => (statement as Tagged).sql));
			if (refuse) throw new Error('the database went away');
			return inner.batch(list.map((statement) => (statement as Tagged).inner));
		},
	};

	return {
		db,
		batches,
		refuseNext(value: boolean) {
			refuse = value;
		},
	};
}

describe('the coverage claim is the stream\u2019s, written with the rows it covers', () => {
	let db: RemoteSQL;

	beforeEach(async () => {
		db = await freshDB();
	});

	it('records how far the stream reaches, under the filter it was fetched with', async () => {
		await foldTheFixture(db, 'alpha');

		const coverage = await readStreamCoverage(db, {indexer: 'alpha', stream: STREAM_DIGEST});
		expect(coverage).toMatchObject({startBlock: START_BLOCK, lastToBlock: 110, latestBlock: 110});
		// the identity half, so a re-folding generation can ask whether this stream was
		// fetched under a filter it is still covered by
		expect(coverage?.config).toBe(streamConfigHashOf(resolveStreamConfig(STREAM_CONFIG)));
		expect(coverage?.source.length).toBeGreaterThan(0);
	});

	it('moves on a batch that emitted NOTHING, which is the whole reason it is stored', async () => {
		const writer = receiverOn(db, 'alpha');
		const inTheWindow = log(104, '0xc104');
		await writer.push({toBlock: 105, latestBlock: 105, logs: [inTheWindow]});
		const rowsBefore = await emissionRows(db, 'alpha');

		// the unconfirmed window re-delivered unchanged and nothing new above it: the
		// fold emits nothing and its cursor still walks to 130
		await writer.push({toBlock: 130, latestBlock: 130, logs: [inTheWindow]});

		// not one new row...
		expect(await emissionRows(db, 'alpha')).toEqual(rowsBefore);
		// ...and the claim moved anyway, which `MAX(blockNumber)` could never have said
		expect((await readStreamCoverage(db, {indexer: 'alpha', stream: STREAM_DIGEST}))?.lastToBlock).toBe(130);
	});

	it('writes `startBlock` ONCE and never moves it', async () => {
		const writer = await foldTheFixture(db, 'alpha');
		await writer.push({toBlock: 140, latestBlock: 140, logs: []});

		expect((await readStreamCoverage(db, {indexer: 'alpha', stream: STREAM_DIGEST}))?.startBlock).toBe(START_BLOCK);
	});

	it('keeps exactly ONE claim per stream, and one per named indexer sharing it', async () => {
		await foldTheFixture(db, 'alpha');
		await receiverOn(db, 'beta').push({toBlock: 105, latestBlock: 105, logs: [log(103, '0xbeta103')]});
		await receiverOn(db, 'alpha', OTHER_SOURCE).push({
			toBlock: 105,
			latestBlock: 105,
			logs: [log(102, '0xother102', {address: OTHER_CONTRACT})],
		});

		const rows = (
			await db.prepare(`SELECT indexer, stream FROM ${STREAM_COVERAGE_TABLE} ORDER BY indexer, stream`).all<{
				indexer: string;
				stream: string;
			}>()
		).results;
		// three folds, three claims: one per PAIR and never one per batch
		expect(rows.map((row) => `${row.indexer}@${row.stream === STREAM_DIGEST ? 'shared' : 'other'}`).sort()).toEqual([
			'alpha@other',
			'alpha@shared',
			'beta@shared',
		]);
	});

	it('lands in the SAME `batch()` as the rows, so it can never claim coverage they lack', async () => {
		const recording = recordingDB(db);
		const writer = receiverOn(recording.db, 'alpha');

		await writer.push({toBlock: 105, latestBlock: 105, logs: [AT_101, DEAD_104]});

		// one batch, holding the claim and both inserts: two batches would leave a
		// window in which the claim covers rows that are not there yet
		expect(recording.batches).toHaveLength(1);
		const statements = recording.batches[0] as string[];
		expect(statements.filter((sql) => sql.includes(STREAM_COVERAGE_TABLE))).toHaveLength(1);
		expect(statements.filter((sql) => sql.includes(`INSERT INTO ${EMISSION_STREAM_TABLE}`))).toHaveLength(2);
	});

	it('leaves NEITHER behind when the store refuses, and the fold does not advance past it', async () => {
		const recording = recordingDB(db);
		const writer = receiverOn(recording.db, 'alpha');
		recording.refuseNext(true);

		await expect(writer.push({toBlock: 105, latestBlock: 105, logs: [AT_101]})).rejects.toThrow(/went away/);

		expect(await emissionRows(db, 'alpha')).toEqual([]);
		expect(await readStreamCoverage(db, {indexer: 'alpha', stream: STREAM_DIGEST})).toBeUndefined();
		// nothing folded, so the receiver still asks for the range it always asked for
		expect(await writer.builder.expectedFromBlock()).toBe(START_BLOCK);
	});

	it('costs ONE statement on an empty save, and nothing proportional to the history', async () => {
		const recording = recordingDB(db);
		const writer = receiverOn(recording.db, 'alpha');
		const inTheWindow = log(104, '0xc104');
		await writer.push({toBlock: 105, latestBlock: 105, logs: [AT_101, inTheWindow]});

		await writer.push({toBlock: 130, latestBlock: 130, logs: [inTheWindow]});

		// the second batch emitted nothing: one upsert, and no scan of what is stored
		expect(recording.batches[1]).toHaveLength(1);
		expect((recording.batches[1] as string[])[0]).toContain(STREAM_COVERAGE_TABLE);
	});

	it('is what PRESENCE is: rows with no claim are not a stream anything may fold', async () => {
		await foldTheFixture(db, 'alpha');
		await db.prepare(`DELETE FROM ${STREAM_COVERAGE_TABLE} WHERE indexer = ?1`).bind('alpha').all();

		// the rows are still there, and they cannot say what filter produced them or
		// how far they reach, so they are reported ABSENT rather than replayed
		expect((await emissionRows(db, 'alpha')).length).toBeGreaterThan(0);
		expect(await viewOn(db, 'alpha').fetchFrom(SOURCE, START_BLOCK)).toBeUndefined();
	});

	it('is PRESENT with no rows at all, which is a stream that has been scanned and found nothing', async () => {
		const writer = receiverOn(db, 'alpha');
		await writer.push({toBlock: 105, latestBlock: 105, logs: []});

		const read = await viewOn(db, 'alpha').fetchFrom(SOURCE, START_BLOCK);
		// NOT absent: reporting absent here would make a deployment whose contracts
		// have emitted nothing re-scan from its start block on every reload
		expect(read?.eventStream).toEqual([]);
		expect(read?.lastSync.lastToBlock).toBe(105);
	});
});
