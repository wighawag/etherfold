import {describe, expect, it} from 'vitest';
import {normalizeEntity} from '@etherfold/state-store';
import {
	DEFAULT_BATCH_BOUNDS,
	VersionedStateStore,
	dropVersionsStatement,
	planBatches,
	tableNames,
} from '../src/index.js';
import {FailingTailSQL, RecordingSQL, createTestDB, rows, sqlOf} from './utils/db.js';
import {TOKEN, block, owns} from './utils/fixtures.js';

describe('applying a block', () => {
	it('is exactly one batch call', async () => {
		const db = new RecordingSQL(createTestDB());
		const store = new VersionedStateStore(db, [TOKEN]);
		await store.migrate();
		db.batches.length = 0;

		await store.applyBlock(block(100), [owns('1', '0xAlice', 1), owns('2', '0xBob', 1)]);

		expect(db.batches.length).toBe(1);
		// the writer's CLAIM + block row + (close + insert) per changed entity + the
		// read-back that says who holds the store. All in the one batch, which is the
		// one transaction: the guard is checked where the write happens (ADR-0075).
		expect(db.batches[0].length).toBe(1 + 1 + 2 * 2 + 1);
		expect(sqlOf(db.batches[0][0])).toMatch(/INSERT INTO _writer/i);
		expect(sqlOf(db.batches[0][1])).toMatch(/INSERT INTO _blocks/i);
		expect(sqlOf(db.batches[0][db.batches[0].length - 1])).toMatch(/SELECT token FROM _writer/i);
	});

	it('is one batch even with no mutations, so the block is still recorded', async () => {
		const db = new RecordingSQL(createTestDB());
		const store = new VersionedStateStore(db, [TOKEN]);
		await store.migrate();
		db.batches.length = 0;

		await store.applyBlock(block(100), []);

		expect(db.batches.length).toBe(1);
		expect(await rows(db, `SELECT number FROM _blocks`)).toEqual([{number: 100}]);
	});

	it('writes a delete as a close only', async () => {
		const db = new RecordingSQL(createTestDB());
		const store = new VersionedStateStore(db, [TOKEN]);
		await store.migrate();
		await store.applyBlock(block(100), [owns('1', '0xAlice', 1)]);
		db.batches.length = 0;

		await store.applyBlock(block(101), [{type: 'delete', entity: 'token', id: {id: '1'}}]);

		// block row + the close + the read-back. No claim statement this time: one
		// landed with the first block, so from here the guard alone stands between
		// this writer and a rival.
		expect(db.batches[0].length).toBe(3);
		expect(sqlOf(db.batches[0][1])).toMatch(/^UPDATE "token" SET _upper/i);
	});

	it('leaves nothing applied when a statement inside the batch fails', async () => {
		const real = createTestDB();
		// A statement that violates the _blocks primary key, appended to the batch
		// AFTER the store's own statements.
		const db = new FailingTailSQL(real, {
			sql: `INSERT INTO _blocks (number, hash, timestamp) VALUES (?, ?, ?)`,
			args: [1, '0xdup', 1],
		});
		const store = new VersionedStateStore(db, [TOKEN]);
		await store.migrate();
		await store.applyBlock(block(1, '0xdup'), []);
		await store.applyBlock(block(100), [owns('1', '0xAlice', 1)]);

		db.armed = true;
		await expect(store.applyBlock(block(101), [owns('1', '0xBob', 2), owns('2', '0xZoe', 1)])).rejects.toThrow();
		db.armed = false;

		// no block row, no new version, and the previously open version is still open
		expect(await rows(real, `SELECT number FROM _blocks WHERE number = ?`, 101)).toEqual([]);
		expect(await rows(real, `SELECT id FROM token WHERE _lower = ?`, 101)).toEqual([]);
		expect((await store.getCurrent<{owner: string}>('token', {id: '1'}))?.owner).toBe('0xAlice');
	});
});

