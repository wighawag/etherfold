import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import type {EmissionWrite, StreamCoverage} from '../src/emissionStream.js';
import {generationDigestOf} from '../src/generation/identity.js';
import {createMemoryGenerationRegistryPort} from '../src/generation/memory.js';
import {DEFAULT_MAX_EMISSIONS_PER_CHUNK, type ReplayChunk, type ReplaySource} from '../src/generation/rebuild.js';
import type {GenerationRegistryPort} from '../src/generation/registry.js';
import {openReceivingIndexer, type ReceivingIndexer} from '../src/receivingContainer.js';
import type {EmittedLog, EventProcessor, IndexingSource, LastSync, LogEvent, WireBatch} from '../src/types.js';
import {taggedBnReplacer, taggedBnReviver} from '../src/utils/bigint.js';

// ---------------------------------------------------------------------------------------------------
// THE REBUILD REPLAYS THE LOCAL STREAM IN BOUNDED CHUNKS, AND THE POINTER MOVES AT THE END
// ---------------------------------------------------------------------------------------------------
// A processor upgrade is a new GENERATION over the SAME stream, so the successor
// is a **follower** (ADR-0044): it fetches NOTHING and re-folds what is already
// stored. This file asserts the CONTRACT of that catch-up over the reference
// substrate -- the driver's per-call report, the state after promotion, and that
// nothing reaches a chain or a stream writer.
//
// The three seams under test, deliberately separate:
//
//  - the DRIVER's per-call report: bounded work, and `complete` as the thing a
//    scheduler acts on, exactly as `prune` and `compactEmissionPairs` report
//    (ADR-0022);
//  - RESUMABILITY, asserted by driving chunk after chunk through a FRESH
//    container -- a new object graph over the same substrate, never a loop in one
//    closure -- including a kill between two chunks;
//  - the POINTER, which moves ONCE, at the end, with the retired generation
//    RETAINED and still answering.
//
// The stored stream here is written by a REAL `StreamBuilder` fed real batches,
// including a REORG and a QUIET range, so what is re-folded is what a deployment
// actually stores rather than a fixture written to suit the reader. What the SQL
// substrate adds -- rows, the coverage claim, the bounded read's block-boundary
// cut -- is asserted in `packages/server/test/rebuildInBoundedChunks.test.ts`.
// ---------------------------------------------------------------------------------------------------

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

const CONTRACT = '0x0000000000000000000000000000000000000099' as const;
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;
const START_BLOCK = 100;
const FINALITY = 3;

const SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
};

let logCounter = 0;

