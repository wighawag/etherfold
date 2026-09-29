/**
 * The workload itself: the LAUNCHED stratagems game on Base, every backend.
 *
 * 31,332 real logs over 1,042 event-bearing blocks, replayed through the ported
 * processor and compared against the state the ORIGINAL `JSProcessor` computed
 * from the same bytes. This is the case the whole fixture exists for, and it is
 * the one a hand-written case cannot stand in for: ten of thirteen handlers
 * fire, the placement window takes 100 arrivals and keeps 7 (so the eviction
 * cascade runs 93 times), and 16,046 of the events write nothing but u256 fields.
 *
 * ## Fast versus full, and which backends
 *
 * It is NOT in the default loop, because it is half a minute rather than one
 * second and a loop nobody runs is worse than a slower one.
 * `test/workload.test.ts` is the fast smoke case and runs on every invocation;
 * this runs in CI (where `CI` is set) and on demand as `test:full`.
 *
 * IndexedDB is in the fast case and NOT in this one by default, and the reason
 * is the shim rather than the backend: on `fake-indexeddb` this replay costs
 * 2,599 s on one machine and 2,052.8 s to 2,165.1 s on a GitHub runner (all
 * measured, full length; see below) and degrades quadratically with the stored version count,
 * where the same backend measured 45.6 ms/block on real Chromium (so under a
 * minute for the whole stream) in
 * `work/notes/findings/sqlite-in-the-browser.md`. Forty minutes on every pull
 * request would be disabled by the next person to wait for it, so it is opt-in as
 * `STRATAGEMS_WORKLOAD=all` (`test:all-backends`), and the honest route to
 * heavy-workload coverage on that backend is the real engine
 * (`packages/state-store-indexeddb/browser/`) rather than a faster shim.
 *
 * ## The IndexedDB timeouts, and where the run lives
 *
 * The cost is ENTIRELY the shim's and it is not the replay's shape: an overwrite
 * in an indexed object store makes `fake-indexeddb` scan every record of every
 * index (`RecordStore.deleteByValue`), and closing a version is exactly such an
 * overwrite, so each block costs its closes times the versions stored. Packing 50
 * blocks per transaction changed a 400-block prefix by 3%, so there is nothing to
 * speed up here and the timeouts are raised instead. Measured on a 400-block
 * prefix (Ryzen 9 9955HX) and extrapolated with a cost model fitted on it: the
 * replay about 890 s and the revert below about 900 s there, against the 2,599 s
 * replay measured on a slower machine. The first run of the workflow below
 * (GitHub Actions run 36502194400, 2026-09-29, `ubuntu-latest`) then measured
 * both at full length: the replay 2,052.8 s and the revert 2,170.5 s, 51 of 51
 * cases passing. A second run (36523554754, same day and runner image) measured
 * the replay 2,165.1 s and the revert 2,295.1 s, about 5% slower on both: that is
 * the run-to-run spread on a GitHub runner. Each bound is twice the SLOWEST real
 * full-length measurement of its step, rounded up to the next 5 minutes, so a
 * machine that has already run it cannot fail it:
 * {@link INDEXEDDB_REPLAY_BOUND_MS} (90 minutes, from the 2,599 s replay) and
 * {@link INDEXEDDB_REVERT_BOUND_MS} (80 minutes, from the 2,295.1 s revert of the
 * second CI run, the slowest full-length revert recorded). The method, the
 * numbers and the script are in
 * `docs/spikes/the-full-stratagems-replay-on-fake-indexeddb/`.
 *
 * `.github/workflows/stratagems-all-backends.yml` runs `test:all-backends`
 * weekly, on demand, and on a pull request that edits that workflow, because a
 * target nobody runs rots: this one sat red on IndexedDB, unnoticed.
 *
 * A diff on the golden state is not a fixture to update. It means the processor
 * changed meaning, and that is a finding.
 */
import {beforeAll, describe, expect, it} from 'vitest';
import {ALPHA1, expectFixtureShape, expectGoldenState, runWorkload, type WorkloadRun} from '../src/index.js';
import {BACKENDS} from './utils/backends.js';

