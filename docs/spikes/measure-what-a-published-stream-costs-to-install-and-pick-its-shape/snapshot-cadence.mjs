/**
 * How often was the stratagems state snapshot ACTUALLY republished?
 *
 * The seeding argument turns on this number and nothing else can supply it. If a
 * snapshot is republished often enough, a browser client never asks a public
 * node for old logs at all: it installs the snapshot and backfills only the
 * blocks since, which is a range every node serves. If it is republished rarely,
 * that window grows until it hits whatever the node will not serve, and a STREAM
 * seed becomes the only way to start.
 *
 * The reference deployment published its snapshots from a GitHub Actions cron
 * into `wighawag/stratagems-snapshots`, one commit per publish, so the commit
 * timestamps ARE the cadence. GitHub's cron is famously not punctual, which is
 * exactly why this is measured rather than quoted: what a client has to survive
 * is the WORST gap, not the intended one.
 *
 *   node snapshot-cadence.mjs
 *
 * Clones the public repository blobless (a few seconds; the API needs 80+ pages
 * for the same thing) into a temporary directory, reads `git log`, and writes
 * `results/snapshot-cadence.json`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, 'results');
const REPO = process.env.SNAPSHOT_REPO ?? 'https://github.com/wighawag/stratagems-snapshots.git';
/** Base's block time, derived in the finding from two of our own captures' provenance. */
const SECONDS_PER_BLOCK = 2;

const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-cadence-'));
try {
	execFileSync('git', ['clone', '--bare', '--filter=blob:none', '-q', REPO, clone], {stdio: 'inherit'});
	const log = execFileSync('git', ['-C', clone, 'log', '--format=%cI\t%s'], {encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024});

	const commits = log
		.trim()
		.split('\n')
		.map((line) => {
			const [when, ...rest] = line.split('\t');
			return {at: new Date(when), subject: rest.join('\t').trim()};
		})
		.sort((a, b) => a.at - b.at);

	// The cron's own commits, which is what a cadence is about: the handful of
	// setup commits at the start are not publishes and would fake a long gap.
	const publishes = commits.filter((one) => one.subject === 'update');
	const gapsHours = [];
	for (let i = 1; i < publishes.length; i++) {
		gapsHours.push((publishes[i].at - publishes[i - 1].at) / 3600000);
	}
	const sorted = [...gapsHours].sort((a, b) => a - b);
	const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
	const blocksFor = (hours) => Math.round((hours * 3600) / SECONDS_PER_BLOCK);

	const report = {
		repo: REPO,
		measuredAt: new Date().toISOString(),
		commits: commits.length,
		publishes: publishes.length,
		firstPublish: publishes[0]?.at.toISOString(),
		lastPublish: publishes[publishes.length - 1]?.at.toISOString(),
		spanDays: Number(((publishes[publishes.length - 1].at - publishes[0].at) / 86400000).toFixed(1)),
		gapHours: {
			min: Number(sorted[0].toFixed(2)),
			p10: Number(at(0.1).toFixed(2)),
			median: Number(at(0.5).toFixed(2)),
			p90: Number(at(0.9).toFixed(2)),
			p99: Number(at(0.99).toFixed(2)),
			max: Number(sorted[sorted.length - 1].toFixed(2)),
		},
		shareWithin: Object.fromEntries(
			[1, 2, 4, 6, 12, 24].map((hours) => [
				`${hours}h`,
				Number(((100 * sorted.filter((gap) => gap <= hours).length) / sorted.length).toFixed(2)),
			]),
		),
		// What the gap COSTS a client, which is the only reason the gap matters:
		// the blocks it must backfill from the node before it is current.
		backfillBlocks: {
			secondsPerBlock: SECONDS_PER_BLOCK,
			atMedian: blocksFor(at(0.5)),
			atP99: blocksFor(at(0.99)),
			atWorst: blocksFor(sorted[sorted.length - 1]),
		},
		longestGaps: sorted
			.slice(-5)
			.map((hours) => Number(hours.toFixed(2)))
			.reverse(),
	};

	fs.mkdirSync(RESULTS, {recursive: true});
	fs.writeFileSync(path.join(RESULTS, 'snapshot-cadence.json'), `${JSON.stringify(report, null, 2)}\n`);

	const fmt = (hours) => (hours < 1 ? `${(hours * 60).toFixed(0)} min` : `${hours.toFixed(1)} h`);
	console.log(`${report.publishes} publishes over ${report.spanDays} days (${report.firstPublish} to ${report.lastPublish})`);
	console.log(
		`gaps: median ${fmt(report.gapHours.median)}, p90 ${fmt(report.gapHours.p90)}, ` +
			`p99 ${fmt(report.gapHours.p99)}, WORST ${fmt(report.gapHours.max)}`,
	);
	console.log(`within 2h: ${report.shareWithin['2h']}%  |  within 4h: ${report.shareWithin['4h']}%`);
	console.log(
		`backfill a client faces: ${report.backfillBlocks.atMedian.toLocaleString()} blocks at the median, ` +
			`${report.backfillBlocks.atWorst.toLocaleString()} at the worst observed gap`,
	);
} finally {
	fs.rmSync(clone, {recursive: true, force: true});
}
