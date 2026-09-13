import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect, test} from '@playwright/test';
import {mountHarness} from './harness.js';
import {BRANCH_A_TIP} from './workload.js';

/**
 * FOUR REAL TABS, ONE DATABASE, ONE CHANNEL: "syncing, N blocks behind" rendered
 * in the three tabs that are NOT doing the folding.
 *
 * The run the node tests cannot make, and it is the whole task: a tab that is
 * not indexing has NO PORT to the host that is, so the only thing that can tell
 * it where the fold has got to is a `BroadcastChannel` between DOCUMENTS. It
 * could not work it out either -- the **sync cursor** is opaque behind the
 * storage seam (ADR-0027) -- so the side that knows publishes, on the ONE
 * channel a reader already listens to for the state-moved signal (ADR-0083)
 * rather than on a second mechanism with its own lifetime and its own silence.
 * `test/syncProgressRidesTheSignalToAReader.test.ts` asserts the same claims
 * over real `BroadcastChannel`s on every commit, with the tabs faked as objects
 * in one process, because that is the only part a node process cannot have.
 *
 * ## What each tab is
 *
 * - the INDEXING tab holds its own dedicated worker, claims the store LAST (so it
 *   is the one that writes, ADR-0075), folds to a HELD block and then to the tip,
 *   and forwards what its port tells it -- BOTH pushes, onto one channel;
 * - the READER WITH A HOST holds a dedicated worker of its own over the same
 *   database, HELD at its first fetch so it claims the store and then folds
 *   nothing. It is the sharpest version of the case: it COULD ask a host, and the
 *   answer would be a standstill, so what it renders has to come from the tab
 *   doing the work;
 * - the READER WITH NO HOST is the ordinary shape: a window that only renders;
 * - the NEWCOMER is a tab opened AFTER the fold reached the tip, which is the case
 *   nothing can push to. A host at the tip pushes nothing, so if attaching did not
 *   ASK, that window would render "nothing yet" until the chain moved.
 *
 * ## What is deliberately NOT here
 *
 * Any change to the port's own `progress` push, which ADR-0082 decided and which
 * shipped: this is a READER TAB, which has no port, being told the same facts
 * over the channel it does have. The reader tabs publish nothing themselves,
 * because progress is published by the tab whose fold is MOVING -- a held host
 * broadcasting its own standstill is the pre-election noise
 * `one-tab-indexes-and-the-others-read` removes.
 *
 * Deliberately not part of `pnpm test`, which is what the acceptance gate runs:
 * it needs `playwright install` and three browser binaries a clean CI checkout
 * does not have, which is this package's existing convention. Results are
 * WRITTEN, per engine, to
 * `docs/spikes/sync-progress-rides-the-signal-to-a-reader/results/`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, '../../../docs/spikes/sync-progress-rides-the-signal-to-a-reader/results');
const CUT = path.join(HERE, 'cut.ts');
const WORKER = path.join(HERE, 'indexer.worker.ts');

/** Where the indexing tab's fold is held, so a reader can be asserted on MID-FLIGHT. */
const HELD_AT = 103;
/** The blocks this fixture carries logs in, which are therefore the blocks a fold APPLIES. */
const APPLIED_BLOCKS = [100, 102, 104];

