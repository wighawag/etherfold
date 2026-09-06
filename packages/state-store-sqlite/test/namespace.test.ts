import {describe, expect, it} from 'vitest';
import {VersionedStateStore} from '../src/index.js';
import {createTestDB, rows} from './utils/db.js';
import {ACCOUNT, TOKEN, block, owns} from './utils/fixtures.js';

/**
 * TWO GENERATIONS FOLDING INTO ONE DATABASE, AND TOUCHING NOTHING OF EACH OTHER'S.
 *
 * A **generation** is a stream plus a fold over it, an indexer holds several and
 * one is canonical (ADR-0053). Their state is a TABLE-NAME NAMESPACE inside ONE
 * database rather than a generation COLUMN or a database each, so a successor
 * rebuilding beside the incumbent writes its own entity tables, its own
 * `_blocks` and its own `_cursor`, and retiring one is a `DROP` of exactly its
 * tables.
 *
 * The isolation is asserted through the SEAM's own reads rather than by
 * comparing table listings, because a listing cannot tell a shared row from two
 * rows that happen to look alike. `_blocks` and `_cursor` are the two that would
 * be easiest to leave shared and the two that would hurt most: one generation's
 * `revertTo` would delete blocks the other still needs, and one fixed cursor key
 * (`lastSync`, the same string for every fold) would have a second generation
 * resume on the first's position.
 */

/**
 * The key a fold's sync cursor lives under, spelled out rather than imported.
 *
 * It is `SYNC_CURSOR_KEY` in `@etherfold/processor-entities`, and the point of
 * this test is that it is FIXED: every generation of every processor writes its
 * position under the same string, so only the namespace keeps two folds from
 * resuming on each other's cursor. This package knows nothing about that
 * package (ADR-0027 keeps the cursor opaque here), so the literal is the honest
 * spelling.
 */
const LAST_SYNC = 'lastSync';

/** Two generations of one indexer, folding into one database handle. */
async function twoGenerations() {
	const db = createTestDB();
	const incumbent = new VersionedStateStore(db, [TOKEN, ACCOUNT], {tableNamespace: 'genA'});
	const successor = new VersionedStateStore(db, [TOKEN, ACCOUNT], {tableNamespace: 'genB'});
	await incumbent.migrate();
	await successor.migrate();
	return {db, incumbent, successor};
}

