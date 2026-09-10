import {expect, test, type Page} from '@playwright/test';
import {mountHarness} from 'playwright-browser-harness';
import {EXPECTED_A, EXPECTED_A_LATER, EXPECTED_B, START_BLOCK} from './workload.js';

/**
 * A browser tab indexing with an entity processor, on the engines it has to work
 * on.
 *
 * The node tests ask the same questions of the same workload under
 * `fake-indexeddb`. What a shim cannot show is exactly what this path is for:
 * a real transaction scheduler, a real database that outlives a page, and a real
 * RELOAD, which is the browser-specific risk in the whole feature (a tab that
 * indexes, closes and reopens must CONTINUE, not start again).
 *
 * Deliberately not part of `pnpm test`, which is what the acceptance gate runs:
 * this needs `playwright install` and three browser binaries a clean CI checkout
 * does not have, and a gate that cannot run on a clean checkout is a gate that
 * gets skipped.
 */

/** The bundled code-under-test. IndexedDB needs no cross-origin isolation. */
const CUT = new URL('./cut.ts', import.meta.url).pathname;

async function harnessFor(page: Page) {
	return mountHarness(page, {cut: CUT, coi: false});
}

/** Unique per run, so an engine's leftover database from a previous run is never read. */
function tag(name: string): string {
	return `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test('indexes the captured stream through the hook, and lands on the expected state', async ({page}) => {
	const harness = await harnessFor(page);
	try {
		const run = await harness.run({phase: 'once', params: {case: 'index', tag: tag('index')}});

		expect(run.errors).toEqual([]);
		expect(run.results.state).toEqual(EXPECTED_A);
		expect(run.results.lastToBlock).toBe(run.results.latestBlock);
	} finally {
		await harness.dispose();
	}
});

test('reverts a reorg through the browser path, and the counter decreases', async ({page}) => {
	const harness = await harnessFor(page);
	try {
		const run = await harness.run({phase: 'once', params: {case: 'reorg', tag: tag('reorg')}});

		expect(run.errors).toEqual([]);
		expect(run.results.before).toEqual(EXPECTED_A);
		expect(run.results.after).toEqual(EXPECTED_B);
		expect(EXPECTED_B.transfers).toBeLessThan(EXPECTED_A.transfers);
	} finally {
		await harness.dispose();
	}
});

test('runs the same processor on whichever backend the application chose', async ({page}) => {
	const harness = await harnessFor(page);
	try {
		const run = await harness.run({phase: 'once', params: {case: 'backends', tag: tag('backends')}});

		expect(run.errors).toEqual([]);
		expect(run.results.indexeddb).toEqual(EXPECTED_A);
		// the claim, in the form that matters: three stores that were never told
		// about each other, one processor, one answer.
		expect(run.results.patch).toEqual(run.results.indexeddb);
		expect(run.results.memory).toEqual(run.results.indexeddb);
		// and the light one says up front what a reload will cost (ADR-0023)
		expect(run.results.patchDurability).toBe('memory-only');
	} finally {
		await harness.dispose();
	}
});

/**
 * The reclamation half of retention, in the engine that has to do it.
 *
 * This is the one claim in this package that a shim cannot make. `prune` on this
 * backend is a range scan over the `upper` index in a real transaction, and what
 * keeps it from destroying current state is that a LIVE version has `upper:
 * null`, which is not a valid IndexedDB key and is therefore absent from that
 * index entirely -- a property of the ENGINE's key handling, not of the store's
 * arithmetic. The counts below are what the database is physically holding after
 * the tab indexed, so "a configured window is actually pruned" is a measurement
 * rather than a statement the store issues about itself.
 */
test('reclaims the versions a retention floor no longer covers, and only those', async ({page}) => {
	const harness = await harnessFor(page);
	try {
		const run = await harness.run({phase: 'once', params: {case: 'prune', tag: tag('prune')}});

		expect(run.errors).toEqual([]);

		// the store that said it keeps everything holds everything: the baseline the
		// other two are a reclamation FROM
		expect(run.results.unboundedVersions).toBe(10);
		// a 64-block window at a tip of 200 floors at 136, and the four versions closed
		// at blocks 102 and 104 are below it
		expect(run.results.windowedVersions).toBe(6);
		// and `revert-only` with a depth prunes for the same reason and to the same
		// floor: the depth a revert reaches IS its retention
		expect(run.results.revertOnlyVersions).toBe(6);

		// what was dropped was unreachable, so all three answer identically -- including
		// the rows last written at 102 and 104, which are 30-odd blocks BELOW the floor
		// and are still the current state
		expect(run.results.unboundedState).toEqual(EXPECTED_A_LATER);
		expect(run.results.windowedState).toEqual(EXPECTED_A_LATER);
		expect(run.results.revertOnlyState).toEqual(EXPECTED_A_LATER);
	} finally {
		await harness.dispose();
	}
});

/**
 * AXIS ONE, in an engine: an edited reducer swapped into a running tab.
 *
 * Hot Contract Replacement's sibling, and the one with a trap in it. The core
 * decides whether the state survives by comparing VERSION HASHES, and a version
 * hash is author-declared: it contains the `version` string, the entity
 * declarations and the config, and nothing derived from handler code. So the
 * same edit is a no-op or a full rebuild depending only on whether a human
 * remembered to change a string.
 */
test('an edited processor takes effect only when its version says so', async ({page}) => {
	const harness = await harnessFor(page);
	try {
		const run = await harness.run({phase: 'once', params: {case: 'hot-processor', tag: tag('hot-processor')}});

		expect(run.errors).toEqual([]);
		expect(run.results.before).toEqual(EXPECTED_A);

		// the edit with `version` untouched: not a change the core can see, so the
		// swap is SKIPPED and the old handler keeps running. The counter stays at the
		// old logic's 5 rather than becoming the edited logic's 50.
		expect(run.results.unbumpedDiscarded).toBe(false);
		expect(run.results.afterUnbumped).toEqual(EXPECTED_A);

		// the same edit with the version bumped: the state is discarded and every
		// block is replayed through the NEW handler.
		expect(run.results.bumpedDiscarded).toBe(true);
		expect((run.results.afterBumped as {transfers: number}).transfers).toBe(EXPECTED_A.transfers * 10);
	} finally {
		await harness.dispose();
	}
});

/**
 * AXIS TWO, in an engine: a redeploy behind a proxy, at an address that already
 * has indexed history.
 *
 * The address does not move, so the only thing the indexer can notice is the
 * regenerated ABI -- which IS hashed into the source, so a changed ABI discards
 * and re-indexes. The second half is the one that used to be silently wrong:
 * when the redeployed implementation has emitted nothing yet, there is no next
 * event to overwrite the display, so whatever the hook published at the moment
 * of the discard is what the tab shows for the rest of the session.
 */
test('a redeploy at the same address re-indexes, and never shows the old contract\u2019s state', async ({page}) => {
	const harness = await harnessFor(page);
	try {
		const run = await harness.run({phase: 'once', params: {case: 'hot-contract', tag: tag('hot-contract')}});

		expect(run.errors).toEqual([]);
		expect(run.results.before).toEqual(EXPECTED_A);

		// the ABI moved, so the source hash moved, so the state went
		expect(run.results.stateDiscarded).toBe(true);
		// and the verdict that decided it crossed out of the page intact, saying which
		// half died rather than only that something did
		expect((run.results.sourceInvalidation as {state: {valid: boolean}}).state.valid).toBe(false);
		expect(run.results.reindexedFrom).toBe(run.results.startBlock);
		expect(run.results.after).toEqual(EXPECTED_A);

		// and with nothing left to replay, the tab shows EMPTY rather than the state
		// the previous implementation produced
		expect(run.results.beforeRedeploy).toEqual(EXPECTED_A);
		expect(run.results.afterEmptyRedeploy).toEqual({
			owners: {'1': undefined, '2': undefined, '3': undefined, '4': undefined},
			transfers: 0,
		});
	} finally {
		await harness.dispose();
	}
});

test('resumes from its cursor after a real page reload, instead of re-indexing', async ({page}) => {
	const harness = await harnessFor(page);
	const params = {tag: tag('reload')};
	try {
		const first = await harness.run({phase: 'write', params});
		expect(first.errors).toEqual([]);
		expect(first.results.state).toEqual(EXPECTED_A);
		// the first tab did start at the beginning, which is what makes the second
		// tab's answer meaningful
		expect(first.results.firstRangeFrom).toBe(START_BLOCK);

		await harness.reload();

		const second = await harness.run({phase: 'read', params});
		expect(second.errors).toEqual([]);
		expect(second.results.state).toEqual(EXPECTED_A);
		// nothing of the first page survived except IndexedDB, and IndexedDB held
		// the cursor: the reopened tab picked up inside the unconfirmed window it
		// had recorded rather than at the start block.
		expect(second.results.firstRangeFrom).toBeGreaterThan(START_BLOCK);
	} finally {
		await harness.dispose();
	}
});
