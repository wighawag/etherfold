import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createClient} from '@libsql/client';
import {
	GenerationCapReachedError,
	GenerationIsCanonicalError,
	openGenerationRegistry,
	type GenerationId,
} from '@etherfold/core';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL, SQLPreparedStatement} from 'remote-sql';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
	GENERATION_SLOT_TABLE,
	GENERATION_TABLE,
	appendEmissions,
	applySchema,
	generationRegistryPortOnSQL,
	openGenerationRegistryOnSQL,
	readStreamCoverage,
} from '../src/index.js';
import {bundleBytes, identityOf, identityOfBytes} from './utils/processorIdentity.js';

// ---------------------------------------------------------------------------
// THE GENERATION REGISTRY, WHERE IT BECOMES ROWS
// ---------------------------------------------------------------------------
// The RULES are asserted in `@etherfold/core` over a memory port, and are not
// re-asserted here in general: what is asserted HERE is everything only a SQL
// substrate can get wrong.
//
//  - the records and the canonical pointer really are rows, keyed on the NAMED
//    INDEXER, so a second handle on the same database comes back holding what
//    the first one held and pointing where it last pointed;
//  - a commit is ATOMIC over a seam that is `prepare` + `batch` and nothing
//    else, so a cap decided from a state a second writer then changed is a
//    RETRY and never a lost update (ADR-0054);
//  - the streams the sweep compares against are the ones physically present in
//    `_emissions`, and dropping a subtree reaches exactly one stream of one
//    named indexer.
//
// NOTHING INDEXES OR FOLDS in this file, and the port has no operation with
// which it could. A bookkeeping mistake here is what silently costs a re-index
// later, which is why it is asserted at this seam rather than through a server.
// ---------------------------------------------------------------------------

const INDEXER = 'main';
const OTHER_INDEXER = 'other';
const STREAM_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const STREAM_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const STREAM_C = 'cccccccccccccccccccccccccccccccc';
const PROC_A = 'processor-a';
const PROC_B = 'processor-b';
const CAPS = {maxGenerations: 4, maxStreams: 2};

const idOf = (stream: string, processor: string): GenerationId => ({stream, processor});

const temporaries: string[] = [];

afterEach(() => {
	vi.useRealTimers();
	for (const directory of temporaries.splice(0)) {
		rmSync(directory, {recursive: true, force: true});
	}
});

async function freshDB(): Promise<RemoteSQL> {
	const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
	await applySchema(db);
	return db;
}

/**
 * A database in a FILE, so a second handle is a second connection to the same
 * bytes -- which is what "a restarted process" means here.
 */
function onDisk(): {open: () => Promise<RemoteSQL>} {
	const directory = mkdtempSync(join(tmpdir(), 'etherfold-generations-'));
	temporaries.push(directory);
	const url = `file:${join(directory, 'indexer.db')}`;
	return {
		async open() {
			const db: RemoteSQL = new RemoteLibSQL(createClient({url}));
			await applySchema(db);
			return db;
		},
	};
}

async function rowsOf<T>(db: RemoteSQL, sql: string, ...args: unknown[]): Promise<T[]> {
	return (
		await db
			.prepare(sql)
			.bind(...args)
			.all<T>()
	).results;
}

const generationRows = (db: RemoteSQL, indexer = INDEXER) =>
	rowsOf<{indexer: string; stream: string; processor: string; createdAt: number}>(
		db,
		`SELECT indexer, stream, processor, createdAt FROM ${GENERATION_TABLE} WHERE indexer = ?1 ORDER BY createdAt, stream, processor`,
		indexer,
	);

/** The SLOT row, projected onto the one slot these cases are about: `canonical`. */
const pointerRows = (db: RemoteSQL) =>
	rowsOf<{indexer: string; stream: string | null; processor: string | null; revision: string}>(
		db,
		`SELECT indexer, canonicalStream AS stream, canonicalProcessor AS processor, revision
		 FROM ${GENERATION_SLOT_TABLE} ORDER BY indexer`,
	);

