import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect, test} from '@playwright/test';
import {mountHarness} from './harness.js';
import {BRANCH_A_TIP, EXPECTED_A, START_BLOCK, type FetchedRange} from './workload.js';

/**
 * TWO REAL TABS, ONE REAL SHAREDWORKER, ONE FOLD.
 *
 * This is the run the node tests cannot make, and the reason is the whole task:
 * a SharedWorker is identified by its SCRIPT URL plus its NAME, so "several tabs
 * attached to one host" is a fact about two DOCUMENTS in one browser reaching the
 * same instance with nothing configured to make them. `test/aSharedWorkerServesSeveralTabs.test.ts`
 * asserts the same claims over real `MessagePort`s on every commit, with the
 * `connect` event faked, because that is the only part a node process cannot
 * have.
 *
 * Driving several real tabs follows the IndexedDB package's multi-tab cases
 * (`packages/state-store-indexeddb/browser/multi-tab.spec.ts`): one lead harness
 * builds and serves the bundle, and every other tab mounts against the SAME
 * `outdir` and `serverUrl`, which is what makes them tabs of one app on one
 * origin rather than two apps.
 *
 * ## What each tab reports, and why an `instance` is the evidence
 *
 * The port has no case for "which host are you" and should not grow one: an app
 * has no use for the answer. So the fixture entry
 * (`indexer.bothShapes.worker.ts`) mints a value once per script execution and
 * says it straight at every attached page, off the port. Two tabs reporting the
 * SAME value are attached to one host; a tab reporting a DIFFERENT one after
 * every tab went away is attached to a host the browser started afresh, which is
 * what makes "it resumed" a claim about a host that really did go.
 *
 * Deliberately not part of `pnpm test`, which is what the acceptance gate runs:
 * it needs `playwright install` and three browser binaries a clean CI checkout
 * does not have, which is this package's existing convention. Results are
 * WRITTEN, per engine, to `docs/spikes/a-sharedworker-serves-several-tabs-from-one-host/results/`
 * -- the same convention as the IndexedDB multi-tab cases, and for the same
 * reason: what three engines agreed on is evidence worth keeping where a reader
 * can find it without a browser.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, '../../../docs/spikes/a-sharedworker-serves-several-tabs-from-one-host/results');
const CUT = path.join(HERE, 'cut.ts');
/**
 * The app-authored entry point, which here is BOTH entry points.
 *
 * The harness builds it to `worker.js` beside the page bundle, and this spec
 * loads that one file twice: once as a `SharedWorker` and once (in the
 * both-shapes case) as a `Worker`. One build, one file, two shapes.
 */
const WORKER = path.join(HERE, 'indexer.bothShapes.worker.ts');

/** The name the two tabs of ONE app pass. Half of the host's identity; the URL is the other half. */
const APP = 'etherfold-indexer';

