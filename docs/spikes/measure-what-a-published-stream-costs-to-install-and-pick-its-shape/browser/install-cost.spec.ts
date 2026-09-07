/**
 * The DESKTOP run: three engines, the two wire shapes, like for like.
 *
 * Desktop Playwright is a PROXY for the device that actually matters, and it is
 * labelled as one everywhere it is reported. What it cannot see is in the README
 * and in the finding: real mobile memory pressure and the eviction that follows
 * it, slower storage, and a background tab being suspended mid-install. The
 * phone run is `android.mjs`, against a named device, and it is the same cut.
 *
 *   npx playwright test --project=chromium
 *   SPIKE_THROTTLE=cpu4 npx playwright test --project=chromium
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test, expect} from '@playwright/test';
import {mountHarness} from 'playwright-browser-harness';
// @ts-expect-error prototype JS shared with the phone runner
import {withHeapSampling} from '../sampler.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const RESULTS = path.join(ROOT, 'results');
const CUT = path.join(HERE, 'cut.ts');
const ASSETS = path.join(ROOT, 'assets');

/** `cpu4` = a 4x CPU slowdown over CDP, the only throttle Chromium lets us force. */
const THROTTLE = process.env.SPIKE_THROTTLE ?? 'none';

/**
 * REPEATS, because these numbers move run to run.
 *
 * Peak heap depends on when garbage collection happens to land, and the same
 * case measured twice in one session differed by 25% (96 MB then 120 MB). A
 * single-shot figure would be quoting that noise as a result, so each case runs
 * several times and the finding reports the MEDIAN with the spread beside it.
 */
const REPEATS = Number(process.env.SPIKE_REPEATS ?? 3);

const rows: Record<string, unknown>[] = [];

test.beforeAll(() => {
	if (!fs.existsSync(path.join(ASSETS, 'single', 'stream.json.gz'))) {
		throw new Error('assets are missing: run `node prepare.mjs` first');
	}
});

test.afterAll(async ({}, testInfo) => {
	fs.mkdirSync(RESULTS, {recursive: true});
	const file = path.join(RESULTS, `install-cost-${testInfo.project.name}.json`);
	const existing = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf-8')).rows ?? []) : [];
	const keyOf = (row: any) => `${row.case}|${row.throttle}|${row.repeat}`;
	const merged = new Map<string, unknown>();
	for (const row of existing) merged.set(keyOf(row), row);
	for (const row of rows) merged.set(keyOf(row), row);
	fs.writeFileSync(
		file,
		`${JSON.stringify(
			{project: testInfo.project.name, ranAt: new Date().toISOString(), throttle: THROTTLE, rows: [...merged.values()]},
			null,
			2,
		)}\n`,
	);
});

/** Mount, and put the prepared artifacts where the page can fetch them. */
async function mount(page: any) {
	const harness = await mountHarness(page, {cut: CUT, coi: true});
	fs.cpSync(ASSETS, path.join(harness.outdir, 'assets'), {recursive: true});
	return harness;
}

/**
 * The DRIVER's own view of the heap, over CDP, as a cross-check on the page's.
 *
 * `performance.memory` needs a launch flag to be precise at all, so a number
 * that rests on it alone rests on a flag. `Runtime.getHeapUsage` is measured by
 * the inspector instead, and the two agreeing at the same moment is what makes
 * either believable. Chromium only, and `null` elsewhere rather than zero.
 */
async function cdpHeap(page: any, browserName: string): Promise<number | null> {
	if (browserName !== 'chromium') return null;
	try {
		const client = await page.context().newCDPSession(page);
		const usage = (await client.send('Runtime.getHeapUsage' as any)) as {usedSize: number};
		return usage.usedSize;
	} catch {
		return null;
	}
}

/**
 * Do the two instruments AGREE, asked properly.
 *
 * Not a check on the peak, which cannot be read twice: a check that
 * `performance.memory` under `--enable-precise-memory-info` reports what the
 * inspector reports. Both readings are taken back to back on a QUIESCENT page
 * with nothing allocated between them, which is the only way the comparison
 * means anything. An earlier version read one inside the run and the other after
 * it returned, and reported a 20x disagreement that was entirely garbage
 * collection happening in the gap.
 */
async function instrumentAgreement(page: any, browserName: string) {
	if (browserName !== 'chromium') return null;
	const fromPage = await page.evaluate(() => {
		const perf = performance as Performance & {memory?: {usedJSHeapSize: number}};
		return perf.memory ? perf.memory.usedJSHeapSize : null;
	});
	const fromCdp = await cdpHeap(page, browserName);
	if (fromPage === null || fromCdp === null) return null;
	return {fromPage, fromCdp, ratio: Number((fromPage / fromCdp).toFixed(3))};
}

async function throttleIfAsked(page: any, browserName: string) {
	if (THROTTLE === 'none') return;
	if (browserName !== 'chromium') {
		test.skip(true, 'only chromium can be CPU-throttled over CDP');
	}
	const client = await page.context().newCDPSession(page);
	const rate = Number(THROTTLE.replace('cpu', '')) || 4;
	await client.send('Emulation.setCPUThrottlingRate', {rate});
}