/** One emission row, so a stream has a SUBTREE the sweep and the reap can see. */
async function writeStream(db: RemoteSQL, indexer: string, stream: string, blockNumber = 100) {
	await appendEmissions(db, {
		indexer,
		stream,
		// a real append carries the stream's coverage claim beside its rows; the
		// registry does not read it, so the shape is what matters here and not the
		// numbers
		coverage: {
			source: [],
			config: 'config',
			latestBlock: blockNumber,
			lastFromBlock: blockNumber,
			lastToBlock: blockNumber,
		},
		emissions: [
			{
				blockNumber,
				blockHash: `0x${blockNumber.toString(16)}` as const,
				logIndex: 0,
				transactionHash: `0xtx${blockNumber}` as const,
				transactionIndex: 0,
				address: '0x0000000000000000000000000000000000000099',
				topics: ['0xdead'],
				data: '0x',
				removed: false,
			},
		],
	});
}

const emissionCount = async (db: RemoteSQL, indexer: string, stream: string) =>
	Number(
		(
			await rowsOf<{records: number}>(
				db,
				`SELECT COUNT(*) AS records FROM _emissions WHERE indexer = ?1 AND stream = ?2`,
				indexer,
				stream,
			)
		)[0]?.records ?? 0,
	);

describe('the registry records and the canonical pointer are rows', () => {
	it('registers a generation under the named indexer, and points at the first one', async () => {
		const db = await freshDB();
		const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: CAPS});

		const record = await registry.create(idOf(STREAM_A, PROC_A));

		expect(await generationRows(db)).toEqual([
			{indexer: INDEXER, stream: STREAM_A, processor: PROC_A, createdAt: record.createdAt},
		]);
		expect(await pointerRows(db)).toEqual([
			{indexer: INDEXER, stream: STREAM_A, processor: PROC_A, revision: expect.any(String)},
		]);
		expect(await registry.canonical()).toEqual(record);
	});

	it('RESOLVES a generation already registered rather than writing a second row', async () => {
		const db = await freshDB();
		const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: CAPS});

		const first = await registry.create(idOf(STREAM_A, PROC_A));
		const again = await registry.create(idOf(STREAM_A, PROC_A));

		expect(again).toEqual(first);
		expect(await generationRows(db)).toHaveLength(1);
	});

	it('is SCOPED to one named indexer: two names in one database never see each other', async () => {
		const db = await freshDB();
		const mine = await openGenerationRegistryOnSQL(db, INDEXER, {caps: CAPS});
		const theirs = await openGenerationRegistryOnSQL(db, OTHER_INDEXER, {caps: CAPS});

		await mine.create(idOf(STREAM_A, PROC_A));
		await theirs.create(idOf(STREAM_B, PROC_B));

		expect(await mine.list()).toEqual([expect.objectContaining({stream: STREAM_A, processor: PROC_A})]);
		expect(await theirs.list()).toEqual([expect.objectContaining({stream: STREAM_B, processor: PROC_B})]);
		expect((await pointerRows(db)).map((row) => [row.indexer, row.stream])).toEqual([
			[INDEXER, STREAM_A],
			[OTHER_INDEXER, STREAM_B],
		]);
	});

	it('moves the pointer, and leaves it where it is when a write does not carry one', async () => {
		const db = await freshDB();
		const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: CAPS});

		const first = await registry.create(idOf(STREAM_A, PROC_A));
		const successor = await registry.create(idOf(STREAM_A, PROC_B));
		// creating a successor writes a record and carries NO canonical
		expect(await registry.canonical()).toEqual(first);

		await registry.moveCanonicalTo(successor);
		expect(await registry.canonical()).toEqual(successor);

		// and the revert is the same one small write, backwards
		await registry.moveCanonicalTo(first);
		expect(await registry.canonical()).toEqual(first);
	});
});

