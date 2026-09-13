import {expect, test} from '@playwright/test';
import {mountHarness} from './harness.js';

/**
 * A BLOCK APPLIES WHOLE OR NOT AT ALL, WITH THE WORKER KILLED INSIDE IT.
 *
 * `@etherfold/state-store-indexeddb` promises that one block is one transaction,
 * and `@etherfold/processor-entities` writes the sync cursor INSIDE it (ADR-0027)
 * so that a cursor can never describe state that is not there. Until now nothing
 * asserted either half against a process that dies mid-write, on any engine:
 * `restartsAndResumes.spec.ts` kills a worker mid-write and then asserts what the
 * REPLACEMENT fetched and where the fold ended up, which a torn commit would
 * survive unnoticed.
 *
 * ## Why it is worth a test rather than a reading of the code
 *
 * Because an engine has got this wrong, in exactly this shape. WebKit bug 288682
 * ("IndexedDB in Worker commits when thread is terminated", reported by Fastmail,
 * fixed March 2025) is a terminated worker's half-finished transaction being
 * COMMITTED rather than aborted -- "this makes transactions, well,
 * non-transactional, which can cause severe data corruption". The cause was that
 * WebKit did not run microtasks during worker termination, so a promise-driven
 * chain scheduled no further request and the transaction was auto-committed as if
 * it had finished. Every request in this backend is awaited through a promise
 * (`idb.ts`), so that is this code, and `Worker.terminate()` mid-`applyBlock` is
 * that trigger.
 *
 * It is fixed upstream. A test is how a project stops taking that on trust for
 * every engine and every version its users actually run, rather than for the one
 * on the machine that last checked. It runs on all three engines because the
 * guarantee is the seam's and not WebKit's.
 *
 * ## What a failure would look like
 *
 * Three facts are recovered per block from a COLD connection -- the block record,
 * the cursor, and the rows that belong to that block and no other -- and they must
 * agree. A torn commit shows up as any disagreement: rows without a block record,
 * a cursor past a block whose rows are missing, some of a block's rows but not all.
 *
 * ## The other bug gets in the way, and is not allowed to be mistaken for this one
 *
 * Killing a worker mid-write is also what can WEDGE a database on WebKit
 * (`work/notes/findings/webkit-does-not-abort-a-terminated-workers-indexeddb-transaction.md`),
 * at a few percent per kill, which lands often across a run of them. A wedged
 * database answers nothing at all, so the read-back is bounded and a timeout is
 * recorded as `wedged`. The two outcomes are opposites -- one writes too much, one
 * stops answering -- and this refuses to confuse them: `wedged` is tolerated and
 * asserted to be WebKit-only, `TORN` fails on every engine.
 */

const CUT = new URL('./cut.ts', import.meta.url).pathname;
const WORKER = new URL('./atomicity.worker.ts', import.meta.url).pathname;

function tag(name: string): string {
	return `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test('a block applies whole or not at all, with the worker killed inside it', async ({page}, testInfo) => {
	const harness = await mountHarness(page, {cut: CUT, worker: WORKER, coi: false});
	try {
		const run = await harness.run({
			phase: 'once',
			params: {case: 'block-atomicity', tag: tag('atomicity'), iterations: 10},
		});
		expect(run.errors).toEqual([]);

		const torn = run.results.torn as unknown[];
		const outcomes = run.results.outcomes as string[];

		// THE CLAIM. Not one block, on any engine, may be half-applied.
		expect(torn).toEqual([]);
		expect(outcomes).not.toContain('TORN');

		// The kills have to have LANDED for any of this to mean anything: an
		// iteration that never started the worker asserts nothing at all.
		expect(outcomes).not.toContain('never-started');
		expect(outcomes.length).toBe(10);

		// THE INSTRUMENT HAS TO HAVE AIMED. A kill that always fell between two
		// transactions would make every iteration pass while asserting nothing, so the
		// run reports how often it died with a block announced and not landed, and a
		// run that never managed it is refused rather than believed.
		expect(run.results.killedInside as number).toBeGreaterThan(0);

		// A wedged database is the OTHER WebKit defect, which is reported rather than
		// asserted away -- and is refused everywhere else, because if Chromium or
		// Firefox ever stops answering here, that is news.
		const wedged = run.results.wedged as number;
		if (wedged > 0) {
			expect(testInfo.project.name).toBe('webkit');
			testInfo.annotations.push({
				type: 'known-webkit-limitation',
				description: `${wedged} of 10 databases were wedged by the kill and could not be read back`,
			});
		}
		// ...so at least one iteration has to have been readable, or this test
		// measured nothing and would pass in silence.
		expect(run.results.atomic as number).toBeGreaterThan(0);
	} finally {
		await harness.dispose();
	}
});
