import 'fake-indexeddb/auto';
import {
	openForReading,
	openForWriting,
	openSnapshotAware,
	StoreWriterChangedError,
	type EntityDeclaration,
} from '@etherfold/state-store';
import {afterEach, describe, expect, it} from 'vitest';
import {IndexedDBStateStore} from '../src/index.js';
import {freshDatabaseName} from './utils/database.js';

/**
 * THE QUERY LAYER'S READS on this backend (ADR-0099, amended 2026-09-30): the
 * block at a height, the block a HASH names (through the `hash` index the blocks
 * store keeps unique), and the REVERT SEQUENCE a query reads at its start and its
 * end, kept in the seam's own object store so a READER tab sees the increments
 * its leader's reverts make.
 */

const TOKEN: EntityDeclaration = {name: 'token', id: ['id'], fields: {owner: 'text'}};
const hashOf = (number: number) => `0x${number.toString(16).padStart(64, '0')}`;
const block = (number: number, hash = hashOf(number)) => ({number, hash, timestamp: 1_700_000_000 + number * 12});
const owns = (id: string, owner: string) => ({type: 'upsert', entity: 'token', id: {id}, values: {owner}}) as const;

const open: IndexedDBStateStore[] = [];
afterEach(async () => {
	for (const store of open.splice(0)) await store.close();
});

/** Two connections to ONE database: what a leader tab and a reader tab hold. */
async function seeded() {
	const databaseName = freshDatabaseName();
	const store = new IndexedDBStateStore([TOKEN], {databaseName});
	const other = new IndexedDBStateStore([TOKEN], {databaseName});
	open.push(store, other);
	await store.migrate();
	await store.applyBlock(block(100), [owns('1', '0xalice')]);
	await store.applyBlock(block(101), [owns('1', '0xbob')]);
	await store.applyBlock(block(102), [owns('1', '0xcarol')]);
	return {store, other};
}

describe('the block reads', () => {
	it('answer the recorded block at a height and by hash, and nothing for one never recorded', async () => {
		const {store} = await seeded();

		expect(await store.tip()).toBe(102);
		expect(await store.blockAt(101)).toEqual(block(101));
		expect(await store.blockOf(hashOf(101))).toEqual(block(101));
		// folded to lower case on write AND on lookup (ADR-0015)
		await store.applyBlock(block(103, `0x${'Ab'.repeat(32)}`), [owns('1', '0xdan')]);
		for (const spelling of [`0x${'AB'.repeat(32)}`, `0x${'ab'.repeat(32)}`]) {
			expect(await store.blockOf(spelling)).toEqual({...block(103), hash: `0x${'ab'.repeat(32)}`});
		}
		expect(await store.blockAt(99)).toBeUndefined();
		expect(await store.blockOf(`0x${'ee'.repeat(32)}`)).toBeUndefined();
	});

	it('forget a block reverted away', async () => {
		const {store} = await seeded();
		await store.revertTo(101);

		expect(await store.blockOf(hashOf(102))).toBeUndefined();
		expect(await store.blockAt(102)).toBeUndefined();
	});
});

describe('the revert sequence', () => {
	it('is 0 before the first revert, and counts every revert, one that removed nothing included', async () => {
		const {store} = await seeded();
		expect(await store.revertSequence()).toBe(0);

		await store.revertTo(101);
		expect(await store.revertSequence()).toBe(1);
		await store.revertTo(101);
		expect(await store.revertSequence()).toBe(2);
		await store.applyBlock(block(102), [owns('1', '0xdan')]);
		expect(await store.revertSequence()).toBe(2);
	});

	it('is PERSISTED: a READER over another connection reads the increments its leader makes', async () => {
		const {store, other} = await seeded();
		const leader = await openForWriting(store);
		const reader = openForReading(other) as IndexedDBStateStore;
		expect(await reader.revertSequence()).toBe(0);

		await leader.revertTo(100);

		expect(await reader.revertSequence()).toBe(1);
		expect(await reader.blockOf(hashOf(101))).toBeUndefined();
	});

	it('does not move when the revert is refused (a writer that lost the store)', async () => {
		const {store, other} = await seeded();
		const first = await openForWriting(store);
		await openForWriting(other);

		await expect(first.revertTo(100)).rejects.toBeInstanceOf(StoreWriterChangedError);

		expect(await store.revertSequence()).toBe(0);
	});

	it('is forwarded, with the block reads, by the claimed and the snapshot-aware handles', async () => {
		const {store} = await seeded();
		const wrapped = (await openForWriting(await openSnapshotAware(store))) as unknown as IndexedDBStateStore;

		await wrapped.revertTo(101);

		expect(await wrapped.revertSequence()).toBe(1);
		expect(await wrapped.tip()).toBe(101);
		expect(await wrapped.blockOf(hashOf(101))).toEqual(block(101));
		expect(await wrapped.blockAt(101)).toEqual(block(101));
	});
});
