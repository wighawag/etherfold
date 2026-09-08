import type {RemoteSQL, SQLPreparedStatement, SQLResult} from 'remote-sql';
import {describe, expect, it} from 'vitest';
import {deserializeLastSync, SYNC_CURSOR_KEY} from '@etherfold/processor-entities';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import {VersionedStateEventProcessor} from '../src/index.js';
import {createTestDB, RecordingSQL, rows, sqlOf} from './utils/db.js';
import {finality, lastSync, processor, SOURCE, transfer, type TestABI} from './utils/fixtures.js';

/**
 * The crash window, closed: on the SQLite path the cursor and the block it
 * describes move in ONE transaction, so a process that dies mid-stream comes
 * back with the two exactly in step.
 *
 * ## What used to happen, and why it was not a retry
 *
 * `process()` applied the stream and then wrote the cursor as a SEPARATE round
 * trip. Between the last `applyBlock` and that write there was a window in which
 * the STATE had advanced and the CURSOR had not, and it was not self-healing:
 * the restart resumes from the stale cursor, re-fetches blocks it already
 * applied, and `applyEventStream` only reverts when the stream carries a
 * retraction -- a plain replay has no fork point, so nothing reverts and
 * `applyBlock` is handed a block the store already holds. Every backend refuses
 * that BY DESIGN, correctly, because silently re-applying would double-write
 * versions. So the indexer did not merely redo work, it threw on every
 * subsequent start, and no amount of restarting cleared it.
 *
 * That was
 * `work/notes/observations/sync-cursor-write-is-not-atomic-with-the-block-it-describes.md`,
 * deleted with this change because it stopped being true.
 *
 * ## Why the fix has to be per BLOCK and not per `process` call
 *
 * One `process` call carries many blocks and each is its own transaction, so
 * writing the stream's cursor with the LAST block only would leave the same
 * window open for the whole run: crash after block 3 of 5 and the cursor is
 * still pre-stream. Each block therefore carries the cursor that describes IT
 * (`syncedThrough`), and the last carries the stream's own. The cases below kill
 * the database mid-stream and check both halves of the invariant: the cursor is
 * not behind the state (which wedges) and not ahead of it (which silently skips).
 */

/** A real database that stops working after the Nth `batch`: a crash, mid-stream. */
class DyingSQL implements RemoteSQL {
	private batches = 0;

	constructor(
		private readonly inner: RemoteSQL,
		/** How many batches succeed before the power goes out. */
		private readonly surviving: number,
	) {}

	prepare(sql: string): SQLPreparedStatement {
		return this.inner.prepare(sql);
	}

	batch<T = any>(list: SQLPreparedStatement[]): Promise<SQLResult<T>[]> {
		// migrations are not the subject: only the WRITE batches are counted, which
		// are the ones carrying a block (and now its cursor).
		if (list.some((statement) => sqlOf(statement).startsWith('INSERT INTO _blocks'))) {
			if (++this.batches > this.surviving) return Promise.reject(new Error('crash: the database went away'));
		}
		return this.inner.batch<T>(list);
	}
}

/** Three blocks, one event each, so "how far did it get" is a block number. */
const STREAM = [
	transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n}),
	transfer(101, '0xB', {from: '0xalice', to: '0xbob', id: 1n}),
	transfer(102, '0xC', {from: '0xbob', to: '0xcarol', id: 1n}),
];

const STREAM_CONFIG = {finality};
const WHOLE_STREAM = lastSync({latestBlock: 102, lastToBlock: 102, lastFromBlock: 90});

/** What the store says it holds, and what the cursor claims, as two numbers. */
async function stateAndCursor(db: RemoteSQL): Promise<{tip: number | undefined; cursor: number | undefined}> {
	const blocks = await rows<{number: number}>(db, `SELECT number FROM _blocks ORDER BY number DESC LIMIT 1`);
	const store = new VersionedStateStore(db, processor.entities);
	const stored = await store.readCursor(SYNC_CURSOR_KEY);
	return {
		tip: blocks[0]?.number,
		cursor: stored === undefined ? undefined : deserializeLastSync<TestABI>(stored).lastToBlock,
	};
}

