import {BlockNotRetainedError} from '@etherfold/state-store';
import {describe, expect, it} from 'vitest';
import {VersionedStateStore} from '../src/index.js';
import {createTestDB, RecordingSQL, rows, sqlOf} from './utils/db.js';
import {ACCOUNT, TOKEN, block, burn, owns} from './utils/fixtures.js';

/**
 * Pruning: the half of retention that is about BYTES rather than about answers.
 *
 * The window already bounds what a read may ask about (`capabilities.test.ts`);
 * this is what makes it bound what the database holds. Everything here asserts
 * on VERSION COUNTS and never on a reported size, and that is a finding rather
 * than a preference: `work/notes/findings/sqlite-in-the-browser.md` records
 * `navigator.storage.estimate()` reporting MORE space used after a prune that
 * dropped nothing, because it is quantised and lags. A count of rows is the only
 * honest measure that a prune did something.
 *
 * The behaviour that a prune must not break -- a read inside the window, the
 * live version of an ancient entity, the reorg revert -- is asserted for EVERY
 * backend by `@etherfold/state-store-conformance` (see `conformance.test.ts`).
 * What is here is what only this backend can be asked: which rows are gone, how
 * many statements it took, and what one request was allowed to carry.
 */

const FINALITY = 64;

/** A store whose window is `blocks`, over the two entities the fixtures declare. */
async function windowed(blocks: number, bounds?: {maxRowsPerStatement?: number}) {
	const db = new RecordingSQL(createTestDB());
	const store = new VersionedStateStore(db, [TOKEN, ACCOUNT], {
		retention: {blocks},
		finalityDepth: FINALITY,
		bounds,
	});
	await store.migrate();
	return {db, store};
}

/** How many VERSIONS (rows, live or closed) an entity table holds. */
async function versions(db: RecordingSQL, table = 'token'): Promise<number> {
	const [count] = await rows<{n: number}>(db, `SELECT COUNT(*) AS n FROM ${table}`);
	return count.n;
}

function transfers(id: string, from: number, to: number) {
	return Array.from({length: to - from + 1}, (_, index) => ({
		number: from + index,
		mutation: owns(id, `0x${(from + index).toString(16)}`, index),
	}));
}

describe('the live version survives, however old it is', () => {
	it('keeps an entity written once at a block far below the floor and never touched again', async () => {
		const {db, store} = await windowed(128);
		// the shape the real stream has: event-bearing blocks median 429 apart, and
		// rows written once and never revisited. A prune that deletes by AGE alone
		// destroys this row, and with it the current state.
		await store.applyBlock(block(12_082_307), [owns('ancient', '0xalice', 1)]);
		await store.applyBlock(block(13_000_000), [owns('busy', '0xbob', 1)]);

		const before = await versions(db);
		const report = await store.prune();

		expect(await versions(db)).toBe(before);
		expect(report.versionsDeleted).toBe(0);
		expect(await store.getCurrent('token', {id: 'ancient'})).toMatchObject({owner: '0xalice'});
	});

	it('keeps it even when its own version is the only row left of that entity', async () => {
		const {db, store} = await windowed(64);
		await store.applyBlock(block(100), [owns('ancient', '0xalice', 1)]);
		// twelve later blocks that touch a DIFFERENT entity, dragging the tip far
		// past the floor while the ancient row's version stays open.
		for (const {number, mutation} of transfers('busy', 1_000, 1_011)) {
			await store.applyBlock(block(number), [mutation]);
		}

		await store.prune();

		expect(await store.getCurrent('token', {id: 'ancient'})).toMatchObject({owner: '0xalice'});
		expect(await rows(db, `SELECT * FROM token WHERE id = 'ancient'`)).toHaveLength(1);
	});
});

