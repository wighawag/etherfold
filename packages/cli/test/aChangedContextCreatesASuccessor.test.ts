import {
	GenerationCapReachedError,
	generationDigestOf,
	openReceivingIndexer,
	resolveStreamConfig,
	streamDigestOf,
	type LogEvent,
	type ReceivingIndexer,
	type WireBatch,
} from '@etherfold/core';
import {
	entityProcessorVersionHash,
	EntityEventProcessor,
	type EntityProcessor,
	openForWriting,
	type StateStore,
	type WritableStateStore,
} from '@etherfold/processor-entities';
import {
	applySchema,
	EMISSION_STREAM_TABLE,
	emissionAppenderFor,
	GENERATION_TABLE,
	generationRegistryPortOnSQL,
	type SQLGenerationRegistryOptions,
} from '@etherfold/server';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import {createClient} from '@libsql/client';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {describe, expect, it} from 'vitest';
import {abi, CONTRACT, nftProcessor, SOURCE, START_BLOCK, timestampOf, ZERO, ALICE, BOB} from './utils/chain.js';

// ---------------------------------------------------------------------------------------------------
// THE OUTAGE, REMOVED ON A REAL DATABASE: A CHANGED CONTEXT CREATES A SUCCESSOR
// ---------------------------------------------------------------------------------------------------
// `packages/core/test/receivingContainer.test.ts` asserts the CONTRACT over the
// reference substrate. This file asserts the two halves the core cannot see,
// because `@etherfold/core` depends on no database:
//
//  - the generation is recorded DURABLY -- rows in `_generations` and
//    `_generation_pointer` that a restart comes back holding (ADR-0054), and
//  - its state lands in its OWN TABLE NAMESPACE (ADR-0053), so nothing is
//    written into the tables or the cursor the canonical generation answers
//    from.
//
// This package is where that database is actually shared: ONE libSQL handle
// carries the server's fixed tables, the stored emission stream and every
// generation's state at once, which is the shape `run`, `build` and `index`
// have. THE COMMANDS NOW FOLD THROUGH EXACTLY THIS ASSEMBLY, which lives in
// `src/folding.ts` (`openFolding`); it is written out again here on purpose, so
// that the CONTAINER is asserted over the real substrate with no command's
// configuration, chain or HTTP surface in the way -- two processors at two
// versions is a thing a test can arrange directly and a command line cannot.
// ---------------------------------------------------------------------------------------------------

const INDEXER = 'alpha';
const FINALITY = 3;

/** The same processor at two versions: the SAME logs, a DIFFERENT fold. */
const V1: EntityProcessor<typeof abi> = nftProcessor;
const V2: EntityProcessor<typeof abi> = {...nftProcessor, version: '2.0.0'};

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

/**
 * The HOST ASSEMBLY: a named indexer's database, the fold it runs, and the caps
 * it states.
 *
 * The state factory names its TABLE NAMESPACE from the generation identity, and
 * it can do so BEFORE the processor exists because both halves are computable up
 * front (ADR-0053): the stream digest is handed to the factory, and
 * `entityProcessorVersionHash` is the very function `getVersionHash()` answers
 * with -- so the namespace and the identity the container OBSERVES afterwards
 * cannot disagree.
 */
async function openIndexer(
	db: RemoteSQL,
	declared: EntityProcessor<typeof abi>,
	options: {caps?: {maxGenerations: number; maxStreams: number}} = {},
): Promise<ReceivingIndexer<typeof abi, unknown, WritableStateStore>> {
	const dropState: SQLGenerationRegistryOptions['dropState'] = async (id) => {
		await new VersionedStateStore(db, declared.entities, {tableNamespace: generationDigestOf(id)}).drop();
	};
	return openReceivingIndexer({
		port: generationRegistryPortOnSQL(db, INDEXER, {dropState}),
		...(options.caps ? {caps: options.caps} : {}),
		source: SOURCE,
		stream: {finality: FINALITY},
		appendEmissions: emissionAppenderFor(db, INDEXER),
		generation: {
			// CLAIMED, because this fold WRITES: the ability to mutate is obtained by
			// claiming (ADR-0077), exactly as the CLI's own `buildFolding` does it.
			createState: (context) =>
				openForWriting(
					new VersionedStateStore(db, declared.entities, {
						tableNamespace: generationDigestOf({
							stream: context.stream,
							processor: entityProcessorVersionHash(declared),
						}),
						finalityDepth: FINALITY,
					}),
				),
			createProcessor: (state: WritableStateStore) =>
				new EntityEventProcessor<typeof abi>(state, declared, {
					finalityDepth: FINALITY,
				}) as unknown as EntityEventProcessor<typeof abi>,
		},
	}) as Promise<ReceivingIndexer<typeof abi, unknown, WritableStateStore>>;
}

let logCounter = 0;

