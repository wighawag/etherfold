import {
	generationDigestOf,
	openReceivingIndexer,
	type LogEvent,
	type RebuildReport,
	type ReceivingIndexer,
	type WireBatch,
} from '@etherfold/core';
import {
	entityProcessorVersionHash,
	EntityEventProcessor,
	type EntityProcessor,
	type StateStore,
} from '@etherfold/processor-entities';
import {
	applySchema,
	EMISSION_STREAM_TABLE,
	emissionAppenderFor,
	generationRegistryPortOnSQL,
	storedEmissionReplaySource,
	STREAM_COVERAGE_TABLE,
	type SQLGenerationRegistryOptions,
} from '@etherfold/server';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import {createClient} from '@libsql/client';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {describe, expect, it} from 'vitest';
import {
	abi,
	ALICE,
	BOB,
	CAROL,
	CONTRACT,
	nftEntities,
	nftProcessor,
	SOURCE,
	START_BLOCK,
	transfer,
	ZERO,
	type RawLog,
} from './utils/chain.js';

// ---------------------------------------------------------------------------------------------------
// A PROCESSOR UPGRADE COSTS A LOCAL SCAN: THE REBUILD, END TO END, ON A REAL DATABASE
// ---------------------------------------------------------------------------------------------------
// `packages/core/test/rebuild.test.ts` asserts the CONTRACT over the reference
// substrate and `packages/server/test/rebuildInBoundedChunks.test.ts` asserts the
// bounded READ over real rows. This file is the whole promise on the shape a
// deployment actually has: ONE libSQL handle carrying the server's fixed tables,
// the stored emission stream and every generation's own table namespace, with
// real entity processors folding into it.
//
// What only this level can say:
//
//  - the successor's state really lands in ITS OWN tables (ADR-0053), and the
//    incumbent's rows are untouched for the whole rebuild;
//  - RESUMABILITY through a genuinely FRESH object graph -- a new container, a
//    new registry over the same rows, new stores, a new rebuild driver -- which
//    is the only honest form of "a process was killed between two chunks";
//  - READS, resolved through the canonical POINTER to a table namespace, answer
//    the incumbent throughout and switch exactly once.
//
// THE COMMANDS NOW FOLD THROUGH EXACTLY THIS ASSEMBLY, which lives in
// `src/folding.ts` (`openFolding`), and `run` schedules the chunks between its
// own fetch cycles. It is written out again here on purpose: the rebuild's
// resumability is asserted by building a genuinely fresh object graph over the
// same rows, which is a thing a test can arrange directly and a running command
// cannot.
// ---------------------------------------------------------------------------------------------------

const INDEXER = 'alpha';
const FINALITY = 3;
const TOKEN = '1'.padStart(78, '0');

/** The incumbent fold: one transfer counted once. */
const V1: EntityProcessor<typeof abi> = nftProcessor;

/**
 * THE UPGRADE: the same logs, a DIFFERENT fold.
 *
 * It counts each transfer TWICE, so the two generations answer observably
 * different things from byte-identical input -- which is what makes "reads
 * answered from the canonical generation throughout" a real assertion rather
 * than one two identical folds would pass by accident.
 */
const V2: EntityProcessor<typeof abi> = {
	version: '2.0.0',
	entities: nftEntities,
	async onTransfer(state, event) {
		const tokenID = event.args.id.toString().padStart(78, '0');
		const to = event.args.to.toLowerCase();
		if (to === ZERO) {
			state.delete('nft', {tokenID});
		} else {
			state.set('nft', {tokenID}, {owner: to});
		}
		const counter = await state.get<{value: number}>('counter', {name: 'transfers'});
		state.set('counter', {name: 'transfers'}, {value: (counter?.value ?? 0) + 2});
	},
};

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

/**
 * ONE FOLD, as the host builds it: the state namespace named from the generation
 * identity, then the processor over it (ADR-0043, ADR-0053).
 */
function specFor(db: RemoteSQL, declared: EntityProcessor<typeof abi>) {
	return {
		createState: (context: {stream: string}) =>
			new VersionedStateStore(db, declared.entities, {
				tableNamespace: generationDigestOf({
					stream: context.stream,
					processor: entityProcessorVersionHash(declared),
				}),
				finalityDepth: FINALITY,
			}),
		createProcessor: (state: StateStore) =>
			new EntityEventProcessor<typeof abi>(state, declared, {
				finalityDepth: FINALITY,
			}) as unknown as EntityEventProcessor<typeof abi>,
	};
}