function tag(name: string): string {
	return `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * WHAT A RECORDED RESULT DELIBERATELY DOES NOT CARRY: anything that changes when
 * the same behaviour happens twice.
 *
 * These files are COMMITTED, so every value in them is either evidence or churn.
 * A wall-clock stamp and the host's random `instance` id are churn: they made an
 * ordinary `pnpm test:browser` rewrite all nine files, leaving an unrelated dirty
 * tree that a later `git add -A` would sweep into somebody else's commit.
 *
 * The stamp is simply dropped -- git already records when a file changed, and it
 * records it more honestly than the file can record itself.
 *
 * The instance ids are NOT dropped, because they are the whole evidence: two tabs
 * reporting the SAME one is what "one host serves several tabs" means, and a
 * third reporting a DIFFERENT one is what says the first pair were not simply the
 * only host there was. So each distinct id is replaced by a stable label in order
 * of first appearance (`host-1`, `host-2`, ...). The relation is preserved
 * exactly; only the entropy is gone, so a re-run of the same behaviour produces a
 * byte-identical file and a real behavioural change still shows up as a diff.
 */
function stabilise(body: unknown): unknown {
	const labels = new Map<string, string>();
	const label = (id: string) => {
		const existing = labels.get(id);
		if (existing) return existing;
		const next = `host-${labels.size + 1}`;
		labels.set(id, next);
		return next;
	};
	const walk = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(walk);
		if (value && typeof value === 'object') {
			return Object.fromEntries(
				Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
					key,
					key === 'instance' && typeof inner === 'string' ? label(inner) : walk(inner),
				]),
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

/** The expected port surface: the dedicated shape's own list, unchanged. */
const PORT_SURFACE = [
	'checkTxInclusion',
	'close',
	'generations',
	'host',
	'onHostDeath',
	'onProgress',
	'progress',
	'promotion',
	'reads',
	'reconfigure',
	'startIndexing',
	'stopIndexing',
];

test('two tabs attached to one SharedWorker read one fold, and both are pushed its progress', async ({
	browser,
}, testInfo) => {
	const shared = tag('shared');
	const context = await browser.newContext();
	const first = await context.newPage();
	const lead = await mountHarness(first, {cut: CUT, worker: WORKER, coi: false});
	const second = await context.newPage();
	// the same bundle and the same server: two tabs of ONE app
	const following = await mountHarness(second, {
		cut: CUT,
		coi: false,
		prebuilt: {outdir: lead.outdir, serverUrl: lead.serverUrl},
	});

	try {
		// BOTH AT ONCE, because that is how two tabs of an app arrive: whichever of
		// them constructs the worker first, there is one host afterwards.
		const [one, two] = await Promise.all([
			lead.run({phase: 'once', params: {case: 'shared-attach', tag: shared, name: APP}}),
			following.run({phase: 'once', params: {case: 'shared-attach', tag: shared, name: APP}}),
		]);
		// The same URL and a DIFFERENT name, from the tab that is already attached.
		const other = await lead.run({
			phase: 'once',
			params: {case: 'shared-other-app', tag: shared, name: 'another-app'},
		});
		const unsupported = await lead.run({phase: 'once', params: {case: 'shared-unsupported'}});

		record('two-tabs', testInfo.project.name, {tabs: [one.results, two.results], other: other.results});

		expect(one.errors).toEqual([]);
		expect(two.errors).toEqual([]);
		expect(other.errors).toEqual([]);

		// WHERE the work happened, measured in the context that did it. Neither
		// number here is a duration.
		for (const tab of [one, two]) {
			expect(tab.results.scope).toBe('SharedWorkerGlobalScope');
			expect(tab.results.tabScope).toBe('Window');
			expect(tab.results.host).toBe('shared-worker');
		}

		// ONE HOST. Two documents, one script URL, one name, and nothing configured
		// to bring them together.
		expect(one.results.instance).not.toBeNull();
		expect(two.results.instance).toBe(one.results.instance);

		// EXACTLY ONE FOLD IS RUNNING, asserted where a second one would be visible:
		// a host per tab would have asked the node for this span twice.
		const fetched = one.results.fetched as FetchedRange[];
		expect(fetched.filter((range) => range.from === START_BLOCK)).toHaveLength(1);
		expect(two.results.fetched).toEqual(fetched);

		// BOTH SEE THE SAME STATE, each from its own port, and the rows are the rows
		// this workload produces anywhere else (`indexing.spec.ts` asserts the same
		// constant).
		for (const tab of [one, two]) {
			expect(tab.results.latestBlock).toBe(BRANCH_A_TIP);
			expect(tab.results.lastToBlock).toBe(tab.results.latestBlock);
			expect(tab.results.transfers).toBe(EXPECTED_A.transfers);
			expect(tab.results.indexing).toBe(true);
			expect(tab.results.phase).toBe('at-tip');
			// ...and BOTH were pushed progress, unprompted, from a context that is not
			// the UI thread: the phases arrived in order and ended at the tip.
			expect((tab.results.phases as string[]).length).toBeGreaterThan(0);
			expect((tab.results.phases as string[]).at(-1)).toBe('at-tip');
			// the surface is the dedicated shape's surface: app code cannot tell
			expect(tab.results.portSurface).toEqual(PORT_SURFACE);
		}

		// A SECOND NAME IS A SECOND HOST, with nothing configured to keep them apart
		// -- the property ADR-0082 notes, verified rather than built. It folds into a
		// database of its own (the fixture derives one from `self.name`), which is the
		// consequence that matters: two apps sharing a bundle do not contend for one
		// store.
		expect(other.results.instance).not.toBeNull();
		expect(other.results.instance).not.toBe(one.results.instance);
		expect(other.results.host).toBe('shared-worker');
		expect(other.results.transfers).toBe(EXPECTED_A.transfers);

		// A RUNTIME WITHOUT SHAREDWORKER IS TOLD, in a sentence that names what is
		// missing and the shape that works everywhere -- and nothing falls back on
		// its own, because the shape decides how many writers an app has.
		expect(unsupported.results.refused).toBe(true);
		expect(unsupported.results.message).toContain('no SharedWorker');
		expect(unsupported.results.message).toContain('dedicatedWorkerHost');
	} finally {
		for (const harness of [lead, following]) await harness.dispose().catch(() => undefined);
		await context.close();
	}
});

/**
 * THE LIFECYCLE: A TAB GOING AWAY, AND THE LAST TAB GOING AWAY.
 *
 * Two different claims, and the difference is the whole reason the shared shape
 * needs its own lifecycle case. One tab closing must not be the host closing --
 * the instance belongs to every tab attached to it, so the fold goes on for
 * whoever is left. The LAST tab closing is the opposite: the browser ends the
 * worker, so what the next tab reaches is a host that knows nothing, and what
 * makes that harmless is that the cursor was written in the same transaction as
 * the block it describes (ADR-0027).
 *
 * The fold is HELD half way through (`holdAbove`) so that a tab is closed in the
 * MIDDLE of a fold rather than after one, and what the resume is asserted on is
 * the RANGES the node was asked for: a host that re-indexed from the start block
 * lands on exactly the same rows as one that resumed, so the resulting state
 * cannot tell them apart and the fetches can.
 */
test('a SharedWorker outlives one tab, and the tab after the last one resumes from the cursor', async ({
	browser,
}, testInfo) => {
	const shared = tag('shared-lifecycle');
	const context = await browser.newContext();
	const first = await context.newPage();
	const lead = await mountHarness(first, {cut: CUT, worker: WORKER, coi: false});
	const second = await context.newPage();
	const leaving = await mountHarness(second, {
		cut: CUT,
		coi: false,
		prebuilt: {outdir: lead.outdir, serverUrl: lead.serverUrl},
	});
	const held = {case: 'shared-attach', tag: shared, name: APP, hold: true};

	try {
		const [staying, going] = await Promise.all([
			lead.run({phase: 'once', params: held}),
			leaving.run({phase: 'once', params: held}),
		]);
		expect(staying.errors).toEqual([]);
		expect(going.errors).toEqual([]);
		// Both attached to one host, and the fold is held below the tip: there is a
		// middle of a fold for a tab to disappear in.
		expect(going.results.instance).toBe(staying.results.instance);
		expect(staying.results.lastToBlock).toBe(103);
		expect(staying.results.phase).toBe('catching-up');

		// ONE TAB GOES AWAY -- a real page closing, not a port being released -- and
		// the tab that stayed carries the fold to the tip.
		await second.close();
		const finished = await lead.run({phase: 'once', params: {case: 'shared-finish', tag: shared, name: APP}});
		expect(finished.errors).toEqual([]);

		// THE SAME HOST: it was not taken down by one of its tabs closing.
		expect(finished.results.instance).toBe(staying.results.instance);
		expect(finished.results.host).toBe('shared-worker');
		expect(finished.results.scope).toBe('SharedWorkerGlobalScope');
		expect(finished.results.indexing).toBe(true);
		expect(finished.results.latestBlock).toBe(BRANCH_A_TIP);
		expect(finished.results.lastToBlock).toBe(finished.results.latestBlock);
		expect(finished.results.transfers).toBe(EXPECTED_A.transfers);
		// ...and the store the host wrote is the state this workload produces
		// anywhere else, read back from the page through a READER.
		expect(finished.results.state).toEqual(EXPECTED_A);

		// THE LAST TAB GOES AWAY. The browser ends a SharedWorker when its last
		// client is gone, which is why the next tab is a resume and not a reconnect.
		await first.close();
		const third = await context.newPage();
		const after = await mountHarness(third, {
			cut: CUT,
			coi: false,
			prebuilt: {outdir: lead.outdir, serverUrl: lead.serverUrl},
		});
		const resumed = await after.run({phase: 'once', params: {case: 'shared-attach', tag: shared, name: APP}});

		record('lifecycle', testInfo.project.name, {
			attached: [staying.results, going.results],
			finished: finished.results,
			resumed: resumed.results,
		});

		expect(resumed.errors).toEqual([]);
		// A HOST THAT REALLY WENT: a different instance, so what follows is a resume
		// rather than a tab reconnecting to a fold that never stopped.
		expect(resumed.results.instance).not.toBeNull();
		expect(resumed.results.instance).not.toBe(finished.results.instance);

		// IT RESUMED. Nothing was asked for at or below the start block: the new host
		// read the cursor the last one left and carried on (ADR-0027).
		const refetched = resumed.results.fetched as FetchedRange[];
		expect(refetched.length).toBeGreaterThan(0);
		expect(Math.min(...refetched.map((range) => range.from))).toBeGreaterThan(START_BLOCK);
		expect(resumed.results.lastToBlock).toBe(BRANCH_A_TIP);
		expect(resumed.results.transfers).toBe(EXPECTED_A.transfers);

		await after.dispose().catch(() => undefined);
	} finally {
		for (const harness of [lead, leaving]) await harness.dispose().catch(() => undefined);
		await context.close();
	}
});

/**
 * ONE ENTRY POINT, BOTH SHAPES, AND THE SAME APP CODE AGAINST EACH.
 *
 * The criterion is that an app selects the shape at CONSTRUCTION and that the
 * code it writes against the port is byte-identical between the two, so it is
 * asserted as an EQUALITY: one function in the page (`whatAnAppSees`) is run
 * against a port to a dedicated worker and a port to a shared one, and everything
 * it reports has to match except the two fields that SAY which shape answered.
 *
 * Both hosts are built from the SAME bundle, loaded once as a `Worker` and once
 * as a `SharedWorker`, which is what makes "what runs inside the host is
 * unchanged" a fact about one file rather than a comparison of two.
 */
test('one entry point serves both hosting shapes, and app code cannot tell them apart', async ({page}, testInfo) => {
	const harness = await mountHarness(page, {cut: CUT, worker: WORKER, coi: false});
	try {
		const run = await harness.run({phase: 'once', params: {case: 'shared-both-shapes', tag: tag('both-shapes')}});
		// The TIMINGS are deliberately not recorded. Nothing asserts them, and a
		// wall-clock duration in a COMMITTED file changes on every run by definition,
		// so it would reintroduce exactly the churn `stabilise` exists to remove. They
		// remain in the run's own output for anyone debugging a slow shape.
		record('both-shapes', testInfo.project.name, {results: run.results});

		expect(run.errors).toEqual([]);
		const shared = run.results.shared as {host: string; scope: string; seen: Record<string, unknown>};
		const dedicated = run.results.dedicated as {host: string; scope: string; seen: Record<string, unknown>};

		// WHICH shape answered, and WHERE it ran: the two things that differ.
		expect(dedicated.host).toBe('dedicated-worker');
		expect(dedicated.scope).toBe('DedicatedWorkerGlobalScope');
		expect(shared.host).toBe('shared-worker');
		expect(shared.scope).toBe('SharedWorkerGlobalScope');
		expect(run.results.tabScope).toBe('Window');

		// EVERYTHING ELSE IS THE SAME. One piece of app code, two shapes, one answer.
		expect(shared.seen).toEqual(dedicated.seen);
		expect(shared.seen.surface).toEqual(PORT_SURFACE);
		expect(shared.seen.lastToBlock).toBe(BRANCH_A_TIP);
		expect(shared.seen.transfers).toBe(EXPECTED_A.transfers);
	} finally {
		await harness.dispose();
	}
});
