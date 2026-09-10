import {StoreWriterChangedError} from '@etherfold/state-store';
import type {RemoteSQL, SQLPreparedStatement, SQLResult} from 'remote-sql';
import {describe, expect, it} from 'vitest';
import {VersionedStateStore} from '../src/index.js';
import {createTestDB, rows, sqlOf} from './utils/db.js';
import {TOKEN, block, owns} from './utils/fixtures.js';

/**
 * Two writers on ONE database, on the substrate that makes it hardest.
 *
 * What the conformance suite asserts is the seam's behaviour: a second writer's
 * claim refuses the first on every mutating path, two stores addressed apart
 * never contend, a single writer notices nothing. What is asserted HERE is what
 * only this backend can be asked, and each of the three is a property of this
 * substrate rather than of the seam:
 *
 * - the EXACT-WINDOW race, which needs the handle wrapped, because
 *   `RemoteSQL` has no transaction verb and a read-then-write is therefore
 *   genuinely two round trips (ADR-0054's whole subject; ADR-0075 applies it);
 * - `applyBlocks`, which is MANY batches and so has semantics the seam's
 *   one-block verb does not have;
 * - `drop`, which is DDL and cannot carry a `WHERE` at all.
 */

const LAST_SYNC = 'lastSync';

/**
 * A handle that lets a RIVAL write land at one exact moment: just before the
 * first batch matching `justBefore` reaches the database.
 *
 * This is the shape ADR-0054 named, and it is the only honest way to test the
 * window: a `setTimeout` race would pass or fail on scheduling, while this one
 * puts the rival's committed write precisely between the reading batch and the
 * writing one. Remove the guard from the writing statements and this test goes
 * red, because that is exactly the state the writer would then overwrite.
 */
class RivalBeforeSQL implements RemoteSQL {
	/** Off until a test says otherwise, so the setup writes are ordinary writes. */
	armed = false;

	constructor(
		private readonly inner: RemoteSQL,
		private readonly justBefore: RegExp,
		private readonly rival: () => Promise<void>,
	) {}

	prepare(sql: string): SQLPreparedStatement {
		return this.inner.prepare(sql);
	}

	async batch<T = unknown>(list: SQLPreparedStatement[]): Promise<SQLResult<T>[]> {
		if (this.armed && list.some((statement) => this.justBefore.test(sqlOf(statement)))) {
			this.armed = false;
			await this.rival();
		}
		return this.inner.batch<T>(list);
	}
}

describe('the exact window between a read and the write it decided', () => {
	it('refuses a prune whose rival landed after the tip was read and before the delete', async () => {
		const real = createTestDB();
		// the rival holds the SAME database through the RAW handle, so its write
		// does not recurse through the interposer
		const rival = new VersionedStateStore(real, [TOKEN]);
		const db = new RivalBeforeSQL(real, /^DELETE FROM/i, async () => {
			await rival.applyBlock(block(200, '0xrival'), [owns('1', '0xrival', 9)]);
		});
		const store = new VersionedStateStore(db, [TOKEN], {retention: {blocks: 1}, finalityDepth: 1});
		await store.migrate();
		for (const n of [100, 101, 102]) await store.applyBlock(block(n), [owns('1', `0x${n}`, n)]);
		db.armed = true;

		// the tip read says 102 and a one-block window puts the version closed at
		// 101 out of reach -- and then the rival claims the store and moves the tip.
		await expect(store.prune()).rejects.toBeInstanceOf(StoreWriterChangedError);

		// nothing was deleted: the floor this writer computed was decided against a
		// tip that had moved, and every statement it would have run matched nothing
		expect(await rival.getAsOf<{owner: string}>('token', {id: '1'}, 100)).toMatchObject({owner: '0x100'});
		expect((await rows(real, `SELECT COUNT(*) AS n FROM token`))[0].n).toBe(4);
	});

	it('refuses a block whose rival claimed the store while the batch was in flight', async () => {
		const real = createTestDB();
		const rival = new VersionedStateStore(real, [TOKEN]);
		const db = new RivalBeforeSQL(real, /INSERT INTO _blocks/i, async () => {
			await rival.applyBlock(block(200, '0xrival'), [owns('1', '0xrival', 9)]);
		});
		const store = new VersionedStateStore(db, [TOKEN]);
		await store.migrate();
		await store.applyBlock(block(100), [owns('1', '0xalice', 1)]);
		db.armed = true;

		await expect(store.applyBlock(block(101), [owns('1', '0xbob', 2)])).rejects.toBeInstanceOf(StoreWriterChangedError);

		// the block row, the close and the insert were all in that one batch and
		// all guarded, so the state is exactly what the rival left
		expect(await rival.getCurrent<{owner: string}>('token', {id: '1'})).toMatchObject({owner: '0xrival'});
		expect(await rows(real, `SELECT number FROM _blocks WHERE number = 101`)).toEqual([]);
	});
});

