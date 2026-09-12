import {expect, test} from '@playwright/test';
import {mountHarness} from 'playwright-browser-harness';
import {BRANCH_A_TIP, START_BLOCK} from './workload.js';

/**
 * SYNC PROGRESS PUSHED FROM A REAL WORKER TO A REAL TAB.
 *
 * `test/aTabSeesSyncProgressPushedFromTheWorker.test.ts` drives the same host
 * over a real `MessagePort` in one process, which proves the envelope's third
 * message kind, the subscription and the cadence. What it has no way to have is
 * a SECOND EXECUTION CONTEXT -- and an unprompted message is exactly the thing
 * worth seeing cross one. So this asserts on WHERE the pushed values were
 * computed (`globalThis.constructor.name`) and on the VALUES in them, never on
 * how long anything took.
 *
 * Deliberately not part of `pnpm test`, which is what the acceptance gate runs:
 * it needs `playwright install` and three browser binaries a clean CI checkout
 * does not have, which is this package's existing convention.
 */

const CUT = new URL('./cut.ts', import.meta.url).pathname;
/** The app-authored entry point. The harness builds it to `worker.js` beside the page bundle. */
const WORKER = new URL('./indexer.worker.ts', import.meta.url).pathname;

function tag(name: string): string {
	return `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test('pushes progress from the worker to its own tab, and stops when the tab lets go', async ({page}) => {
	const harness = await mountHarness(page, {cut: CUT, worker: WORKER, coi: false});
	try {
		const run = await harness.run({
			phase: 'once',
			params: {case: 'progress-pushed-from-the-worker', tag: tag('progress')},
		});

		expect(run.errors).toEqual([]);

		// WHERE the reports were computed, measured in the context that computed
		// them. The page and the host are different execution contexts, which is
		// the whole reason a push is worth having.
		expect(run.results.scope).toBe('DedicatedWorkerGlobalScope');
		expect(run.results.tabScope).toBe('Window');
		expect(run.results.host).toBe('dedicated-worker');

		// THE COARSE PHASES, in the order a fold passes through them. The first is
		// `waiting`, which is what a first visit renders before the chain has
		// answered anything at all.
		expect(run.results.firstPhase).toBe('waiting');
		expect(run.results.phases).toEqual(['waiting', 'loading', 'catching-up', 'at-tip']);

		// "SYNCING, N BLOCKS BEHIND", advancing: more than one report knew a tip,
		// and the distance to it only ever shrank, ending at zero.
		const behind = run.results.blocksBehindTip as number[];
		expect(behind.length).toBeGreaterThan(1);
		expect(behind).toEqual([...behind].sort((a, b) => b - a));
		expect(behind[behind.length - 1]).toBe(0);

		// and the numbers an app binds to a progress display, at the end of it
		expect(run.results.done).toEqual({
			phase: 'at-tip',
			lastToBlock: BRANCH_A_TIP,
			latestBlock: BRANCH_A_TIP,
			blocksBehindTip: 0,
			numBlocksProcessedSoFar: BRANCH_A_TIP - START_BLOCK,
			syncPercentage: 100,
		});

		// THE HELPER IS A VIEW: nothing before the host has spoken, and afterwards
		// the host's own last report by reference rather than a value it assembled.
		expect(run.results.helperBeforeAnyPush).toBe(true);
		expect(run.results.helperHoldsTheLastPush).toBe(true);

		// AN UNSUBSCRIBED TAB STOPS RECEIVING, counted on the `Worker` object
		// itself: the worker goes on advancing at the tip throughout, and posts
		// nothing at a tab that let go.
		expect(run.results.pushedWhileUnsubscribed).toBe(0);

		// A TAB THAT ATTACHES LATE is told where the fold is, and this one attaches
		// after it has finished -- so nothing is ever going to move again, and
		// attaching is the only way it could learn.
		expect(run.results.lateSubscriber).toEqual({phase: 'at-tip', lastToBlock: BRANCH_A_TIP});

		// Everything the tab was handed, in full.
		expect(run.results.portSurface).toEqual([
			'checkTxInclusion',
			'close',
			'generations',
			'host',
			'onProgress',
			'progress',
			'promotion',
			'reads',
			'reconfigure',
			'startIndexing',
			'stopIndexing',
		]);
	} finally {
		await harness.dispose();
	}
});
