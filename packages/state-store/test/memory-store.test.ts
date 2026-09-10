import {describe, expect, it} from 'vitest';
import {MemoryStateStore} from '../src/index.js';
import {ACCOUNT, TOKEN, block, owns} from './utils/fixtures.js';

/**
 * The reference backend: versioned rows in a Map.
 *
 * It exists so the CONTRACT has an executable definition that owes nothing to
 * SQL, and so a processor can be run against two backends in a test. What that
 * contract IS -- versioned reads, as-of reads against its declared capabilities,
 * reorg revert with a counter that must go back down, read-your-writes, a block
 * applying as one unit -- is asserted by the shared suite, which runs this store
 * under three different retention claims in
 * `@etherfold/state-store-conformance`. It runs there rather than here for the
 * one reason that admits no workaround: that package depends on this one, so
 * this one cannot depend back on it.
 *
 * What is left here is what is particular to this implementation: the shape it
 * hands back, the block lookup that is deliberately NOT at the seam, the
 * declarations it refuses at construction, and how a retention setting becomes
 * the claim it reports.
 */

async function migrated(declarations = [TOKEN, ACCOUNT]): Promise<MemoryStateStore> {
	const store = new MemoryStateStore(declarations);
	await store.migrate();
	return store;
}

describe('the row it hands back carries the version range, as a SQL row does', () => {
	it('reports the half-open bounds of the version that answered', async () => {
		// Parity with `SELECT *` on a versioned table, and it is deliberate: a
		// lenient reference implementation would let a caller that reads `_upper`
		// work here and fail on the store it ships against.
		const store = await migrated();
		await store.applyBlock(block(10), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(20), [owns('1', '0xbob', 2)]);

		expect(await store.getAsOf('token', {id: '1'}, 10)).toMatchObject({owner: '0xalice', _lower: 10, _upper: 20});
		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xbob', _lower: 20, _upper: null});
	});
});

describe('the block lookup, which is not part of the seam', () => {
	it('reports the block recorded at a height, and nothing above a revert', async () => {
		const store = await migrated();
		await store.applyBlock(block(10), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(20), [owns('1', '0xbob', 2)]);

		await store.revertTo(15);

		expect(await store.getBlock(10)).toMatchObject({number: 10, hash: '0xa'});
		expect(await store.getBlock(20)).toBeUndefined();
	});

	it('records a block that carried no mutation, because the caller decides which blocks exist', async () => {
		const store = await migrated();
		await store.applyBlock(block(10), []);
		expect(await store.getBlock(10)).toMatchObject({number: 10, hash: '0xa'});
	});
});

describe('a declaration is validated at construction', () => {
	it('rejects identifiers that are not plain identifiers, and reserved field names', () => {
		expect(() => new MemoryStateStore([{name: 'to"ken', id: ['id'], fields: {}}])).toThrow(/identifier/i);
		expect(() => new MemoryStateStore([{name: 'token', id: ['id'], fields: {_lower: 'integer'}}])).toThrow(/reserved/i);
	});
});

describe('capabilities are data, readable before any read is attempted', () => {
	it('reports what it keeps and what it can answer', async () => {
		const store = new MemoryStateStore([TOKEN]);
		// note: before `migrate`, before any write. That is the point of story 7.
		expect(store.capabilities).toEqual({retention: {kind: 'unbounded'}, asOf: true, singleWriter: false});
	});
});

describe('pruning, in the reference implementation', () => {
	async function windowed(blocks: number) {
		const store = new MemoryStateStore([TOKEN, ACCOUNT], {retention: {blocks}, finalityDepth: 64});
		await store.migrate();
		return store;
	}

	it('keeps the LIVE version of an entity written once and never touched again', async () => {
		const store = await windowed(128);
		// the dangerous case, and the normal one: the real stream's event-bearing
		// blocks are median 429 apart and its state has rows written once and never
		// revisited, so a prune that deletes by AGE destroys the current state.
		await store.applyBlock(block(12_082_307), [owns('ancient', '0xalice', 1)]);
		await store.applyBlock(block(13_000_000), [owns('busy', '0xbob', 1)]);

		expect(await store.prune()).toMatchObject({versionsDeleted: 0, floor: 12_999_872});
		expect(await store.getCurrent('token', {id: 'ancient'})).toMatchObject({owner: '0xalice'});
	});

	it('drops the versions the window no longer covers, and counts them', async () => {
		const store = await windowed(64);
		await store.applyBlock(block(1_000), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(1_010), [owns('1', '0xbob', 2)]);
		await store.applyBlock(block(1_100), [owns('1', '0xcarol', 3)]);

		// floor 1_036: Alice's version closed at 1_010 is unreachable, Bob's (closed
		// at 1_100) is the answer across the whole window.
		expect(await store.prune()).toMatchObject({tip: 1_100, floor: 1_036, versionsDeleted: 1, complete: true});
		expect(await store.getAsOf('token', {id: '1'}, 1_036)).toMatchObject({owner: '0xbob'});
	});

	it('stops at a budget and says the pass is not finished', async () => {
		const store = await windowed(64);
		for (let number = 1_000; number <= 1_005; number++) {
			await store.applyBlock(block(number), [owns('1', `0x${number}`, number)]);
		}
		await store.applyBlock(block(1_100), [owns('2', '0xother', 1)]);

		expect(await store.prune({maxVersions: 2})).toMatchObject({versionsDeleted: 2, complete: false});
		expect(await store.prune()).toMatchObject({versionsDeleted: 3, complete: true});
		expect(await store.prune()).toMatchObject({versionsDeleted: 0, complete: true});
	});

	it('is a no-op on an unbounded store rather than an error', async () => {
		const store = await migrated();
		await store.applyBlock(block(10), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(1_000_000), [owns('1', '0xbob', 2)]);

		expect(await store.prune()).toMatchObject({floor: undefined, versionsDeleted: 0, complete: true});
		expect(await store.getAsOf('token', {id: '1'}, 10)).toMatchObject({owner: '0xalice'});
	});

	it('drops the last trace of an entity deleted long ago', async () => {
		const store = await windowed(64);
		await store.applyBlock(block(1_000), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(1_001), [{type: 'delete', entity: 'token', id: {id: '1'}}]);
		await store.applyBlock(block(1_100), [owns('2', '0xother', 1)]);

		expect((await store.prune()).versionsDeleted).toBe(1);
		expect(await store.getCurrent('token', {id: '1'})).toBeUndefined();
	});
});