describe('applyBlocks, which is many batches', () => {
	it('applies the batches before a refusal and none after it, and says which error it was', async () => {
		const real = createTestDB();
		const rival = new VersionedStateStore(real, [TOKEN]);
		// land the rival's claim once the FIRST batch has gone in: this arms on the
		// second batch, because the interposer fires before the batch it matches
		let batches = 0;
		const db: RemoteSQL = {
			prepare: (sql) => real.prepare(sql),
			async batch<T>(list: SQLPreparedStatement[]): Promise<SQLResult<T>[]> {
				if (list.some((statement) => /INSERT INTO _blocks/i.test(sqlOf(statement))) && ++batches === 2) {
					await rival.applyBlock(block(500, '0xrival'), []);
				}
				return real.batch<T>(list);
			},
		};
		// 3 statements per block, and the guard keeps 2 back, so one block per batch
		const store = new VersionedStateStore(db, [TOKEN], {bounds: {maxStatementsPerBatch: 5}});
		await store.migrate();

		await expect(
			store.applyBlocks([
				{block: block(100), mutations: [owns('1', '0xa', 1)]},
				{block: block(101), mutations: [owns('1', '0xb', 2)]},
				{block: block(102), mutations: [owns('1', '0xc', 3)]},
			]),
		).rejects.toBeInstanceOf(StoreWriterChangedError);

		// The semantics, stated rather than discovered: the guard is checked PER
		// BATCH, so a refusal mid-sequence leaves the batches that already
		// committed applied and every later one unwritten. That is what makes a
		// refusal cost a re-fold rather than a partial block.
		expect(await rows(real, `SELECT number FROM _blocks ORDER BY number`)).toEqual([{number: 100}, {number: 500}]);
		expect(await rival.getCurrent<{owner: string}>('token', {id: '1'})).toMatchObject({owner: '0xa'});
	});

	it('refuses the whole sequence from a writer that had already lost the store', async () => {
		const db = createTestDB();
		const lost = new VersionedStateStore(db, [TOKEN]);
		const holder = new VersionedStateStore(db, [TOKEN]);
		await lost.migrate();
		await lost.applyBlock(block(100), [owns('1', '0xalice', 1)]);
		await holder.applyBlock(block(101), [owns('1', '0xbob', 2)]);

		await expect(
			lost.applyBlocks([
				{block: block(102), mutations: [owns('1', '0xmallory', 3)]},
				{block: block(103), mutations: [owns('1', '0xmallory', 4)]},
			]),
		).rejects.toBeInstanceOf(StoreWriterChangedError);

		expect(await rows(db, `SELECT number FROM _blocks ORDER BY number`)).toEqual([{number: 100}, {number: 101}]);
	});
});

describe('drop, which is DDL and cannot carry a predicate', () => {
	it('drops nothing for a writer whose claim was taken', async () => {
		const db = createTestDB();
		const lost = new VersionedStateStore(db, [TOKEN], {tableNamespace: 'gen'});
		const holder = new VersionedStateStore(db, [TOKEN], {tableNamespace: 'gen'});
		await lost.migrate();
		await lost.applyBlock(block(100), [owns('1', '0xalice', 1)]);
		await holder.applyBlock(block(101), [owns('1', '0xbob', 2)]);

		await expect(lost.drop()).rejects.toBeInstanceOf(StoreWriterChangedError);

		// the tables are all still there, and so is the state: a writer that lost
		// the store does not get to dispose of the generation it stopped holding
		expect(await holder.getCurrent<{owner: string}>('token', {id: '1'})).toMatchObject({owner: '0xbob'});
		expect(await rows(db, `SELECT name FROM sqlite_master WHERE name = 'gen_token'`)).toEqual([{name: 'gen_token'}]);
	});

	it('drops for the writer that holds it, and the store claims again after a migrate', async () => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [TOKEN], {tableNamespace: 'gen'});
		await store.migrate();
		await store.applyBlock(block(100), [owns('1', '0xalice', 1)]);

		await store.drop();
		expect(await rows(db, `SELECT name FROM sqlite_master WHERE name LIKE 'gen%'`)).toEqual([]);

		// the claim went with the table it lived in, so this handle claims again on
		// its next write rather than guarding on a token that no longer exists
		await store.migrate();
		await store.applyBlock(block(100), [owns('1', '0xcarol', 1)]);
		expect(await store.getCurrent<{owner: string}>('token', {id: '1'})).toMatchObject({owner: '0xcarol'});
	});

	it('is still the documented no-op on a store that never migrated', async () => {
		const store = new VersionedStateStore(createTestDB(), [TOKEN], {tableNamespace: 'gen'});
		await expect(store.drop()).resolves.not.toThrow();
	});
});

describe('the cursor, which no block record protects', () => {
	it('keeps the holder position when a lost writer tries to move it backwards', async () => {
		const db = createTestDB();
		const stale = new VersionedStateStore(db, [TOKEN]);
		const holder = new VersionedStateStore(db, [TOKEN]);
		await stale.migrate();
		await stale.applyBlock(block(100), [owns('1', '0xalice', 1)], {key: LAST_SYNC, value: 'at 100'});
		await holder.applyBlock(block(101), [owns('1', '0xbob', 2)], {key: LAST_SYNC, value: 'at 101'});

		// the quiet failure this whole guard exists for: a writer holding a stale
		// LastSync moving the recorded position BACKWARDS, leaving a state that is
		// internally consistent, reproducible on reload, and wrong.
		await expect(stale.writeCursor(LAST_SYNC, 'at 100')).rejects.toBeInstanceOf(StoreWriterChangedError);
		expect(await holder.readCursor(LAST_SYNC)).toBe('at 101');
	});
});
