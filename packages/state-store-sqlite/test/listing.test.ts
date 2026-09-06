import {describe, expect, it} from 'vitest';
import {VersionedStateStore, listAsOfStatement, listCurrentStatement, tableNames} from '../src/index.js';
import {normalizeEntity} from '@etherfold/state-store';
import {createTestDB, rows} from './utils/db.js';
import {PLACEMENT, block, placed} from './utils/fixtures.js';

/**
 * What only THIS backend can be asked about the bounded id-prefix listing.
 *
 * The BEHAVIOUR of a listing (ascending id order, the limit, truncation,
 * read-your-writes, as-of) is the seam's, and is asserted for every backend by
 * `@etherfold/state-store-conformance`. What is asserted here is the ACCESS
 * PATH, which is the reason the surface was given this exact shape: a listing
 * must be one indexed range scan against the declared id, and no amount of
 * behavioural testing can see the difference between that and a table scan that
 * happens to return the same rows.
 */

const ENTITY = normalizeEntity(PLACEMENT);

async function withPlacements() {
	const db = createTestDB();
	const store = new VersionedStateStore(db, [PLACEMENT]);
	await store.migrate();
	await store.applyBlock(block(100), [
		placed(7, 2, 0, '0xcarol'),
		placed(7, 1, 1, '0xbob'),
		placed(7, 1, 0, '0xalice'),
		placed(8, 0, 0, '0xzoe'),
	]);
	return {db, store};
}

/** SQLite's own account of how it would run a statement. */
async function queryPlan(db: ReturnType<typeof createTestDB>, sql: string, args: unknown[]): Promise<string[]> {
	const plan = await rows<{detail: string}>(db, `EXPLAIN QUERY PLAN ${sql}`, ...args);
	return plan.map((step) => step.detail);
}

describe('the statement a listing compiles to', () => {
	it('is an equality on the leading id columns, ordered by the id, with a bound', () => {
		expect(listCurrentStatement(ENTITY, {epoch: 7}, 3, tableNames())).toEqual({
			sql:
				`SELECT * FROM "placement" WHERE "epoch" = ? AND _upper IS NULL ` +
				`ORDER BY "epoch", "position", "playerIndex" LIMIT ?`,
			// the bound is limit + 1: the extra row is what makes `truncated` a fact
			args: ['7', 4],
		});
	});

	it('adds the as-of predicate and nothing else when it is asked about a block', () => {
		expect(listAsOfStatement(ENTITY, {epoch: 7, position: 1}, 102, 3, tableNames())).toEqual({
			sql:
				`SELECT * FROM "placement" WHERE "epoch" = ? AND "position" = ? AND ` +
				`_lower <= ? AND (_upper IS NULL OR ? < _upper) ` +
				`ORDER BY "epoch", "position", "playerIndex" LIMIT ?`,
			args: ['7', '1', 102, 102, 4],
		});
	});

	it('has nowhere to put a predicate, a sort or an offset', () => {
		const sql = listCurrentStatement(ENTITY, {epoch: 7}, 3, tableNames()).sql;
		expect(sql).not.toMatch(/OFFSET/i);
		// the only ORDER BY is the declared id, and it is not caller-supplied
		expect(sql.match(/ORDER BY/gi)).toHaveLength(1);
		expect(sql).toMatch(/ORDER BY "epoch", "position", "playerIndex" LIMIT \?$/);
	});
});

describe('a listing is ONE indexed range scan', () => {
	it('rides the id index at the tip, with no temp b-tree for the ordering', async () => {
		const {db} = await withPlacements();
		const statement = listCurrentStatement(ENTITY, {epoch: 7}, 3, tableNames());

		const plan = await queryPlan(db, statement.sql, statement.args);

		expect(plan).toHaveLength(1);
		expect(plan[0]).toMatch(/^SEARCH placement USING INDEX _placement_\w+ \(epoch=\?\)$/);
		expect(plan.join('\n')).not.toMatch(/TEMP B-TREE|SCAN placement/);
	});

	it('rides it for a longer prefix too, using both columns to seek', async () => {
		const {db} = await withPlacements();
		const statement = listCurrentStatement(ENTITY, {epoch: 7, position: 1}, 3, tableNames());

		const plan = await queryPlan(db, statement.sql, statement.args);

		expect(plan).toHaveLength(1);
		expect(plan[0]).toMatch(/USING INDEX _placement_\w+ \(epoch=\? AND position=\?\)/);
	});

	it('rides it for an as-of listing, which is the same range under the validity predicate', async () => {
		const {db} = await withPlacements();
		const statement = listAsOfStatement(ENTITY, {epoch: 7}, 100, 3, tableNames());

		const plan = await queryPlan(db, statement.sql, statement.args);

		expect(plan).toHaveLength(1);
		expect(plan[0]).toMatch(/^SEARCH placement USING INDEX _placement_\w+ \(epoch=\?\)$/);
		expect(plan.join('\n')).not.toMatch(/TEMP B-TREE|SCAN placement/);
	});
});

describe('the listing this backend actually answers with', () => {
	it('reads a whole row per child, version columns and all', async () => {
		const {store} = await withPlacements();

		const {rows: children, truncated} = await store.listCurrent<Record<string, unknown>>('placement', {epoch: 7}, 10);

		expect(children.map((child) => child.player)).toEqual(['0xalice', '0xbob', '0xcarol']);
		expect(children[0]).toMatchObject({epoch: '7', position: '1', playerIndex: '0', _lower: 100, _upper: null});
		expect(truncated).toBe(false);
	});

	it('answers about an old block, and refuses an address that is no block at all', async () => {
		const {store} = await withPlacements();
		await store.applyBlock(block(101), [
			{type: 'delete', entity: 'placement', id: {epoch: 7, position: 1, playerIndex: 0}},
		]);

		// the hash axis works here exactly as it does for `getAsOf`: this backend
		// resolves an address, the seam only ever sees the resolved number.
		const at100 = await store.listAsOf<{player: string}>('placement', {epoch: 7}, {hash: block(100).hash}, 10);
		expect(at100.rows.map((child) => child.player)).toEqual(['0xalice', '0xbob', '0xcarol']);
		expect((await store.listCurrent<{player: string}>('placement', {epoch: 7}, 10)).rows.map((c) => c.player)).toEqual([
			'0xbob',
			'0xcarol',
		]);

		await expect(store.listAsOf('placement', {epoch: 7}, {hash: '0xdeadbeef'}, 10)).rejects.toThrow(/no such block/i);
	});
});