function tag(name: string): string {
	return `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * WHAT A RECORDED RESULT DELIBERATELY DOES NOT CARRY: anything that changes when
 * the same behaviour happens twice.
 *
 * The same rule (and the same reason) as the neighbouring cross-tab spec: these
 * files are COMMITTED, so a value in them is either evidence or churn. Here the
 * only churn is the database name, which carries the run's own timestamp and
 * rides inside the channel name; the reports themselves are block numbers and
 * phases, which is exactly what a re-run must reproduce.
 */
function stabilise(body: unknown): unknown {
	const walk = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(walk);
		if (value && typeof value === 'object') {
			return Object.fromEntries(
				Object.entries(value as Record<string, unknown>).map(([key, inner]) => {
					if (key === 'channel' && typeof inner === 'string') {
						return [key, inner.replace(/-\d{13}-[a-z0-9]{6}-/, '-<run>-')];
					}
					return [key, walk(inner)];
				}),
			);
		}
		return value;
	};
	return walk(body);
}

function record(name: string, project: string, body: unknown): void {
	fs.mkdirSync(RESULTS, {recursive: true});
	fs.writeFileSync(
		path.join(RESULTS, `${name}-${project}.json`),
		`${JSON.stringify({project, ...(stabilise(body) as object)}, null, 2)}\n`,
	);
}

type Report = {
	host: string;
	scope: string;
	phase: string;
	lastToBlock: number | null;
	latestBlock: number | null;
	blocksBehindTip: number | null;
	syncPercentage: number | null;
};

test('every tab renders how far behind the fold is, sourced from the one tab that knows', async ({
	browser,
}, testInfo) => {
	const shared = tag('progress');
	const context = await browser.newContext();

	const indexingPage = await context.newPage();
	const lead = await mountHarness(indexingPage, {cut: CUT, worker: WORKER, coi: false});
	const withAHostPage = await context.newPage();
	// the same bundle and the same server: tabs of ONE app on ONE origin
	const withAHost = await mountHarness(withAHostPage, {
		cut: CUT,
		coi: false,
		prebuilt: {outdir: lead.outdir, serverUrl: lead.serverUrl},
	});
	const withNoHostPage = await context.newPage();
	const withNoHost = await mountHarness(withNoHostPage, {
		cut: CUT,
		coi: false,
		prebuilt: {outdir: lead.outdir, serverUrl: lead.serverUrl},
	});

	try {
		// (1) THE READER TABS LISTEN, before anything has folded into this store. One
		// holds a host of its own (held at its first fetch); the other holds nothing
		// at all.
		const hostedReader = await withAHost.run({
			phase: 'once',
			params: {case: 'sync-progress-reader-with-a-host', tag: shared},
		});
		expect(hostedReader.errors).toEqual([]);
		expect(hostedReader.results.tabScope).toBe('Window');
		expect(hostedReader.results.told).toEqual([]);
		expect(hostedReader.results.rendered).toBe('nothing yet');
		// ITS OWN HOST KNOWS NOTHING USEFUL: held at its first fetch, it has learnt no
		// tip, so the distance to the tip is ABSENT rather than a zero a progress bar
		// would draw full.
		const heldHost = hostedReader.results.ownHost as Report;
		expect(heldHost.scope).toBe('DedicatedWorkerGlobalScope');
		expect(heldHost.blocksBehindTip).toBeNull();

		const plainReader = await withNoHost.run({
			phase: 'once',
			params: {case: 'sync-progress-reader-with-no-host', tag: shared},
		});
		expect(plainReader.errors).toEqual([]);
		expect(plainReader.results.told).toEqual([]);
		expect(plainReader.results.rendered).toBe('nothing yet');
		// ONE CHANNEL, named from the STORAGE and nothing else, in every tab.
		expect(plainReader.results.channel).toBe(`etherfold/state-moved/${shared}-progress-cross-tab`);
		expect(hostedReader.results.channel).toBe(plainReader.results.channel);

		// (2) THE INDEXING TAB TAKES THE STORE AND FOLDS, held half way, forwarding
		// what its port tells it.
		const started = await lead.run({phase: 'once', params: {case: 'sync-progress-writer-start', tag: shared}});
		expect(started.errors).toEqual([]);
		expect(started.results.host).toBe('dedicated-worker');
		expect(started.results.scope).toBe('DedicatedWorkerGlobalScope');
		expect(started.results.lastToBlock).toBe(HELD_AT);
		expect(started.results.channel).toBe(plainReader.results.channel);

		// (3) ...AND BOTH READER TABS RENDER THE SAME THING THE INDEXING TAB DOES,
		// mid-fold, with no port to the host that computed it.
		const midway = {
			hosted: await withAHost.run({
				phase: 'once',
				params: {case: 'sync-progress-reader-report', tag: shared, until: {lastToBlock: HELD_AT}},
			}),
			plain: await withNoHost.run({
				phase: 'once',
				params: {case: 'sync-progress-reader-report', tag: shared, until: {lastToBlock: HELD_AT}},
			}),
		};
		expect(midway.hosted.errors).toEqual([]);
		expect(midway.plain.errors).toEqual([]);
		for (const at of [midway.hosted, midway.plain]) {
			const held = at.results.heldByTheHelper as Report;
			expect(held.lastToBlock).toBe(HELD_AT);
			// THE HOST IS NAMED AS THE HOST THAT COMPUTED IT: a dedicated worker, in a
			// worker scope, which is not this tab.
			expect(held.scope).toBe('DedicatedWorkerGlobalScope');
			expect(at.results.rendered).toBe(`syncing, ${held.blocksBehindTip} blocks behind`);
			// the shipped helper holds the last report BY REFERENCE: a view, never a
			// value a reader assembled
			expect(at.results.holdsTheLastOneByReference).toBe(true);
		}
		// The tab that has a host of its own still renders the INDEXING tab's numbers
		// and not its own host's: its own host is exactly where it was.
		expect((midway.hosted.results.ownHost as Report).lastToBlock).toBeLessThan(HELD_AT);

		// (4) THE INDEXING TAB FINISHES.
		const finished = await lead.run({phase: 'once', params: {case: 'sync-progress-writer-finish', tag: shared}});
		expect(finished.errors).toEqual([]);
		expect(finished.results.lastToBlock).toBe(BRANCH_A_TIP);
		expect(finished.results.rendered).toBe('live');
		// ONE CHANNEL CARRIED BOTH: the notifications rode it too, unchanged, which is
		// what \"one channel, two things a reader can be told\" means.
		expect(finished.results.movedBlocks).toEqual(APPLIED_BLOCKS);

		// (5) AND EVERY READER TAB SAYS 'live', because it was told.
		const report = {
			hosted: await withAHost.run({
				phase: 'once',
				params: {case: 'sync-progress-reader-report', tag: shared, until: {phase: 'at-tip'}},
			}),
			plain: await withNoHost.run({
				phase: 'once',
				params: {case: 'sync-progress-reader-report', tag: shared, until: {phase: 'at-tip'}},
			}),
		};

		// (6) A TAB OPENED INTO A QUIET CHAIN, after everything above already
		// happened. Nothing will ever be pushed to it: it asks, and the tab that knows
		// answers.
		const newcomerPage = await context.newPage();
		const newcomer = await mountHarness(newcomerPage, {
			cut: CUT,
			coi: false,
			prebuilt: {outdir: lead.outdir, serverUrl: lead.serverUrl},
		});
		const opened = await newcomer.run({phase: 'once', params: {case: 'sync-progress-newcomer', tag: shared}});

		record('one-fold-every-tab-renders-it', testInfo.project.name, {
			readerWithAHost: hostedReader.results,
			readerWithNoHost: plainReader.results,
			writerHeld: started.results,
			readersMidway: {hosted: midway.hosted.results, plain: midway.plain.results},
			writerFinished: finished.results,
			readersAtTheTip: {hosted: report.hosted.results, plain: report.plain.results},
			newcomer: opened.results,
		});

		expect(report.hosted.errors).toEqual([]);
		expect(report.plain.errors).toEqual([]);
		const published = finished.results.published as Report[];
		const atTip = finished.results.atTip as Report;
		expect(atTip.blocksBehindTip).toBe(0);

		for (const at of [report.hosted, report.plain]) {
			// THE VALUE IS THE HOST'S OWN REPORT, and the sequence is the one the port
			// pushed: not a recomputation, not a reader-side derivation, not a second
			// vocabulary for how far the fold has got.
			expect(at.results.told).toEqual(published);
			expect(at.results.rendered).toBe(finished.results.rendered);
			expect(at.results.heldByTheHelper).toEqual(atTip);
		}
		// THE TWO READERS AGREE WITH EACH OTHER as well as with the indexing tab,
		// which is the claim stated the other way round.
		expect(report.hosted.results.told).toEqual(report.plain.results.told);
		// ...and the tab with a host of its own STILL renders the indexing tab's
		// position: its own host never got anywhere.
		expect((report.hosted.results.ownHost as Report).lastToBlock).toBeLessThan(BRANCH_A_TIP);

		expect(opened.errors).toEqual([]);
		// ONE report, and it is where the fold IS. Nothing is replayed to it: it was
		// never told about the blocks it missed, because nothing is kept per tab.
		expect(opened.results.told).toEqual([atTip]);
		expect(opened.results.rendered).toBe('live');

		await withAHost.run({phase: 'once', params: {case: 'sync-progress-reader-done', tag: shared}});
		await withNoHost.run({phase: 'once', params: {case: 'sync-progress-reader-done', tag: shared}});
		await lead.run({phase: 'once', params: {case: 'sync-progress-writer-done', tag: shared}});
		await newcomer.dispose().catch(() => undefined);
	} finally {
		for (const harness of [withNoHost, withAHost, lead]) await harness.dispose().catch(() => undefined);
		await context.close();
	}
});
