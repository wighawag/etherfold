import {expect, test} from '@playwright/test';
import {mountHarness} from 'playwright-browser-harness';

/**
 * `checkTxInclusion` ASKED FROM A TAB AND ANSWERED BY A REAL WORKER.
 *
 * `test/checkTxInclusionFromTheTab.test.ts` drives the same host over a real
 * `MessagePort` in one process, which is where the claims that need a COUNTED
 * CHAIN live: a tip tens of thousands of blocks above the fold, and a pointer
 * moved to a generation with no window yet. What that run has no way to have is
 * a SECOND EXECUTION CONTEXT -- so this asserts that the verdict crosses one
 * with its status AND its basis intact, and that it is answered from where the
 * fold is AT THE MOMENT OF THE CALL rather than from anything the tab kept.
 *
 * The pair that makes it a snapshot is the point: the fold is held one block
 * below the transaction the app is watching, so the verdict is `absent` and the
 * optimistic update stays; the fold is let go, and the SAME call says `included`,
 * which is when the app must drop it or double-count.
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

test('a tab asks about its pending transactions and a worker answers the verdict whole', async ({page}) => {
	const harness = await mountHarness(page, {cut: CUT, worker: WORKER, coi: false});
	try {
		const run = await harness.run({
			phase: 'once',
			params: {case: 'tx-inclusion-from-the-tab', tag: tag('tx-inclusion')},
		});

		expect(run.errors).toEqual([]);

		// WHERE the verdict was computed, measured in the context that answered
		// rather than declared by the caller.
		expect(run.results.scope).toBe('DedicatedWorkerGlobalScope');
		expect(run.results.tabScope).toBe('Window');
		expect(run.results.host).toBe('dedicated-worker');

		// NOTHING SYNCED YET: the honest unknown, ANSWERED rather than hung, from a
		// host that has not even opened a container.
		expect(run.results.phaseBeforeAnySync).toBe('waiting');
		expect(run.results.beforeAnySync).toEqual({
			watched: {status: 'unknown', basis: 'not-synced'},
			old: {status: 'unknown', basis: 'not-synced'},
		});

		// HELD ONE BLOCK BELOW IT: the fold has looked as far as block 103 and the
		// transaction is not there, which is `absent` and not `unknown` -- and the
		// same call, given the block a receipt names, concludes about a transaction
		// that has already fallen out of the sparse window.
		expect(run.results.beforeTheFoldReachesIt).toEqual({
			watched: {status: 'absent', basis: 'window-miss'},
			never: {status: 'absent', basis: 'window-miss'},
			oldWithAReceipt: {status: 'included', basis: 'below-window'},
		});
		// three hashes, one round trip
		expect(run.results.askedAtOnce).toBe(3);

		// AT THE TIP: the same question, a different answer, and the block IN THE
		// INDEXER'S OWN VIEW -- not whatever block the app's node reported.
		expect(run.results.afterTheFoldReachesIt).toEqual({
			watched: {status: 'included', basis: 'window-hit', blockNumber: 104, blockHash: '0xa104'},
			never: {status: 'absent', basis: 'window-miss'},
		});

		// Everything the tab was handed, in full.
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
