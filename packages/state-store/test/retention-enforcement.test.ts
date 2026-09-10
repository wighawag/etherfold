import {describe, expect, it} from 'vitest';
import {MemoryStateStore, RETENTION_ENFORCEMENT_KEY, retentionEnforcementOf} from '../src/index.js';
import {ACCOUNT, TOKEN, block, owns} from './utils/fixtures.js';

/**
 * WHETHER THIS STORE'S RETENTION IS ACTUALLY ENFORCED.
 *
 * Retention has two halves: `assertRetained` bounds what a read may ask about
 * the moment a floor exists, and `prune` physically drops what falls below it.
 * The first happens on every read whatever the host does; the second happens
 * only if a host schedules it. A host that rolled its own loop and never
 * schedules one gets the refusals of a bounded store and the footprint of an
 * unbounded one, and nothing anywhere detects it.
 *
 * This is the detection: an ASYNCHRONOUS read, because the answer is durable
 * and therefore lives in storage. It is deliberately NOT on the `capabilities`
 * getter, which is synchronous and readable before `migrate` -- a value that
 * survives a reload cannot be produced before the database is even open.
 *
 * Every assertion here is on the REPORT, and the one thing it must never do is
 * come back saying `never-pruned` for a store that was pruned in an earlier
 * process.
 */

/** A store with a retention window, so it has a floor and therefore something to enforce. */
async function windowed(blocks = 64): Promise<MemoryStateStore> {
	const store = new MemoryStateStore([TOKEN, ACCOUNT], {retention: {blocks}, finalityDepth: 64});
	await store.migrate();
	return store;
}

/** Two versions of one token far enough apart that the older one falls below any floor. */
async function withHistory(store: MemoryStateStore): Promise<MemoryStateStore> {
	await store.applyBlock(block(1_000), [owns('1', '0xalice', 1)]);
	await store.applyBlock(block(1_001), [owns('1', '0xbob', 2)]);
	await store.applyBlock(block(10_000), []);
	return store;
}

describe('a store reports whether its retention is enforced', () => {
	it('reports `no-floor` for a store that keeps everything: there is nothing to enforce', async () => {
		const store = new MemoryStateStore([TOKEN, ACCOUNT]);
		await store.migrate();

		expect(await store.readRetentionEnforcement()).toEqual({kind: 'no-floor'});
	});

	it('reports `no-floor` for `revert-only` with no declared depth, which states no floor either', async () => {
		const store = new MemoryStateStore([TOKEN, ACCOUNT], {retention: 'revert-only'});
		await store.migrate();

		expect(await store.readRetentionEnforcement()).toEqual({kind: 'no-floor'});
	});

	it('reports a floor for `revert-only` WITH a depth, which is the case a binary window check misses', async () => {
		const store = new MemoryStateStore([TOKEN, ACCOUNT], {retention: 'revert-only', finalityDepth: 64});
		await store.migrate();

		expect(await store.readRetentionEnforcement()).toMatchObject({kind: 'never-pruned'});
	});

	it('reports `never-pruned` for a configured store before anything has ever pruned it', async () => {
		const store = await withHistory(await windowed());

		expect(await store.readRetentionEnforcement()).toEqual({kind: 'never-pruned', floor: 10_000 - 64});
	});

	it('reports `never-pruned` before the first block too, since a floor is a fact about the SETTING', async () => {
		const store = await windowed();

		// the store a bespoke host is most likely to have misconfigured has applied
		// nothing yet, so answering `no-floor` here would hide exactly that store.
		expect(await store.readRetentionEnforcement()).toEqual({kind: 'never-pruned', floor: undefined});
	});

	it('reports the block a prune ran to once one has', async () => {
		const store = await withHistory(await windowed());

		await store.prune();

		expect(await store.readRetentionEnforcement()).toEqual({kind: 'pruned', floor: 9_936, prunedTo: 9_936});
	});

	it('reports `pruned` even when the pass had nothing to delete, because the pass still RAN', async () => {
		const store = await windowed();
		await store.applyBlock(block(1_000), [owns('1', '0xalice', 1)]);

		const report = await store.prune();

		expect(report.versionsDeleted).toBe(0);
		// a healthy host pruning every cycle deletes nothing most cycles; reporting
		// `never-pruned` there would make the common case the alarm.
		expect(await store.readRetentionEnforcement()).toMatchObject({kind: 'pruned', prunedTo: 936});
	});

	it('leaves the report alone when a prune had no floor to run at', async () => {
		const store = new MemoryStateStore([TOKEN, ACCOUNT]);
		await store.migrate();
		await store.applyBlock(block(1_000), [owns('1', '0xalice', 1)]);

		await store.prune();

		expect(await store.readRetentionEnforcement()).toEqual({kind: 'no-floor'});
	});

	it('keeps `floor` and `prunedTo` apart, so how far a prune has FALLEN BEHIND is readable', async () => {
		const store = await withHistory(await windowed());
		await store.prune();

		await store.applyBlock(block(20_000), []);

		const enforcement = await store.readRetentionEnforcement();
		expect(enforcement).toEqual({kind: 'pruned', floor: 19_936, prunedTo: 9_936});
	});
});

describe('the record a prune leaves behind', () => {
	it('is written at the cursor port, which is the durable slot a reload reads back', async () => {
		const store = await withHistory(await windowed());

		await store.prune();

		// The port is a keyed slot for an opaque string that is never versioned,
		// never reverted and never pruned -- the same durability the snapshot origin
		// rides on, and the reason a reload is as honest as the first run.
		expect(await store.readCursor(RETENTION_ENFORCEMENT_KEY)).toBeDefined();
	});

	it('is what a store built over the SAME storage reads back, rather than starting at never', async () => {
		const store = await withHistory(await windowed());
		await store.prune();
		const recorded = await store.readCursor(RETENTION_ENFORCEMENT_KEY);

		// what a second process does on a durable backend: same setting, same
		// record, no memory of the run that wrote it.
		const reopened = retentionEnforcementOf({kind: 'window', blocks: 64}, 64, 10_000, recorded);

		expect(reopened).toEqual({kind: 'pruned', floor: 9_936, prunedTo: 9_936});
	});

	it('is treated as never-pruned when it cannot be read, rather than throwing', async () => {
		const store = await withHistory(await windowed());
		await store.writeCursor(RETENTION_ENFORCEMENT_KEY, 'not json');

		// Deliberately unlike the snapshot origin, which throws: that marker is a
		// SAFETY floor whose absence would have a store claim history it never had,
		// while this one is a diagnostic, and under-claiming enforcement is the
		// direction that cannot mislead.
		expect(await store.readRetentionEnforcement()).toMatchObject({kind: 'never-pruned'});
	});
});
