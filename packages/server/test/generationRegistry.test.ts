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
	GENERATION_POINTER_TABLE,
	GENERATION_TABLE,
	appendEmissions,
	applySchema,
	generationRegistryPortOnSQL,
	openGenerationRegistryOnSQL,
} from '../src/index.js';

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

const pointerRows = (db: RemoteSQL) =>
	rowsOf<{indexer: string; stream: string | null; processor: string | null; revision: string}>(
		db,
		`SELECT indexer, stream, processor, revision FROM ${GENERATION_POINTER_TABLE} ORDER BY indexer`,
	);

/** One emission row, so a stream has a SUBTREE the sweep and the reap can see. */
async function writeStream(db: RemoteSQL, indexer: string, stream: string, blockNumber = 100) {
	await appendEmissions(db, {
		indexer,
		stream,
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

	it('REAPS the stream subtree when the last generation on it goes', async () => {
		const db = await freshDB();
		const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: CAPS});
		await registry.create(idOf(STREAM_A, PROC_A));
		const onOwnStream = await registry.create(idOf(STREAM_B, PROC_B));
		await writeStream(db, INDEXER, STREAM_A);
		await writeStream(db, INDEXER, STREAM_B);
		await writeStream(db, OTHER_INDEXER, STREAM_B);

		const deletion = await registry.deleteGeneration(onOwnStream);

		expect(deletion.reaped).toBe(STREAM_B);
		expect(await emissionCount(db, INDEXER, STREAM_B)).toBe(0);
		// the live stream, and another named indexer's rows under the same digest
		expect(await emissionCount(db, INDEXER, STREAM_A)).toBe(1);
		expect(await emissionCount(db, OTHER_INDEXER, STREAM_B)).toBe(1);
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
		expect(await registry.writerOf(STREAM_A)).toEqual(original);

		writes.length = 0;
		await registry.deleteGeneration(original);

		expect(await registry.writerOf(STREAM_A)).toEqual(successor);
		expect((await generationRows(db)).map((row) => row.processor)).toEqual([PROC_A]);
		// ONE writing batch: succession is atomic with the drop because it is
		// stored NOWHERE -- no writer column, no second write to crash between
		expect(writes).toHaveLength(1);
		expect(writes[0]!.filter((sql) => /DELETE/i.test(sql))).toHaveLength(1);
		expect(writes.flat().join('\n')).not.toMatch(/writer/i);
	});

	it('has no writer left when the last generation goes, so the stream is reaped', async () => {
		const db = await freshDB();
		const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: CAPS});
		const canonical = await registry.create(idOf(STREAM_A, PROC_A));
		const onOwnStream = await registry.create(idOf(STREAM_B, PROC_B));
		await writeStream(db, INDEXER, STREAM_B);

		await registry.deleteGeneration(onOwnStream);

		expect(await registry.writerOf(STREAM_B)).toBeUndefined();
		expect(await emissionCount(db, INDEXER, STREAM_B)).toBe(0);
		expect(await registry.writerOf(STREAM_A)).toEqual(canonical);
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

	it('supplies exactly the five port operations', async () => {
		const db = await freshDB();

		expect(Object.keys(generationRegistryPortOnSQL(db, INDEXER)).sort()).toEqual([
			'commit',
			'dropState',
			'dropStreamSubtree',
			'listStreamDigests',
			'read',
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
