import {describe, expect, it} from 'vitest';
import {MemoryStateStore, pruneMore} from '../src/index.js';
import {ACCOUNT, TOKEN, block, owns} from './utils/fixtures.js';

/**
 * ONE SCHEDULED PASS, OVER EVERY STATE A HOST HOLDS.
 *
 * `prune` is a call the HOST schedules (ADR-0022), and every host that schedules
 * one meets the same three questions: which states does it hold, how much may
 * ONE pass delete, and has it finished. This is the answer, written once so that
 * a CLI cycle and a Worker invocation drive the same loop rather than two
 * implementations of it that agree today.
 *
 * The budget is a PARAMETER and never a constant here, because the number is a
 * property of the CALLER's schedule and not of pruning: a Worker's is a query
 * allowance (`d1PruneBudget`), a browser tab's is a responsiveness budget, and a
 * CLI's is the gap between poll cycles.
 *
 * Every assertion is on what is STORED or ANSWERED after the passes, never on
 * what a store claims: the two coming apart is the whole defect (a store bounded
 * in what it answers and unbounded in what it holds).
 */

/** A store whose window is `blocks`, over the two entities the fixtures declare. */
async function windowed(blocks: number): Promise<MemoryStateStore> {
	const store = new MemoryStateStore([TOKEN, ACCOUNT], {retention: {blocks}, finalityDepth: 64});
	await store.migrate();
	return store;
}

/**
 * One entity rewritten on every block from 1,000 to 1,000 + `writes` - 1, then a
 * far later block that drags the tip past the floor.
 *
 * Each rewrite CLOSES the previous version, so a store loaded this way holds
 * `writes` versions of which `writes - 1` are unreachable at the floor and one is
 * LIVE -- the row a prune must never take, however old it is.
 */
async function loaded(store: MemoryStateStore, id: string, writes: number): Promise<MemoryStateStore> {
	for (let index = 0; index < writes; index++) {
		await store.applyBlock(block(1_000 + index), [owns(id, `0x${index}`, index)]);
	}
	await store.applyBlock(block(1_100), []);
	return store;
}

/** What a store still holds, as the versions a read can reach: the honest measure of a prune. */
async function survives(store: MemoryStateStore, id: string): Promise<Record<string, unknown> | undefined> {
	return store.getCurrent('token', {id});
}

