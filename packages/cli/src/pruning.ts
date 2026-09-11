import type {Abi, ReceivingIndexer} from '@etherfold/core';
import type {WritableStateStore} from '@etherfold/processor-entities';
import {pruneMore, type PruneOptions, type PruneReport, type ScheduledPruneReport} from '@etherfold/state-store';

// ---------------------------------------------------------------------------------------------------
// THE PRUNE THIS PROCESS SCHEDULES, AND WHAT BOUNDS ONE PASS OF IT
// ---------------------------------------------------------------------------------------------------
// Retention has two halves. A window bounds what a READ may ask about from the
// moment it is configured (`assertRetained`, at the seam, on every backend), and
// `prune` is what physically drops the versions it no longer covers -- an
// explicit call the HOST schedules (ADR-0022), because it costs time
// proportional to what it drops. Without a host calling it, a deployment that
// configured a window got "a store bounded in what it answers and unbounded in
// what it holds", which is strictly worse than either honest position.
//
// This module is the CLI's half of that: WHICH states this process holds, and
// how much ONE pass may delete. The pass itself is `pruneMore`
// (`@etherfold/state-store`), shared deliberately: a Worker's `scheduled`
// handler drives the same loop with its own budget (`d1PruneBudget`, which
// computes how many versions fit in one invocation's query allowance) rather
// than a second implementation of it that agrees today.
//
// The shape is `rebuildMore`'s and not a new one: bounded work per call,
// reporting whether it finished, with the host looping. The two commands loop
// differently because their lives are different, and that is the whole of the
// difference:
//
//   `run`    a FOLLOWER, which has no exit: one bounded pass in the gap the loop
//            already waits between cycles, and whatever it could not finish is
//            the next cycle's. A backlog therefore drains over cycles instead of
//            stalling the one that met it.
//   `build`  a ONE-SHOT, which does: the passes run until `complete` once it has
//            reached the tip, because the database it exits with is a
//            publishable ARTIFACT and "prunes eventually" is not a property an
//            artifact has.
//
// Nothing here asks whether a store HAS a floor. It is a no-op wherever there is
// none, which is exactly why ADR-0022 says a host may schedule it
// unconditionally -- and the question could not be answered from here anyway:
// the trigger is a FLOOR and not a window (`retentionFloor` returns one for
// `revert-only` too, wherever a finality depth is stated) while the capability
// report carries no depth. A host that branched on `retention.kind === 'window'`
// would leave a `revert-only` deployment refusing every historical read while
// retaining every version for ever.
// ---------------------------------------------------------------------------------------------------

/**
 * How many versions ONE scheduled pass of this process's prune may delete.
 *
 * A number had to be chosen, because a pass has to be bounded or the first cycle
 * that meets a large backlog pays for all of it at once (the spec's own caveat:
 * a deployment that ran unbounded for a year and then configures a window prunes
 * that whole backlog). The axis it is chosen on here is the FOLLOWER's
 * responsiveness, since the CLI's database is local and imposes no per-request
 * allowance of its own -- the platform that does is a Worker, and that host
 * passes `d1PruneBudget(plan)` to the same loop instead of this number.
 *
 * The number: a prune plus `VACUUM` measured 1.1 s at 62,553 versions on SQLite
 * (`work/notes/findings/sqlite-in-the-browser.md`, and this prune does not
 * `VACUUM`), so ~18 µs per version is a safe over-estimate. Ten thousand
 * versions is therefore a fifth of a second of database work in a gap that is a
 * poll interval (4 s by default) wide, and it drains the whole measured
 * workload's unbounded footprint (29,393 versions) in three cycles rather than
 * in one long stall. A steady-state cycle deletes a handful and never reaches
 * it.
 *
 * It bounds ONE PASS and never the total, and it is deliberately not a way to
 * turn pruning off: `--retention` is where a deployment says what it wants kept.
 */
export const DEFAULT_PRUNE_BUDGET = 10_000;

/**
 * How often a receiver runs a scheduled prune pass, in seconds.
 *
 * `run` and `build` need no such number: both have a CYCLE, so they prune in a
 * gap that already exists. `index` has none -- it is a server that folds what a
 * sender pushes at it and otherwise waits -- so the schedule has to be a clock,
 * and a clock needs an interval.
 *
 * A minute, because nothing here is racing anything. What a prune reclaims is
 * disk, the pass is bounded so a backlog drains over several ticks rather than
 * in one, and a store with no floor makes the whole thing a no-op it costs one
 * tip read to discover. Tuning this down buys a slightly smaller high-water
 * mark on disk; tuning it up buys nothing measurable, because the work is
 * proportional to what is dropped and not to how often it is asked for.
 */
export const DEFAULT_PRUNE_INTERVAL_SECONDS = 60;

/**
 * THE STATES THIS PROCESS HOLDS: one per generation, deduplicated.
 *
 * Every generation held, not only the canonical one. A successor folding beside
 * the incumbent accumulates versions exactly as the incumbent does, and it is
 * the one a reader will be reading from shortly, so pruning only what answers
 * reads today would leave the store that is about to answer them unbounded.
 *
 * The narrowing is honest here for the reason `foldingStatusReport`'s is: the
 * container types the state it folds into as an opaque parameter precisely so
 * `@etherfold/core` names no storage seam, and this package is where the factory
 * that built it is written.
 */
export function statesHeldBy<ABI extends Abi, ProcessResultType>(
	container: ReceivingIndexer<ABI, ProcessResultType, WritableStateStore>,
): WritableStateStore[] {
	return container.held().map((fold) => fold.state as WritableStateStore);
}

/**
 * ONE bounded pass over every state this process holds, on the budget the caller
 * names.
 *
 * The `run` cycle's call. `complete: false` means the budget stopped the pass
 * and the next cycle continues from where it stopped; it is not an error and
 * nothing waits on it.
 */
export function pruneHeldMore<ABI extends Abi, ProcessResultType>(
	container: ReceivingIndexer<ABI, ProcessResultType, WritableStateStore>,
	options: PruneOptions = {},
): Promise<ScheduledPruneReport> {
	return pruneMore(statesHeldBy(container), options);
}

/**
 * Bounded passes until nothing prunable is left: the ONE-SHOT's call, at the end
 * of a `build`.
 *
 * The passes stay bounded (so no single request carries the whole backlog) and
 * the HOST loops, which is the same division `rebuildMore` makes. What is
 * different from the follower is only that this one keeps going: a `build` exits,
 * and a database it exited with holding versions its retention does not cover is
 * an artifact that never gets a second chance to drop them.
 *
 * A pass that deletes NOTHING and still reports itself unfinished ends the loop.
 * That cannot happen against a store that is doing what it says (a pass that
 * deletes nothing has nothing left to delete), so it is here as a bound on the
 * loop rather than as a case with a meaning: an unbounded loop over a report
 * this function does not compute is how a one-shot fails to terminate.
 */
export async function pruneHeldUntilComplete<ABI extends Abi, ProcessResultType>(
	container: ReceivingIndexer<ABI, ProcessResultType, WritableStateStore>,
	options: PruneOptions = {},
): Promise<ScheduledPruneReport> {
	const passes: PruneReport[] = [];
	let versionsDeleted = 0;
	for (;;) {
		const report = await pruneHeldMore(container, options);
		passes.push(...report.passes);
		versionsDeleted += report.versionsDeleted;
		if (report.complete) return {passes, versionsDeleted, complete: true};
		if (report.versionsDeleted === 0) return {passes, versionsDeleted, complete: false};
	}
}