describe('the cursor and the block it describes are one transaction', () => {
	it('lands in the same batch as the block, not in a second round trip', async () => {
		// `_blocks` and `_cursor` are written by the SAME `batch([...])`, which is
		// the only transaction `remote-sql` exposes. Asserted on the STATEMENTS rather
		// than inferred from the outcome, because the outcome is identical either way
		// until something crashes -- and a crash can only be staged at a batch
		// boundary, so a cursor written in its own batch is a window no outcome
		// assertion in this file can see.
		const recording = new RecordingSQL(createTestDB());
		const p = new VersionedStateEventProcessor<TestABI>(recording, processor);
		await p.load(SOURCE, STREAM_CONFIG);
		await p.process(STREAM, WHOLE_STREAM);

		const writes = recording.batches
			.map((list) => list.map(sqlOf))
			.filter((sqls) => sqls.some((sql) => sql.startsWith('INSERT INTO _blocks')));

		// one write batch per block, and not one of them moves the state without also
		// moving the cursor that describes it
		expect(writes).toHaveLength(STREAM.length);
		for (const sqls of writes) {
			expect(sqls.some((sql) => sql.includes('_cursor'))).toBe(true);
		}
		// and nothing WRITES the cursor on its own, which is the same window seen from
		// the other side. Scoped to writes rather than to any mention of `_cursor`,
		// because the migration batch creates that table and is not a cursor move.
		const writesCursor = (sql: string) => /^\s*(INSERT|REPLACE|UPDATE)\b/i.test(sql) && sql.includes('_cursor');
		const cursorOnly = recording.batches
			.map((list) => list.map(sqlOf))
			.filter((sqls) => sqls.some(writesCursor) && !sqls.some((sql) => sql.startsWith('INSERT INTO _blocks')));
		expect(cursorOnly).toEqual([]);

		expect(await stateAndCursor(recording)).toEqual({tip: 102, cursor: 102});
	});

	it.each([0, 1, 2])('leaves the cursor exactly at the last applied block after a crash (%i survived)', async (n) => {
		const real = createTestDB();
		const dying = new DyingSQL(real, n);
		const p = new VersionedStateEventProcessor<TestABI>(dying, processor);
		await p.load(SOURCE, STREAM_CONFIG);

		await expect(p.process(STREAM, WHOLE_STREAM)).rejects.toThrow(/crash/);

		// the whole invariant, in one line: what the store HOLDS and what the cursor
		// CLAIMS are the same block. Behind wedges the next run, ahead loses it.
		const {tip, cursor} = await stateAndCursor(real);
		expect({tip, cursor}).toEqual({tip: n === 0 ? undefined : 99 + n, cursor: n === 0 ? undefined : 99 + n});
	});

	it('so the run that follows the crash resumes and finishes, rather than wedging', async () => {
		const real = createTestDB();
		const dying = new DyingSQL(real, 2);
		const crashed = new VersionedStateEventProcessor<TestABI>(dying, processor);
		await crashed.load(SOURCE, STREAM_CONFIG);
		await expect(crashed.process(STREAM, WHOLE_STREAM)).rejects.toThrow(/crash/);

		// A restart resumes from the persisted cursor and re-fetches from there. The
		// core would not re-emit blocks its `unconfirmedBlocks` already record, so
		// what actually arrives is the tail -- and the point is that it applies
		// cleanly, where before the restart was handed block 100 again and threw.
		const restarted = new VersionedStateEventProcessor<TestABI>(real, processor);
		const loaded = await restarted.load(SOURCE, STREAM_CONFIG);
		expect(loaded?.lastSync.lastToBlock).toBe(101);

		await restarted.process(STREAM.slice(2), lastSync({latestBlock: 102, lastToBlock: 102, lastFromBlock: 102}));

		expect(await stateAndCursor(real)).toEqual({tip: 102, cursor: 102});
		expect(await restarted.state.getCurrent<{owner: string}>('token', {id: '1'})).toMatchObject({owner: '0xcarol'});
	});

	it('carries the unconfirmed window that belongs to each block, not the stream tail', async () => {
		// The intermediate cursor is the stream's, truncated (`syncedThrough`): an
		// unconfirmed block ABOVE the resume point would make the blocks between them
		// invisible on the next round, because the engine treats the last unconfirmed
		// block as the boundary above which events are new.
		const real = createTestDB();
		const dying = new DyingSQL(real, 1);
		const p = new VersionedStateEventProcessor<TestABI>(dying, processor);
		await p.load(SOURCE, STREAM_CONFIG);

		const unconfirmed = STREAM.map((event) => ({number: event.blockNumber, hash: event.blockHash, events: [event]}));
		await expect(
			p.process(
				STREAM,
				lastSync({latestBlock: 102, lastToBlock: 102, lastFromBlock: 90, unconfirmedBlocks: unconfirmed}),
			),
		).rejects.toThrow(/crash/);

		const store = new VersionedStateStore(real, processor.entities);
		const stored = deserializeLastSync<TestABI>((await store.readCursor(SYNC_CURSOR_KEY)) as string);
		expect(stored.lastToBlock).toBe(100);
		expect(stored.unconfirmedBlocks.map((block) => block.number)).toEqual([100]);
		// the chain tip observed is NOT truncated: it is what the re-fetch window is
		// measured back from, and lowering it would widen it for nothing.
		expect(stored.latestBlock).toBe(102);
	});
});