/** `CI` is set by every CI runner; `test:full` sets the explicit one. */
const FULL = Boolean(process.env.CI) || process.env.STRATAGEMS_WORKLOAD === 'full';
/** Everything, including the backend whose SHIM cannot carry this in a sane time. */
const ALL_BACKENDS = process.env.STRATAGEMS_WORKLOAD === 'all';
const SUBJECTS = BACKENDS.filter((backend) => ALL_BACKENDS || backend.name !== 'indexeddb');

/**
 * The address the game gives cells nobody owns to, and the account the reorg
 * case is about: `EVIL_OWNER_ADDRESS` in the vendored contract logic.
 */
const EVIL_OWNER = '0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF';

/**
 * A real block on the real stream, 521 event-bearing blocks below the tip.
 *
 * Reverting to it is what the finding measured: the evil owner's accumulated
 * `computedPoints` goes from 12 back to 6. It is a literal rather than a
 * computed midpoint because the whole value of the case is that it is a fact
 * about a chain, reproducible by anyone with the fixture.
 */
const FORK_BLOCK = 13_364_821;
const POINTS_AT_TIP = 12;
const POINTS_AFTER_REVERT = 6;

/**
 * The bound on the IndexedDB replay: twice the slowest full replay measured on
 * `fake-indexeddb` (2 x 2,599 s = 5,198 s), rounded up to 90 minutes. See the
 * header.
 */
const INDEXEDDB_REPLAY_BOUND_MS = 5_400_000;
/**
 * The bound on the IndexedDB revert: twice the slowest full revert measured on
 * `fake-indexeddb` (2 x 2,295.1 s = 4,590.2 s, run 36523554754), rounded up to
 * 80 minutes. See the header.
 */
const INDEXEDDB_REVERT_BOUND_MS = 4_800_000;
/** Every other backend replays in well under a minute; ten is the old bound. */
const BOUND_MS = 600_000;

describe.runIf(FULL || ALL_BACKENDS).each(SUBJECTS)('the launched stratagems game on Base, on $name', (backend) => {
	let run: WorkloadRun;

	// One replay per backend, because it is the expensive part and both cases are
	// about the SAME run: the second one asks what happens when it is undone.
	beforeAll(
		async () => {
			const started = performance.now();
			run = await runWorkload(backend.make, ALPHA1);
			// the scheduled all-backends run is where the full-length figure comes from
			console.info(`stratagems replay on ${backend.name}: ${((performance.now() - started) / 1000).toFixed(1)} s`);
		},
		boundFor(backend.name, 'replay'),
	);

	it('lands on the state the original JSProcessor computed from the same stream', () => {
		expectFixtureShape(run, ALPHA1);
		expectGoldenState(run, ALPHA1);
	});

	it(
		`reverting to block ${FORK_BLOCK.toLocaleString('en-US')} makes the evil owner's computedPoints DECREASE from ${POINTS_AT_TIP} to ${POINTS_AFTER_REVERT}`,
		async () => {
			// The canonical bug this whole design exists to prevent, on real data: an
			// ACCUMULATED counter (read, add, write) that a reorged-out block raised has
			// to come back DOWN when that block is undone, because the next read is what
			// the next increment is a function of. A store that leaves the raised value
			// standing is not obviously broken -- it is quietly, permanently wrong.
			// the fork has to be BELOW the tip, or the revert is a no-op that would pass
			// this case by accident on a truncated capture.
			expect(run.report.tip).toBeGreaterThan(FORK_BLOCK);
			expect(await pointsOf(run, EVIL_OWNER)).toBe(POINTS_AT_TIP);

			const started = performance.now();
			await run.store.revertTo(FORK_BLOCK);
			console.info(`stratagems revert on ${backend.name}: ${((performance.now() - started) / 1000).toFixed(1)} s`);

			expect(await pointsOf(run, EVIL_OWNER)).toBe(POINTS_AFTER_REVERT);
		},
		boundFor(backend.name, 'revert'),
	);
});

function boundFor(backend: string, step: 'replay' | 'revert'): number {
	if (backend !== 'indexeddb') return BOUND_MS;
	return step === 'replay' ? INDEXEDDB_REPLAY_BOUND_MS : INDEXEDDB_REVERT_BOUND_MS;
}

async function pointsOf(run: WorkloadRun, owner: string): Promise<number | undefined> {
	const row = await run.store.getCurrent<{points: number}>('computedPoints', {owner});
	return row === undefined ? undefined : Number(row.points);
}
