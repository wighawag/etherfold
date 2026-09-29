import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {type EntityDeclaration} from '@etherfold/state-store';
import {
	BLOCKS,
	CURRENT,
	CURSORS,
	HASH_INDEX,
	IndexedDBStateStore,
	LOWER_INDEX,
	openDatabase,
	SCHEMA_VERSION,
	SEAM,
	UPPER_INDEX,
	VERSIONS,
	WRITER_KEY,
} from '../src/index.js';
import {freshDatabaseName} from './utils/database.js';

/**
 * The key layout: each id column is keyed by its UTF-8 BYTES, so the key order
 * IndexedDB walks is the listing's id order (ADR-0021), and a database written
 * under the layout before it (id columns as STRING keys, whose order is UTF-16
 * code units) is never read by this code: it is discarded at the version change
 * and comes back empty in the new layout.
 *
 * The order itself is the conformance suite's to assert (`bounded id-prefix
 * listing`, on every backend); what only this backend can be asked is what its
 * keys ARE and what happens to a database the previous layout wrote.
 */

const PLACEMENT: EntityDeclaration = {
	name: 'placement',
	id: ['epoch', 'position', 'playerIndex'],
	fields: {player: 'text'},
};

function block(number: number) {
	return {number, hash: `0x${number.toString(16)}`, timestamp: 1_700_000_000 + number * 12};
}

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function done(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

/**
 * A database exactly as the previous layout wrote it: version 1, the same five
 * object stores and indexes, and the id columns as STRING keys. Written by hand
 * rather than by an old build, because an old build is not in the tree; the
 * layout it wrote is `rowKey` before the change, `[entity, ...idStrings]`.
 */
async function writtenWithTheOldLayout(databaseName: string): Promise<void> {
	const db = await openDatabase(databaseName, 1, (db) => {
		db.createObjectStore(SEAM);
		db.createObjectStore(CURSORS);
		db.createObjectStore(CURRENT);
		const versions = db.createObjectStore(VERSIONS);
		versions.createIndex(LOWER_INDEX, 'lower');
		versions.createIndex(UPPER_INDEX, 'upper');
		const blocks = db.createObjectStore(BLOCKS, {keyPath: 'number'});
		blocks.createIndex(HASH_INDEX, 'hash', {unique: true});
	});
	const tx = db.transaction([SEAM, CURSORS, CURRENT, VERSIONS, BLOCKS], 'readwrite');
	const written = done(tx);
	// ids either side of the UTF-8 / UTF-16 boundary, so reading them in the old
	// key order would be visible: U+1F600 before U+E000
	for (const [position, player] of [
		['\u{1F600}', 'U+1F600'],
		['\uE000', 'U+E000'],
	]) {
		const values = {epoch: '7', position, playerIndex: '0', player};
		tx.objectStore(CURRENT).put({lower: 100, values}, ['placement', '7', position, '0']);
		tx.objectStore(VERSIONS).put({lower: 100, upper: null, values}, ['placement', '7', position, '0', 100]);
	}
	tx.objectStore(BLOCKS).put(block(100));
	tx.objectStore(CURSORS).put('100', 'sync');
	tx.objectStore(SEAM).put('a-writer-from-the-old-build', WRITER_KEY);
	await written;
	db.close();
}

/** The raw primary keys of `current`, in the order IndexedDB walks them. */
async function rawKeys(databaseName: string): Promise<{version: number; keys: IDBValidKey[]}> {
	const db = await openDatabase(databaseName, SCHEMA_VERSION, () => {
		throw new Error('the store should already have brought the database to this version');
	});
	try {
		return {
			version: db.version,
			keys: await request(db.transaction(CURRENT, 'readonly').objectStore(CURRENT).getAllKeys()),
		};
	} finally {
		db.close();
	}
}

describe('the key layout keys each id column by its UTF-8 bytes', () => {
	it('stores a row under [entity, ...UTF-8 bytes of each id column], so the key order is UTF-8 byte order', async () => {
		const databaseName = freshDatabaseName();
		const store = new IndexedDBStateStore([PLACEMENT], {databaseName});
		await store.migrate();
		await store.applyBlock(block(100), [
			{
				type: 'upsert',
				entity: 'placement',
				id: {epoch: 7, position: '\u{1F600}', playerIndex: 0},
				values: {player: 'x'},
			},
			{type: 'upsert', entity: 'placement', id: {epoch: 7, position: '\uE000', playerIndex: 0}, values: {player: 'y'}},
		]);
		await store.close();

		const {keys} = await rawKeys(databaseName);
		const decoded = keys.map((key) =>
			(key as IDBValidKey[]).map((part) =>
				typeof part === 'string' ? part : new TextDecoder().decode(part as ArrayBuffer),
			),
		);

		// the entity name stays a string; every id column is bytes
		expect(keys.every((key) => typeof (key as IDBValidKey[])[0] === 'string')).toBe(true);
		expect(keys.every((key) => (key as IDBValidKey[]).slice(1).every((part) => part instanceof ArrayBuffer))).toBe(
			true,
		);
		// and walked in UTF-8 order: U+E000 (EE 80 80) before U+1F600 (F0 9F 98 80)
		expect(decoded).toEqual([
			['placement', '7', '\uE000', '0'],
			['placement', '7', '\u{1F600}', '0'],
		]);
	});

	it('keeps the id columns readable as strings in the record itself', async () => {
		const databaseName = freshDatabaseName();
		const store = new IndexedDBStateStore([PLACEMENT], {databaseName});
		await store.migrate();
		await store.applyBlock(block(100), [
			{type: 'upsert', entity: 'placement', id: {epoch: 7, position: 'a', playerIndex: 0}, values: {player: 'x'}},
		]);

		expect(await store.storedCurrent('placement', {epoch: 7, position: 'a', playerIndex: 0})).toMatchObject({
			epoch: '7',
			position: 'a',
			playerIndex: '0',
		});
		await store.close();
	});
});

describe('a database written with the previous layout', () => {
	it('is recreated EMPTY in the new layout, never read in the old order', async () => {
		const databaseName = freshDatabaseName();
		await writtenWithTheOldLayout(databaseName);

		const store = new IndexedDBStateStore([PLACEMENT], {databaseName});
		await store.migrate();

		// nothing the old layout wrote is visible: no rows, no history, no tip, no
		// cursor, and no writer claim standing in the way of this handle
		expect(await store.listCurrent('placement', {epoch: 7}, 10)).toEqual({rows: [], truncated: false});
		expect(await store.getCurrent('placement', {epoch: 7, position: '\uE000', playerIndex: 0})).toBeUndefined();
		expect(await store.tip()).toBeUndefined();
		expect(await store.readCursor('sync')).toBeUndefined();

		// and it is a working database in the new layout: the same height applies
		// again, and lists in UTF-8 order
		await store.applyBlock(block(100), [
			{
				type: 'upsert',
				entity: 'placement',
				id: {epoch: 7, position: '\u{1F600}', playerIndex: 0},
				values: {player: 'U+1F600'},
			},
			{
				type: 'upsert',
				entity: 'placement',
				id: {epoch: 7, position: '\uE000', playerIndex: 0},
				values: {player: 'U+E000'},
			},
		]);
		const listing = await store.listCurrent<{player: string}>('placement', {epoch: 7}, 10);
		expect(listing.rows.map((row) => row.player)).toEqual(['U+E000', 'U+1F600']);
		await store.close();

		const {version, keys} = await rawKeys(databaseName);
		expect(version).toBe(SCHEMA_VERSION);
		expect(keys.every((key) => (key as IDBValidKey[]).slice(1).every((part) => part instanceof ArrayBuffer))).toBe(
			true,
		);
	});

	it('is recreated only once: a database already in the new layout keeps its rows across a reopen', async () => {
		const databaseName = freshDatabaseName();
		await writtenWithTheOldLayout(databaseName);
		const first = new IndexedDBStateStore([PLACEMENT], {databaseName});
		await first.migrate();
		await first.applyBlock(block(100), [
			{type: 'upsert', entity: 'placement', id: {epoch: 7, position: 'a', playerIndex: 0}, values: {player: 'kept'}},
		]);
		await first.close();

		const second = new IndexedDBStateStore([PLACEMENT], {databaseName});
		await second.migrate();
		expect(await second.getCurrent('placement', {epoch: 7, position: 'a', playerIndex: 0})).toMatchObject({
			player: 'kept',
		});
		await second.close();
	});
});