describe('the rules the other substrates pass, over SQL', () => {
	it('REFUSES at the generation cap, evicts nothing, and names what could be deleted', async () => {
		const db = await freshDB();
		const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: {maxGenerations: 2, maxStreams: 2}});
		const canonical = await registry.create(idOf(STREAM_A, PROC_A));
		const spare = await registry.create(idOf(STREAM_A, PROC_B));

		const refusal = await registry.create(idOf(STREAM_B, PROC_A)).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(GenerationCapReachedError);
		expect((refusal as GenerationCapReachedError).cap).toBe('maxGenerations');
		expect((refusal as GenerationCapReachedError).candidates).toEqual([idOf(spare.stream, spare.processor)]);
		// nothing evicted, and nothing written for the refused generation
		expect((await generationRows(db)).map((row) => row.processor)).toEqual([canonical.processor, spare.processor]);
	});

	it('REFUSES at the stream cap', async () => {
		const db = await freshDB();
		const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: {maxGenerations: 4, maxStreams: 1}});
		await registry.create(idOf(STREAM_A, PROC_A));

		await expect(registry.create(idOf(STREAM_B, PROC_A))).rejects.toBeInstanceOf(GenerationCapReachedError);
		expect(await generationRows(db)).toHaveLength(1);
	});

	it('REFUSES to delete the canonical generation', async () => {
		const db = await freshDB();
		const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: CAPS});
		const canonical = await registry.create(idOf(STREAM_A, PROC_A));

		await expect(registry.deleteGeneration(canonical)).rejects.toBeInstanceOf(GenerationIsCanonicalError);
		expect(await generationRows(db)).toHaveLength(1);
	});

	it('deletes a generation, dropping the state store the host named', async () => {
		const db = await freshDB();
		const dropped: GenerationId[] = [];
		const registry = await openGenerationRegistryOnSQL(db, INDEXER, {
			caps: CAPS,
			dropState: async (id) => {
				dropped.push(id);
			},
		});
		await registry.create(idOf(STREAM_A, PROC_A));
		const successor = await registry.create(idOf(STREAM_A, PROC_B));

		const deletion = await registry.deleteGeneration(successor);

		expect(deletion.generation).toEqual(successor);
		expect(dropped).toEqual([idOf(STREAM_A, PROC_B)]);
		expect((await generationRows(db)).map((row) => row.processor)).toEqual([PROC_A]);
	});

	it('REAPS the stream subtree when the last generation on it goes AND the caller ASKED', async () => {
		const db = await freshDB();
		const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: CAPS});
		await registry.create(idOf(STREAM_A, PROC_A));
		const onOwnStream = await registry.create(idOf(STREAM_B, PROC_B));
		await writeStream(db, INDEXER, STREAM_A);
		await writeStream(db, INDEXER, STREAM_B);
		await writeStream(db, OTHER_INDEXER, STREAM_B);

		// ASKED FOR, which is the operator's `reclaim` and nothing else: the automatic
		// reap a registration or a promotion used to fire is gone (ADR-0087).
		const deletion = await registry.deleteGeneration(onOwnStream, {reapStream: true});

		expect(deletion.reaped).toBe(STREAM_B);
		expect(await emissionCount(db, INDEXER, STREAM_B)).toBe(0);
		// the live stream, and another named indexer's rows under the same digest
		expect(await emissionCount(db, INDEXER, STREAM_A)).toBe(1);
		expect(await emissionCount(db, OTHER_INDEXER, STREAM_B)).toBe(1);
	});

	it('KEEPS the stream subtree where nobody asked for it to go', async () => {
		// A stream OUTLIVES every fold over it (ADR-0087): it is what CHAIN FETCHES
		// bought, the state is derived from it, and "no registered generation folds it"
		// is exactly the state it is in between an old fold being dropped and a new one
		// being built.
		const db = await freshDB();
		const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: CAPS});
		await registry.create(idOf(STREAM_A, PROC_A));
		const onOwnStream = await registry.create(idOf(STREAM_B, PROC_B));
		await writeStream(db, INDEXER, STREAM_B);

		const deletion = await registry.deleteGeneration(onOwnStream);

		expect(deletion.reaped).toBeUndefined();
		expect(await emissionCount(db, INDEXER, STREAM_B)).toBe(1);
		// ...and the registry still RECORDS it, which is what stops the sweep on the
		// next open undoing the keep
		expect(await registry.keptStreams()).toEqual([STREAM_A, STREAM_B].sort());
	});

	it('SURVIVES A RESTART, because the keep is a ROW and not a decision in memory', async () => {
		// The trap ADR-0087 does not name and the one that silently undoes it: the
		// sweep on registry OPEN drops every stream subtree "claimed by no registered
		// generation", and a kept stream is exactly that. Re-opening over the same
		// database is the only way to assert it; a second read inside one process
		// would not go near the sweep.
		const db = await freshDB();
		const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: CAPS});
		await registry.create(idOf(STREAM_A, PROC_A));
		const onOwnStream = await registry.create(idOf(STREAM_B, PROC_B));
		await writeStream(db, INDEXER, STREAM_B);
		await registry.deleteGeneration(onOwnStream);

		const reopened = await openGenerationRegistryOnSQL(db, INDEXER, {caps: CAPS});

		expect(reopened.swept).toEqual([]);
		expect(await emissionCount(db, INDEXER, STREAM_B)).toBe(1);
		expect(await readStreamCoverage(db, {indexer: INDEXER, stream: STREAM_B})).toBeDefined();
	});

	it('still COLLECTS a pre-generation orphan, so the sweep keeps its own reason for existing', async () => {
		// The sweep exists for a subtree written BEFORE generations existed -- under a
		// placeholder digest, or under a digest rule a later change replaced -- which no
		// departure could ever fire a reap for. Such a subtree was never RECORDED, which
		// is exactly what tells it apart from a deliberately kept stream.
		const db = await freshDB();
		const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: CAPS});
		await registry.create(idOf(STREAM_A, PROC_A));
		await writeStream(db, INDEXER, STREAM_A);
		await writeStream(db, INDEXER, STREAM_C);

		const reopened = await openGenerationRegistryOnSQL(db, INDEXER, {caps: CAPS});

		expect(reopened.swept).toEqual([STREAM_C]);
		expect(await emissionCount(db, INDEXER, STREAM_C)).toBe(0);
		expect(await emissionCount(db, INDEXER, STREAM_A)).toBe(1);
	});
});