/** One decoded `Transfer`, as the fetching half hands it over. */
function transferEvent(
	blockNumber: number,
	blockHash: string,
	from: string,
	to: string,
	id: bigint,
): LogEvent<typeof abi> {
	logCounter++;
	return {
		blockNumber,
		blockHash,
		blockTimestamp: timestampOf(blockNumber),
		transactionIndex: 0,
		removed: false,
		address: CONTRACT,
		data: '0x',
		topics: [],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}`,
		logIndex: 0,
		extra: undefined,
		eventName: 'Transfer',
		args: {from, to, id},
	} as unknown as LogEvent<typeof abi>;
}

function batch(
	indexer: ReceivingIndexer<typeof abi, unknown, WritableStateStore>,
	over: {fromBlock: number; toBlock: number; latestBlock: number; logs?: LogEvent<typeof abi>[]},
): WireBatch<typeof abi> {
	return {
		context: indexer.ingestion.context,
		fromBlock: over.fromBlock,
		toBlock: over.toBlock,
		latestBlock: over.latestBlock,
		logs: over.logs ?? [],
	};
}

/** What a fold concluded, read back through the store it wrote. */
async function stateOf(store: StateStore) {
	const counter = await store.getCurrent<{value: number}>('counter', {name: 'transfers'});
	const owner = await store.getCurrent<{owner: string}>('nft', {tokenID: '1'.padStart(78, '0')});
	return {transfers: counter?.value ?? 0, owner: owner?.owner};
}

/** How many rows the stored emission stream holds, under this name. */
async function emissionRows(db: RemoteSQL): Promise<number> {
	const rows = await db
		.prepare(`SELECT COUNT(*) AS records FROM ${EMISSION_STREAM_TABLE} WHERE indexer = ?1`)
		.bind(INDEXER)
		.all<{records: number}>();
	return Number(rows.results[0]?.records ?? 0);
}

/** Every table this database holds, minus the ones SQLite made for itself. */
async function tablesIn(db: RemoteSQL): Promise<string[]> {
	const rows = await db
		.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
		.all<{name: string}>();
	return rows.results.map((row) => row.name);
}

/** A database that has been folded by V1 up to the tip, exactly as a deployment leaves one. */
async function anIndexerThatHasFolded(db: RemoteSQL) {
	await applySchema(db);
	const incumbent = await openIndexer(db, V1);
	await incumbent.ingestion.receive(
		batch(incumbent, {
			fromBlock: START_BLOCK,
			toBlock: START_BLOCK + 100,
			latestBlock: START_BLOCK + 100,
			logs: [transferEvent(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n)],
		}),
	);
	return incumbent;
}

describe('an upgraded fold against a database another fold wrote', () => {
	it('registers a SUCCESSOR durably and leaves the canonical generation answering', async () => {
		const db = oneDatabase();
		const incumbent = await anIndexerThatHasFolded(db);
		const before = await stateOf(incumbent.state);
		expect(before).toEqual({transfers: 1, owner: ALICE});

		// the upgrade: same source, same stream config, a different fold
		const successor = await openIndexer(db, V2);
		await successor.ingestion.receive(
			batch(successor, {
				fromBlock: START_BLOCK,
				toBlock: START_BLOCK + 20,
				latestBlock: START_BLOCK + 100,
				logs: [transferEvent(START_BLOCK + 10, '0xa10', ZERO, BOB, 1n)],
			}),
		);

		// STORY 2: the canonical generation's state is untouched, and it is still the
		// one the pointer names
		expect(await stateOf(incumbent.state)).toEqual(before);
		expect(await successor.canonical()).toMatchObject(incumbent.generation);

		// and the successor folded into its OWN tables
		expect(await stateOf(successor.state)).toEqual({transfers: 1, owner: BOB});
		expect(successor.generation).not.toEqual(incumbent.generation);
		expect(successor.streamDigest).toBe(incumbent.streamDigest);

		// DURABLY: two rows, not two objects
		const rows = await db
			.prepare(`SELECT processor FROM ${GENERATION_TABLE} WHERE indexer = ?1 ORDER BY createdAt`)
			.bind(INDEXER)
			.all<{processor: string}>();
		expect(rows.results.map((row) => row.processor)).toEqual([
			incumbent.generation.processor,
			successor.generation.processor,
		]);
	});

	it('does NOT append the stream a second time: only the writer of a stream stores it', async () => {
		const db = oneDatabase();
		const incumbent = await anIndexerThatHasFolded(db);
		expect(incumbent.writesStream).toBe(true);
		const stored = await emissionRows(db);
		expect(stored).toBe(1);

		const successor = await openIndexer(db, V2);
		expect(successor.writesStream).toBe(false);
		await successor.ingestion.receive(
			batch(successor, {
				fromBlock: START_BLOCK,
				toBlock: START_BLOCK + 20,
				latestBlock: START_BLOCK + 100,
				logs: [transferEvent(START_BLOCK + 10, '0xa10', ZERO, BOB, 1n)],
			}),
		);

		// ADR-0052: the stream is ONE history, re-folded by every generation on it. A
		// successor that appended what it re-folded would store it twice, and the
		// duplicate would be indistinguishable from a real second emission.
		expect(await emissionRows(db)).toBe(stored);
	});

	it('gives the successor its own tables and writes nothing into the incumbent`s', async () => {
		const db = oneDatabase();
		const incumbent = await anIndexerThatHasFolded(db);
		const incumbentTables = (await tablesIn(db)).filter((name) =>
			name.includes(generationDigestOf(incumbent.generation)),
		);
		expect(incumbentTables.length).toBeGreaterThan(0);

		const successor = await openIndexer(db, V2);
		await successor.ingestion.receive(
			batch(successor, {fromBlock: START_BLOCK, toBlock: START_BLOCK + 20, latestBlock: START_BLOCK + 100}),
		);

		const successorNamespace = generationDigestOf(successor.generation);
		const tables = await tablesIn(db);
		expect(tables.filter((name) => name.includes(successorNamespace)).length).toBeGreaterThan(0);
		// the two namespaces share no table, so a successor cannot reach the cursor
		// the canonical generation resumes from
		expect(incumbentTables.some((name) => name.includes(successorNamespace))).toBe(false);
	});

	it('comes back holding the same generations, with the same canonical one, after a restart', async () => {
		const db = oneDatabase();
		const incumbent = await anIndexerThatHasFolded(db);
		await openIndexer(db, V2);

		// a restart is a new container over the same rows
		const restarted = await openIndexer(db, V2);
		expect((await restarted.generations()).map((record) => record.processor)).toEqual([
			incumbent.generation.processor,
			restarted.generation.processor,
		]);
		expect(await restarted.canonical()).toMatchObject(incumbent.generation);
		// and the generation the pointer names still answers what it answered
		expect(await stateOf(incumbent.state)).toEqual({transfers: 1, owner: ALICE});
	});

	it('resolves the same fold a second time rather than writing a second row', async () => {
		const db = oneDatabase();
		await anIndexerThatHasFolded(db);
		const again = await openIndexer(db, V1);
		await again.ingestion.expectedFromBlock();

		const rows = await db
			.prepare(`SELECT COUNT(*) AS records FROM ${GENERATION_TABLE} WHERE indexer = ?1`)
			.bind(INDEXER)
			.all<{records: number}>();
		expect(Number(rows.results[0]?.records)).toBe(1);
	});
});