/**
 * TWO AXES, deliberately crossed rather than confounded: how the artifact is
 * DELIVERED (one document or contiguous chunks) and what it CARRIES (the
 * capture's decoded events, or only what the keeper stores). The parser is part
 * of the second axis, because a stored-only artifact has no tagged BigInt in it
 * to revive.
 */
const CASES = [
	{
		name: 'single, decoded, as committed (indented, parseStreamFixture)',
		params: {mode: 'single', url: './assets/single/stream.json.gz', parse: 'fixture'},
	},
	{
		name: 'single, decoded, compact (parseStreamFixture)',
		params: {mode: 'single', url: './assets/single-compact/stream.json.gz', parse: 'fixture'},
	},
	{
		name: 'single, decoded, compact (plain JSON.parse: isolates the revive)',
		params: {mode: 'single', url: './assets/single-compact/stream.json.gz', parse: 'json'},
	},
	{
		name: 'single, STORED-only, compact (plain JSON.parse)',
		params: {mode: 'single', url: './assets/single-stored/stream.json.gz', parse: 'json'},
	},
	{name: 'chunked 4000, decoded', params: {mode: 'chunked', base: './assets/chunks-4000'}},
	{name: 'chunked 1000, decoded', params: {mode: 'chunked', base: './assets/chunks-1000'}},
	{name: 'chunked 4000, STORED-only', params: {mode: 'chunked', base: './assets/chunks-stored-4000'}},
];

for (const one of CASES) {
	test(one.name, async ({page, browserName}, testInfo) => {
		await throttleIfAsked(page, browserName);
		const harness = await mount(page);
		try {
			for (let repeat = 0; repeat < REPEATS; repeat++) {
			// Sampled from OUTSIDE the page over CDP, which is the instrument the
			// phone run uses too, so desktop and device numbers are comparable.
			const client = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
			const sampled = await withHeapSampling(client, 25, () => harness.run({phase: 'once', params: one.params}));
			const run = sampled.value;
			expect(run.errors).toEqual([]);
			// Whatever the shape, the seed has to end up as ONE stream reaching the
			// capture's coverage end, or the numbers describe an install that did not
			// work.
			expect(run.results.stored).toMatchObject({present: true, events: 31332, lastToBlock: 23400000});
			rows.push({
				case: one.name,
				repeat,
				throttle: THROTTLE,
				project: testInfo.project.name,
				...run.results,
				peakSampledHeapBytes: sampled.peakSampledHeapBytes,
				heapSampleCount: sampled.sampleCount,
				instrumentAgreement: await instrumentAgreement(page, browserName),
				cdpHeapAfterRunBytes: await cdpHeap(page, browserName),
				timings: run.timings,
				env: run.env,
			});
			// A fresh page per repeat: IndexedDB and the heap both carry over
			// otherwise, and the second repeat would measure a warm store.
			await harness.reset();
			await harness.reload();
			}
		} finally {
			await harness.dispose();
		}
	});
}

/**
 * RESUMABILITY, which is the claim chunking is supposed to buy.
 *
 * ADR-0063 says a partial install is a contiguous prefix with an honest cursor,
 * so resuming needs no record of which chunks were installed: the keeper's own
 * cursor says where to continue. This installs three chunks, RELOADS the page,
 * and continues, asserting the client worked out where to resume by asking the
 * keeper and that the finished stream is identical to an uninterrupted one.
 */
test('chunked, interrupted and resumed across a reload', async ({page, browserName}, testInfo) => {
	await throttleIfAsked(page, browserName);
	const harness = await mount(page);
	try {
		const first = await harness.run({
			phase: 'write',
			params: {mode: 'chunked', base: './assets/chunks-4000', name: 'resume-case', stopAfter: 3},
		});
		expect(first.errors).toEqual([]);
		expect(first.results.chunksInstalled).toBe(3);
		const partial = first.results.stored as {present: boolean; lastToBlock: number; events: number};
		expect(partial.present).toBe(true);
		expect(partial.lastToBlock).toBeLessThan(23400000);

		await harness.reload();

		const second = await harness.run({
			phase: 'read',
			params: {mode: 'chunked', base: './assets/chunks-4000', name: 'resume-case'},
		});
		expect(second.errors).toEqual([]);
		// It resumed from the cursor, not from the beginning, and it finished.
		expect(second.results.resumedFrom).toBe(partial.lastToBlock + 1);
		expect(second.results.chunksInstalled).toBe(5);
		expect(second.results.stored).toMatchObject({present: true, events: 31332, lastToBlock: 23400000});

		rows.push({
			case: 'chunked 4000, interrupted after 3 and resumed across a reload',
			throttle: THROTTLE,
			project: testInfo.project.name,
			partialAfterThreeChunks: partial,
			resumedFrom: second.results.resumedFrom,
			chunksInstalledOnResume: second.results.chunksInstalled,
			stored: second.results.stored,
			timings: [...first.timings, ...second.timings],
			env: second.env,
		});
	} finally {
		await harness.dispose();
	}
});