/**
 * A STREAM LIVES IN TWO TABLES, SO A REAP HAS TO TAKE BOTH.
 *
 * PRESENCE is the COVERAGE CLAIM and never "there are rows" (ADR-0035/ADR-0055),
 * which is what lets a stream that has been scanned and found nothing read as
 * present-and-empty instead of absent. That rule is what makes a SURVIVING claim
 * so much worse than no claim at all: a reap that took the emissions and left the
 * claim leaves a stream reading as PRESENT AND COMPLETE with nothing in it, and
 * the generation folding it is told it re-folded the whole history and may resume
 * at the old tip -- with empty state, durably, and with no error anywhere.
 */
describe('reaping a stream takes its COVERAGE CLAIM with its rows', () => {
	it('leaves no claim behind, so the reaped stream reads ABSENT and not empty-but-complete', async () => {
		const db = await freshDB();
		const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: CAPS});
		await registry.create(idOf(STREAM_A, PROC_A));
		const onOwnStream = await registry.create(idOf(STREAM_B, PROC_B));
		await writeStream(db, INDEXER, STREAM_A);
		await writeStream(db, INDEXER, STREAM_B);
		await writeStream(db, OTHER_INDEXER, STREAM_B);
		// the claim is there before the reap, or this asserts nothing
		expect(await readStreamCoverage(db, {indexer: INDEXER, stream: STREAM_B})).toBeDefined();

		await registry.deleteGeneration(onOwnStream, {reapStream: true});

		expect(await readStreamCoverage(db, {indexer: INDEXER, stream: STREAM_B})).toBeUndefined();
		// the OTHER named indexer's claim under the SAME digest is untouched, exactly as
		// its rows are: both statements carry both discriminators
		expect(await readStreamCoverage(db, {indexer: OTHER_INDEXER, stream: STREAM_B})).toBeDefined();
		// and the live stream keeps its own
		expect(await readStreamCoverage(db, {indexer: INDEXER, stream: STREAM_A})).toBeDefined();
	});

	it('takes the claim on the unregistered-subtree SWEEP too, which is the reachable path', async () => {
		const db = await freshDB();
		// a database written BEFORE this runtime held generations: rows and a claim that
		// no registered generation names, which the first registry open sweeps
		await writeStream(db, INDEXER, STREAM_A);
		expect(await readStreamCoverage(db, {indexer: INDEXER, stream: STREAM_A})).toBeDefined();

		const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: CAPS});

		expect(registry.swept).toEqual([STREAM_A]);
		expect(await emissionCount(db, INDEXER, STREAM_A)).toBe(0);
		expect(await readStreamCoverage(db, {indexer: INDEXER, stream: STREAM_A})).toBeUndefined();
	});
});

// The other half of this pin lives in `storedStreamRefold.test.ts` ("is what
// PRESENCE is: rows with no claim are not a stream anything may fold"): together
// they say a reap removes the claim, and a stream with no claim reads ABSENT. The
// digests here are fabricated rather than derived from a source, so the reader
// itself -- which resolves a stream by hashing the source it is asked about --
// cannot be driven from this file.