/**
 * A CONTAINER over this database: the incumbent as the opening fold, and the
 * emission stream both stored and re-read through the same handle.
 *
 * Called again and again in these tests, which is the point: every call is a new
 * object graph over the same durable rows, so what survives between them is
 * exactly what the store committed.
 */
async function openIndexer(
	db: RemoteSQL,
	options: {maxEmissionsPerChunk?: number} = {},
): Promise<ReceivingIndexer<typeof abi, unknown, StateStore>> {
	const dropState: SQLGenerationRegistryOptions['dropState'] = async (id) => {
		await new VersionedStateStore(db, nftEntities, {tableNamespace: generationDigestOf(id)}).drop();
	};
	return openReceivingIndexer({
		port: generationRegistryPortOnSQL(db, INDEXER, {dropState}),
		source: SOURCE,
		stream: {finality: FINALITY},
		appendEmissions: emissionAppenderFor(db, INDEXER),
		// THE READ COUNTERPART of the appender, over the same handle: this is what a
		// follower re-folds, and it is why the upgrade costs a local scan.
		replay: storedEmissionReplaySource(db, INDEXER),
		...(options.maxEmissionsPerChunk === undefined ? {} : {maxEmissionsPerChunk: options.maxEmissionsPerChunk}),
		generation: specFor(db, V1),
	}) as Promise<ReceivingIndexer<typeof abi, unknown, StateStore>>;
}

/** One decoded `Transfer`, carrying the REAL topics a stored row keeps, so a replay can decode it again. */
function transferEvent(
	blockNumber: number,
	blockHash: string,
	from: string,
	to: string,
	id: bigint,
): LogEvent<typeof abi> {
	// Built from the raw-log fixture rather than beside it: the stored row keeps
	// `topics` and `data` and nothing else, and a rebuild re-derives `args` from
	// them against the source running now (ADR-0034). A hand-written topic list
	// would let the two disagree without anything noticing.
	const raw: RawLog = transfer(blockNumber, blockHash, from, to, id);
	return {
		blockNumber: parseInt(raw.blockNumber.slice(2), 16),
		blockHash: raw.blockHash,
		blockTimestamp: parseInt(raw.blockTimestamp.slice(2), 16),
		transactionIndex: parseInt(raw.transactionIndex.slice(2), 16),
		removed: false,
		address: raw.address,
		data: raw.data,
		topics: raw.topics,
		transactionHash: raw.transactionHash,
		logIndex: parseInt(raw.logIndex.slice(2), 16),
		extra: undefined,
		eventName: 'Transfer',
		args: {from, to, id},
	} as unknown as LogEvent<typeof abi>;
}

async function push(
	indexer: ReceivingIndexer<typeof abi, unknown, StateStore>,
	over: {toBlock: number; latestBlock: number; logs?: LogEvent<typeof abi>[]},
): Promise<void> {
	const fromBlock = await indexer.ingestion.expectedFromBlock();
	const batch: WireBatch<typeof abi> = {
		context: indexer.ingestion.context,
		fromBlock,
		toBlock: over.toBlock,
		latestBlock: over.latestBlock,
		logs: (over.logs ?? []).map((event) => ({...event})),
	};
	await indexer.ingestion.receive(batch);
}

/** What a fold concluded, read back out of ONE generation's own table namespace. */
async function stateIn(db: RemoteSQL, namespace: string) {
	const store = new VersionedStateStore(db, nftEntities, {tableNamespace: namespace, finalityDepth: FINALITY});
	await store.migrate();
	const counter = await store.getCurrent<{value: number}>('counter', {name: 'transfers'});
	const owner = await store.getCurrent<{owner: string}>('nft', {tokenID: TOKEN});
	return {transfers: counter?.value ?? 0, owner: owner?.owner};
}

/**
 * WHAT A READ ANSWERS: the canonical pointer resolved to a table namespace.
 *
 * This is how a read tier answers on this runtime (ADR-0053) -- with no engine
 * and no processor -- which is exactly why the pointer is the only thing a
 * promotion has to move.
 */
async function canonicalAnswers(db: RemoteSQL, indexer: ReceivingIndexer<typeof abi, unknown, StateStore>) {
	const canonical = await indexer.canonical();
	if (!canonical) throw new Error('no canonical generation');
	return stateIn(db, generationDigestOf(canonical));
}

