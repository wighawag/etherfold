import {expect, test} from '@playwright/test';
import {mountHarness} from 'playwright-browser-harness';
import {hostingShapeCases} from './hostingShapes.js';

/**
 * THREE HOSTING SHAPES, ONE IMPLEMENTATION (ADR-0082).
 *
 * The ADR opens with a claim -- a dedicated worker, a SharedWorker and the main
 * thread must not become three implementations -- and this is the run that
 * checks it. It runs HERE because it is the only place all three shapes exist at
 * once: a `Worker` and a `SharedWorker` are browser constructs, and the third is
 * `createIndexerState` on the page's own thread.
 *
 * ## Why it is one LIST and not three specs
 *
 * "One implementation" is easy to assert weakly. Three spec files that happen to
 * agree prove nothing, because they drift one edit at a time and each goes on
 * passing. So the behaviours live in `hostingShapes.ts` as DATA -- the shape
 * `@etherfold/state-store-conformance` uses to parameterise over store
 * implementations -- and this spec runs that list three times over three ports,
 * reporting the failures by name. A behaviour somebody adds is added for all
 * three at once, because there is one place to add it.
 *
 * `test/theThreeHostingShapesRunOneImplementation.test.ts` runs the SAME list
 * against the main-thread shape under `fake-indexeddb`, on every commit -- which
 * is what keeps it honest between browser runs, since the acceptance gate has no
 * browser binaries.
 */

const CUT = new URL('./cut.ts', import.meta.url).pathname;
/**
 * ONE entry point, BOTH worker shapes: it picks its helper from the scope it
 * finds itself in, so "what runs inside the host is unchanged between the shapes"
 * is a fact about one built file. The main-thread shape loads no bundle at all.
 */
const WORKER = new URL('./indexer.bothShapes.worker.ts', import.meta.url).pathname;

/** Unique per run, so an engine's leftover database from a previous run is never read. */
function tag(name: string): string {
	return `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test('runs one behaviour suite against all three hosting shapes, and passes on each', async ({page}) => {
	const harness = await mountHarness(page, {cut: CUT, worker: WORKER, coi: false});
	try {
		const run = await harness.run({phase: 'once', params: {case: 'hosting-shapes', tag: tag('shapes')}});

		expect(run.errors).toEqual([]);
		expect(run.results.tabScope).toBe('Window');
		expect(run.results.cases).toBe(hostingShapeCases.length);

		const shapes = ['dedicated', 'shared', 'mainThread'] as const;
		for (const shape of shapes) {
			const result = run.results[shape] as {
				host: string;
				scope: string;
				passed: number;
				failures: {group: string; name: string; error: string}[];
			};
			// Reported as the behaviours that broke, per shape, rather than as one opaque
			// red suite: a divergence names itself.
			expect(`${shape}: ${JSON.stringify(result.failures)}`).toBe(`${shape}: []`);
			expect(result.passed).toBe(hostingShapeCases.length);
		}

		// WHICH shape answered, as the entry point that obtained each port named it.
		expect((run.results.dedicated as {host: string}).host).toBe('dedicated-worker');
		expect((run.results.shared as {host: string}).host).toBe('shared-worker');
		expect((run.results.mainThread as {host: string}).host).toBe('main-thread');

		// WHERE each fold ran, measured in the context that ran it. This is the one
		// thing the three legitimately differ in, and it is the whole difference: the
		// main-thread shape says `Window`, which is exactly what it costs.
		expect((run.results.dedicated as {scope: string}).scope).toBe('DedicatedWorkerGlobalScope');
		expect((run.results.shared as {scope: string}).scope).toBe('SharedWorkerGlobalScope');
		expect((run.results.mainThread as {scope: string}).scope).toBe('Window');
	} finally {
		await harness.dispose();
	}
});
