import {expect, test} from '@playwright/test';
import {mountHarness} from 'playwright-browser-harness';
import {BRANCH_A_TIP, EXPECTED_A} from './workload.js';

/**
 * THE INDEXER IN A DEDICATED WORKER, in a real browser, over a real
 * `postMessage`.
 *
 * This is the run the node tests cannot make. `test/aHostFoldsAndATabAsksHowFar.test.ts`
 * drives the same host over a real `MessagePort` in one process, which proves
 * the envelope, the correlation and the clone boundary; what it has no way to
 * have is a SECOND EXECUTION CONTEXT. So the claim this spec exists for --
 * "the UI thread is not doing the fold" -- is asserted here and on WHERE the
 * answering code ran (`globalThis.constructor.name`), never on how long anything
 * took. A timing threshold would be a flake waiting for a loaded CI machine.
 *
 * Deliberately not part of `pnpm test`, which is what the acceptance gate runs:
 * it needs `playwright install` and three browser binaries a clean CI checkout
 * does not have, which is this package's existing convention (see the
 * IndexedDB package's multi-tab cases). Results are printed by the `list`
 * reporter of `playwright.config.ts` and kept nowhere else: the run is
 * reproducible with `pnpm --filter @etherfold/browser test:browser`.
 */

const CUT = new URL('./cut.ts', import.meta.url).pathname;
/** The app-authored entry point. The harness builds it to `worker.js` beside the page bundle. */
const WORKER = new URL('./indexer.worker.ts', import.meta.url).pathname;

/** Unique per run, so an engine's leftover database from a previous run is never read. */
function tag(name: string): string {
	return `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test('folds a real workload in a dedicated worker, and the tab asks how far it got', async ({page}) => {
	const harness = await mountHarness(page, {cut: CUT, worker: WORKER, coi: false});
	try {
		const run = await harness.run({phase: 'once', params: {case: 'hosted-in-a-worker', tag: tag('worker')}});

		expect(run.errors).toEqual([]);

		// WHERE THE WORK HAPPENED, measured in the context that did it. The page and
		// the host are different execution contexts, which is the whole claim, and
		// neither number here is a duration.
		expect(run.results.scope).toBe('DedicatedWorkerGlobalScope');
		expect(run.results.tabScope).toBe('Window');
		expect(run.results.host).toBe('dedicated-worker');

		// The tab asked a question across the real boundary and got the right answer:
		// the fixture's tip, reached. (Equality ALONE would be true of a host that had
		// not fetched yet, which publishes 0 of 0.)
		expect(run.results.latestBlock).toBe(BRANCH_A_TIP);
		expect(run.results.lastToBlock).toBe(run.results.latestBlock);
		expect(run.results.indexing).toBe(true);

		// And the fold RAN: the rows the worker wrote are the rows this same workload
		// produces on the main thread (`indexing.spec.ts` asserts the same constant).
		expect(run.results.state).toEqual(EXPECTED_A);

		// Everything the tab was handed. There is no store on this side and no verb
		// that could write one: the host holds the writer (ADR-0077, ADR-0082), and
		// `reads` is the store's four READS proxied (`readsAcrossThePort.spec.ts`).
		expect(run.results.portSurface).toEqual(['close', 'host', 'progress', 'reads']);
	} finally {
		await harness.dispose();
	}
});
