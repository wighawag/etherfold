import {expect, test} from '@playwright/test';
import {mountHarness} from './harness.js';
import {BRANCH_A_TIP} from './workload.js';

/**
 * START, STOP AND RECONFIGURE, FROM A TAB TO A REAL WORKER.
 *
 * `test/aTabControlsTheIndexerAcrossThePort.test.ts` drives the same host over a
 * real `MessagePort` in one process, which is where the claims that need a
 * COUNTED CHAIN live: no request after a stop resolves, a mid-cycle stop that
 * lets its cycle land, and the ranges a resumed run asks for. What that run has
 * no way to have is a SECOND EXECUTION CONTEXT -- so this asserts that the
 * lifecycle crosses one: a tab holding nothing but a port stops a fold in
 * another thread, reconfigures its source, and is answered from the generation
 * the pointer moved to.
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

test('a tab starts, stops and reconfigures the indexer across the port', async ({page}) => {
	const harness = await mountHarness(page, {cut: CUT, worker: WORKER, coi: false});
	try {
		const run = await harness.run({
			phase: 'once',
			params: {case: 'controls-the-indexer', tag: tag('controls')},
		});

		expect(run.errors).toEqual([]);

		// WHERE the fold runs, measured in the context that answered rather than
		// declared by the caller.
		expect(run.results.scope).toBe('DedicatedWorkerGlobalScope');
		expect(run.results.tabScope).toBe('Window');
		expect(run.results.host).toBe('dedicated-worker');

		// the workload, folded in the worker and read across the port
		expect(run.results.before).toBe(run.results.expectedBefore);

		// STOPPED FROM THE TAB: the driver is not running, the fold is where it got
		// to, and the store goes on answering -- stopping the driver is not closing
		// the container.
		expect(run.results.stopped).toEqual({indexing: false, phase: 'at-tip', lastToBlock: BRANCH_A_TIP});
		expect(run.results.readWhileStopped).toBe(run.results.expectedBefore);
		expect(run.results.startedIndexing).toBe(true);

		// RECONFIGURED: a generation CREATED beside the live one, on a stream of its
		// own (a different source is a different fetch filter, so it fetches rather
		// than following), and NOT answering reads yet -- which is what makes a
		// reconfigure not an outage under the default policy.
		expect(run.results.reconfigure).toEqual({
			added: true,
			follows: false,
			canonicalAtOnce: false,
			sameStream: false,
		});
		// the POLICY is the one default there is everywhere; the DROP is the one value
		// this runtime answers for, because a tab ships one processor and can never run
		// the generation a promotion superseded again (ADR-0090)
		expect(run.results.promotion).toEqual({policy: 'on-catch-up', dropOnPromotion: true});

		// ...so the app was still reading complete OLD answers while the new fold
		// caught up, and reads the NEW ones once the pointer moved.
		expect(run.results.duringCatchUp).toBe(run.results.expectedBefore);
		expect(run.results.afterPromotion).toBe(run.results.expectedAfter);

		// ONE generation, canonical and level with the tip: the promotion FINISHED, so
		// the generation it superseded is gone rather than kept as an un-runnable row
		// (ADR-0090). Its STREAM is kept, which is the expensive half (ADR-0087).
		expect(run.results.generations).toEqual([
			{canonical: true, follows: false, lastToBlock: BRANCH_A_TIP, blocksBehind: 0},
		]);

		// Everything the tab was handed, in full.
		expect(run.results.portSurface).toEqual([
			'checkTxInclusion',
			'close',
			'generations',
			'host',
			'onHostDeath',
			'onProgress',
			'onStateMoved',
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
