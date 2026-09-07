/**
 * Read every results file and print the comparison the finding quotes.
 *
 * Medians with the spread beside them, never a single run: peak heap depends on
 * when garbage collection lands, and the same case measured twice differed by a
 * quarter.
 *
 *   node report.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, 'results');

const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	if (sorted.length === 0) return null;
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const mb = (n) => (n === null || n === undefined ? '-' : (n / 1048576).toFixed(1));
const totalMs = (row) => row.timings.filter((t) => !/^chunks: /.test(t.label)).reduce((n, t) => n + t.ms, 0);

const files = fs.existsSync(RESULTS) ? fs.readdirSync(RESULTS).filter((f) => f.startsWith('install-cost-')) : [];
if (files.length === 0) {
	console.log('no results yet: run `npx playwright test` and/or `node android.mjs`');
	process.exit(0);
}

for (const file of files) {
	const data = JSON.parse(fs.readFileSync(path.join(RESULTS, file), 'utf-8'));
	const runs = data.rows.filter((row) => row.shape && row.timings);
	if (runs.length === 0) continue;
	const label = data.device ? `${data.device} (REAL DEVICE)` : `${data.project} (desktop proxy)`;
	console.log(`\n### ${label}`);
	console.log(
		`${''.padEnd(58)} ${'ms'.padStart(12)} ${'peak page/cdp'.padStart(14)} ${'blockMs'.padStart(8)}  transferMB`,
	);

	// Keyed on the THROTTLE as well as the case: a results file accumulates runs
	// at different throttles (they merge by design), and folding them into one
	// median would report the spread between two conditions as noise within one.
	const byCase = new Map();
	for (const row of runs) {
		const key = `${row.case}||${row.throttle}`;
		if (!byCase.has(key)) byCase.set(key, []);
		byCase.get(key).push(row);
	}
	let lastThrottle;
	for (const [key, rows] of [...byCase.entries()].sort(([a], [b]) => a.split('||')[1].localeCompare(b.split('||')[1]))) {
		const [name, throttle] = key.split('||');
		if (throttle !== lastThrottle) {
			console.log(`-- throttle: ${throttle}`);
			lastThrottle = throttle;
		}
		const times = rows.map(totalMs);
		const inPage = rows.map((r) => r.peakHeapAboveBaselineBytes).filter((n) => typeof n === 'number');
		const sampled = rows.map((r) => r.peakSampledHeapBytes).filter((n) => typeof n === 'number');
		const blocking = rows.filter((r) => r.longTasks?.supported).map((r) => r.longTasks.longestMs);
		// BOTH instruments, side by side, never one silently chosen: the in-page
		// figure is ABOVE BASELINE and only Chromium-with-the-flag has it, while
		// the CDP figure is ABSOLUTE and is the only one the phone can give. They
		// are not the same quantity, so the comparison that crosses devices has to
		// be the cdp column.
		console.log(
			`${name.slice(0, 58).padEnd(58)} ` +
				`${`${median(times).toFixed(0)} (${Math.min(...times).toFixed(0)}-${Math.max(...times).toFixed(0)})`.padStart(12)} ` +
				`${`${mb(median(inPage))}/${mb(median(sampled))}`.padStart(14)} ` +
				`${(blocking.length > 0 ? median(blocking).toFixed(0) : 'n/a').padStart(8)}  ` +
				`${mb(rows[0].transferBytes)}`,
		);
	}
	const calibrated = runs.find((row) => row.heapCalibration && !row.heapCalibration.spoiledByGc);
	if (calibrated) {
		console.log(`  heap instrument linearity (2x allocation): ratio ${calibrated.heapCalibration.ratio}`);
	}
	const noLongTasks = runs.find((row) => row.longTasks && !row.longTasks.supported);
	if (noLongTasks) console.log('  long tasks: NOT SUPPORTED by this engine (reported as n/a, never as zero)');
	const ua = runs.find((row) => row.uaMemoryUnavailableBecause);
	if (ua) console.log(`  measureUserAgentSpecificMemory unavailable: ${ua.uaMemoryUnavailableBecause}`);
}

const artifacts = path.join(RESULTS, 'artifacts.json');
if (fs.existsSync(artifacts)) {
	const summary = JSON.parse(fs.readFileSync(artifacts, 'utf-8'));
	console.log('\n### the artifacts themselves');
	console.log(`  single, as committed (indented): ${mb(summary.fixture.rawBytes)} MB raw, ${mb(summary.fixture.gzipBytes)} MB gzipped`);
	console.log(`  single, compact:                 ${mb(summary.fixture.compactRawBytes)} MB raw, ${mb(summary.fixture.compactGzipBytes)} MB gzipped`);
	console.log(`  single, compact STORED-only:     ${mb(summary.fixture.storedRawBytes)} MB raw, ${mb(summary.fixture.storedGzipBytes)} MB gzipped`);
	for (const set of summary.chunkSets) {
		console.log(
			`  ${set.name.padEnd(31)} ${set.chunks} chunks, ${mb(set.totalGzipBytes)} MB gzipped total, ` +
				`largest chunk ${mb(set.largestChunkGzipBytes)} MB`,
		);
	}
	console.log(`  a chunk carrying the fixture header would add ${(summary.sharedHeaderRawBytes / 1024).toFixed(1)} KB each`);
}