/** Every table and index the database holds, minus the ones SQLite made for itself. */
async function namesIn(db: ReturnType<typeof createTestDB>): Promise<string[]> {
	const objects = await rows<{name: string}>(
		db,
		`SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
	);
	return objects.map((object) => object.name);
}

describe('two stores over ONE handle, under different namespaces', () => {
	it('writes an entity in one and changes nothing readable in the other', async () => {
		const {incumbent, successor} = await twoGenerations();

		await incumbent.applyBlock(block(100), [owns('1', '0xAlice', 1)]);

		expect(await incumbent.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xAlice'});
		expect(await successor.getCurrent('token', {id: '1'})).toBeUndefined();

		// and the other direction, at the same id: the two rows are two rows
		await successor.applyBlock(block(100), [owns('1', '0xBob', 7)]);
		expect(await incumbent.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xAlice'});
		expect(await successor.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xBob'});
	});

	it('keeps their sync cursors independent, under the SAME key', async () => {
		const {incumbent, successor} = await twoGenerations();

		// the key is the processor's and is fixed (`lastSync`), so nothing but the
		// namespace can keep two folds from resuming on each other's position
		await incumbent.writeCursor(LAST_SYNC, 'incumbent@100');
		expect(await successor.readCursor(LAST_SYNC)).toBeUndefined();

		await successor.writeCursor(LAST_SYNC, 'successor@40');
		expect(await incumbent.readCursor(LAST_SYNC)).toBe('incumbent@100');

		await successor.clearCursor(LAST_SYNC);
		expect(await incumbent.readCursor(LAST_SYNC)).toBe('incumbent@100');
	});

	it('records blocks separately, so one fold sees nothing of the other height', async () => {
		const {incumbent, successor} = await twoGenerations();

		await incumbent.applyBlock(block(100), [owns('1', '0xAlice', 1)]);

		expect(await incumbent.getBlock({hash: block(100).hash})).toMatchObject({number: 100});
		expect(await successor.getBlock({hash: block(100).hash})).toBeUndefined();
		// the same block applied by both is not a primary-key violation: two tables
		await expect(successor.applyBlock(block(100), [owns('1', '0xBob', 1)])).resolves.not.toThrow();
	});
});

describe('a revert or a prune in one generation', () => {
	it('leaves the other generation blocks and rows exactly where they were', async () => {
		const {incumbent, successor} = await twoGenerations();

		for (const store of [incumbent, successor]) {
			await store.applyBlock(block(100), [owns('1', '0xAlice', 1)]);
			await store.applyBlock(block(101), [owns('1', '0xBob', 2)]);
			await store.applyBlock(block(102), [owns('1', '0xCarol', 3)]);
		}

		await successor.revertTo(101);

		// the successor rolled back...
		expect(await successor.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xBob'});
		expect(await successor.getBlock(102)).toBeUndefined();
		// ...and the incumbent, which is what still answers reads, did not
		expect(await incumbent.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xCarol'});
		expect(await incumbent.getBlock(102)).toMatchObject({number: 102});
		expect(await incumbent.getAsOf('token', {id: '1'}, 102)).toMatchObject({owner: '0xCarol'});
	});

	it('prunes only its own versions', async () => {
		const db = createTestDB();
		const kept = new VersionedStateStore(db, [TOKEN], {tableNamespace: 'genA'});
		const pruning = new VersionedStateStore(db, [TOKEN], {
			tableNamespace: 'genB',
			retention: {blocks: 1},
			finalityDepth: 1,
		});
		await kept.migrate();
		await pruning.migrate();

		for (const store of [kept, pruning]) {
			await store.applyBlock(block(100), [owns('1', '0xAlice', 1)]);
			await store.applyBlock(block(101), [owns('1', '0xBob', 2)]);
			await store.applyBlock(block(102), [owns('1', '0xCarol', 3)]);
		}

		// tip 102 under a one-block window: the version closed at 101 is out of reach
		const report = await pruning.prune();
		expect(report.versionsDeleted).toBe(1);

		// the same superseded version is still there for the generation that keeps it
		expect(await kept.getAsOf('token', {id: '1'}, 100)).toMatchObject({owner: '0xAlice'});
	});
});

describe('dropping one generation state', () => {
	it('removes exactly its tables and their indexes, and leaves the other READABLE', async () => {
		const {db, incumbent, successor} = await twoGenerations();

		await incumbent.applyBlock(block(100), [owns('1', '0xAlice', 1)]);
		await incumbent.writeCursor(LAST_SYNC, 'incumbent@100');
		await successor.applyBlock(block(100), [owns('1', '0xBob', 1)]);

		const before = await namesIn(db);
		await successor.drop();
		const after = await namesIn(db);

		// exactly the successor's: its two entity tables, its `_blocks`, its
		// `_cursor`, and every index derived from them
		expect(before.filter((name) => !after.includes(name)).sort()).toEqual(
			[
				'_genB_account_history',
				'_genB_account_lower',
				'_genB_account_open',
				'_genB_account_upper',
				'_genB_blocks',
				'_genB_blocks_timestamp',
				'_genB_cursor',
				'_genB_token_history',
				'_genB_token_lower',
				'_genB_token_open',
				'_genB_token_upper',
				'genB_account',
				'genB_token',
			].sort(),
		);
		// nothing of the incumbent's went with it
		expect(after.filter((name) => name.includes('genB'))).toEqual([]);
		expect(after).toEqual(before.filter((name) => !name.includes('genB')));

		// and the assertion the listing cannot make: it still ANSWERS
		expect(await incumbent.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xAlice'});
		expect(await incumbent.getAsOf('token', {id: '1'}, 100)).toMatchObject({owner: '0xAlice'});
		expect(await incumbent.getBlock({hash: block(100).hash})).toMatchObject({number: 100});
		expect(await incumbent.readCursor(LAST_SYNC)).toBe('incumbent@100');
	});

	it('is idempotent, and a dropped generation can be migrated back', async () => {
		const {successor} = await twoGenerations();

		await successor.drop();
		await expect(successor.drop()).resolves.not.toThrow();

		await successor.migrate();
		await successor.applyBlock(block(1), [owns('1', '0xBob', 1)]);
		expect(await successor.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xBob'});
	});
});

describe('with NO namespace configured', () => {
	it('creates exactly the names it creates today, byte for byte', async () => {
		const db = createTestDB();
		await new VersionedStateStore(db, [TOKEN]).migrate();

		expect(await namesIn(db)).toEqual([
			'_blocks',
			'_blocks_timestamp',
			'_cursor',
			'_token_history',
			'_token_lower',
			'_token_open',
			'_token_upper',
			'token',
		]);
	});
});

describe('the names a namespace produces', () => {
	it('put it where the reserved `_` prefix still leads', async () => {
		const db = createTestDB();
		await new VersionedStateStore(db, [TOKEN], {tableNamespace: 'genA'}).migrate();

		const names = await namesIn(db);
		// an entity table is the declaration's name under the namespace...
		expect(names).toContain('genA_token');
		// ...and everything the STORE owns keeps the `_` prefix that says "not a
		// user entity", with the namespace INSIDE it: the reserved namespace still
		// leads, so a fixed table is still recognisable as one
		// (`packages/cli/test/fixedTableNamespace.test.ts`).
		expect(names).toContain('_genA_blocks');
		expect(names).toContain('_genA_cursor');
		expect(names).toContain('_genA_token_open');
		expect(names.filter((name) => name !== 'genA_token').every((name) => name.startsWith('_'))).toBe(true);
	});
});

describe('a namespace this store could not keep separate', () => {
	it('is refused at CONSTRUCTION, like every other identifier rule here', () => {
		// an underscore is the SEPARATOR, so allowing one in the namespace would make
		// `a_b` + `c` and `a` + `b_c` the same table: two generations silently
		// sharing rows, which is the one thing this namespace exists to prevent
		expect(() => new VersionedStateStore(createTestDB(), [TOKEN], {tableNamespace: 'gen_a'})).toThrow(/namespace/i);
		expect(() => new VersionedStateStore(createTestDB(), [TOKEN], {tableNamespace: 'gen-a'})).toThrow(/namespace/i);
		expect(() => new VersionedStateStore(createTestDB(), [TOKEN], {tableNamespace: ''})).toThrow(/namespace/i);
		expect(() => new VersionedStateStore(createTestDB(), [TOKEN], {tableNamespace: 'a b'})).toThrow(/namespace/i);
		expect(() => new VersionedStateStore(createTestDB(), [TOKEN], {tableNamespace: 'gen"a'})).toThrow(/namespace/i);
	});

	it('refuses `sqlite`, because its entity tables would be `sqlite_<entity>`', () => {
		// the engine refuses a `sqlite_` object name however it is quoted, so this
		// has to fail where the store was constructed rather than at `migrate()`
		expect(() => new VersionedStateStore(createTestDB(), [TOKEN], {tableNamespace: 'sqlite'})).toThrow(/sqlite_/);
		expect(() => new VersionedStateStore(createTestDB(), [TOKEN], {tableNamespace: 'SQLite'})).toThrow(/sqlite_/);
	});

	it('takes a rendered generation digest as it comes', async () => {
		// `generationDigestOf` (`@etherfold/core`) is 32 lowercase hex characters and
		// may start with a digit; every name this store emits is either quoted or
		// begins with `_`, so a digest needs no decoration to be a namespace.
		const digest = '3f2a9c1b4d6e8f0a2b4c6d8e0f1a3b5c';
		const db = createTestDB();
		const store = new VersionedStateStore(db, [TOKEN], {tableNamespace: digest});
		await store.migrate();
		await store.applyBlock(block(1), [owns('1', '0xAlice', 1)]);

		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xAlice'});
		expect(await namesIn(db)).toContain(`${digest}_token`);
	});
});
