import {pruneBudget, type PruneOptions, type PruneReport} from './retention.js';
import type {WritableStateStore} from './store.js';

/**
 * ## THE PASS A HOST SCHEDULES
 *
 * `retention.ts` says what a deployment SETS and what one store's `prune` does.
 * This is the half above it: what a HOST does on its schedule, over every state
 * it holds, on a budget it names.
 *
 * It exists because every host meets the same three questions and there is one
 * right answer to each. Which states -- all of them it holds, since a superseded
 * generation folding beside the canonical one accumulates versions exactly as
 * the canonical one does. How much work -- the caller's `maxVersions`, spent
 * ACROSS the states rather than by each of them, because on a platform where the
 * budget is a request's query allowance (`d1PruneBudget`, `@etherfold/platform-cf-worker`)
 * two generations would otherwise cost twice the allowance and be rejected. And
 * whether it finished -- `complete`, which is what a host loops on.
 *
 * The shape is `rebuildMore`'s and not a new one: bounded work per call,
 * reporting whether it is finished, with the HOST looping. That is what lets one
 * loop serve a CLI cycle (which comes back in a poll interval) and a Worker's
 * `scheduled` handler (which comes back on the next invocation) without either
 * of them reimplementing it, and it is why the budget is a parameter rather than
 * a constant: the number is a property of the caller's schedule, never of
 * pruning.
 *
 * It is deliberately NOT a policy. Nothing here decides a cadence, retries, or
 * what to do about a failure -- ADR-0022 leaves those to the host, and a store
 * with no floor is a no-op here exactly as it is there, so a host may call
 * unconditionally without first asking what it is holding.
 */

/** What ONE scheduled pass did, across every state a host holds. */
export type ScheduledPruneReport = {
	/**
	 * What each state's own pass reported, in the order they were pruned.
	 *
	 * Shorter than the states given whenever the budget ran out first: a state
	 * that was not reached this pass has no report, which is exactly what
	 * `complete: false` is telling the host to come back for.
	 */
	readonly passes: readonly PruneReport[];
	/** How many versions the whole pass deleted. The honest measure of a prune. */
	readonly versionsDeleted: number;
	/**
	 * Whether nothing prunable is left in ANY of them.
	 *
	 * `false` only when this pass ran out of budget -- either a store said so or
	 * there were states left to visit -- and it is the signal to schedule another
	 * pass, never an error.
	 */
	readonly complete: boolean;
};

/**
 * Prune every state a host holds by at most `maxVersions` versions in total, and
 * report whether anything prunable is left.
 *
 * Repeated states are pruned ONCE: two generations may legitimately fold into
 * one store (a factory that hands back the object it captured), and spending the
 * budget twice on it would buy nothing.
 *
 * A budget of `0` is refused in the seam's own words (`pruneBudget`) before
 * anything is deleted, because a caller that computed a budget wrongly would
 * otherwise watch a prune run on schedule while the store grew.
 *
 * Failures are NOT caught here. What a host does about a state it could not
 * prune is the host's decision -- a browser tab logs it and goes on indexing, a
 * batch job may want to fail -- and swallowing it here would take that decision
 * away from every caller at once.
 */
export async function pruneMore(
	states: Iterable<WritableStateStore>,
	options: PruneOptions = {},
): Promise<ScheduledPruneReport> {
	// FIRST, and over the whole pass: an unspendable budget is refused before any
	// state is touched, so the refusal is about the caller's number rather than
	// about whichever store happened to be first.
	let remaining = pruneBudget(options);

	const passes: PruneReport[] = [];
	let versionsDeleted = 0;
	let complete = true;
	for (const state of new Set(states)) {
		if (remaining < 1) {
			// the budget is gone and there are states this pass never reached, which is
			// exactly the "come back" case rather than a finished one
			complete = false;
			break;
		}
		const report = await state.prune(remaining === Number.POSITIVE_INFINITY ? {} : {maxVersions: remaining});
		passes.push(report);
		versionsDeleted += report.versionsDeleted;
		remaining -= report.versionsDeleted;
		if (!report.complete) complete = false;
	}

	return {passes, versionsDeleted, complete};
}
