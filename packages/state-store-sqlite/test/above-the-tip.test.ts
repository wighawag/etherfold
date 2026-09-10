import {describe, expect, it} from 'vitest';
import {VersionedStateStore} from '../src/index.js';
import {RecordingSQL, createTestDB, rows, sqlOf} from './utils/db.js';
import {TOKEN, block, owns} from './utils/fixtures.js';

/**
 * A block must be ABOVE the recorded tip, on the substrate that cannot simply
 * look before it writes.
 *
 * The RULE is the seam's and is asserted for every backend by
 * `@etherfold/state-store-conformance`. What is asserted here is how this
 * backend can honour it at all: `remote-sql` exposes a transaction only as a
 * pre-built batch, so there is no reading, deciding and writing inside one
 * transaction (ADR-0054's opening line, ADR-0075). The verdict is therefore a
 * CONDITIONAL WRITE -- every statement of the block carries the tip predicate,
 * so a refused block applies to nothing -- plus a READ-BACK inside the same
 * batch, which is what lets the message name the tip the write was judged
 * against. A tip read issued BEFORE the batch would be a second transaction and
 * would merely LOOK atomic, which is the exact shape both ADRs refuse.
 */
describe('a height that is not above the recorded tip', () => {
	it('is refused, naming both heights', async () => {
		const store = new VersionedStateStore(createTestDB(), [TOKEN]);
		await store.migrate();
		await store.applyBlock(block(100), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(102), [owns('1', '0xbob', 2)]);

		await expect(store.applyBlock(block(101), [owns('1', '0xcarol', 3)])).rejects.toThrow(
			/block 101 is not above the recorded tip 102/,
		);
	});

	it('writes NOTHING: not the block row, not a version, not the cursor', async () => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [TOKEN]);
		await store.migrate();
		await store.applyBlock(block(100), [owns('1', '0xalice', 1)], {key: 'lastSync', value: 'at-100'});
		await store.applyBlock(block(102), [owns('1', '0xbob', 2)], {key: 'lastSync', value: 'at-102'});

		await expect(
			store.applyBlock(block(101), [owns('1', '0xcarol', 3)], {key: 'lastSync', value: 'at-101'}),
		).rejects.toThrow();

		// the guard rides every statement of the block, so the version writes and the
		// cursor cannot land under a block row that did not
		expect(await rows(db, `SELECT number FROM _blocks ORDER BY number`)).toEqual([{number: 100}, {number: 102}]);
		expect(await rows(db, `SELECT id FROM token WHERE _lower = ?`, 101)).toEqual([]);
		expect(await store.readCursor('lastSync')).toBe('at-102');
		expect((await store.getCurrent<{owner: string}>('token', {id: '1'}))?.owner).toBe('0xbob');
	});

	it('reads the tip inside the SAME batch as the write, and in one round trip', async () => {
		const db = new RecordingSQL(createTestDB());
		const store = new VersionedStateStore(db, [TOKEN]);
		await store.migrate();
		await store.applyBlock(block(100), [owns('1', '0xalice', 1)]);
		db.batches.length = 0;

		await store.applyBlock(block(101), [owns('1', '0xbob', 2)]);

		// ONE call: the tip read is a statement of the block's own batch and not a
		// query before it, which is the whole difference between a compare-and-swap
		// and a read-then-write that looks like one.
		expect(db.batches.length).toBe(1);
		expect(sqlOf(db.batches[0][0])).toMatch(/SELECT number, hash, timestamp FROM _blocks ORDER BY number DESC/i);
		// and every statement in it carries the predicate, block row and versions alike
		for (const statement of db.batches[0].slice(1, -1)) {
			expect(sqlOf(statement)).toMatch(/NOT EXISTS \(SELECT 1 FROM _blocks WHERE number > \?\)/i);
		}
	});

	it('admits the height again once a revert has taken the tip back under it', async () => {
		const store = new VersionedStateStore(createTestDB(), [TOKEN]);
		await store.migrate();
		await store.applyBlock(block(100), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(102), [owns('1', '0xbob', 2)]);

		// the reorg shape: revert, then apply the canonical branch. The revert is in
		// the same store and its DELETE moves the tip, so the next block is judged
		// against the state the revert left rather than against a remembered number.
		await store.revertTo(101);
		await store.applyBlock(block(101), [owns('1', '0xcarol', 3)]);

		expect((await store.getCurrent<{owner: string}>('token', {id: '1'}))?.owner).toBe('0xcarol');
	});

	it('refuses a packed sequence that does not ascend, before it writes anything at all', async () => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [TOKEN]);
		await store.migrate();

		// `applyBlocks` packs several blocks into one batch, so each is judged against
		// the tip its predecessors left: a descending pair would silently apply the
		// second to nothing. It is a fact about the CALL rather than about the store,
		// so it is refused here and nothing is sent.
		await expect(
			store.applyBlocks([
				{block: block(102), mutations: [owns('1', '0xbob', 2)]},
				{block: block(101), mutations: [owns('1', '0xcarol', 3)]},
			]),
		).rejects.toThrow(/must ASCEND/);

		expect(await rows(db, `SELECT number FROM _blocks ORDER BY number`)).toEqual([]);
	});

	it('refuses a packed sequence that starts at or below the tip, and applies none of it', async () => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [TOKEN]);
		await store.migrate();
		await store.applyBlock(block(105), [owns('1', '0xalice', 1)]);

		// the tip read rides the first batch, so the refusal covers the whole
		// sequence: 106 is above the tip and would have landed on its own, and it must
		// not land on top of a block that applied to nothing.
		await expect(
			store.applyBlocks([
				{block: block(101), mutations: [owns('1', '0xbob', 2)]},
				{block: block(106), mutations: [owns('1', '0xcarol', 3)]},
			]),
		).rejects.toThrow(/block 101 is not above the recorded tip 105/);

		expect(await rows(db, `SELECT number FROM _blocks ORDER BY number`)).toEqual([{number: 105}]);
	});
});