/** A REAL raw log with real topics, so `reparse` decodes it rather than recording a decode error. */
function transfer(blockNumber: number, blockHash: string, id: bigint, logIndex = 0): LogEvent<TestABI> {
	logCounter++;
	return {
		blockNumber,
		blockHash,
		transactionIndex: 0,
		removed: false,
		address: CONTRACT,
		data: `0x${id.toString(16).padStart(64, '0')}`,
		topics: [TRANSFER_TOPIC0, pad(CONTRACT), pad(CONTRACT)],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}`,
		logIndex,
		extra: undefined,
	} as unknown as LogEvent<TestABI>;
}

function pad(address: string): string {
	return `0x${address.slice(2).padStart(64, '0')}`;
}

/** What ONE emission is, for comparing a fold against a re-fold. */
function idOf(event: {blockNumber: number; blockHash: string; logIndex: number}): string {
	return `${event.blockNumber}:${event.blockHash}:${event.logIndex}`;
}

// ---------------------------------------------------------------------------------------------------
// THE STORED STREAM, in memory, with the two things the real one has
// ---------------------------------------------------------------------------------------------------

type StoredRow = {seq: number; log: EmittedLog};

/**
 * The emission stream of one named indexer, as ADR-0006's table holds it: rows
 * in `seq` order with retractions INCLUDED, plus the COVERAGE CLAIM beside them,
 * which is the only thing that can say how far a quiet range carried the stream.
 *
 * Only the RAW log is kept, exactly as the columns do: `args` and `eventName`
 * are what SOME ABI made of those bytes (ADR-0034) and a replay decodes again.
 */
function storedStream() {
	const rows: StoredRow[] = [];
	let coverage: (StreamCoverage & {startBlock: number}) | undefined;
	let seq = 0;

	return {
		get rows() {
			return rows;
		},
		/** A byte comparison, so "the re-fold wrote nothing" is not a row count. */
		snapshot: () => JSON.stringify({rows, coverage}),
		append(write: EmissionWrite): void {
			coverage = coverage
				? {...write.coverage, startBlock: coverage.startBlock}
				: {...write.coverage, startBlock: write.coverage.lastFromBlock};
			for (const emission of write.emissions) {
				seq++;
				const {blockNumber, blockHash, logIndex, transactionHash, transactionIndex, address, topics, data, removed} =
					emission as EmittedLog & {removed?: boolean};
				rows.push({
					seq,
					log: {
						blockNumber,
						blockHash,
						logIndex,
						transactionHash,
						transactionIndex,
						address,
						topics,
						data,
						removed: removed ? true : false,
					} as unknown as EmittedLog,
				});
			}
		},
		/**
		 * The BOUNDED read, in the shape `@etherfold/server` implements over SQL: a
		 * budget in emissions, cut on a BLOCK boundary (a block is the indivisible unit
		 * of a `seq`-ordered stream carrying reorgs) and never at or below what the fold
		 * already covers (or a fold inside the reorg window would never advance).
		 */
		source(): ReplaySource<TestABI> {
			return {
				async readChunk({fromBlock, foldedThrough, maxEmissions}): Promise<ReplayChunk<TestABI> | undefined> {
					if (!coverage || coverage.startBlock > fromBlock) return undefined;
					const highWater = rows.length === 0 ? 0 : (rows[rows.length - 1] as StoredRow).seq;
					const above = rows
						.filter((row) => blockOf(row) >= fromBlock)
						.sort((a, b) => blockOf(a) - blockOf(b) || a.seq - b.seq);
					const floor = Math.max(foldedThrough + 1, fromBlock);
					const budgetCut =
						above.length > maxEmissions ? blockOf(above[maxEmissions] as StoredRow) - 1 : coverage.lastToBlock;
					const lastToBlock = Math.min(coverage.lastToBlock, Math.max(budgetCut, floor));
					return {
						eventStream: eventsOf(above.filter((row) => blockOf(row) <= lastToBlock)),
						lastFromBlock: fromBlock,
						lastToBlock,
						latestBlock: coverage.latestBlock,
						truncated: lastToBlock < coverage.lastToBlock,
						highWater,
					};
				},
			};
		},
	};
}

function blockOf(row: StoredRow): number {
	return (row.log as unknown as {blockNumber: number}).blockNumber;
}

function eventsOf(rows: readonly StoredRow[]): LogEvent<TestABI>[] {
	return [...rows].sort((a, b) => a.seq - b.seq).map((row) => ({...row.log}) as unknown as LogEvent<TestABI>);
}

// ---------------------------------------------------------------------------------------------------
// THE SUBSTRATE: one named indexer's records, and a state store per NAMESPACE
// ---------------------------------------------------------------------------------------------------

type MemoryStore = {rows: string[]; lastSync?: LastSync<TestABI>};

/**
 * A fold whose state is a list of emission ids and whose REVERT IS EXACT, so
 * "the re-fold reproduces the original state" is a real claim rather than one an
 * approximate revert could pass by luck.
 *
 * It persists its cursor WITH its state, which is the whole of the checkpoint:
 * the driver keeps no position of its own, and a store that wrote one without
 * the other is exactly what ADR-0027 puts behind the storage seam to prevent.
 */
function foldingProcessor(version: string, store: MemoryStore, weight: number): EventProcessor<TestABI, string[]> {
	return {
		getVersionHash: () => version,
		getCodeFingerprint: () => undefined,
		load: async () => (store.lastSync ? {state: store.rows, lastSync: clone(store.lastSync)} : undefined),
		process: async (eventStream, lastSync) => {
			for (const event of eventStream) {
				const mark = `${idOf(event)}x${weight}`;
				if (event.removed) {
					const at = store.rows.lastIndexOf(mark);
					if (at >= 0) store.rows.splice(at, 1);
				} else {
					store.rows.push(mark);
				}
			}
			// the state and the CHECKPOINT, together, which is what makes a kill between
			// two chunks resume rather than re-apply or skip
			store.lastSync = clone(lastSync);
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
}

/**
 * Through the repo's own codec, because a replayed window holds DECODED events
 * and every `uint256` in them is a BigInt that `JSON.stringify` throws on.
 */
function clone(lastSync: LastSync<TestABI>): LastSync<TestABI> {
	return JSON.parse(JSON.stringify(lastSync, taggedBnReplacer), taggedBnReviver) as LastSync<TestABI>;
}

/** One named indexer's DURABLE world: the registry records, the stream, and a store per namespace. */
function world() {
	const port: GenerationRegistryPort = createMemoryGenerationRegistryPort();
	const stream = storedStream();
	const stores = new Map<string, MemoryStore>();

	function storeFor(namespace: string): MemoryStore {
		let store = stores.get(namespace);
		if (!store) {
			store = {rows: []};
			stores.set(namespace, store);
		}
		return store;
	}

	/** A fold, as the container builds one: the state FIRST, then the processor over it (ADR-0043). */
	function specFor(version: string, weight: number) {
		return {
			createState: (context: {stream: string}) =>
				storeFor(generationDigestOf({stream: context.stream, processor: version})),
			createProcessor: (state: MemoryStore) => foldingProcessor(version, state, weight),
		};
	}

	/** A CONTAINER over this world: a new object graph every time, over the same durable rows. */
	function open(version: string, weight: number): Promise<ReceivingIndexer<TestABI, string[], MemoryStore>> {
		return openReceivingIndexer<TestABI, string[], MemoryStore>({
			port,
			source: SOURCE,
			stream: {finality: FINALITY},
			appendEmissions: (write) => stream.append(write),
			replay: stream.source(),
			generation: specFor(version, weight),
		});
	}

	return {
		port,
		stream,
		stores,
		specFor,
		open,
		rowsIn: (version: string, streamDigest: string) =>
			storeFor(generationDigestOf({stream: streamDigest, processor: version})).rows,
	};
}

type World = ReturnType<typeof world>;

function batch(
	indexer: ReceivingIndexer<TestABI, string[], MemoryStore>,
	over: {toBlock: number; latestBlock: number; logs: LogEvent<TestABI>[]},
	fromBlock: number,
): WireBatch<TestABI> {
	return {
		context: indexer.ingestion.context,
		fromBlock,
		toBlock: over.toBlock,
		latestBlock: over.latestBlock,
		logs: over.logs.map((event) => ({...event})),
	};
}

// The fixture: a history, a REORG that retracts a block and replaces it, and a
// QUIET range that carries no logs at all and still moves the coverage claim.
const AT_101 = transfer(101, '0xa101', 1n);
const DEAD_104 = transfer(104, '0xa104', 2n);
const REORGED_104 = transfer(104, '0xb104', 3n);
const AT_106 = transfer(106, '0xa106', 4n);

/** A world whose incumbent has folded the fixture and stored its emission stream. */
async function anIncumbentThatHasFolded(): Promise<{
	world: World;
	incumbent: ReceivingIndexer<TestABI, string[], MemoryStore>;
}> {
	const w = world();
	const incumbent = await w.open('v1', 1);
	const push = async (over: {toBlock: number; latestBlock: number; logs: LogEvent<TestABI>[]}) => {
		const fromBlock = await incumbent.ingestion.expectedFromBlock();
		await incumbent.ingestion.receive(batch(incumbent, over, fromBlock));
	};
	// [100, 105]: the history
	await push({toBlock: 105, latestBlock: 105, logs: [AT_101, DEAD_104]});
	// [102, 106]: 104 comes back with a different hash -- a contradiction, so the dead
	// block is retracted and the replacement applied
	await push({toBlock: 106, latestBlock: 106, logs: [REORGED_104, AT_106]});
	// [103, 110]: the window re-delivered unchanged and nothing new. The cursor moves
	// to 110 and the stream gains no row.
	await push({toBlock: 110, latestBlock: 110, logs: [REORGED_104, AT_106]});
	return {world: w, incumbent};
}

/** The state the CANONICAL generation answers from, resolved through the pointer (ADR-0053). */
async function canonicalAnswers(
	w: World,
	indexer: ReceivingIndexer<TestABI, string[], MemoryStore>,
): Promise<string[]> {
	const canonical = await indexer.canonical();
	if (!canonical) throw new Error('no canonical generation');
	return [...w.rowsIn(canonical.processor, canonical.stream)];
}

// ---------------------------------------------------------------------------------------------------

describe('a successor on a SHARED stream is a FOLLOWER, determined and never configured', () => {
	it('gets a rebuild over the stored stream and NO receiver, because a stream is one address', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();

		const successor = await incumbent.add(w.specFor('v2', 10));

		expect(successor.follows).toBe(true);
		expect(successor.ingestion).toBeUndefined();
		expect(successor.rebuild).toBeDefined();
		// and it is not the writer: ADR-0052's one-writer rule, so it stores nothing
		expect(successor.writesStream).toBe(false);
		expect(incumbent.writesStream).toBe(true);
		// one live wire context, still: the follower has no address of its own
		expect((await incumbent.liveIngestions()).map((live) => live.streamDigest)).toEqual([incumbent.streamDigest]);
	});

	it('replays `_emissions` alone: no chain, and not one write to the stream', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		const before = w.stream.snapshot();

		await incumbent.add(w.specFor('v2', 10));
		let report = await incumbent.rebuildMore();
		while (!report[0]?.complete) {
			report = await incumbent.rebuildMore();
		}

		// The chain is unreachable by construction: this container holds no provider
		// at all and the rebuild's decoder is built over one that throws on every call
		// (asserted below). What is asserted here is the other half -- the stored stream
		// is untouched, byte for byte, so nothing was appended a second time.
		expect(w.stream.snapshot()).toBe(before);
	});

	it('holds a provider that REFUSES, so a reach for the chain is loud and not a quiet re-index', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		const successor = await incumbent.add(w.specFor('v2', 10));

		// The decoder is the only thing in a rebuild that is built out of a chain-facing
		// class, and this is what it holds instead of a node. ZERO calls is asserted by
		// construction rather than by counting: there is nothing to count against,
		// because a single call throws.
		const provider = (
			successor.rebuild as unknown as {
				decoder: {provider: {request(args: {method: string}): Promise<never>}};
			}
		).decoder.provider;
		await expect(provider.request({method: 'eth_getLogs'})).rejects.toThrow(/must never reach the chain/);
	});
});

describe('the rebuild proceeds in bounded chunks and REPORTS whether it finished', () => {
	it('does bounded work per call and says `complete` only when the stream is folded', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		await incumbent.add(w.specFor('v2', 10));

		const reports = [];
		let done = false;
		while (!done) {
			const [report] = await incumbent.rebuildMore({maxEmissions: 1});
			if (!report) throw new Error('no follower to advance');
			reports.push(report);
			done = report.complete;
		}

		// more than one call, and every one of them bounded: the fixture holds five
		// emissions and a budget of one cannot swallow them in a single chunk
		expect(reports.length).toBeGreaterThan(1);
		expect(reports.slice(0, -1).every((report) => report.complete === false)).toBe(true);
		// the report is what a scheduler acts on, and it names the position it reached
		expect(reports[0]).toMatchObject({fromBlock: START_BLOCK, absent: false});
		expect(reports[reports.length - 1]).toMatchObject({complete: true, toBlock: 110});
		// and it reports the stream-space size it is folding against
		expect(reports[reports.length - 1]?.highWater).toBe(w.stream.rows.length);
	});

	it('spends a budget that lands INSIDE one block on the whole block, never on half of it', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		await incumbent.add(w.specFor('v2', 10));

		const scans: number[] = [];
		let done = false;
		while (!done) {
			const [report] = await incumbent.rebuildMore({maxEmissions: 1});
			if (!report) throw new Error('no follower to advance');
			scans.push(report.scanned);
			done = report.complete;
		}

		// block 104 carries three emissions (an application, its retraction and the
		// replacement) and a budget of one still reads all three: a chunk that ended
		// mid-block would leave rows below its own resume point, and the next chunk
		// resumes above them
		expect(Math.max(...scans)).toBeGreaterThan(1);
	});

	it('refuses a budget of zero rather than reading it as "do nothing"', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		await incumbent.add(w.specFor('v2', 10));

		await expect(incumbent.rebuildMore({maxEmissions: 0})).rejects.toThrow(/invalid rebuild budget/);
		expect(DEFAULT_MAX_EMISSIONS_PER_CHUNK).toBeGreaterThan(0);
	});

	it('reports ABSENT rather than completing, where there is no stored stream to fold', async () => {
		const w = world();
		// nothing has ever been folded, so nothing has been stored
		const incumbent = await w.open('v1', 1);
		await incumbent.add(w.specFor('v2', 10));

		const [report] = await incumbent.rebuildMore();
		expect(report).toMatchObject({absent: true, complete: false, scanned: 0});
		// and the pointer did not move onto a generation that has folded nothing
		expect(await incumbent.canonical()).toMatchObject(incumbent.generation);
	});
});

describe('resumability, asserted through a FRESH container between every chunk', () => {
	it('lands on the state the original fold produced, over a stream holding a REORG', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		const original = [...w.rowsIn('v1', incumbent.streamDigest)];
		// the incumbent took the reorg: the dead 104 is gone and its replacement is in
		expect(original).toEqual([`${idOf(AT_101)}x1`, `${idOf(REORGED_104)}x1`, `${idOf(AT_106)}x1`]);

		// EVERY chunk through a new object graph: a new container, a new receiver, a
		// new rebuild driver, over the same durable rows. Nothing carries from one
		// call to the next but what the store committed.
		let done = false;
		let chunks = 0;
		while (!done) {
			const fresh = await w.open('v1', 1);
			await fresh.add(w.specFor('v2', 10));
			const [report] = await fresh.rebuildMore({maxEmissions: 1});
			if (!report) throw new Error('no follower to advance');
			chunks++;
			done = report.complete;
			expect(chunks).toBeLessThan(20);
		}

		// compare STATE, not row counts: the successor folded the same history and the
		// same reorg, and its own fold applied to it
		const rebuilt = w.rowsIn('v2', incumbent.streamDigest);
		expect(rebuilt).toEqual([`${idOf(AT_101)}x10`, `${idOf(REORGED_104)}x10`, `${idOf(AT_106)}x10`]);
		expect(rebuilt).not.toContain(`${idOf(DEAD_104)}x10`);
	});

	it('resumes from the checkpoint after a KILL between two chunks, applying nothing twice', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		await incumbent.add(w.specFor('v2', 10));

		// two chunks, then the process is gone
		await incumbent.rebuildMore({maxEmissions: 1});
		await incumbent.rebuildMore({maxEmissions: 1});
		const killedAt = [...w.rowsIn('v2', incumbent.streamDigest)];
		expect(killedAt.length).toBeGreaterThan(0);

		// a new process comes up against the same substrate and finishes the job
		let done = false;
		while (!done) {
			const revived = await w.open('v1', 1);
			await revived.add(w.specFor('v2', 10));
			const [report] = await revived.rebuildMore({maxEmissions: 1});
			done = !!report?.complete;
		}

		// nothing applied twice and nothing skipped: the rebuilt state is exactly the
		// one an uninterrupted rebuild produces
		expect(w.rowsIn('v2', incumbent.streamDigest)).toEqual([
			`${idOf(AT_101)}x10`,
			`${idOf(REORGED_104)}x10`,
			`${idOf(AT_106)}x10`,
		]);
		// and it did resume rather than start again: the killed-at prefix survived
		expect(w.rowsIn('v2', incumbent.streamDigest).slice(0, killedAt.length)).toEqual(killedAt);
	});

	it('does nothing on a further call once level, and stays complete', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		await incumbent.add(w.specFor('v2', 10));
		let done = false;
		while (!done) {
			const [report] = await incumbent.rebuildMore({maxEmissions: 1});
			done = !!report?.complete;
		}
		const level = [...w.rowsIn('v2', incumbent.streamDigest)];

		const [again] = await incumbent.rebuildMore();

		expect(again).toMatchObject({complete: true, replayed: 0});
		expect(w.rowsIn('v2', incumbent.streamDigest)).toEqual(level);
	});
});

describe('the canonical generation is served throughout, and the pointer moves ONCE at the end', () => {
	it('answers from the incumbent for the whole rebuild and switches only at the move', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		const incumbentAnswers = await canonicalAnswers(w, incumbent);
		await incumbent.add(w.specFor('v2', 10));

		const answersDuring: string[][] = [];
		const pointers: string[] = [];
		let done = false;
		while (!done) {
			const [report] = await incumbent.rebuildMore({maxEmissions: 1});
			if (!report) throw new Error('no follower to advance');
			done = report.complete;
			if (!done) {
				answersDuring.push(await canonicalAnswers(w, incumbent));
				pointers.push((await incumbent.canonical())?.processor as string);
			}
		}

		// nobody ever observed partial state: every read during the rebuild answered
		// exactly what the incumbent answered before it started
		expect(answersDuring.length).toBeGreaterThan(0);
		for (const answer of answersDuring) {
			expect(answer).toEqual(incumbentAnswers);
		}
		expect(new Set(pointers)).toEqual(new Set(['v1']));

		// and at the end the pointer names the successor
		expect((await incumbent.canonical())?.processor).toBe('v2');
		expect(await canonicalAnswers(w, incumbent)).toEqual([
			`${idOf(AT_101)}x10`,
			`${idOf(REORGED_104)}x10`,
			`${idOf(AT_106)}x10`,
		]);
	});

	it('RETAINS the retired generation, which still holds its own state and can still answer', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		const before = await canonicalAnswers(w, incumbent);
		await incumbent.add(w.specFor('v2', 10));
		let done = false;
		while (!done) {
			const [report] = await incumbent.rebuildMore({maxEmissions: 1});
			done = !!report?.complete;
		}

		// still registered, with its own rows untouched -- which is what makes moving
		// the pointer BACK a revert rather than a re-index
		expect((await incumbent.generations()).map((record) => record.processor)).toEqual(['v1', 'v2']);
		expect(w.rowsIn('v1', incumbent.streamDigest)).toEqual(before);

		// and moving the pointer back restores the answers EXACTLY, with no re-fold
		await incumbent.promote({stream: incumbent.streamDigest, processor: 'v1'});
		expect(await canonicalAnswers(w, incumbent)).toEqual(before);
	});

	it('does not move the pointer again on the chunk after a REVERT', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		await incumbent.add(w.specFor('v2', 10));
		let done = false;
		while (!done) {
			const [report] = await incumbent.rebuildMore({maxEmissions: 1});
			done = !!report?.complete;
		}
		await incumbent.promote({stream: incumbent.streamDigest, processor: 'v1'});

		// the successor is caught up by construction, so "any level non-canonical
		// generation is promotable" would put the pointer straight back (ADR-0046)
		await incumbent.rebuildMore();
		await incumbent.rebuildMore();

		expect((await incumbent.canonical())?.processor).toBe('v1');
	});

	it('keeps the WRITER and the retired generation FOLDING after the move (open question 2)', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		await incumbent.add(w.specFor('v2', 10));
		let done = false;
		while (!done) {
			const [report] = await incumbent.rebuildMore({maxEmissions: 1});
			done = !!report?.complete;
		}
		expect((await incumbent.canonical())?.processor).toBe('v2');

		// the append duty did NOT move with the pointer: the writer is the oldest
		// surviving generation on the stream, registration order and never the pointer
		expect((await incumbent.registry.writerOf(incumbent.streamDigest))?.processor).toBe('v1');
		expect(incumbent.writesStream).toBe(true);
		// so the retired generation is still the one being fed...
		expect((await incumbent.liveIngestions()).map((live) => live.streamDigest)).toEqual([incumbent.streamDigest]);

		const LATER = transfer(112, '0xa112', 5n);
		const fromBlock = await incumbent.ingestion.expectedFromBlock();
		await incumbent.ingestion.receive(batch(incumbent, {toBlock: 115, latestBlock: 115, logs: [LATER]}, fromBlock));

		// ...and it KEEPS FOLDING: a frozen retired generation would answer stale data
		// the instant the pointer was moved back to it
		expect(w.rowsIn('v1', incumbent.streamDigest)).toContain(`${idOf(LATER)}x1`);
		// and the promoted successor keeps FOLLOWING the same stream
		await incumbent.rebuildMore();
		expect(w.rowsIn('v2', incumbent.streamDigest)).toContain(`${idOf(LATER)}x10`);
	});
});

describe('the promotion policy is applied here and re-decided nowhere', () => {
	it('defaults to `on-catch-up` with nothing dropped, as in every runtime', async () => {
		const {incumbent} = await anIncumbentThatHasFolded();
		expect(incumbent.promotion).toEqual({policy: 'on-catch-up', dropOnPromotion: false});
	});

	it('under `manual` the pointer moves only when asked', async () => {
		const w = world();
		const incumbent = await openReceivingIndexer<TestABI, string[], MemoryStore>({
			port: w.port,
			source: SOURCE,
			stream: {finality: FINALITY},
			appendEmissions: (write) => w.stream.append(write),
			replay: w.stream.source(),
			promotion: {policy: 'manual'},
			generation: w.specFor('v1', 1),
		});
		const fromBlock = await incumbent.ingestion.expectedFromBlock();
		await incumbent.ingestion.receive(batch(incumbent, {toBlock: 105, latestBlock: 105, logs: [AT_101]}, fromBlock));

		await incumbent.add(w.specFor('v2', 10));
		let done = false;
		while (!done) {
			const [report] = await incumbent.rebuildMore({maxEmissions: 1});
			done = !!report?.complete;
		}

		// caught up, and still not canonical: `manual` means an operator inspects first
		expect((await incumbent.canonical())?.processor).toBe('v1');
		await incumbent.promote({stream: incumbent.streamDigest, processor: 'v2'});
		expect((await incumbent.canonical())?.processor).toBe('v2');
	});

	it('REFUSES `immediate` with drop-on-promotion rather than dropping a state that proved nothing', async () => {
		const w = world();
		await expect(
			openReceivingIndexer<TestABI, string[], MemoryStore>({
				port: w.port,
				source: SOURCE,
				stream: {finality: FINALITY},
				replay: w.stream.source(),
				promotion: {policy: 'immediate', dropOnPromotion: true},
				generation: w.specFor('v1', 1),
			}),
		).rejects.toThrow(/'immediate' with dropOnPromotion is not available/);
	});

	it('DECLINES a drop that would leave a follower folding a stream nothing appends to', async () => {
		const w = world();
		const incumbent = await openReceivingIndexer<TestABI, string[], MemoryStore>({
			port: w.port,
			source: SOURCE,
			stream: {finality: FINALITY},
			appendEmissions: (write) => w.stream.append(write),
			replay: w.stream.source(),
			promotion: {dropOnPromotion: true},
			generation: w.specFor('v1', 1),
		});
		const fromBlock = await incumbent.ingestion.expectedFromBlock();
		await incumbent.ingestion.receive(batch(incumbent, {toBlock: 105, latestBlock: 105, logs: [AT_101]}, fromBlock));

		await incumbent.add(w.specFor('v2', 10));
		let done = false;
		while (!done) {
			const [report] = await incumbent.rebuildMore({maxEmissions: 1});
			done = !!report?.complete;
		}

		// the superseded generation WRITES the stream the promoted one follows, so
		// dropping it would leave the app simply not advancing (ADR-0046)
		expect((await incumbent.canonical())?.processor).toBe('v2');
		expect((await incumbent.generations()).map((record) => record.processor)).toEqual(['v1', 'v2']);
	});
});