describe('at the cap', () => {
	it('REFUSES the successor, names what to delete, and registers nothing', async () => {
		const db = oneDatabase();
		const incumbent = await anIndexerThatHasFolded(db);
		const tablesBefore = await tablesIn(db);

		const refused = openIndexer(db, V2, {caps: {maxGenerations: 1, maxStreams: 1}});
		await expect(refused).rejects.toBeInstanceOf(GenerationCapReachedError);
		await expect(refused).rejects.toThrow(/Delete one of these first/);

		// no orphan record: what makes a generation EXIST is the registry row, and the
		// refusal is before it
		const rows = await db
			.prepare(`SELECT processor FROM ${GENERATION_TABLE} WHERE indexer = ?1`)
			.bind(INDEXER)
			.all<{processor: string}>();
		expect(rows.results.map((row) => row.processor)).toEqual([incumbent.generation.processor]);
		// The refused generation's namespace DOES exist, and that is the price of the
		// claim being explicit: `createState` claims (ADR-0077) and claiming migrates,
		// while the cap is enforced one step later, when the record is written -- because
		// the record needs the processor's version hash, which needs the processor, which
		// needs the state (ADR-0043). So a refusal costs the DDL of a namespace it can
		// never fill, plus the claim row inside it. It is reused verbatim if the operator
		// raises the bound (the namespace is a digest of the identity, not a fresh name),
		// nothing reads it while no record names it, and dropping a generation still drops
		// exactly its own tables. What must hold is that it carries no STATE:
		const added = (await tablesIn(db)).filter((table) => !tablesBefore.includes(table));
		const namespace = generationDigestOf({
			stream: streamDigestOf(SOURCE, resolveStreamConfig({finality: FINALITY})),
			processor: entityProcessorVersionHash(V2),
		});
		expect(added.length).toBeGreaterThan(0);
		expect(added.every((table) => table.includes(namespace))).toBe(true);
		for (const table of added) {
			const rows = await db.prepare(`SELECT COUNT(*) AS records FROM "${table}"`).all<{records: number}>();
			// the one row anywhere in it is the CLAIM the open took, in the writer table the
			// guard keeps its token in (ADR-0075); every other table is untouched.
			expect(Number(rows.results[0]?.records), table).toBe(table.endsWith('_writer') ? 1 : 0);
		}
		// and the incumbent still answers
		expect(await stateOf(incumbent.state)).toEqual({transfers: 1, owner: ALICE});
	});

	it('creates the successor once the host raises the bound past it', async () => {
		const db = oneDatabase();
		await anIndexerThatHasFolded(db);
		const successor = await openIndexer(db, V2, {caps: {maxGenerations: 2, maxStreams: 1}});
		expect((await successor.generations()).length).toBe(2);
		expect(successor.caps).toEqual({maxGenerations: 2, maxStreams: 1});
	});
});