/** Every table this database holds, minus the ones SQLite made for itself. */
async function tablesIn(db: RemoteSQL): Promise<string[]> {
	const rows = await db
		.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
		.all<{name: string}>();
	return rows.results.map((row) => row.name);
}

/** The stored stream, byte for byte, so "the rebuild wrote nothing" is not a row count. */
async function streamSnapshot(db: RemoteSQL): Promise<string> {
	const emissions = (
		await db
			.prepare(
				`SELECT seq, removed, alive, blockNumber, blockHash, logIndex FROM ${EMISSION_STREAM_TABLE}
				 WHERE indexer = ?1 ORDER BY seq`,
			)
			.bind(INDEXER)
			.all()
	).results;
	const coverage = (
		await db
			.prepare(
				`SELECT startBlock, latestBlock, lastFromBlock, lastToBlock FROM ${STREAM_COVERAGE_TABLE} WHERE indexer = ?1`,
			)
			.bind(INDEXER)
			.all()
	).results;
	return JSON.stringify({emissions, coverage});
}

/**
 * A database an incumbent has folded into, over a history containing a REORG and
 * a QUIET range.
 *
 * The quiet range is not padding: it moves the fold's cursor from S+6 to S+10
 * while adding no row, so a successor that resumed off the ROWS rather than off
 * the stream's coverage claim would be permanently behind and never promoted.
 */
async function anIndexerThatHasFolded(db: RemoteSQL): Promise<ReceivingIndexer<typeof abi, unknown, StateStore>> {
	await applySchema(db);
	const incumbent = await openIndexer(db);
	// [S, S+5]: the history
	await push(incumbent, {
		toBlock: START_BLOCK + 5,
		latestBlock: START_BLOCK + 5,
		logs: [
			transferEvent(START_BLOCK + 1, '0xa1', ZERO, ALICE, 1n),
			transferEvent(START_BLOCK + 4, '0xa4', ALICE, CAROL, 1n),
		],
	});
	// [S+2, S+6]: block S+4 comes back with a different hash -- a contradiction, so
	// the dead block is retracted and the replacement applied
	await push(incumbent, {
		toBlock: START_BLOCK + 6,
		latestBlock: START_BLOCK + 6,
		logs: [
			transferEvent(START_BLOCK + 4, '0xb4', ALICE, BOB, 1n),
			transferEvent(START_BLOCK + 6, '0xa6', BOB, CAROL, 1n),
		],
	});
	// [S+3, S+10]: the window re-delivered unchanged and nothing new
	await push(incumbent, {
		toBlock: START_BLOCK + 10,
		latestBlock: START_BLOCK + 10,
		logs: [
			transferEvent(START_BLOCK + 4, '0xb4', ALICE, BOB, 1n),
			transferEvent(START_BLOCK + 6, '0xa6', BOB, CAROL, 1n),
		],
	});
	return incumbent;
}

/** What the incumbent computed: three surviving transfers, the last of them to Carol. */
const INCUMBENT_ANSWER = {transfers: 3, owner: CAROL};
/** The same logs under the upgraded fold, which counts each transfer twice. */
const SUCCESSOR_ANSWER = {transfers: 6, owner: CAROL};

// ---------------------------------------------------------------------------------------------------