describe('versions closed below the floor are physically gone', () => {
	it('drops them, and a count taken before and after proves it', async () => {
		const {db, store} = await windowed(64);
		// twelve versions of one token, closed at 1_001 .. 1_011, plus the live one
		for (const {number, mutation} of transfers('1', 1_000, 1_011)) {
			await store.applyBlock(block(number), [mutation]);
		}
		await store.applyBlock(block(1_100), [owns('2', '0xother', 1)]);

		const before = await versions(db);
		expect(before).toBe(13);

		// tip 1_100, window 64, so the floor is 1_036: every version of token 1
		// closed at or below it is unreachable by any legal read.
		const report = await store.prune();

		expect(report.floor).toBe(1_036);
		expect(report.versionsDeleted).toBe(11);
		expect(await versions(db)).toBe(before - 11);
		// the survivor of token 1 is its live version, and nothing else
		expect(await rows(db, `SELECT _lower, _upper FROM token WHERE id = '1'`)).toEqual([{_lower: 1_011, _upper: null}]);
	});

	it('drops the closing version of a DELETED entity, which has no live row to protect', async () => {
		const {db, store} = await windowed(64);
		await store.applyBlock(block(1_000), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(1_001), [burn('1')]);
		await store.applyBlock(block(1_100), [owns('2', '0xother', 1)]);

		await store.prune();

		expect(await rows(db, `SELECT * FROM token WHERE id = '1'`)).toEqual([]);
	});

	it('leaves the version that is still valid AT the floor, because a read there must answer', async () => {
		const {store} = await windowed(64);
		await store.applyBlock(block(1_000), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(1_037), [owns('1', '0xbob', 2)]);
		await store.applyBlock(block(1_100), [owns('2', '0xother', 1)]);

		// floor 1_036; the first version's range is [1_000, 1_037), so it is still
		// the answer at 1_036 and must not be dropped.
		await store.prune();

		expect(await store.getAsOf('token', {id: '1'}, 1_036)).toMatchObject({owner: '0xalice'});
	});

	it('is idempotent: a second prune at the same tip drops nothing', async () => {
		const {store} = await windowed(64);
		for (const {number, mutation} of transfers('1', 1_000, 1_011)) {
			await store.applyBlock(block(number), [mutation]);
		}
		await store.applyBlock(block(1_100), [owns('2', '0xother', 1)]);

		expect((await store.prune()).versionsDeleted).toBe(11);
		expect((await store.prune()).versionsDeleted).toBe(0);
	});
});

describe('what a read gets after a prune', () => {
	async function pruned() {
		const {db, store} = await windowed(64);
		await store.applyBlock(block(1_000), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(1_010), [owns('1', '0xbob', 2)]);
		await store.applyBlock(block(1_100), [owns('1', '0xcarol', 3)]);
		await store.prune();
		return {db, store};
	}

	it('answers correctly inside the window', async () => {
		const {store} = await pruned();
		// floor 1_036, tip 1_100: the version live across the whole window is Bob's
		expect(await store.getAsOf('token', {id: '1'}, 1_036)).toMatchObject({owner: '0xbob'});
		expect(await store.getAsOf('token', {id: '1'}, 1_099)).toMatchObject({owner: '0xbob'});
		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xcarol'});
	});

	it('refuses below the window, rather than answering wrongly or crashing', async () => {
		const {store} = await pruned();
		const error = await store.getAsOf('token', {id: '1'}, 1_035).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(BlockNotRetainedError);
		expect((error as BlockNotRetainedError).requested).toBe(1_035);
		expect((error as BlockNotRetainedError).retained).toEqual({from: 1_036, to: 1_100});
	});
});

describe('pruning never eats the reorg floor', () => {
	it('still reverts to the finality depth on a store whose window IS the finality depth', async () => {
		const {store} = await windowed(FINALITY);
		await store.applyBlock(block(1_000), [owns('1', '0xalice', 1)]);
		// a version closed inside the finality window: exactly what revert must reopen
		await store.applyBlock(block(1_050), [owns('1', '0xbob', 2)]);
		await store.applyBlock(block(1_100), [owns('1', '0xcarol', 3)]);

		await store.prune();
		// the deepest reorg this deployment protects against
		await store.revertTo(1_100 - FINALITY);

		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
	});

	it('reverts a counter back DOWN after a prune, which is the canonical reorg bug', async () => {
		const {store} = await windowed(FINALITY);
		await store.applyBlock(block(1_000), [
			{type: 'upsert', entity: 'account', id: {address: '0xa'}, values: {balance: 6}},
		]);
		await store.applyBlock(block(1_090), [
			{type: 'upsert', entity: 'account', id: {address: '0xa'}, values: {balance: 12}},
		]);

		await store.prune();
		await store.revertTo(1_089);

		expect(await store.getCurrent('account', {address: '0xa'})).toMatchObject({balance: 6});
	});
});

describe('a store with nothing to enforce', () => {
	it('prunes nothing when its retention is `unbounded`, and does not raise', async () => {
		const db = new RecordingSQL(createTestDB());
		const store = new VersionedStateStore(db, [TOKEN, ACCOUNT]);
		await store.migrate();
		await store.applyBlock(block(1_000), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(1_100), [owns('1', '0xbob', 2)]);

		const report = await store.prune();

		expect(report).toMatchObject({floor: undefined, versionsDeleted: 0, complete: true});
		expect(await versions(db)).toBe(2);
	});

	it('prunes nothing before the first block, when there is no tip to measure from', async () => {
		const {store} = await windowed(64);
		expect(await store.prune()).toMatchObject({tip: undefined, floor: undefined, versionsDeleted: 0});
	});

	it('prunes a `revert-only` store down to the finality depth it declared', async () => {
		const db = new RecordingSQL(createTestDB());
		const store = new VersionedStateStore(db, [TOKEN], {retention: 'revert-only', finalityDepth: FINALITY});
		await store.migrate();
		for (const {number, mutation} of transfers('1', 1_000, 1_011)) {
			await store.applyBlock(block(number), [mutation]);
		}
		await store.applyBlock(block(1_100), [owns('2', '0xother', 1)]);

		// `revert-only` means "kept for as long as reorg revert needs them", and the
		// depth it declared is exactly how long that is.
		expect((await store.prune()).floor).toBe(1_036);
		expect(await versions(db)).toBe(2);
	});

	it('prunes nothing on a `revert-only` store that declared no depth, because it has no floor', async () => {
		const db = new RecordingSQL(createTestDB());
		const store = new VersionedStateStore(db, [TOKEN], {retention: 'revert-only'});
		await store.migrate();
		await store.applyBlock(block(1_000), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(1_100), [owns('1', '0xbob', 2)]);

		expect(await store.prune()).toMatchObject({floor: undefined, versionsDeleted: 0});
		expect(await versions(db)).toBe(2);
	});
});