describe('one bounded pass over the states a host holds', () => {
	it('spends its budget and reports that the pass is NOT finished', async () => {
		const store = await loaded(await windowed(64), '1', 6);

		const report = await pruneMore([store], {maxVersions: 2});

		expect(report.versionsDeleted).toBe(2);
		expect(report.complete).toBe(false);
	});

	it('reports complete once nothing prunable is left, so a host knows to stop', async () => {
		const store = await loaded(await windowed(64), '1', 6);

		expect(await pruneMore([store], {maxVersions: 2})).toMatchObject({complete: false});
		expect(await pruneMore([store], {maxVersions: 2})).toMatchObject({complete: false});
		const last = await pruneMore([store], {maxVersions: 2});

		expect(last.complete).toBe(true);
		expect(last.versionsDeleted).toBe(1);
		// and a pass over a store already at its floor deletes nothing rather than
		// failing: a host prunes on a schedule and must not have to ask first
		expect(await pruneMore([store], {maxVersions: 2})).toMatchObject({versionsDeleted: 0, complete: true});
	});

	/**
	 * The criterion a budget exists to make safe: passing it in pieces must not
	 * arrive anywhere else than paying for it once.
	 *
	 * Asserted rather than assumed, because the cheap wrong implementation --
	 * pruning from the newest unreachable version rather than the oldest -- passes
	 * the count assertions above and leaves a DIFFERENT set of rows behind when a
	 * budget stops it.
	 */
	it('reaches the same end state in budgeted passes as in one unbounded pass', async () => {
		const budgeted = await loaded(await windowed(64), '1', 9);
		const atOnce = await loaded(await windowed(64), '1', 9);

		let passes = 0;
		for (;;) {
			const report = await pruneMore([budgeted], {maxVersions: 2});
			passes++;
			if (report.complete) break;
			if (passes > 20) throw new Error(`the budgeted loop never reported complete`);
		}
		await pruneMore([atOnce]);

		expect(passes).toBeGreaterThan(1);
		expect(await survives(budgeted, '1')).toEqual(await survives(atOnce, '1'));
		// the same question put to the stores themselves: neither has anything left
		// below its floor, and both kept the live version
		expect(await budgeted.prune()).toMatchObject({versionsDeleted: 0});
		expect(await atOnce.prune()).toMatchObject({versionsDeleted: 0});
		expect(await survives(budgeted, '1')).toMatchObject({owner: '0x8'});
	});

	/**
	 * The budget bounds the PASS and not each store in it.
	 *
	 * A host holding two generations mid-upgrade would otherwise do twice the work
	 * it budgeted for, which on a platform where the budget IS the request's query
	 * allowance is the difference between a scheduled prune and a rejected
	 * invocation.
	 */
	it('spends ONE budget across the states, not one budget each', async () => {
		const first = await loaded(await windowed(64), '1', 6);
		const second = await loaded(await windowed(64), '2', 6);

		const report = await pruneMore([first, second], {maxVersions: 3});

		expect(report.versionsDeleted).toBe(3);
		expect(report.complete).toBe(false);
		// and the pass that follows finishes what this one could not, in both stores
		let remaining = await pruneMore([first, second], {maxVersions: 3});
		while (!remaining.complete) {
			remaining = await pruneMore([first, second], {maxVersions: 3});
		}
		expect(await first.prune()).toMatchObject({versionsDeleted: 0});
		expect(await second.prune()).toMatchObject({versionsDeleted: 0});
		expect(await survives(first, '1')).toMatchObject({owner: '0x5'});
		expect(await survives(second, '2')).toMatchObject({owner: '0x5'});
	});

	/** Two generations may legitimately fold into ONE store; the budget must not be spent twice on it. */
	it('prunes a state held twice exactly once', async () => {
		const store = await loaded(await windowed(64), '1', 6);

		const report = await pruneMore([store, store], {maxVersions: 5});

		expect(report.passes).toHaveLength(1);
		expect(report.versionsDeleted).toBe(5);
	});

	/**
	 * No floor, nothing deleted, and the host still calls unconditionally.
	 *
	 * ADR-0022 states a prune "is a no-op wherever there is no floor, so a host may
	 * schedule it unconditionally", which is what keeps `revert-only` WITH a
	 * finality depth (a floor) from needing a question the capability report cannot
	 * answer.
	 */
	it('deletes nothing where a store states no floor', async () => {
		const unbounded = new MemoryStateStore([TOKEN, ACCOUNT]);
		await unbounded.migrate();
		await loaded(unbounded, '1', 6);

		expect(await pruneMore([unbounded], {maxVersions: 100})).toMatchObject({versionsDeleted: 0, complete: true});
		expect(await unbounded.getAsOf('token', {id: '1'}, 1_000)).toMatchObject({owner: '0x0'});
	});

	/**
	 * A budget no pass could spend is refused in the seam's own words, and refused
	 * BEFORE anything is deleted.
	 *
	 * `maxVersions: 0` is a caller that computed a budget wrongly, and reading it
	 * as "do nothing" would let a store grow for ever while its owner watched a
	 * prune run on schedule.
	 */
	it('refuses a budget no pass could spend', async () => {
		const store = await loaded(await windowed(64), '1', 6);

		await expect(pruneMore([store], {maxVersions: 0})).rejects.toThrow(/invalid prune budget/);
		expect(await survives(store, '1')).toMatchObject({owner: '0x5'});
	});
});
