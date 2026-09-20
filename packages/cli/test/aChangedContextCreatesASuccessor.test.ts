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
	streamCursorSourceOn,
	storedEmissionReplaySource,
	GENERATION_TABLE,
	generationRegistryPortOnSQL,
	type SQLGenerationRegistryOptions,
} from '@etherfold/server';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import {createClient} from '@libsql/client';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {describe, expect, it} from 'vitest';
import {
	abi,
	addressTopic,
	CONTRACT,
	nftProcessor,
	SOURCE,
	START_BLOCK,
	timestampOf,
	TRANSFER_TOPIC,
	ZERO,
	ALICE,
	BOB,
} from './utils/chain.js';
import {identityOf} from './utils/processorIdentity.js';
import {generationStateSeamsOn} from './utils/generationState.js';

// ---------------------------------------------------------------------------------------------------
// THE OUTAGE, REMOVED ON A REAL DATABASE: A CHANGED CONTEXT CREATES A SUCCESSOR
// ---------------------------------------------------------------------------------------------------
// `packages/core/test/receivingContainer.test.ts` asserts the CONTRACT over the
// reference substrate. This file asserts the two halves the core cannot see,
// because `@etherfold/core` depends on no database:
//
//  - the generation is recorded DURABLY -- rows in `_generations` and
//    `_generation_slots` that a restart comes back holding (ADR-0054), and
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

/**
 * The same processor as two ARRIVALS: the SAME logs, a DIFFERENT fold.
 *
 * What makes them two folds is the identity their arrival derived (ADR-0086) --
 * the hash of the bytes each was read as -- and not a field the author bumped.
 * The declared object is shared between them precisely to say so: nothing about
 * `nftProcessor` distinguishes the two, and the registry still files two
 * generations.
 */
const V1 = {declared: nftProcessor as EntityProcessor<typeof abi>, identity: identityOf('the-incumbent-fold')};
const V2 = {declared: nftProcessor as EntityProcessor<typeof abi>, identity: identityOf('the-successor-fold')};

function oneDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

/**
 * The HOST ASSEMBLY: a named indexer's database, the fold it runs, and the caps
 * it states.
 *
 * The state factory names its TABLE NAMESPACE from the generation identity, and
 * it can do so BEFORE the processor exists because both halves are computable up
 * front (ADR-0053): the stream digest is handed to the factory, and the fold half
 * is the identity the ARRIVAL supplied, which is a value this host already holds
 * -- so the namespace, the registry record and the fold all answer to one string
 * that no two of them could spell differently.
 */