describe('one request carries a bounded number of rows', () => {
	it('never names more rows in one DELETE than the configured bound', async () => {
		const {db, store} = await windowed(64, {maxRowsPerStatement: 3});
		for (const {number, mutation} of transfers('1', 1_000, 1_011)) {
			await store.applyBlock(block(number), [mutation]);
		}
		await store.applyBlock(block(1_100), [owns('2', '0xother', 1)]);

		db.batches.length = 0;
		expect((await store.prune()).versionsDeleted).toBe(11);

		const deletes = db.batches
			.flat()
			.map(sqlOf)
			.filter((sql) => sql.startsWith('DELETE'));
		expect(deletes.length).toBeGreaterThan(1);
		for (const sql of deletes) {
			expect(sql.split('?').length - 1).toBeLessThanOrEqual(3);
		}
	});

	it('stops at a budget and says so, so a host can amortise the pass', async () => {
		const {db, store} = await windowed(64);
		for (const {number, mutation} of transfers('1', 1_000, 1_011)) {
			await store.applyBlock(block(number), [mutation]);
		}
		await store.applyBlock(block(1_100), [owns('2', '0xother', 1)]);

		const first = await store.prune({maxVersions: 4});
		expect(first).toMatchObject({versionsDeleted: 4, complete: false});
		// oldest first, so what is left is the NEWEST of the prunable versions
		expect(await versions(db)).toBe(13 - 4);

		const second = await store.prune({maxVersions: 100});
		expect(second).toMatchObject({versionsDeleted: 7, complete: true});
	});

	it('refuses a budget that is not a whole number of versions', async () => {
		const {store} = await windowed(64);
		await expect(store.prune({maxVersions: 0})).rejects.toThrow(/versions/i);
	});
});

describe('what pruning deliberately does NOT touch', () => {
	it('keeps the block table, so an old hash still resolves and is REFUSED rather than unknown', async () => {
		const {db, store} = await windowed(64);
		await store.applyBlock(block(1_000), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(1_100), [owns('1', '0xbob', 2)]);

		await store.prune();

		expect(await rows(db, `SELECT number FROM _blocks ORDER BY number`)).toEqual([{number: 1_000}, {number: 1_100}]);
		// the block existed and we indexed it; what is gone is the state, and that
		// is a different piece of news from "no such block".
		await expect(store.getAsOf('token', {id: '1'}, {hash: block(1_000).hash})).rejects.toBeInstanceOf(
			BlockNotRetainedError,
		);
	});
});

describe('the record a prune leaves behind survives the process it ran in', () => {
	it('is read back by a store opened on the same database, rather than starting at never', async () => {
		const db = createTestDB();
		const options = {retention: {blocks: 64}, finalityDepth: FINALITY} as const;

		const first = new VersionedStateStore(db, [TOKEN, ACCOUNT], options);
		await first.migrate();
		await first.applyBlock(block(1_000), [owns('1', '0xalice', 1)]);
		await first.applyBlock(block(1_001), [owns('1', '0xbob', 2)]);
		// far enough ahead that the floor is above the close at 1,001
		await first.applyBlock(block(1_100), []);
		const pass = await first.prune();
		expect(pass.versionsDeleted).toBeGreaterThan(0);

		// a redeploy, a restarted process, or the read tier of a split deployment
		// opening the database the folding tier wrote: nothing in memory survived,
		// and the store must not come back claiming it has never been pruned.
		const reopened = new VersionedStateStore(db, [TOKEN, ACCOUNT], options);
		await reopened.migrate();

		expect(await reopened.readRetentionEnforcement()).toEqual({kind: 'pruned', floor: 1_036, prunedTo: 1_036});
	});

	it('leaves an unbounded store reporting `no-floor` after a pass, with no record written', async () => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [TOKEN, ACCOUNT]);
		await store.migrate();
		await store.applyBlock(block(1_000), [owns('1', '0xalice', 1)]);

		await store.prune();

		expect(await store.readRetentionEnforcement()).toEqual({kind: 'no-floor'});
		expect(await rows(db, `SELECT key FROM _cursor`)).toEqual([]);
	});
});