/** How many rows under this name carry a bundle, read straight off the table. */
const bundleCount = async (db: RemoteSQL, indexer = INDEXER) =>
	Number(
		(
			await rowsOf<{bundles: number}>(
				db,
				`SELECT COUNT(bundle) AS bundles FROM ${GENERATION_TABLE} WHERE indexer = ?1`,
				indexer,
			)
		)[0]?.bundles ?? 0,
	);

describe('a generation KEEPS its bundle on its own row (ADR-0092)', () => {
	it('stores the bytes with the record, readable back through the port', async () => {
		const db = await freshDB();
		const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: CAPS});
		const id = idOf(STREAM_A, identityOf('v1'));

		await registry.create(id, {bundle: bundleBytes('v1')});

		const stored = await generationRegistryPortOnSQL(db, INDEXER).readBundle(id);
		expect(stored).toEqual(bundleBytes('v1'));
		// the EXACT bytes the identity is the hash of, re-hashed off the row
		expect(identityOfBytes(stored as Uint8Array)).toBe(id.processor);
	});

	it('is DURABLE: a restarted process reads the same bytes off the same file', async () => {
		const file = onDisk();
		const registry = await openGenerationRegistryOnSQL(await file.open(), INDEXER, {caps: CAPS});
		const id = idOf(STREAM_A, identityOf('v1'));
		await registry.create(id, {bundle: bundleBytes('v1')});

		const restarted = await openGenerationRegistryOnSQL(await file.open(), INDEXER, {caps: CAPS});

		expect(await restarted.bundleOf(id)).toEqual(bundleBytes('v1'));
	});

	it('goes with the ROW on `deleteGeneration`, by the one DELETE that takes the record', async () => {
		const db = await freshDB();
		const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: CAPS});
		await registry.create(idOf(STREAM_A, identityOf('v1')), {bundle: bundleBytes('v1')});
		await registry.create(idOf(STREAM_A, identityOf('v2')), {bundle: bundleBytes('v2')});

		await registry.deleteGeneration(idOf(STREAM_A, identityOf('v2')));

		expect(await registry.bundleOf(idOf(STREAM_A, identityOf('v2')))).toBeUndefined();
		expect(await bundleCount(db)).toBe(1);
	});

	it('goes with every row on `deleteStream`', async () => {
		const db = await freshDB();
		const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: CAPS});
		await registry.create(idOf(STREAM_A, identityOf('v1')), {bundle: bundleBytes('v1')});
		await registry.create(idOf(STREAM_B, identityOf('v2')), {bundle: bundleBytes('v2')});
		await registry.create(idOf(STREAM_B, identityOf('v3')), {bundle: bundleBytes('v3')});

		await registry.deleteStream(STREAM_B);

		expect(await bundleCount(db)).toBe(1);
		expect(await registry.bundleOf(idOf(STREAM_A, identityOf('v1')))).toEqual(bundleBytes('v1'));
	});

	it('answers NOTHING for a row that kept no code, and for a generation it does not hold', async () => {
		const db = await freshDB();
		const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: CAPS});
		await registry.create(idOf(STREAM_A, PROC_A));

		expect(await registry.bundleOf(idOf(STREAM_A, PROC_A))).toBeUndefined();
		expect(await registry.bundleOf(idOf(STREAM_A, PROC_B))).toBeUndefined();
	});

	it('is SCOPED to one named indexer, like every other row', async () => {
		const db = await freshDB();
		const main = await openGenerationRegistryOnSQL(db, INDEXER, {caps: CAPS});
		const other = await openGenerationRegistryOnSQL(db, OTHER_INDEXER, {caps: CAPS});
		const id = idOf(STREAM_A, identityOf('v1'));
		await main.create(id, {bundle: bundleBytes('v1')});

		expect(await other.bundleOf(id)).toBeUndefined();
	});
});

describe('a second handle on the same database', () => {
	it('sees the same generations and the same canonical generation', async () => {
		const file = onDisk();
		const first = await file.open();
		const registry = await openGenerationRegistryOnSQL(first, INDEXER, {caps: CAPS});
		const original = await registry.create(idOf(STREAM_A, PROC_A));
		const successor = await registry.create(idOf(STREAM_A, PROC_B));
		await writeStream(first, INDEXER, STREAM_A);
		await registry.moveCanonicalTo(successor);

		const restarted = await openGenerationRegistryOnSQL(await file.open(), INDEXER, {caps: CAPS});

		expect(await restarted.list()).toEqual([original, successor]);
		expect(await restarted.canonical()).toEqual(successor);
		expect(restarted.swept).toEqual([]);
	});
});