describe('the batch chunk bound', () => {
	it('defaults to the tightest supported backend and plan, which is D1 Free', () => {
		// Each of these is a DOCUMENTED D1 limit, not a taste: see
		// work/notes/findings/d1-caps-bound-parameters-per-query-at-100.md.
		// Raising one silently is how retention enforcement broke on D1 before.
		expect(DEFAULT_BATCH_BOUNDS.maxStatementsPerBatch).toBe(50); // D1 Free: 50 queries per Worker invocation
		expect(DEFAULT_BATCH_BOUNDS.maxBytesPerBatch).toBe(90_000);
		expect(DEFAULT_BATCH_BOUNDS.maxRowsPerStatement).toBe(100); // D1: 100 bound parameters per query
	});

	it('emits no prune statement with more bound parameters than D1 allows', () => {
		// The DEFAULT sits EXACTLY on D1's cap, which is only safe because this
		// statement carries no other bound parameter. That coupling is invisible at
		// the default's definition site, so it is asserted here: add an argument to
		// dropVersionsStatement and this fails, which is the point.
		const D1_MAX_BOUND_PARAMETERS_PER_QUERY = 100;
		const rowids = Array.from({length: DEFAULT_BATCH_BOUNDS.maxRowsPerStatement}, (_, i) => i + 1);
		const statement = dropVersionsStatement(normalizeEntity(TOKEN), rowids, tableNames());

		expect(statement.args.length).toBe(rowids.length);
		expect(statement.args.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS_PER_QUERY);
		// and the placeholder count agrees with the argument count
		expect((statement.sql.match(/\?/g) ?? []).length).toBe(statement.args.length);
	});

	it('leaves room for the writer guard, which IS the parameter that was added', async () => {
		// The coupling above finally bit: the guard is one more bound parameter on
		// this exact statement, so `prune` names one FEWER row than the bound allows
		// and the query still fits the tightest hosted backend's cap. Asserted on the
		// statement AND on what the store actually emits, because the second is the
		// one a deployment runs.
		const D1_MAX_BOUND_PARAMETERS_PER_QUERY = 100;
		const rowids = Array.from({length: DEFAULT_BATCH_BOUNDS.maxRowsPerStatement - 1}, (_, i) => i + 1);
		const guarded = dropVersionsStatement(normalizeEntity(TOKEN), rowids, tableNames(), {
			predicate: `COALESCE((SELECT token FROM _writer WHERE id = 0), '') = ?`,
			token: 'a-token',
		});
		expect(guarded.args.length).toBe(D1_MAX_BOUND_PARAMETERS_PER_QUERY);
		expect((guarded.sql.match(/\?/g) ?? []).length).toBe(guarded.args.length);

		const db = new RecordingSQL(createTestDB());
		const store = new VersionedStateStore(db, [TOKEN], {retention: {blocks: 1}, finalityDepth: 1});
		await store.migrate();
		for (let n = 100; n < 210; n++) await store.applyBlock(block(n), [owns('1', `0x${n}`, n)]);
		db.batches.length = 0;
		await store.prune();

		for (const batch of db.batches) {
			for (const statement of batch) {
				expect((sqlOf(statement).match(/\?/g) ?? []).length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS_PER_QUERY);
			}
		}
	});

	it('never splits an indivisible group across batches', () => {
		const group = (n: number) => Array.from({length: n}, (_, i) => ({sql: `SELECT ${i}`, args: []}));
		const batches = planBatches([group(3), group(3), group(3)], {
			maxStatementsPerBatch: 7,
			maxBytesPerBatch: Number.MAX_SAFE_INTEGER,
		});
		expect(batches.map((b) => b.length)).toEqual([6, 3]);
	});

	it('bounds by size as well as by statement count', () => {
		const big = [{sql: 'SELECT ?', args: ['x'.repeat(400)]}];
		const batches = planBatches([big, big, big], {maxStatementsPerBatch: 100, maxBytesPerBatch: 500});
		expect(batches.length).toBe(3);
	});

	it('keeps a group that alone exceeds the bound as a single batch, because atomicity wins', () => {
		const huge = Array.from({length: 12}, (_, i) => ({sql: `SELECT ${i}`, args: []}));
		const batches = planBatches([huge], {maxStatementsPerBatch: 5, maxBytesPerBatch: Number.MAX_SAFE_INTEGER});
		expect(batches.length).toBe(1);
		expect(batches[0].length).toBe(12);
	});

	it('is configurable, and applying many blocks packs them up to the bound', async () => {
		const db = new RecordingSQL(createTestDB());
		// 3 statements per block here (block row + close + insert), and the guard
		// keeps 2 of the bound back for itself (the claim and the read-back), so a
		// bound of 8 packs two blocks per batch.
		const store = new VersionedStateStore(db, [TOKEN], {bounds: {maxStatementsPerBatch: 8}});
		await store.migrate();
		db.batches.length = 0;

		await store.applyBlocks([
			{block: block(100), mutations: [owns('1', '0xA', 1)]},
			{block: block(101), mutations: [owns('1', '0xB', 2)]},
			{block: block(102), mutations: [owns('1', '0xC', 3)]},
			{block: block(103), mutations: [owns('1', '0xD', 4)]},
		]);

		expect(db.batches.length).toBe(2);
		for (const batch of db.batches) {
			// the bound is what a backend accepts, so the guard's statements count
			// against it rather than riding on top of it
			expect(batch.length).toBeLessThanOrEqual(8);
			expect(sqlOf(batch[batch.length - 1])).toMatch(/SELECT token FROM _writer/i);
			expect(batch.some((statement) => /INSERT INTO _blocks/i.test(sqlOf(statement)))).toBe(true);
		}
		expect((await store.getAsOf<{owner: string}>('token', {id: '1'}, 101))?.owner).toBe('0xB');
		expect((await store.getCurrent<{owner: string}>('token', {id: '1'}))?.owner).toBe('0xD');
	});

	it('applies a single block as one batch even when it exceeds the bound', async () => {
		const db = new RecordingSQL(createTestDB());
		const store = new VersionedStateStore(db, [TOKEN], {bounds: {maxStatementsPerBatch: 4}});
		await store.migrate();
		db.batches.length = 0;

		const mutations = Array.from({length: 10}, (_, i) => owns(String(i), '0xA', 1));
		await store.applyBlock(block(100), mutations);

		expect(db.batches.length).toBe(1);
		// block row + 10 * (close + insert), plus the claim and the read-back
		expect(db.batches[0].length).toBe(23);
	});

	it('also bounds the DDL issued by migrate', async () => {
		const db = new RecordingSQL(createTestDB());
		const store = new VersionedStateStore(
			db,
			[TOKEN, {name: 'account', id: ['address'], fields: {balance: 'integer'}}],
			{
				bounds: {maxStatementsPerBatch: 3},
			},
		);
		await store.migrate();
		expect(db.batches.length).toBeGreaterThan(1);
		for (const batch of db.batches) {
			expect(batch.length).toBeLessThanOrEqual(3);
		}
	});
});
