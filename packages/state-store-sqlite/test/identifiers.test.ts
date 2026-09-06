import {describe, expect, it} from 'vitest';
import {normalizeEntity} from '@etherfold/state-store';
import {VersionedStateStore, listCurrentStatement, tableNames} from '../src/index.js';
import {createTestDB, rows} from './utils/db.js';
import {block} from './utils/fixtures.js';

/**
 * What only THIS backend can be asked about an identifier: that a name the seam
 * accepts survives being INTERPOLATED into SQL text.
 *
 * SQL cannot bind an identifier as a parameter, so a table or column name
 * reaches the engine as text, and a name with a perfectly valid identifier SHAPE
 * can still be a SQL KEYWORD -- `index`, `order`, `group`, `select`, `table`,
 * `where`, `default`, `references`, `primary`. Unquoted, `..., index INTEGER,
 * ...` is a syntax error, so the declaration passed validation and then died at
 * `migrate()`, on this backend only, while the light and IndexedDB backends
 * stored it without complaint.
 *
 * The fix is to QUOTE every identifier that comes from a declaration (see
 * `src/identifiers.ts`), which is why these assertions are here rather than in
 * the conformance suite: the CROSS-BACKEND property (the same declaration works
 * everywhere, or is refused everywhere) belongs to the seam and is asserted for
 * every backend by `@etherfold/state-store-conformance`; what belongs here is
 * the DDL and the statements this package emits.
 */

/** Every keyword the finding listed, each used as an identifier in turn. */
const KEYWORDS = ['index', 'order', 'group', 'select', 'table', 'where', 'default', 'references', 'primary'] as const;