describe('the writer of a stream is the OLDEST SURVIVING generation on it', () => {
	it('hands the append duty to the next oldest, in the SAME commit as the delete', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(1_000);
		const db = await freshDB();
		const writes: string[][] = [];
		const registry = await openGenerationRegistryOnSQL(watched(db, writes), INDEXER, {caps: CAPS});
		const original = await registry.create(idOf(STREAM_A, PROC_B));
		vi.setSystemTime(2_000);
		const successor = await registry.create(idOf(STREAM_A, PROC_A));
		await registry.moveCanonicalTo(successor);

		// the WRITER is the oldest, and is deliberately not the canonical one
		expect(await registry.fetcherOf(STREAM_A)).toEqual(original);

		writes.length = 0;
		await registry.deleteGeneration(original);

		expect(await registry.fetcherOf(STREAM_A)).toEqual(successor);
		expect((await generationRows(db)).map((row) => row.processor)).toEqual([PROC_A]);
		// ONE writing batch: succession is atomic with the drop because it is
		// stored NOWHERE -- no writer column, no second write to crash between
		expect(writes).toHaveLength(1);
		expect(writes[0]!.filter((sql) => /DELETE/i.test(sql))).toHaveLength(1);
		expect(writes.flat().join('\n')).not.toMatch(/writer/i);
	});

	it('answers NOTHING when the last generation goes, and the stream STAYS', async () => {
		// RE-SCOPED with its sentence. "No writer left, so the stream is reaped" rested
		// on the answer being a DUTY; under ADR-0087 the DEPLOYMENT appends, so no answer
		// here is nobody's permission to do anything and there is no reason to delete the
		// bytes a fetch bought.
		const db = await freshDB();
		const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: CAPS});
		const canonical = await registry.create(idOf(STREAM_A, PROC_A));
		const onOwnStream = await registry.create(idOf(STREAM_B, PROC_B));
		await writeStream(db, INDEXER, STREAM_B);

		await registry.deleteGeneration(onOwnStream);

		expect(await registry.fetcherOf(STREAM_B)).toBeUndefined();
		expect(await emissionCount(db, INDEXER, STREAM_B)).toBe(1);
		expect(await registry.fetcherOf(STREAM_A)).toEqual(canonical);
	});
});

/**
 * A handle that COMMITS SOMEBODY ELSE'S WRITE just before the first writing
 * batch of the handle under test reaches the database.
 *
 * Deterministic and not a race: the interleaving is the exact window a
 * read-then-write implementation cannot survive -- the decision has been made
 * from a state that no longer holds by the time the write lands.
 */
function interleaved(db: RemoteSQL, competitor: () => Promise<void>): RemoteSQL {
	let fired = false;
	return {
		prepare: (sql) => db.prepare(sql),
		async batch<T>(list: SQLPreparedStatement[]) {
			if (!fired && list.some(isWrite)) {
				fired = true;
				await competitor();
			}
			return db.batch<T>(list);
		},
	};
}

/** A handle that records the SQL of every writing batch that goes through it. */
function watched(db: RemoteSQL, writes: string[][]): RemoteSQL {
	return {
		prepare: (sql) => db.prepare(sql),
		async batch<T>(list: SQLPreparedStatement[]) {
			if (list.some(isWrite)) {
				writes.push(list.map(sqlOf));
			}
			return db.batch<T>(list);
		},
	};
}

const isWrite = (statement: SQLPreparedStatement): boolean => /^\s*(INSERT|UPDATE|DELETE)/i.test(sqlOf(statement));

const sqlOf = (statement: SQLPreparedStatement): string => (statement as unknown as {sql?: string}).sql ?? '';

