import {describe, expect, it} from 'vitest';
import {VersionedStateStore, revertToStatements, tableNames} from '../src/index.js';
import {createTestDB, rows} from './utils/db.js';
import {TOKEN, block, owns} from './utils/fixtures.js';

/**
 * The DELETE-before-re-open ordering, pinned in BOTH directions.
 *
 * `revertTo` must (A) DELETE versions opened above the fork before it (B)
 * re-opens versions closed above it. SQLite enforces the partial unique index
 * `(id) WHERE _upper IS NULL` per statement, with no deferred mode: re-opening
 * first makes the re-opened row and the still-present dead-branch row both open
 * for the same id, which is a UNIQUE violation.
 *
 * Asserting only that the right order works would let a future refactor swap the
 * two statements and "clean up" a rule it could not see the reason for. So the
 * wrong order is executed here, against a real SQLite engine, and its failure is
 * asserted. This test IS the documentation of why the order is what it is.
 */

// Fork at 101: token 1 has a version [100, 101) then [101, 102) (Bob), and a
// dead-branch version [102, ...) (Carol). Reverting to 101 must delete Carol's
// row and re-open Bob's.
async function forkedChain() {
	const db = createTestDB();
	const store = new VersionedStateStore(db, [TOKEN]);
	await store.migrate();
	await store.applyBlock(block(100), [owns('1', '0xAlice', 1)]);
	await store.applyBlock(block(101), [owns('1', '0xBob', 2)]);
	await store.applyBlock(block(102), [owns('1', '0xCarol', 3)]);
	return {db, store};
}

describe('revertTo statement ordering', () => {
	it('emits the DELETE of opened versions before the re-open of closed ones', () => {
		const statements = revertToStatements([TOKEN], 101, tableNames());
		const deleteIndex = statements.findIndex((s) => /^DELETE FROM "token"/i.test(s.sql));
		const reopenIndex = statements.findIndex((s) => /^UPDATE "token" SET _upper = NULL/i.test(s.sql));

		expect(deleteIndex, 'a DELETE of versions opened above the fork').toBeGreaterThanOrEqual(0);
		expect(reopenIndex, 'a re-open of versions closed above the fork').toBeGreaterThanOrEqual(0);
		expect(deleteIndex).toBeLessThan(reopenIndex);

		expect(statements[deleteIndex].sql).toMatch(/_lower > \?/);
		expect(statements[reopenIndex].sql).toMatch(/_upper > \?/);
	});

	it('succeeds in the emitted order', async () => {
		const {db, store} = await forkedChain();
		await store.revertTo(101);
		const open = await rows<{owner: string}>(db, `SELECT owner FROM token WHERE _upper IS NULL`);
		expect(open.map((o) => o.owner)).toEqual(['0xBob']);
	});

	it('raises a unique-constraint violation in the reverse order', async () => {
		const {db} = await forkedChain();

		// Same statements, re-open before DELETE. This is the order a well-meaning
		// refactor would produce, and it cannot work.
		const statements = revertToStatements([TOKEN], 101, tableNames());
		const reopenFirst = [...statements].reverse();

		await expect(db.batch(reopenFirst.map((s) => db.prepare(s.sql).bind(...s.args)))).rejects.toThrow(
			/UNIQUE|constraint/i,
		);
	});

	it('leaves the database untouched when the reverse order fails', async () => {
		const {db} = await forkedChain();
		const before = await rows(db, `SELECT * FROM token ORDER BY _rowid`);

		const reopenFirst = [...revertToStatements([TOKEN], 101, tableNames())].reverse();
		await expect(db.batch(reopenFirst.map((s) => db.prepare(s.sql).bind(...s.args)))).rejects.toThrow();

		const after = await rows(db, `SELECT * FROM token ORDER BY _rowid`);
		expect(after).toEqual(before);
	});
});
