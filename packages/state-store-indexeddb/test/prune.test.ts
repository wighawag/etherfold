import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import type {EntityDeclaration, Mutation} from '@etherfold/state-store';
import {IndexedDBStateStore} from '../src/index.js';
import {freshDatabaseName} from './utils/database.js';
import {cursors, recordAccess} from './utils/access-path.js';

/**
 * What only THIS backend can be asked about pruning.
 *
 * That a prune must never drop a live version, and what a windowed store may
 * drop, is the seam's contract and is asserted for every backend by the shared
 * suite. What is asserted here is HOW: the closed versions live in their own
 * index, because a live version's `upper` is `null` and `null` is not a valid
 * IndexedDB key, so the row that IS the current state cannot be reached from the
 * prune at all. The spike's prototype pruned by scanning every version and
 * testing a predicate (6.3 s at 62,553 versions, in
 * `work/notes/findings/sqlite-in-the-browser.md`); this one walks a range.
 */

const TOKEN: EntityDeclaration = {name: 'token', id: ['id'], fields: {owner: 'text'}};

function owns(id: string, owner: string): Mutation {
	return {type: 'upsert', entity: 'token', id: {id}, values: {owner}};
}

function block(number: number) {
	return {number, hash: `0x${number.toString(16)}`, timestamp: 1_700_000_000 + number * 12};
}

/**
 * A store with a 64-block window, one row rewritten at every block from 100 to
 * 110, and one row written once at block 100 and never again.
 */
async function withHistory(retention: 'window' | 'unbounded' = 'window') {
	const store = new IndexedDBStateStore([TOKEN], {
		databaseName: freshDatabaseName(),
		...(retention === 'window' ? {retention: {blocks: 64}, finalityDepth: 64} : {}),
	});
	await store.migrate();
	await store.applyBlock(block(100), [owns('untouched', '0xancient'), owns('busy', '0xowner-100')]);
	for (let number = 101; number <= 110; number++) {
		await store.applyBlock(block(number), [owns('busy', `0xowner-${number}`)]);
	}
	// the tip, far enough ahead that the floor (tip - 64) is above every close
	await store.applyBlock(block(1_000), [owns('late', '0xlate')]);
	return store;
}

describe('pruning walks the closed versions and cannot reach a live one', () => {
	it('opens one cursor, over the `upper` index, and visits only what it deletes', async () => {
		const store = await withHistory();
		const log = recordAccess();
		let report;
		try {
			report = await store.prune();
		} finally {
			log.stop();
		}

		// ten closes: `busy` at 101..110. `untouched` and `late` are live and have
		// no entry in this index at all.
		expect(report.versionsDeleted).toBe(10);
		expect(report.floor).toBe(1_000 - 64);
		const walked = cursors(log).filter((request) => request.on === 'upper');
		expect(walked).toHaveLength(1);
		expect(log.recordsVisited).toBe(10);
	});

	it('leaves the state of a row written once, long before the floor, untouched', async () => {
		const store = await withHistory();

		await store.prune();

		expect(await store.getCurrent('token', {id: 'untouched'})).toMatchObject({owner: '0xancient'});
		expect(await store.getCurrent('token', {id: 'busy'})).toMatchObject({owner: '0xowner-110'});
	});

	it('leaves the block records, so a pruned height is still a recorded block', async () => {
		const store = await withHistory();

		await store.prune();

		// dropping them would turn "that block is outside what I keep"
		// (BlockNotRetainedError) into "there is no such block", which is a worse
		// answer and, for a consumer that pinned the hash, a wrong one.
		expect(await store.getBlock(100)).toMatchObject({number: 100, hash: '0x64'});
	});

	it('spends a budget on the OLDEST closes first, and says the pass is unfinished', async () => {
		const store = await withHistory();

		const first = await store.prune({maxVersions: 4});
		expect(first).toMatchObject({versionsDeleted: 4, complete: false});

		const rest = await store.prune();
		expect(rest).toMatchObject({versionsDeleted: 6, complete: true});

		// the four it dropped were the four oldest closes (101 to 104), so what
		// survived a partial pass is the newest of the unreachable versions and the
		// store converges towards the window from the far end.
		const third = await store.prune();
		expect(third.versionsDeleted).toBe(0);
	});

	it('is a no-op on an unbounded store, which is the claim that nothing is unreachable', async () => {
		const store = await withHistory('unbounded');
		const log = recordAccess();
		try {
			const report = await store.prune();
			expect(report).toMatchObject({versionsDeleted: 0, floor: undefined, complete: true});
		} finally {
			log.stop();
		}

		// and it did not open a write transaction to discover that
		expect(cursors(log).filter((request) => request.on === 'upper')).toEqual([]);
	});
});

describe('the record a prune leaves behind survives the page it ran on', () => {
	it('is read back by a store opened on the same database, rather than starting at never', async () => {
		const databaseName = freshDatabaseName();
		const options = {databaseName, retention: {blocks: 64}, finalityDepth: 64} as const;

		const first = new IndexedDBStateStore([TOKEN], options);
		await first.migrate();
		await first.applyBlock(block(100), [owns('busy', '0xowner-100')]);
		await first.applyBlock(block(101), [owns('busy', '0xowner-101')]);
		await first.applyBlock(block(1_000), []);
		const pass = await first.prune();
		expect(pass.versionsDeleted).toBeGreaterThan(0);

		// a new tab, or the same tab after a reload: nothing in memory survived, so
		// a store that held its enforcement state in a closure would come back
		// reporting `never-pruned` over versions it had already dropped.
		const reloaded = new IndexedDBStateStore([TOKEN], options);
		await reloaded.migrate();

		expect(await reloaded.readRetentionEnforcement()).toEqual({kind: 'pruned', floor: 936, prunedTo: 936});
	});

	it('leaves an unbounded store reporting `no-floor` after a pass, with no record written', async () => {
		const store = await withHistory('unbounded');

		await store.prune();

		expect(await store.readRetentionEnforcement()).toEqual({kind: 'no-floor'});
	});
});