describe('a cap decision made concurrently cannot be beaten', () => {
	it('REFUSES rather than leaving more generations than the cap allows', async () => {
		const db = await freshDB();
		const rival = await openGenerationRegistryOnSQL(db, INDEXER, {caps: {maxGenerations: 1, maxStreams: 2}});
		const registry = await openGenerationRegistryOnSQL(
			interleaved(db, async () => {
				await rival.create(idOf(STREAM_B, PROC_B));
			}),
			INDEXER,
			{caps: {maxGenerations: 1, maxStreams: 2}},
		);

		const refusal = await registry.create(idOf(STREAM_A, PROC_A)).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(GenerationCapReachedError);
		expect((await generationRows(db)).map((row) => row.stream)).toEqual([STREAM_B]);
	});

	it('RETRIES the loser rather than losing its write, when the cap has room', async () => {
		const db = await freshDB();
		const rival = await openGenerationRegistryOnSQL(db, INDEXER, {caps: CAPS});
		const registry = await openGenerationRegistryOnSQL(
			interleaved(db, async () => {
				await rival.create(idOf(STREAM_B, PROC_B));
			}),
			INDEXER,
			{caps: CAPS},
		);

		const mine = await registry.create(idOf(STREAM_A, PROC_A));

		expect((await generationRows(db)).map((row) => row.stream).sort()).toEqual([STREAM_A, STREAM_B]);
		expect(await registry.list()).toEqual(expect.arrayContaining([mine]));
		// the FIRST generation registered is the one the pointer took, and the
		// loser's retry must not have moved it
		expect(await registry.canonical()).toEqual(expect.objectContaining({stream: STREAM_B}));
	});
});

describe('the sweep, over the stored emission stream', () => {
	it('drops exactly the subtree no registered generation claims', async () => {
		const db = await freshDB();
		const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: CAPS});
		await registry.create(idOf(STREAM_A, PROC_A));
		await writeStream(db, INDEXER, STREAM_A);
		// the placeholder-era case: a stream nothing points at
		await writeStream(db, INDEXER, STREAM_B);
		await writeStream(db, OTHER_INDEXER, STREAM_B);

		const reopened = await openGenerationRegistryOnSQL(db, INDEXER, {caps: CAPS});

		expect(reopened.swept).toEqual([STREAM_B]);
		expect(await emissionCount(db, INDEXER, STREAM_B)).toBe(0);
		expect(await emissionCount(db, INDEXER, STREAM_A)).toBe(1);
		expect(await emissionCount(db, OTHER_INDEXER, STREAM_B)).toBe(1);
	});

	it('lists the stream digests physically present under this indexer, and no other name', async () => {
		const db = await freshDB();
		await writeStream(db, INDEXER, STREAM_A);
		await writeStream(db, INDEXER, STREAM_B);
		await writeStream(db, OTHER_INDEXER, STREAM_A);

		const port = generationRegistryPortOnSQL(db, INDEXER);

		expect(await port.listStreamDigests()).toEqual([STREAM_A, STREAM_B]);
		expect(await port.dropStreamSubtree(STREAM_A)).toBe(1);
		expect(await port.listStreamDigests()).toEqual([STREAM_B]);
		expect(await emissionCount(db, OTHER_INDEXER, STREAM_A)).toBe(1);
	});
});

describe('nothing about the CAPS is persisted by this substrate', () => {
	it('has no caps table and no caps column in the fixed schema', () => {
		const schema = readFileSync(new URL('../src/schema/sql/db.sql', import.meta.url), 'utf-8').replace(/--[^\n]*/g, '');

		expect(schema).not.toMatch(/maxGenerations|maxStreams|\bcaps?\b/i);
	});

	it('supplies exactly the seven port operations', async () => {
		const db = await freshDB();

		expect(Object.keys(generationRegistryPortOnSQL(db, INDEXER)).sort()).toEqual([
			'commit',
			'dropState',
			'dropStreamSubtree',
			'listStreamDigests',
			'read',
			// the code a generation was registered with (ADR-0092), which this substrate DOES
			// own: it is a column on the generation's own row
			'readBundle',
			// the READ half of the state seam, beside the DROP: both are the host's fact
			// about where a generation's state lives, and neither is this substrate's
			'readStateCursor',
		]);
	});

	it('takes the caps as an argument of the registry, so the substrate never reads one', async () => {
		const db = await freshDB();
		const registry = await openGenerationRegistry(generationRegistryPortOnSQL(db, INDEXER), {
			maxGenerations: 1,
			maxStreams: 1,
		});
		await registry.create(idOf(STREAM_A, PROC_A));

		await expect(registry.create(idOf(STREAM_A, PROC_B))).rejects.toBeInstanceOf(GenerationCapReachedError);
		// the same rows, read by a registry opened with ROOM: the bound was the
		// argument's and never anything this substrate stored
		const generous = await openGenerationRegistryOnSQL(db, INDEXER, {caps: CAPS});
		expect(await generous.create(idOf(STREAM_A, PROC_B))).toEqual(
			expect.objectContaining({stream: STREAM_A, processor: PROC_B}),
		);
	});
});
