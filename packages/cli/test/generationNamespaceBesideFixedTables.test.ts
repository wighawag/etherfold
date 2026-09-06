import {
	appendEmissions,
	applySchema,
	openGenerationRegistryOnSQL,
	readSchemaState,
	EMISSION_STREAM_TABLE,
	GENERATION_POINTER_TABLE,
	GENERATION_TABLE,
} from '@etherfold/server';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import {createClient} from '@libsql/client';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {describe, expect, it} from 'vitest';

// ---------------------------------------------------------------------------------------------------
// WHERE THE GENERATION NAMESPACE STOPS: THE SERVER'S FIXED TABLES ARE SHARED ON PURPOSE
// ---------------------------------------------------------------------------------------------------
// A **generation**'s state is a TABLE-NAME NAMESPACE inside one database
// (ADR-0053), and this package is where that database is actually shared: one
// libSQL handle carries the server's fixed tables and every generation's state
// at once, which is the whole reason `fixedTableNamespace.test.ts` exists beside
// this file.
//
// The boundary is EXACT and it is asserted from the other side here. The
// namespace covers what the STORE owns -- the entity tables, `_blocks`, `_cursor`
// and the indexes derived from them -- and nothing the SERVER owns: `_meta`,
// `_emissions` and the generation registry (`_generations`,
// `_generation_pointer`) are per NAMED INDEXER and are deliberately SHARED across
// its generations. That sharing is the point rather than an oversight: a
// processor-only change re-folds the SAME stored stream, which is what makes it
// free, and the registry has to name generations from OUTSIDE any of them.
//
// So the test is not "the names are different". It is that the code that OWNS
// those tables still finds them with a namespaced generation's tables sitting in
// the same file -- `readSchemaState` over `_meta`, `appendEmissions` over
// `_emissions`, and the registry over its two -- and that neither can see the
// other's rows.
// ---------------------------------------------------------------------------------------------------

const INDEXER = 'alpha';
const STREAM = '0fbe2d6c9a1e4b3d8c7f0a1b2c3d4e5f';

const ENTITIES = [{name: 'token', id: ['id'], fields: {owner: 'text'}}] as const;

/** One emission, so `_emissions` has a row the registry's sweep can see. */
/**
 * The stream's COVERAGE CLAIM, which every append carries beside its rows.
 *
 * Nothing in this file reads it -- what is under test is which TABLES exist and
 * who finds them -- so it is the smallest honest one rather than a scenario.
 */
const coverage = {source: [], config: 'config', latestBlock: 100, lastFromBlock: 100, lastToBlock: 100};

function emission(blockNumber = 100) {
	return {
		blockNumber,
		blockHash: `0x${blockNumber.toString(16)}` as const,
		logIndex: 0,
		transactionHash: `0xtx${blockNumber}` as const,
		transactionIndex: 0,
		address: '0x0000000000000000000000000000000000000099' as const,
		topics: ['0xdead' as const],
		data: '0x' as const,
		removed: false,
	};
}

/** The combined shape: the server's fixed schema and two generations, one handle. */
async function oneDatabase(): Promise<{db: RemoteSQL; incumbent: VersionedStateStore; successor: VersionedStateStore}> {
	const db = new RemoteLibSQL(createClient({url: ':memory:'}));
	await applySchema(db);
	const incumbent = new VersionedStateStore(db, ENTITIES, {tableNamespace: 'genA'});
	const successor = new VersionedStateStore(db, ENTITIES, {tableNamespace: 'genB'});
	await incumbent.migrate();
	await successor.migrate();
	return {db, incumbent, successor};
}

/** Every table and index the database holds, minus the ones SQLite made for itself. */
async function namesIn(db: RemoteSQL): Promise<string[]> {
	const rows = await db
		.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'`)
		.all<{name: string}>();
	return rows.results.map((row) => row.name);
}

describe('the server-owned fixed tables, in a database holding several generations', () => {
	it('keep the names they have, un-namespaced', async () => {
		const {db} = await oneDatabase();
		const names = await namesIn(db);

		expect(names).toEqual(
			expect.arrayContaining(['_meta', EMISSION_STREAM_TABLE, GENERATION_TABLE, GENERATION_POINTER_TABLE]),
		);
		// and no generation grew a copy of one of them
		expect(names.filter((name) => name.includes('genA') && !name.includes('token'))).toEqual(
			expect.arrayContaining(['_genA_blocks', '_genA_cursor']),
		);
		expect(names.filter((name) => /^_gen[AB]_(meta|emissions|generations|generation_pointer)$/.test(name))).toEqual([]);
	});

	it('are still found by the code that owns them', async () => {
		const {db} = await oneDatabase();

		// `_meta`, read by the status route on any host
		expect(await readSchemaState(db)).toMatchObject({applied: true, matches: true});

		// `_emissions`, written by whoever owns the store and read by both feed views
		await appendEmissions(db, {indexer: INDEXER, stream: STREAM, coverage, emissions: [emission()]});

		// `_generations` and `_generation_pointer`: the registry names generations
		// from OUTSIDE any of them, which is why they cannot be namespaced by one
		const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: {maxGenerations: 4, maxStreams: 2}});
		await registry.create({stream: STREAM, processor: 'genA'});
		await registry.create({stream: STREAM, processor: 'genB'});
		await registry.moveCanonicalTo({stream: STREAM, processor: 'genA'});

		expect((await registry.list()).map((record) => record.processor)).toEqual(['genA', 'genB']);
		expect(await registry.canonical()).toMatchObject({processor: 'genA'});
		// the stream it folds is stored once, under the NAME, and both generations
		// re-fold it: that sharing is what makes a processor-only change free
		expect(await registry.streams()).toEqual([STREAM]);
	});

	it('are unmoved by a generation dropping its state', async () => {
		const {db, incumbent, successor} = await oneDatabase();
		await appendEmissions(db, {indexer: INDEXER, stream: STREAM, coverage, emissions: [emission()]});
		await incumbent.applyBlock({number: 100, hash: '0xa100', timestamp: 1_700_000_000}, [
			{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xAlice'}},
		]);

		await successor.drop();

		expect(await readSchemaState(db)).toMatchObject({applied: true, matches: true});
		const emissions = await db.prepare(`SELECT COUNT(*) AS rows FROM ${EMISSION_STREAM_TABLE}`).all<{rows: number}>();
		expect(Number(emissions.results[0]?.rows)).toBe(1);
		// the stored stream is what a successor re-folds, so dropping a generation's
		// state must leave it exactly where it was
		expect(await incumbent.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xAlice'});
	});
});