describe('an upgraded processor catches up from disk while the old one keeps answering', () => {
	it('rebuilds to the incumbent`s position in bounded chunks, and moves the pointer ONCE at the end', async () => {
		const db = oneDatabase();
		const incumbent = await anIndexerThatHasFolded(db);
		expect(await canonicalAnswers(db, incumbent)).toEqual(INCUMBENT_ANSWER);
		const streamBefore = await streamSnapshot(db);

		const successor = await incumbent.add(specFor(db, V2));
		// DETERMINED by the stream and never configured (ADR-0044): the same fetch
		// filter, so the same stream, so a FOLLOWER with no receiver of its own
		expect(successor.follows).toBe(true);
		expect(successor.ingestion).toBeUndefined();
		expect(successor.writesStream).toBe(false);

		const reports: RebuildReport[] = [];
		const answersDuring: {transfers: number; owner: string | undefined}[] = [];
		let done = false;
		while (!done) {
			const [report] = await incumbent.rebuildMore({maxEmissions: 1});
			if (!report) throw new Error('no follower to advance');
			reports.push(report);
			done = report.complete;
			if (!done) answersDuring.push(await canonicalAnswers(db, incumbent));
		}

		// BOUNDED: more than one call, each of them reporting what it did and whether
		// it had finished -- the shape `prune` and `compactEmissionPairs` have
		expect(reports.length).toBeGreaterThan(1);
		expect(reports.slice(0, -1).every((report) => !report.complete)).toBe(true);
		expect(reports[reports.length - 1]).toMatchObject({complete: true, toBlock: START_BLOCK + 10});

		// SERVED THROUGHOUT: every read during the rebuild answered the incumbent, so
		// nobody ever observed partial state
		expect(answersDuring.length).toBeGreaterThan(0);
		for (const answer of answersDuring) {
			expect(answer).toEqual(INCUMBENT_ANSWER);
		}

		// AND THE POINTER MOVED, once, at the end
		expect(await canonicalAnswers(db, incumbent)).toEqual(SUCCESSOR_ANSWER);
		expect(await incumbent.canonical()).toMatchObject(successor.record);

		// A LOCAL SCAN AND NOT A RE-INDEX: the stored stream is untouched, byte for
		// byte, and this container never held a provider at all
		expect(await streamSnapshot(db)).toBe(streamBefore);
	});

	it('folds into its OWN tables and leaves the incumbent`s rows exactly as they were', async () => {
		const db = oneDatabase();
		const incumbent = await anIndexerThatHasFolded(db);
		const incumbentNamespace = generationDigestOf(incumbent.generation);
		const incumbentTables = (await tablesIn(db)).filter((name) => name.includes(incumbentNamespace));
		expect(incumbentTables.length).toBeGreaterThan(0);

		const successor = await incumbent.add(specFor(db, V2));
		const successorNamespace = generationDigestOf(successor.record);
		let done = false;
		while (!done) {
			const [report] = await incumbent.rebuildMore({maxEmissions: 1});
			done = !!report?.complete;
		}

		// two namespaces, sharing no table: a rebuild writes nowhere near the rows the
		// canonical generation answers from (ADR-0053)
		expect((await tablesIn(db)).filter((name) => name.includes(successorNamespace)).length).toBeGreaterThan(0);
		expect(incumbentTables.some((name) => name.includes(successorNamespace))).toBe(false);
		expect(await stateIn(db, incumbentNamespace)).toEqual(INCUMBENT_ANSWER);
		expect(await stateIn(db, successorNamespace)).toEqual(SUCCESSOR_ANSWER);
	});

	it('lands on the same state over a stream containing a REORG, which is a STATE comparison', async () => {
		const db = oneDatabase();
		const incumbent = await anIndexerThatHasFolded(db);
		const successor = await incumbent.add(specFor(db, V2));
		let done = false;
		while (!done) {
			const [report] = await incumbent.rebuildMore({maxEmissions: 1});
			done = !!report?.complete;
		}

		// The dead branch's transfer (Alice -> Carol at S+4, hash 0xa4) was retracted
		// and replaced by Alice -> Bob (0xb4). A rebuild that filtered the `removed`
		// rows out instead of WALKING them would have applied both branches, so the
		// count would be higher and the owner could be either. This is the fold, not
		// the row count: six is three surviving transfers under a doubling fold.
		expect(await stateIn(db, generationDigestOf(successor.record))).toEqual(SUCCESSOR_ANSWER);
	});
});

