import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {BlockNotRetainedError, type EntityDeclaration, type Mutation} from '@etherfold/state-store';
import {deleteDatabase, IndexedDBStateStore} from '../src/index.js';
import {freshDatabaseName} from './utils/database.js';
import {recordAccess} from './utils/access-path.js';

/**
 * The property this backend exists for: the state is IN the database, so a
 * reload is a new connection rather than a rebuild.
 *
 * The incumbent this replaced (`keepStateOnIndexedDB`, deleted by ADR-0037)
 * handed the whole state object to IndexedDB on every save and read all of it
 * back on load: measured at 70 ms on Chromium at 44,000 rows, and growing with
 * total state
 * (`work/notes/findings/sqlite-in-the-browser.md`). Here a cold start reads
 * nothing at all, and the first read reads one row. That -- with history and
 * revert -- is what row-level writes buy, and they are NOT a throughput win at
 * today's sizes: the blob writes a block in 2.0 ms where this writes it in 45.6.
 */

const TOKEN: EntityDeclaration = {name: 'token', id: ['id'], fields: {owner: 'text'}};

function owns(id: string, owner: string): Mutation {
	return {type: 'upsert', entity: 'token', id: {id}, values: {owner}};
}

function block(number: number) {
	return {number, hash: `0x${number.toString(16)}`, timestamp: 1_700_000_000 + number * 12};
}

