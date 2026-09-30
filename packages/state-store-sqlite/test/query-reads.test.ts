import {openForReading, openForWriting, openSnapshotAware, StoreWriterChangedError} from '@etherfold/state-store';
import {describe, expect, it} from 'vitest';
import {VersionedStateStore} from '../src/index.js';
import {createTestDB} from './utils/db.js';
import {TOKEN, block, owns} from './utils/fixtures.js';

/**
 * THE QUERY LAYER'S READS on this backend (ADR-0099, amended 2026-09-30): the
 * block at a height, the block a HASH names, and the REVERT SEQUENCE a query
 * reads at its start and its end so that it is never answered from two branches.
 */

async function seeded() {
	const db = createTestDB();
	const store = new VersionedStateStore(db, [TOKEN]);
	await store.migrate();
	await store.applyBlock(block(100), [owns('1', '0xalice', 1)]);
	await store.applyBlock(block(101), [owns('1', '0xbob', 2)]);
	await store.applyBlock(block(102), [owns('1', '0xcarol', 3)]);
	return {db, store};
}

describe('the block reads', () => {
	it('answer the recorded block at a height and by hash, and nothing for one never recorded', async () => {
		const {store} = await seeded();
		const recorded = block(101);

		expect(await store.tip()).toBe(102);
		expect(await store.blockAt(101)).toEqual({number: 101, hash: recorded.hash, timestamp: recorded.timestamp});
		expect(await store.blockOf(recorded.hash)).toEqual(await store.blockAt(101));
		// folded to lower case on write AND on lookup (ADR-0015), so a hash echoed back
		// in another case still resolves, to the stored spelling
		await store.applyBlock(block(103, `0x${'Ab'.repeat(32)}`), [owns('1', '0xdan', 4)]);
		for (const spelling of [`0x${'AB'.repeat(32)}`, `0x${'ab'.repeat(32)}`, `0x${'Ab'.repeat(32)}`]) {
			expect(await store.blockOf(spelling)).toMatchObject({number: 103, hash: `0x${'ab'.repeat(32)}`});
		}
		expect(await store.blockAt(99)).toBeUndefined();
		expect(await store.blockOf(`0x${'ee'.repeat(32)}`)).toBeUndefined();
	});

	it('forget a block reverted away', async () => {
		const {store} = await seeded();
		const gone = block(102).hash;
		await store.revertTo(101);

		expect(await store.blockOf(gone)).toBeUndefined();
		expect(await store.blockAt(102)).toBeUndefined();
		expect(await store.tip()).toBe(101);
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
		await store.applyBlock(block(102), [owns('1', '0xdan', 4)]);
		expect(await store.revertSequence()).toBe(2);
	});

	it('is PERSISTED: another handle over the same database, and a reader of it, read the increments', async () => {
		const {db, store} = await seeded();
		const writer = await openForWriting(store);
		const reader = openForReading(new VersionedStateStore(db, [TOKEN]));

		await writer.revertTo(100);

		expect(await (reader as VersionedStateStore).revertSequence()).toBe(1);
	});

	it('does not move when the revert is refused (a writer that lost the store)', async () => {
		const {db, store} = await seeded();
		const first = await openForWriting(store);
		await openForWriting(new VersionedStateStore(db, [TOKEN]));

		await expect(first.revertTo(100)).rejects.toBeInstanceOf(StoreWriterChangedError);

		expect(await store.revertSequence()).toBe(0);
	});

	it('is forwarded, with the block reads, by the claimed and the snapshot-aware handles', async () => {
		const {store} = await seeded();
		const wrapped = (await openForWriting(await openSnapshotAware(store))) as unknown as VersionedStateStore;

		await wrapped.revertTo(101);

		expect(await wrapped.revertSequence()).toBe(1);
		expect(await wrapped.tip()).toBe(101);
		expect(await wrapped.blockOf(block(101).hash)).toEqual(await store.blockAt(101));
		expect(await wrapped.blockAt(101)).toEqual(await store.blockAt(101));
	});
});