describe('resumability, through a genuinely FRESH container between every chunk', () => {
	it('resumes from the durable checkpoint after a kill, applying nothing twice and skipping nothing', async () => {
		const db = oneDatabase();
		const first = await anIndexerThatHasFolded(db);
		await first.add(specFor(db, V2));
		const successorNamespace = generationDigestOf({
			stream: first.streamDigest,
			processor: entityProcessorVersionHash(V2),
		});

		// ONE chunk, then the process is gone. Nothing in memory survives: the next
		// container opens a new registry, new stores and a new rebuild driver over the
		// same database.
		await first.rebuildMore({maxEmissions: 1});
		const killedAt = await stateIn(db, successorNamespace);
		expect(killedAt).not.toEqual(SUCCESSOR_ANSWER);

		let chunks = 1;
		let done = false;
		while (!done) {
			const revived = await openIndexer(db);
			await revived.add(specFor(db, V2));
			const [report] = await revived.rebuildMore({maxEmissions: 1});
			if (!report) throw new Error('no follower to advance');
			chunks++;
			done = report.complete;
			expect(chunks).toBeLessThan(20);
			if (!done) {
				// still the incumbent's answers, on every one of those fresh containers
				expect(await canonicalAnswers(db, revived)).toEqual(INCUMBENT_ANSWER);
			}
		}

		expect(chunks).toBeGreaterThan(1);
		expect(await stateIn(db, successorNamespace)).toEqual(SUCCESSOR_ANSWER);
		// and a restart after the move comes back pointing where it last pointed
		const restarted = await openIndexer(db);
		expect(await canonicalAnswers(db, restarted)).toEqual(SUCCESSOR_ANSWER);
	});

	it('costs one read and changes nothing once level, whatever drives it', async () => {
		const db = oneDatabase();
		const incumbent = await anIndexerThatHasFolded(db);
		await incumbent.add(specFor(db, V2));
		let done = false;
		while (!done) {
			const [report] = await incumbent.rebuildMore({maxEmissions: 1});
			done = !!report?.complete;
		}
		const streamAfter = await streamSnapshot(db);

		const level = await openIndexer(db);
		await level.add(specFor(db, V2));
		const [again] = await level.rebuildMore();

		expect(again).toMatchObject({complete: true, replayed: 0});
		expect(await canonicalAnswers(db, level)).toEqual(SUCCESSOR_ANSWER);
		expect(await streamSnapshot(db)).toBe(streamAfter);
	});
});

describe('after the move: the retired generation is RETAINED, keeps folding, and keeps writing', () => {
	async function anUpgradedIndexer(db: RemoteSQL) {
		const incumbent = await anIndexerThatHasFolded(db);
		const successor = await incumbent.add(specFor(db, V2));
		let done = false;
		while (!done) {
			const [report] = await incumbent.rebuildMore({maxEmissions: 1});
			done = !!report?.complete;
		}
		return {incumbent, successor};
	}

	it('still holds its own state and still answers, so the way back is a pointer move', async () => {
		const db = oneDatabase();
		const {incumbent, successor} = await anUpgradedIndexer(db);

		// both registered, and the retired one's rows are untouched -- which is what
		// makes moving the pointer BACK a revert rather than a re-index
		expect((await incumbent.generations()).map((record) => record.processor)).toEqual([
			incumbent.generation.processor,
			successor.record.processor,
		]);
		expect(await stateIn(db, generationDigestOf(incumbent.generation))).toEqual(INCUMBENT_ANSWER);

		await incumbent.promote(incumbent.generation);
		expect(await canonicalAnswers(db, incumbent)).toEqual(INCUMBENT_ANSWER);
		// and the pointer does not bounce forward again on the next chunk: a
		// reverted-from successor is caught up by construction (ADR-0046)
		await incumbent.rebuildMore();
		expect(await canonicalAnswers(db, incumbent)).toEqual(INCUMBENT_ANSWER);
	});

	it('KEEPS FOLDING, and the append duty does not move with the pointer', async () => {
		const db = oneDatabase();
		const {incumbent, successor} = await anUpgradedIndexer(db);

		// the writer is the OLDEST SURVIVING generation on the stream, registration
		// order and never the canonical pointer (ADR-0044), so promotion does not hand
		// the append duty to a different engine mid-flight
		expect((await incumbent.registry.writerOf(incumbent.streamDigest))?.processor).toBe(incumbent.generation.processor);
		expect(incumbent.writesStream).toBe(true);
		expect((await incumbent.liveIngestions()).map((live) => live.streamDigest)).toEqual([incumbent.streamDigest]);

		await push(incumbent, {
			toBlock: START_BLOCK + 20,
			latestBlock: START_BLOCK + 20,
			logs: [transferEvent(START_BLOCK + 14, '0xa14', CAROL, ALICE, 1n)],
		});

		// the RETIRED generation folded it -- a frozen one would answer stale data the
		// instant the pointer was moved back to it...
		expect(await stateIn(db, generationDigestOf(incumbent.generation))).toEqual({transfers: 4, owner: ALICE});
		// ...and the promoted successor FOLLOWS the same stream, still fetching nothing
		await incumbent.rebuildMore();
		expect(await stateIn(db, generationDigestOf(successor.record))).toEqual({transfers: 8, owner: ALICE});
		expect(await canonicalAnswers(db, incumbent)).toEqual({transfers: 8, owner: ALICE});
	});
});