describe('an identifier that is a SQL keyword', () => {
	it('migrates as an entity name, an id column and a field', async () => {
		const db = createTestDB();
		// the declaration from the finding, which passed validation and then made
		// migrate() throw `SQLITE_ERROR: near "index": syntax error`.
		const store = new VersionedStateStore(db, [
			{name: 'placementPlayer', id: ['epoch', 'position', 'index'], fields: {color: 'integer', address: 'text'}},
		]);
		await expect(store.migrate()).resolves.not.toThrow();

		const columns = await rows<{name: string; type: string}>(db, `PRAGMA table_info(placementPlayer)`);
		const byName = Object.fromEntries(columns.map((c) => [c.name, c]));
		expect(byName['index'].type).toBe('TEXT');
		expect(byName['color'].type).toBe('INTEGER');
	});

	it.each(KEYWORDS)('migrates with %s as a key column and as a data field', async (keyword) => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [
			{name: keyword, id: ['id', keyword], fields: {[`${keyword}Value`]: 'text'}},
			{name: `holder_${keyword}`, id: ['id'], fields: {[keyword]: 'text'}},
		]);
		await expect(store.migrate()).resolves.not.toThrow();

		const columns = await rows<{name: string}>(db, `PRAGMA table_info("${keyword}")`);
		expect(columns.map((c) => c.name)).toContain(keyword);
		const held = await rows<{name: string}>(db, `PRAGMA table_info(holder_${keyword})`);
		expect(held.map((c) => c.name)).toContain(keyword);
	});

	it('round-trips through every statement the store emits', async () => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [
			{name: 'order', id: ['group', 'index'], fields: {select: 'text', default: 'integer'}},
		]);
		await store.migrate();

		await store.applyBlock(block(100), [
			{type: 'upsert', entity: 'order', id: {group: 'a', index: '1'}, values: {select: 'first', default: 7}},
			{type: 'upsert', entity: 'order', id: {group: 'a', index: '2'}, values: {select: 'second', default: 8}},
		]);

		// the tip read, the as-of read, and the bounded listing on a keyword prefix
		expect(await store.getCurrent('order', {group: 'a', index: '1'})).toMatchObject({select: 'first', default: 7});
		expect(await store.getAsOf('order', {group: 'a', index: '2'}, 100)).toMatchObject({select: 'second'});
		const listed = await store.listCurrent<{select: string}>('order', {group: 'a'}, 10);
		expect(listed.rows.map((row) => row.select)).toEqual(['first', 'second']);

		// the caller-supplied-SQL tier: the identifiers are the caller's to quote
		expect(await store.queryCurrent('order', {where: '"default" > ?', args: [7]})).toHaveLength(1);

		// the close-then-insert write path, then the delete path
		await store.applyBlock(block(101), [
			{type: 'upsert', entity: 'order', id: {group: 'a', index: '1'}, values: {select: 'again', default: 9}},
		]);
		expect(await store.getCurrent('order', {group: 'a', index: '1'})).toMatchObject({select: 'again'});
		await store.applyBlock(block(102), [{type: 'delete', entity: 'order', id: {group: 'a', index: '2'}}]);
		expect(await store.getCurrent('order', {group: 'a', index: '2'})).toBeUndefined();

		// the revert path: DELETE the versions above the fork, re-open what it closed
		await store.revertTo(100);
		expect(await store.getCurrent('order', {group: 'a', index: '1'})).toMatchObject({select: 'first'});
		expect(await store.getCurrent('order', {group: 'a', index: '2'})).toMatchObject({select: 'second'});
	});

	it('prunes versions of a keyword entity like any other', async () => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [{name: 'table', id: ['where'], fields: {default: 'integer'}}], {
			retention: {blocks: 10},
			finalityDepth: 10,
		});
		await store.migrate();
		await store.applyBlock(block(100), [{type: 'upsert', entity: 'table', id: {where: 'x'}, values: {default: 1}}]);
		await store.applyBlock(block(101), [{type: 'upsert', entity: 'table', id: {where: 'x'}, values: {default: 2}}]);
		await store.applyBlock(block(200), []);

		const report = await store.prune();
		expect(report.versionsDeleted).toBe(1);
		// the live version survives whatever its age
		expect(await store.getCurrent('table', {where: 'x'})).toMatchObject({default: 2});
	});

	it('builds the indexes on the quoted columns, so the listing still rides them', async () => {
		const declaration = {name: 'order', id: ['group', 'index'], fields: {select: 'text'}} as const;
		const db = createTestDB();
		const store = new VersionedStateStore(db, [declaration]);
		await store.migrate();

		const indexes = await rows<{name: string}>(
			db,
			`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'order'`,
		);
		expect(indexes.map((i) => i.name).sort()).toEqual([
			'_order_history',
			'_order_lower',
			'_order_open',
			'_order_upper',
		]);

		// quoting must not cost the access path: a listing over a keyword id column
		// is still one indexed range scan, which is the whole reason the surface has
		// the shape it has (see `test/listing.test.ts`).
		const statement = listCurrentStatement(normalizeEntity(declaration), {group: 'a'}, 3, tableNames());
		const plan = await rows<{detail: string}>(db, `EXPLAIN QUERY PLAN ${statement.sql}`, ...statement.args);
		expect(plan).toHaveLength(1);
		expect(plan[0].detail).toMatch(/^SEARCH "?order"? USING INDEX _order_\w+ \(group=\?\)$/);
	});
});

describe('the identifier rules that did NOT change', () => {
	it('still rejects the store reserved `_` prefix', () => {
		const db = createTestDB();
		expect(() => new VersionedStateStore(db, [{name: '_secret', id: ['id'], fields: {}}])).toThrow(/reserved/i);
		expect(() => new VersionedStateStore(db, [{name: 'token', id: ['_rowid'], fields: {}}])).toThrow(/reserved/i);
		expect(() => new VersionedStateStore(db, [{name: 'token', id: ['id'], fields: {_lower: 'integer'}}])).toThrow(
			/reserved/i,
		);
	});

	it('still rejects a name that is not an identifier at all', () => {
		const db = createTestDB();
		// quoting a name is not a licence to interpolate anything: the shape check
		// is what keeps the quotes from being escapable in the first place.
		expect(() => new VersionedStateStore(db, [{name: 'to"ken', id: ['id'], fields: {}}])).toThrow(/identifier/i);
		expect(() => new VersionedStateStore(db, [{name: 'token', id: ['id"; DROP TABLE token; --'], fields: {}}])).toThrow(
			/identifier/i,
		);
		expect(() => new VersionedStateStore(db, [{name: 'token', id: ['id'], fields: {'a-b': 'text'}}])).toThrow(
			/identifier/i,
		);
	});
});
