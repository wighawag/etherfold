import {expect, test} from '@playwright/test';
import {mountHarness} from 'playwright-browser-harness';
import {readSurfaceCases} from './readWorkload.js';

/**
 * A TAB READING THE STORE ACROSS THE PORT, in a real browser, over a real
 * `postMessage` to a real dedicated worker.
 *
 * The claim is an EQUALITY between two surfaces, and this is where it is made
 * against two genuine execution contexts: the store lives in the worker, the tab
 * holds a port, and the SAME case list (`readWorkload.ts`) is run over the
 * surface generated across that port and over the surface generated from a store
 * folded on the page's own thread. `test/aTabReadsTheStoreAcrossThePort.test.ts`
 * asks the identical questions over a `MessagePort` in node on every commit;
 * what only this run has is the second thread.
 *
 * Deliberately not part of `pnpm test`, which is what the acceptance gate runs:
 * it needs `playwright install` and three browser binaries a clean CI checkout
 * does not have, which is this package's existing convention. Results are
 * printed by the `list` reporter of `playwright.config.ts` and kept nowhere
 * else: the run is reproducible with
 * `pnpm --filter @etherfold/browser test:browser`.
 */

const CUT = new URL('./cut.ts', import.meta.url).pathname;
/** The app-authored entry point for this fixture. The harness builds it to `worker.js`. */
const WORKER = new URL('./reads.worker.ts', import.meta.url).pathname;

function tag(name: string): string {
	return `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test('reads the store across a port to a real worker, and matches a same-thread surface', async ({page}) => {
	const harness = await mountHarness(page, {cut: CUT, worker: WORKER, coi: false});
	try {
		const run = await harness.run({phase: 'once', params: {case: 'reads-across-the-port', tag: tag('reads')}});

		expect(run.errors).toEqual([]);

		// WHERE the rows are, measured in the context that read them: the store is
		// in the worker and the page holds a port to it.
		expect(run.results.scope).toBe('DedicatedWorkerGlobalScope');
		expect(run.results.tabScope).toBe('Window');
		expect(run.results.host).toBe('dedicated-worker');

		// ONE case list, BOTH ways, and the same verdict from each.
		const across = run.results.acrossThePort as {passed: number; failures: unknown[]};
		const here = run.results.onThisThread as {passed: number; failures: unknown[]};
		expect(across.failures).toEqual([]);
		expect(here.failures).toEqual([]);
		expect(across.passed).toBe(readSurfaceCases.length);
		expect(here.passed).toBe(readSurfaceCases.length);

		// A read issued before the fold had finished was ANSWERED rather than
		// refused or left hanging: the host serves reads while it indexes, and one
		// arriving before the store exists waits for it.
		expect((run.results.whileFolding as {answered: boolean}).answered).toBe(true);

		// Everything the tab was handed, in full: four reads per entity, and
		// nothing beside them that could write (ADR-0077, ADR-0082).
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
		expect(run.results.readSurface).toEqual(['getAsOf', 'getCurrent', 'listAsOf', 'listCurrent']);
	} finally {
		await harness.dispose();
	}
});
