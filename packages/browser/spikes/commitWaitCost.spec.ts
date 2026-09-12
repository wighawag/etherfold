import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect, test} from '@playwright/test';
import {mountHarness} from '../browser/harness.js';

/**
 * WHAT THE WEBKIT WORKAROUND COSTS, on all three engines.
 *
 * The wedge in
 * `work/notes/findings/webkit-does-not-abort-a-terminated-workers-indexeddb-transaction.md`
 * is avoidable by never holding two transactions at once, and the open question
 * is whether that is cheap enough to do everywhere -- which would remove the
 * whole engine-detection problem, since a WebKit engine cannot be identified
 * from inside a worker at all (`spikes/` detect probe).
 *
 * So this measures the shipped `IndexedDBStateStore` against itself: the same
 * workload, the same rows, with `oneTransactionAtATime` off and on. Reads with
 * nothing else running give the per-read price; a fold running WHILE a reader
 * hammers the store gives the throughput price, which is the one serialising can
 * actually hurt.
 *
 * Each engine runs it `REPEATS` times with the ORDER ALTERNATED, because
 * whichever candidate runs first pays for a cold database and a cold JIT, and
 * that is worth more than the effect being measured.
 *
 * Run: `pnpm --filter @etherfold/browser exec playwright test --config spikes/playwright.config.ts commitWaitCost`
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CUT = join(HERE, 'commitWaitCost.cut.ts');
const RESULTS = join(HERE, '../../../docs/spikes/webkit-terminated-worker-wedges-indexeddb/results');

const REPEATS = Number(process.env.REPEATS ?? '4');
/**
 * How much work goes into ONE sample.
 *
 * Deliberately large. At 400 reads a measurement is ~45 ms, and a single garbage
 * collection inside it moves the paired ratio between 0.65 and 1.8 -- which is
 * several times the effect being measured, so a small sample does not merely add
 * noise, it manufactures conclusions.
 */
const WORKLOAD = {
	rows: Number(process.env.ROWS ?? '4000'),
	blocks: Number(process.env.BLOCKS ?? '200'),
	reads: Number(process.env.READS ?? '4000'),
	listings: Number(process.env.LISTINGS ?? '400'),
};

type Measurement = {
	usPerPointRead: number;
	usPerListing: number;
	usPerCursorRead: number;
	usPerAsOfRead: number;
	concurrentMsPerBlock: number;
	concurrentUsPerRead: number;
	concurrentReadsServed: number;
};

const KEYS: (keyof Measurement)[] = [
	'usPerPointRead',
	'usPerListing',
	'usPerCursorRead',
	'usPerAsOfRead',
	'concurrentMsPerBlock',
	'concurrentUsPerRead',
	'concurrentReadsServed',
];

/** The MEDIAN, not the mean: one scheduling hiccup should not decide a percentage. */
function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

test('what refusing two transactions at once costs', async ({page}, testInfo) => {
	test.setTimeout(30 * 60 * 1000);
	const harness = await mountHarness(page, {cut: CUT, coi: false});
	try {
		const samples: {asShipped: Measurement; serialised: Measurement}[] = [];
		for (let repeat = 0; repeat < REPEATS; repeat++) {
			const run = await harness.run({
				phase: 'once',
				params: {...WORKLOAD, first: repeat % 2 === 0 ? 'as-shipped' : 'serialised'},
			});
			expect(run.errors).toEqual([]);
			samples.push({
				asShipped: run.results.asShipped as Measurement,
				serialised: run.results.serialised as Measurement,
			});
		}

		const summary: Record<string, unknown> = {engine: testInfo.project.name, repeats: REPEATS, workload: WORKLOAD};
		for (const key of KEYS) {
			const shipped = median(samples.map((one) => one.asShipped[key]));
			const serialised = median(samples.map((one) => one.serialised[key]));
			// PAIRED: each repeat measured both candidates back to back, so the ratio
			// within a repeat cancels the drift between repeats that the medians of two
			// separate distributions do not.
			const paired = samples.filter((one) => one.asShipped[key]).map((one) => one.serialised[key] / one.asShipped[key]);
			summary[key] = {
				asShipped: +shipped.toFixed(2),
				serialised: +serialised.toFixed(2),
				ratio: shipped === 0 ? null : +(serialised / shipped).toFixed(2),
				pairedRatio: paired.length ? +median(paired).toFixed(2) : null,
				pairedRange: paired.length ? [+Math.min(...paired).toFixed(2), +Math.max(...paired).toFixed(2)] : null,
			};
		}
		summary.raw = samples;

		mkdirSync(RESULTS, {recursive: true});
		writeFileSync(join(RESULTS, `commit-wait-${testInfo.project.name}.json`), `${JSON.stringify(summary, null, 2)}\n`);
		for (const key of KEYS) {
			const one = summary[key] as {
				asShipped: number;
				serialised: number;
				pairedRatio: number | null;
				pairedRange: [number, number] | null;
			};
			// eslint-disable-next-line no-console
			console.log(
				`COST ${testInfo.project.name} ${key}: ${one.asShipped} -> ${one.serialised} ` +
					`(paired x${one.pairedRatio}, range x${one.pairedRange?.[0]}-x${one.pairedRange?.[1]})`,
			);
		}
		expect(samples.length).toBe(REPEATS);
	} finally {
		await harness.dispose();
	}
});