describe('a reload is a new connection to the same rows', () => {
	it('finds the state, the history and the tip where the last session left them', async () => {
		const databaseName = freshDatabaseName();
		const first = new IndexedDBStateStore([TOKEN], {databaseName});
		await first.migrate();
		await first.applyBlock(block(100), [owns('1', '0xalice')]);
		await first.applyBlock(block(101), [owns('1', '0xbob')]);
		await first.close();

		const second = new IndexedDBStateStore([TOKEN], {databaseName});
		await second.migrate();

		expect(await second.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xbob'});
		expect(await second.getAsOf('token', {id: '1'}, 100)).toMatchObject({owner: '0xalice'});
		// and the height is still taken, which is how a resumed session knows it
		// has already processed that block
		await expect(second.applyBlock(block(101), [owns('1', '0xcarol')])).rejects.toThrow(/already recorded/);
		await second.close();
	});

	it('costs nothing to start: opening reads no rows, and the first read reads one', async () => {
		const databaseName = freshDatabaseName();
		const first = new IndexedDBStateStore([TOKEN], {databaseName});
		await first.migrate();
		await first.applyBlock(block(100), [owns('1', '0xalice'), owns('2', '0xbob'), owns('3', '0xcarol')]);
		await first.close();

		const log = recordAccess();
		try {
			const second = new IndexedDBStateStore([TOKEN], {databaseName});
			await second.migrate();
			expect(log.requests).toEqual([]);

			await second.getCurrent('token', {id: '2'});
			await second.close();
		} finally {
			log.stop();
		}

		// one `get`, whatever the store holds. The whole-state blob's cold start is
		// a read and a revive of everything, and it grows with total state.
		expect(log.requests).toEqual([{method: 'get', on: 'current', query: ['token', '2']}]);
	});

	it('measures its retention window against the tip in the database, not one it remembers', async () => {
		const databaseName = freshDatabaseName();
		const first = new IndexedDBStateStore([TOKEN], {databaseName, retention: {blocks: 64}, finalityDepth: 64});
		await first.migrate();
		await first.applyBlock(block(100), [owns('1', '0xalice')]);
		await first.applyBlock(block(1_000), [owns('2', '0xbob')]);
		await first.close();

		const second = new IndexedDBStateStore([TOKEN], {databaseName, retention: {blocks: 64}, finalityDepth: 64});
		await second.migrate();

		// a fresh instance has written nothing and remembers no tip; asking it
		// about block 100 must still be REFUSED, because the tip is 1,000 and the
		// window is 64. A store that measured against what it had seen itself would
		// answer, from versions it kept but no longer promises.
		await expect(second.getAsOf('token', {id: '1'}, 100)).rejects.toBeInstanceOf(BlockNotRetainedError);
		expect(await second.getAsOf('token', {id: '2'}, 1_000)).toMatchObject({owner: '0xbob'});
		await second.close();
	});
});

describe('two connections to one database', () => {
	/**
	 * The node-side stand-in for two tabs. The real four-tab evidence is
	 * `browser/multi-tab.spec.ts`, which is where a browser's own transaction
	 * scheduling can be observed; what is asserted here is that this store holds
	 * nothing in memory that a second connection would contradict.
	 *
	 * It is the case both wasm-SQLite VFSs FAIL AT OPEN (three of four tabs, with
	 * `createSyncAccessHandle` or `SQLITE_BUSY`), and it is a large part of why
	 * this backend is the browser default.
	 */
	it('sees each other`s blocks, and refuses a height the other one took', async () => {
		const databaseName = freshDatabaseName();
		const a = new IndexedDBStateStore([TOKEN], {databaseName});
		const b = new IndexedDBStateStore([TOKEN], {databaseName});
		await a.migrate();
		await b.migrate();

		await a.applyBlock(block(100), [owns('from-a', '0xalice')]);
		await b.applyBlock(block(101), [owns('from-b', '0xbob')]);

		expect(await a.getCurrent('token', {id: 'from-b'})).toMatchObject({owner: '0xbob'});
		expect(await b.getCurrent('token', {id: 'from-a'})).toMatchObject({owner: '0xalice'});
		await expect(b.applyBlock(block(100), [owns('from-b', '0xcarol')])).rejects.toThrow(/already recorded/);

		const listing = await a.listCurrent('token', {id: 'from-a'}, 10);
		expect(listing.rows).toHaveLength(1);
		await a.close();
		await b.close();
	});

	it('interleaves writes from both without losing one', async () => {
		const databaseName = freshDatabaseName();
		const a = new IndexedDBStateStore([TOKEN], {databaseName});
		const b = new IndexedDBStateStore([TOKEN], {databaseName});
		await Promise.all([a.migrate(), b.migrate()]);

		// The heights ASCEND across both connections, and that is not decoration: a
		// store's blocks are ONE sequence, so a block must be above the recorded tip
		// whichever connection offers it. "Each tab owns its own heights" is therefore
		// not a way for two writers to share a database -- it never was -- and this
		// case is about the other thing, that neither handle caches state the other
		// would contradict. They are still applied concurrently: one block is one
		// transaction, so the engine serialises them in the order they were issued.
		const issued = [100, 101, 102, 103, 104, 105].map((number, index) =>
			index % 2 === 0
				? a.applyBlock(block(number), [owns(`a-${number}`, '0xalice')])
				: b.applyBlock(block(number), [owns(`b-${number}`, '0xbob')]),
		);
		await Promise.all(issued);

		for (const number of [100, 102, 104]) {
			expect(await b.getCurrent('token', {id: `a-${number}`})).toMatchObject({owner: '0xalice'});
		}
		for (const number of [101, 103, 105]) {
			expect(await a.getCurrent('token', {id: `b-${number}`})).toMatchObject({owner: '0xbob'});
		}
		await a.close();
		await b.close();
	});
});

describe('a database can be dropped', () => {
	it('leaves nothing behind, so the next store starts empty', async () => {
		const databaseName = freshDatabaseName();
		const store = new IndexedDBStateStore([TOKEN], {databaseName});
		await store.migrate();
		await store.applyBlock(block(100), [owns('1', '0xalice')]);
		await store.close();

		await deleteDatabase(databaseName);

		const next = new IndexedDBStateStore([TOKEN], {databaseName});
		await next.migrate();
		expect(await next.getCurrent('token', {id: '1'})).toBeUndefined();
		await next.close();
	});
});
