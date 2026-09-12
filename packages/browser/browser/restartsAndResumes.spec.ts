import {expect, test} from '@playwright/test';
import {mountHarness} from 'playwright-browser-harness';
import {BRANCH_A_TIP, EXPECTED_A, START_BLOCK, type FetchedRange} from './workload.js';

/**
 * A REAL DEDICATED WORKER, TERMINATED MID-FOLD, AND THE TAB THAT PUT ANOTHER ONE
 * IN ITS PLACE.
 *
 * Browsers evict workers, so ADR-0082 treats a death as an EXPECTED event with a
 * defined outcome: the app is told, every call in flight rejects by type, the
 * port restarts the host, and the fold resumes from the cursor. This is the run
 * that proves it where it has to be proved -- `Worker.terminate()` means nothing
 * outside a browser, and the node tests
 * (`test/aTerminatedHostRestartsAndResumes.test.ts`) can only ask a host to stop
 * answering.
 *
 * The kill is fired the moment the worker says it is STARTING A STORE WRITE,
 * because that is the case "the cursor is written in the same transaction as the
 * block it describes" (ADR-0027) exists for. A test that only terminated between
 * cycles would never produce it, and would pass against an implementation where
 * the cursor can be ahead of the data.
 *
 * ## What is asserted, and why it is not the end state
 *
 * A restart that re-ran the LOAD lands on exactly the same rows as one that
 * resumed -- correct-looking on a five-block fixture and an afternoon of syncing
 * on a real one. So the claim is the RANGES the replacement asked the node for:
 * nothing below the block the first host had already passed, and no hole left
 * anywhere in the span.
 *
 * Deliberately not part of `pnpm test`, which is what the acceptance gate runs:
 * it needs `playwright install` and three browser binaries a clean CI checkout
 * does not have, which is this package's existing convention.
 */

const CUT = new URL('./cut.ts', import.meta.url).pathname;
/** The app-authored entry point. The harness builds it to `worker.js` beside the page bundle. */
const WORKER = new URL('./indexer.worker.ts', import.meta.url).pathname;

function tag(name: string): string {
	return `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * WHETHER THESE RANGES COVER THE SPAN WITH NO HOLE IN IT.
 *
 * The honest form of "no skipped range": a resume RE-asks for part of what it
 * already had, because the unconfirmed window is refetched by design, so what
 * must be true of the ranges is that their union has no gap -- not that one
 * begins exactly where another ended.
 */
function coversWithoutGaps(ranges: readonly FetchedRange[], from: number, to: number): boolean {
	let reached = from - 1;
	for (const range of [...ranges].sort((a, b) => a.from - b.from)) {
		if (range.from > reached + 1) return false;
		reached = Math.max(reached, range.to);
	}
	return reached >= to;
}

test('a terminated worker restarts and resumes from the cursor', async ({page}) => {
	const harness = await mountHarness(page, {cut: CUT, worker: WORKER, coi: false});
	try {
		const run = await harness.run({phase: 'once', params: {case: 'restarts-and-resumes', tag: tag('restart')}});

		expect(run.errors).toEqual([]);

		// WHERE the resumed fold ran, measured in the context that ran it: the
		// replacement is a worker too, and the tab is still only holding a port.
		expect(run.results.scope).toBe('DedicatedWorkerGlobalScope');
		expect(run.results.tabScope).toBe('Window');
		expect(run.results.host).toBe('dedicated-worker');

		// IT REALLY DIED, and it died WRITING: two workers were built, the first was
		// terminated part way through applying a block, and the fold was nowhere near
		// the tip when it happened.
		expect(run.results.lives).toBe(2);
		expect(run.results.killedWritingBlock).toBeGreaterThanOrEqual(102);
		expect(run.results.landedBeforeDeath).not.toEqual([]);

		// THE APP WAS TOLD, as an event and without asking: one death, the first in a
		// row, with a replacement coming.
		expect(run.results.death).toEqual({cause: 'unresponsive', attempt: 1, restarting: true, rejected: 1});
		expect(run.results.deaths).toBe(1);

		// ...and the call that was in flight when it happened was REJECTED, by type. A
		// hung promise is the worst available outcome, because a stalled app and a
		// slow app look identical from outside (ADR-0082).
		expect(run.results.rejectedInFlight).toBe('IndexerHostDiedError');

		// THE RESUME, asserted on what was FETCHED rather than on where the fold
		// ended up. The replacement asked for nothing at or below the start block:
		// it read the cursor and carried on (ADR-0027).
		const before = run.results.fetchedBeforeDeath as FetchedRange[];
		const after = run.results.fetchedAfterRestart as FetchedRange[];
		expect(before.length).toBeGreaterThan(0);
		expect(after.length).toBeGreaterThan(0);
		expect(Math.min(...after.map((range) => range.from))).toBeGreaterThan(START_BLOCK);

		// ...and nothing was jumped over, which is the other half of the same claim
		// and the one a cursor written AHEAD of its data would break.
		expect(coversWithoutGaps([...before, ...after], START_BLOCK, BRANCH_A_TIP)).toBe(true);

		// The fold finished, and the state is the state an UNINTERRUPTED run of this
		// workload produces (`indexing.spec.ts` asserts the same constant).
		expect(run.results.latestBlock).toBe(BRANCH_A_TIP);
		expect(run.results.lastToBlock).toBe(run.results.latestBlock);
		expect(run.results.state).toEqual(EXPECTED_A);

		// EVERY SURFACE THE TAB HAD BEFORE THE DEATH, asked again after it, over the
		// port it never let go of.
		expect(run.results.afterTheRestart).toEqual({
			transfers: EXPECTED_A.transfers,
			generations: 1,
			promotion: 'on-catch-up',
			inclusion: 'included',
			// the same source names the generation already running, so a reconfigure
			// after a restart resolves rather than rebuilding
			reconfigureAdded: false,
			stopped: false,
			started: true,
		});

		expect(run.results.portSurface).toEqual([
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
		]);
	} finally {
		await harness.dispose();
	}
});
