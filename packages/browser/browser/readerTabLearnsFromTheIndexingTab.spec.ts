import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect, test} from '@playwright/test';
import {mountHarness} from './harness.js';
import {BRANCH_A_TIP, EXPECTED_A, START_BLOCK} from './workload.js';

/**
 * THREE REAL TABS, THREE REAL HOSTS, TWO DATABASES, ONE CHANNEL EACH.
 *
 * The run the node tests cannot make, and the reason is the whole task: a tab
 * that is not doing the indexing has NO PORT to the host that is, so the only
 * thing that can tell it the state moved is a `BroadcastChannel` between
 * DOCUMENTS. `test/aReaderTabLearnsFromTheIndexingTab.test.ts` asserts the same
 * claims over real `BroadcastChannel`s on every commit, with the two tabs faked
 * as two objects in one process, because that is the only part a node process
 * cannot have.
 *
 * ## Why it is NOT the shared-worker case
 *
 * The nearest existing case (`sharedWorkerServesSeveralTabs.spec.ts`) puts
 * several tabs on ONE host. Those tabs already hold a port to it and are already
 * pushed its notifications, so a channel test there would pass while
 * demonstrating nothing. The case that proves this signal is tabs with their OWN
 * hosts against one database -- which is also the shape an app has before
 * `one-tab-indexes-and-the-others-read` exists, where every tab opens a host and
 * the **writer token** decides which one actually writes (ADR-0075).
 *
 * ## What each tab is
 *
 * - the READER tab holds its own dedicated worker over the shared database,
 *   HELD at its first fetch so that it claims the store and then folds nothing.
 *   It listens on two channels and re-reads only when it is told;
 * - the NEXT DOOR tab is another app on this origin: its own host, its own
 *   database, its own channel, folding the same fixture to the tip. It is what
 *   makes "the reader heard nothing" a fact rather than a vacuous negative;
 * - the INDEXING tab holds its own dedicated worker over the shared database,
 *   claims the store second (so it is the one that writes), folds to a HELD
 *   block, and forwards everything its port tells it to the channel.
 *
 * Deliberately not part of `pnpm test`, which is what the acceptance gate runs:
 * it needs `playwright install` and three browser binaries a clean CI checkout
 * does not have, which is this package's existing convention. Results are
 * WRITTEN, per engine, to
 * `docs/spikes/a-reader-tab-learns-from-the-indexing-tab/results/`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, '../../../docs/spikes/a-reader-tab-learns-from-the-indexing-tab/results');
const CUT = path.join(HERE, 'cut.ts');
const WORKER = path.join(HERE, 'indexer.worker.ts');

/** The blocks this fixture carries logs in, which are therefore the blocks a fold APPLIES. */
const APPLIED_BLOCKS = [100, 102, 104];
/** Both declared entities are touched by every transfer: the token row and the counter. */
const TOUCHED = ['counter', 'token'];
/** Where the indexing tab's fold is held, so a listener can attach in the middle of it. */
const HELD_AT = 103;