async function openIndexer(
	db: RemoteSQL,
	fold: {declared: EntityProcessor<typeof abi>; identity: string},
	options: {caps?: {maxGenerations: number; maxStreams: number}} = {},
): Promise<ReceivingIndexer<typeof abi, unknown, WritableStateStore>> {
	const {declared, identity} = fold;
	// BOTH state seams, under the namespace convention `openFolding` uses: the DROP
	// of a generation's namespace, and the READ of how far the fold in it got -- which
	// is what the promotion trigger compares, with no engine and for a generation this
	// process may hold no fold for.
	const state = generationStateSeamsOn(db, declared.entities);
	return openReceivingIndexer({
		port: generationRegistryPortOnSQL(db, INDEXER, state),
		...(options.caps ? {caps: options.caps} : {}),
		source: SOURCE,
		stream: {finality: FINALITY},
		appendEmissions: emissionAppenderFor(db, INDEXER),
		streamCursor: streamCursorSourceOn(db, INDEXER),
		replay: storedEmissionReplaySource(db, INDEXER),
		generation: {
			// CLAIMED, because this fold WRITES: the ability to mutate is obtained by
			// claiming (ADR-0077), exactly as the CLI's own `buildFolding` does it.
			createState: (context) =>
				openForWriting(
					new VersionedStateStore(db, declared.entities, {
						tableNamespace: generationDigestOf({stream: context.stream, processor: identity}),
						finalityDepth: FINALITY,
					}),
				),
			createProcessor: (state: WritableStateStore) =>
				new EntityEventProcessor<typeof abi>(state, declared, {
					finalityDepth: FINALITY,
				}) as unknown as EntityEventProcessor<typeof abi>,
			processorIdentity: identity,
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
		// REAL TOPICS, so a REPLAY can `reparse` this row. It used to be `topics: []`
		// with a pre-decoded `args`, which was enough while a fold was fed by the WIRE:
		// the decoded half arrived with the batch. Since ADR-0087 every generation
		// advances by re-folding the stream the deployment STORED, and a stored row
		// carries the raw log alone (`args` is what SOME ABI made of those bytes,
		// ADR-0034) -- so a fixture with no `topic0` is one no fold can decode.
		topics: [TRANSFER_TOPIC, addressTopic(from), addressTopic(to), `0x${id.toString(16).padStart(64, '0')}`],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}`,
		logIndex: 0,
		extra: undefined,
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

/**
 * Carry every fold this container holds to the end of the stream as it stands.
 *
 * Since ADR-0087 no generation fetches: the deployment appends to the stream and
 * every generation READS it, taking each delta live where it is level and reading
 * the rows back where it is behind. A fold that comes up behind -- a successor over
 * a database that already holds the history -- therefore advances by re-folding,
 * and a caller that wants it level says so.
 */
async function rebuildToLevel(indexer: ReceivingIndexer<typeof abi, unknown, WritableStateStore>): Promise<void> {
	for (let guard = 0; guard < 50; guard++) {
		const reports = await indexer.rebuildMore();
		if (reports.every((report) => report.complete)) return;
	}
	throw new Error('the rebuild never reported itself complete');
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

		// the upgrade: same source, same stream config, a different fold. It is a new
		// DEPLOYMENT over the same rows, so it fetches from where the STREAM reaches --
		// not from `START_BLOCK`, which is where its own empty state would have said
		// (ADR-0087). Asking for that range is now a refusal, so the position is read
		// rather than written into the test.
		const successor = await openIndexer(db, V2);
		expect(await successor.ingestion.expectedFromBlock()).toBeGreaterThan(START_BLOCK);
		await successor.ingestion.receive(
			batch(successor, {
				fromBlock: await successor.ingestion.expectedFromBlock(),
				toBlock: START_BLOCK + 120,
				latestBlock: START_BLOCK + 120,
			}),
		);
		// STORY 2: the canonical generation's state is untouched, and while the successor
		// is still catching up it is still the one the pointer names
		expect(await stateOf(incumbent.state)).toEqual(before);
		expect(await successor.canonical()).toMatchObject(incumbent.generation);

		// the successor was BEHIND the stream, so it declined the delta and its rebuild
		// is what carries it over the history the incumbent already fetched
		await rebuildToLevel(successor);

		// and the successor folded into its OWN tables, off the stored stream, having
		// re-fetched nothing -- then the default policy promoted it, because it is level
		expect(await stateOf(successor.state)).toEqual({transfers: 1, owner: ALICE});
		expect(await stateOf(incumbent.state)).toEqual(before);
		expect(await successor.canonical()).toMatchObject(successor.generation);
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
		const stored = await emissionRows(db);
		expect(stored).toBe(1);

		const successor = await openIndexer(db, V2);
		// the SAME range the incumbent already stored, re-offered: the position comes
		// from the stream, so the deployment reaches back over the reorg window and no
		// further -- and the log it re-delivers is one the stream already holds.
		await successor.ingestion.receive(
			batch(successor, {
				fromBlock: await successor.ingestion.expectedFromBlock(),
				toBlock: START_BLOCK + 120,
				latestBlock: START_BLOCK + 120,
			}),
		);
		await rebuildToLevel(successor);

		// ADR-0052/ADR-0087: the stream is ONE history, re-folded by every generation on
		// it and written by the DEPLOYMENT. A fold that appended what it re-folded would
		// store it twice, and the duplicate would be indistinguishable from a real second
		// emission -- which cannot happen, because no fold has an appender at all.
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
			batch(successor, {
				fromBlock: await successor.ingestion.expectedFromBlock(),
				toBlock: START_BLOCK + 120,
				latestBlock: START_BLOCK + 120,
			}),
		);
		await rebuildToLevel(successor);

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
			processor: V2.identity,
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