function tag(name: string): string {
	return `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * WHAT A RECORDED RESULT DELIBERATELY DOES NOT CARRY: anything that changes when
 * the same behaviour happens twice.
 *
 * The same rule (and the same reason) as `sharedWorkerServesSeveralTabs.spec.ts`:
 * these files are COMMITTED, so a value in them is either evidence or churn. Here
 * the churn is the COHERENCE TOKEN, which is a fresh random value per fold by
 * construction, and the database names, which carry a timestamp.
 *
 * The tokens are not DROPPED, because their relation is the whole evidence: every
 * notification of one fold carries the same one, and a token from another fold is
 * a different one. So each distinct token becomes a stable label in order of first
 * appearance (`fold-1`, `fold-2`, ...). A re-run of the same behaviour then
 * produces a byte-identical file, and a real behavioural change still shows up as
 * a diff.
 *
 * The third is subtler and worth saying out loud, because it is the MODEL rather
 * than the harness: a read triggered by a notification answers from where the fold
 * is NOW, which may already be past the block that triggered it. The signal says
 * WHAT MOVED and never hands over a delta (ADR-0083), so an INTERMEDIATE read is a
 * race between the reader and the next block -- measured differing between engines
 * and between runs, token 1 reading as its block-100 owner or its block-102 owner.
 * What each read was triggered BY is evidence and is kept; the state of every read
 * but the LAST is dropped, since after the fold reaches the tip nothing moves and
 * that one is the answer the tab settles on.
 */
function stabilise(body: unknown): unknown {
	const labels = new Map<string, string>();
	const label = (token: string) => {
		const existing = labels.get(token);
		if (existing) return existing;
		const next = `fold-${labels.size + 1}`;
		labels.set(token, next);
		return next;
	};
	const settling = (reads: unknown): unknown =>
		Array.isArray(reads)
			? reads.map((read, index) => (index === reads.length - 1 ? walk(read) : {block: (read as {block: number}).block}))
			: walk(reads);
	const walk = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(walk);
		if (value && typeof value === 'object') {
			return Object.fromEntries(
				Object.entries(value as Record<string, unknown>).map(([key, inner]) => {
					if (key === 'reads' || key === 'lateReads') return [key, settling(inner)];
					if (key === 'coherence' && typeof inner === 'string') return [key, label(inner)];
					// The channel name carries the database name, which carries the run's own
					// timestamp. What is evidence about it is its SHAPE and which parts of it
					// two tabs agreed on, not the stamp.
					if ((key === 'channel' || key === 'nextDoorChannel') && typeof inner === 'string') {
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

type Told = {kind: string; block: number; coherence: string; entities: string[]; generation: string};

test('a reader tab with its own host learns from the indexing tab, and the app next door hears nothing', async ({
	browser,
}, testInfo) => {
	const shared = tag('cross-tab');
	const context = await browser.newContext();

	const indexingPage = await context.newPage();
	const lead = await mountHarness(indexingPage, {cut: CUT, worker: WORKER, coi: false});
	const readerPage = await context.newPage();
	// the same bundle and the same server: tabs of ONE app on ONE origin
	const reader = await mountHarness(readerPage, {
		cut: CUT,
		coi: false,
		prebuilt: {outdir: lead.outdir, serverUrl: lead.serverUrl},
	});
	const nextDoorPage = await context.newPage();
	const nextDoor = await mountHarness(nextDoorPage, {
		cut: CUT,
		coi: false,
		prebuilt: {outdir: lead.outdir, serverUrl: lead.serverUrl},
	});

	try {
		// (1) THE READER TAB LISTENS, before anything has folded into this store.
		const listening = await reader.run({phase: 'once', params: {case: 'cross-tab-reader-listen', tag: shared}});
		expect(listening.errors).toEqual([]);
		expect(listening.results.tabScope).toBe('Window');
		// its OWN host, in a worker of its own, holding the store and folding nothing
		expect(listening.results.host).toBe('dedicated-worker');
		expect(listening.results.scope).toBe('DedicatedWorkerGlobalScope');
		expect(listening.results.told).toEqual([]);
		expect(listening.results.stateBeforeAnyNotification).toEqual({
			owners: {'1': undefined, '2': undefined, '3': undefined, '4': undefined},
			transfers: 0,
		});
		// THE CHANNEL IS THE STORAGE: the name is composed from the database this
		// state lives in and nothing else, so the app next door is a different name
		// with nothing configured to keep them apart.
		expect(listening.results.channel).toBe(`etherfold/state-moved/${shared}-cross-tab`);
		expect(listening.results.nextDoorChannel).toBe(`etherfold/state-moved/${shared}-cross-tab-next-door`);

		// (2) THE APP NEXT DOOR FOLDS A WHOLE CHAIN, in its own tab, into its own
		// store, publishing every block of it.
		const nextDoorFold = await nextDoor.run({phase: 'once', params: {case: 'cross-tab-nextdoor-fold', tag: shared}});
		expect(nextDoorFold.errors).toEqual([]);
		expect(nextDoorFold.results.lastToBlock).toBe(BRANCH_A_TIP);
		expect(nextDoorFold.results.transfers).toBe(EXPECTED_A.transfers);
		expect((nextDoorFold.results.published as Told[]).map((one) => one.block)).toEqual(APPLIED_BLOCKS);

		// (3) ...AND THE READER TAB HEARD NOT ONE WORD OF IT on its own channel,
		// while hearing all of it on the one scoped to that store. Both directions,
		// which is the only way either is worth asserting.
		const quiet = await reader.run({phase: 'once', params: {case: 'cross-tab-reader-quiet', tag: shared}});
		expect(quiet.errors).toEqual([]);
		expect((quiet.results.nextDoor as Told[]).map((one) => one.block)).toEqual(APPLIED_BLOCKS);
		expect(quiet.results.told).toEqual([]);
		// ...so it has not re-read either: nothing in this tab is on a timer.
		expect(quiet.results.read).toBe(0);

		// (4) THE INDEXING TAB TAKES THE STORE AND FOLDS, held half way.
		const started = await lead.run({phase: 'once', params: {case: 'cross-tab-writer-start', tag: shared}});
		expect(started.errors).toEqual([]);
		expect(started.results.host).toBe('dedicated-worker');
		expect(started.results.scope).toBe('DedicatedWorkerGlobalScope');
		expect(started.results.lastToBlock).toBe(HELD_AT);
		expect(started.results.channel).toBe(listening.results.channel);
		const publishedSoFar = started.results.published as Told[];
		expect(publishedSoFar.map((one) => one.block)).toEqual([100, 102]);

		// (5) A LISTENER ATTACHES HALF WAY THROUGH, and is handed NOTHING for the
		// blocks it missed: the producer holds nothing per receiving tab.
		const late = await reader.run({phase: 'once', params: {case: 'cross-tab-reader-late', tag: shared}});
		expect(late.errors).toEqual([]);
		expect(late.results.lateTold).toEqual([]);
		// The tab that was listening throughout was told about both blocks as they
		// landed, and re-read once per notification.
		const heardSoFar = late.results.told as Told[];
		expect(heardSoFar.map((one) => one.block)).toEqual([100, 102]);
		expect(heardSoFar).toEqual(publishedSoFar);
		expect((late.results.reads as {block: number; state: {transfers: number}}[]).map((one) => one.block)).toEqual([
			100, 102,
		]);

		// (6) THE INDEXING TAB FINISHES.
		const finished = await lead.run({phase: 'once', params: {case: 'cross-tab-writer-finish', tag: shared}});
		expect(finished.errors).toEqual([]);
		expect(finished.results.lastToBlock).toBe(BRANCH_A_TIP);
		expect(finished.results.transfers).toBe(EXPECTED_A.transfers);

		// (7) AND THE READER TAB RENDERS WHAT THE WRITER FOLDED, because it was told.
		const report = await reader.run({phase: 'once', params: {case: 'cross-tab-reader-report', tag: shared}});
		record('two-tabs-one-database', testInfo.project.name, {
			listening: listening.results,
			nextDoor: nextDoorFold.results,
			quiet: quiet.results,
			writerHeld: started.results,
			readerLate: late.results,
			writerFinished: finished.results,
			report: report.results,
		});
		expect(report.errors).toEqual([]);

		const told = report.results.told as Told[];
		const published = finished.results.published as Told[];
		// ONE NOTIFICATION PER APPLIED BLOCK, in the order the fold applied them, in
		// a tab that holds no port to the host that applied them.
		expect(told.map((one) => one.block)).toEqual(APPLIED_BLOCKS);
		// THE VALUE IS THE ONE THE FOLD PUBLISHED: what the reader tab was handed is
		// byte for byte what the indexing tab was handed over its PORT. That is the
		// adapter claim -- an app writes one handler (ADR-0083).
		expect(told).toEqual(published);
		for (const one of told) {
			expect(one.kind).toBe('applied');
			expect(one.entities).toEqual(TOUCHED);
			expect(one.generation).toMatch(/\S/);
		}
		// ONE TOKEN THROUGHOUT: nothing was retracted and the pointer did not move,
		// so a reader comparing it invalidates NARROWLY using `entities`.
		expect(new Set(told.map((one) => one.coherence)).size).toBe(1);

		// NOTHING CROSSED BETWEEN THE STORES, in either direction: the app next
		// door's fold was published under a different token on a different channel,
		// and this tab heard it on that one and only that one.
		const heardNextDoor = report.results.nextDoor as Told[];
		expect(heardNextDoor.map((one) => one.block)).toEqual(APPLIED_BLOCKS);
		expect(new Set(heardNextDoor.map((one) => one.coherence)).size).toBe(1);
		expect(heardNextDoor[0]!.coherence).not.toBe(told[0]!.coherence);

		// IT RE-READ ONLY WHEN TOLD, and what it holds now is the writer's state.
		const reads = report.results.reads as {block: number; state: typeof EXPECTED_A}[];
		expect(reads.map((one) => one.block)).toEqual(APPLIED_BLOCKS);
		expect(reads.at(-1)!.state).toEqual(EXPECTED_A);
		expect(report.results.state).toEqual(EXPECTED_A);

		// THE TAB THAT MISSED TWO BLOCKS CONVERGED ON THE NEXT ONE rather than
		// staying stale: it was told about 104 alone and read the WHOLE fold,
		// including the blocks nobody told it about.
		const lateTold = report.results.lateTold as Told[];
		expect(lateTold.map((one) => one.block)).toEqual([104]);
		const lateReads = report.results.lateReads as {block: number; state: typeof EXPECTED_A}[];
		expect(lateReads.map((one) => one.block)).toEqual([104]);
		expect(lateReads[0]!.state).toEqual(EXPECTED_A);

		// NO ELECTION HAPPENED HERE, and the evidence is structural: nothing on the
		// wire names the publisher, so no reader could have asked who is indexing.
		for (const one of [...told, ...lateTold, ...heardNextDoor]) {
			expect(Object.keys(one).sort()).toEqual(['block', 'coherence', 'entities', 'generation', 'kind']);
		}
		// This tab wired its own host to the channel exactly as the indexing tab did
		// -- every tab publishes, every tab listens -- and published nothing, because
		// its fold applied nothing. Its own host never got anywhere.
		expect(report.results.published).toEqual([]);
		// ...and it never applied a block: a container that has loaded and fetched
		// nothing reports a cursor below this fixture's very first block.
		expect(report.results.ownHostLastToBlock as number).toBeLessThan(START_BLOCK);
	} finally {
		for (const harness of [nextDoor, reader, lead]) await harness.dispose().catch(() => undefined);
		await context.close();
	}
});
