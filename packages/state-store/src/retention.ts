import {assertBlockNumber} from './blocks.js';
import type {Retention, StateStoreCapabilities} from './capabilities.js';
import {BlockNotRetainedError} from './errors.js';

/**
 * ## Retention, from the deployment's side
 *
 * `Retention` (in `capabilities.ts`) is what a store REPORTS. This module is the
 * other half: what a deployment SETS, how it is validated, and what a read that
 * falls outside it gets back.
 *
 * The two are deliberately not the same type. A setting is a request, and a
 * store reports what it can actually provide, so a store that cannot enforce
 * what it was asked for reports what it does instead of what it was told.
 *
 * The third piece is `retentionFloor` and `prune`: the window bounds what a READ
 * may ask about at all times (`assertRetained`), and pruning is what makes it
 * bound the BYTES as well. The two halves share one comparison, deliberately, so
 * that no backend can refuse a read at one boundary and delete rows at another.
 */

/**
 * What a deployment writes: a distance in BLOCK NUMBERS, or one of the two ends.
 *
 * The window is `{blocks: N}` and not a bare `N`, because a bare number names no
 * unit and this surface has exactly one. It is also not `{seconds}`, `{days}` or
 * `{updates}`, and those are rejected loudly rather than ignored (see
 * `resolveRetention`).
 *
 * **Choosing N is not choosing a number of updates.** On the real measured
 * stream (the launched stratagems game on Base) event-bearing blocks are median
 * **429 blocks apart**, so a window of 64 blocks holds exactly ONE event-bearing
 * block, and reading "64 blocks" as "64 updates of history" is wrong by orders
 * of magnitude on any sparse contract. Size a window against the chain's block
 * rate and the contract's activity, not against how much history it feels like.
 */
export type RetentionSetting =
	/**
	 * Reorg safety and no history, said honestly: superseded versions survive only
	 * as long as reorg revert needs them (its floor is the `finalityDepth` stated
	 * beside it, which is also what it prunes to), and no historical read is
	 * answered at all. Such a store reports `asOf: false`, so a caller that needs
	 * history learns it at STARTUP rather than from a refused read later.
	 *
	 * This is what to write for "no history", rather than approximating it with a
	 * small window: a window is a distance in BLOCK NUMBERS (above), so a short one
	 * refuses nearly every historical read while looking configured for history.
	 */
	| 'revert-only'
	/** Keep everything: nothing is ever pruned, and the whole history is readable. */
	| 'unbounded'
	/** Keep superseded versions for `blocks` block numbers behind the tip. */
	| {readonly blocks: number};

/** What `resolveRetention` needs to know besides the setting itself. */
export type RetentionOptions = {
	/**
	 * The reorg depth this deployment protects against, in block numbers.
	 *
	 * Required whenever a window is set: reorg revert reopens versions closed
	 * after the fork point, so a window shorter than the finality depth would
	 * prune the versions revert itself needs.
	 *
	 * Optional but load-bearing alongside `revert-only`, where it is the store's
	 * whole retention and therefore its prune floor (`retentionFloor`). A
	 * `revert-only` store that states no depth has stated no floor and prunes
	 * nothing.
	 */
	readonly finalityDepth?: number;
};

/** The block numbers a store can still answer about: `from` and `to` inclusive. */
export type RetainedRange = {readonly from: number; readonly to: number};

/** How much work ONE `prune` call may do. */
export type PruneOptions = {
	/**
	 * Stop after deleting this many versions and leave the rest for the next call.
	 *
	 * This is what makes an AMORTISED policy expressible above the seam without
	 * the store guessing one: a host that wants to spread the cost calls
	 * `prune({maxVersions: n})` on its own schedule and watches `complete`, while a
	 * host that wants the whole pass calls `prune()` and pays for it once. Pruning
	 * is not free (a prune plus `VACUUM` measured 1.1 s at 62,553 versions in
	 * `work/notes/findings/sqlite-in-the-browser.md`), which is exactly why the
	 * budget is the caller's to set.
	 *
	 * Unset means no budget: prune until there is nothing left to prune.
	 */
	readonly maxVersions?: number;
};

/** What one `prune` call actually did, as data rather than as a log line. */
export type PruneReport = {
	/** The tip the floor was measured back from, or `undefined` before the first block. */
	readonly tip: number | undefined;
	/**
	 * The block at or below which a CLOSED version was dropped, or `undefined`
	 * when this store has no floor to prune at (see `retentionFloor`).
	 */
	readonly floor: number | undefined;
	/** How many versions were physically deleted. The honest measure of a prune. */
	readonly versionsDeleted: number;
	/** Whether nothing prunable remains. `false` only when a budget stopped the pass. */
	readonly complete: boolean;
};

/** The retention of a store nothing was asked of: keep everything, claim nothing. */
export const DEFAULT_RETENTION: Retention = {kind: 'unbounded'};

/**
 * Read a deployment's setting into the report shape, or throw.
 *
 * Every rejection here is a decision the spec records rather than a preference:
 *
 * - **A window below the finality depth** is refused naming both numbers. Reorg
 *   revert already requires retaining superseded versions that far back, so a
 *   shorter window is not a smaller store, it is a broken one.
 * - **A duration** is refused on every spelling. Time prunes on WALL-CLOCK
 *   progress rather than chain progress: a stalled indexer would drop history it
 *   never finished writing, and a halted chain would expire its whole window
 *   while the tip stands still. (Time is already solved on the READ side, where
 *   a timestamp resolves to the latest block at or before it.)
 * - **A count of updates** is refused because it is derivable, not a second
 *   mode: every backend already indexes the blocks that changed something, so
 *   "the last N updates" resolves to a floor BLOCK NUMBER above the seam and the
 *   one enforcement path does the rest.
 *
 * The default, when nothing is set, is `unbounded`: it is the only setting that
 * changes nothing about a store that was never configured, and any default
 * window would be both a bound nobody chose and (at the sizes that look
 * generous) nearly empty in updates on a real stream.
 */

export function resolveRetention(setting: RetentionSetting | undefined, options: RetentionOptions): Retention {
	// BEFORE the early returns, because every retention kind USES this number.
	// `revert-only` and `unbounded` do not require one, but they do pass whatever
	// they were given to `retentionFloor`, so a malformed depth reached a floor
	// computation on three of the four backends while only the `{blocks: N}` path
	// ever checked it -- and a NEGATIVE depth puts the floor ABOVE the tip, which
	// prunes exactly the versions a reorg revert reopens (measured: tip 1000,
	// depth -5, floor 1005). This is a rule about the ARGUMENT, so it does not
	// belong behind a branch on a different argument.
	assertFinalityDepth(options.finalityDepth);
	if (setting === undefined) return DEFAULT_RETENTION;
	if (setting === 'revert-only') return {kind: 'revert-only'};
	if (setting === 'unbounded') return {kind: 'unbounded'};

	if (typeof setting !== 'object' || setting === null || !('blocks' in setting)) {
		throw new Error(
			`invalid retention: ${JSON.stringify(setting)}. Retention is measured in BLOCK NUMBERS and in no other ` +
				`unit: write {blocks: N}, 'revert-only' or 'unbounded'. A duration is refused because it would prune on ` +
				`wall-clock progress rather than chain progress, and a count of updates is refused because it is a floor ` +
				`block number derived above this seam, not a second retention kind.`,
		);
	}

	const blocks = (setting as {blocks: unknown}).blocks;
	if (typeof blocks !== 'number' || !Number.isInteger(blocks) || blocks < 0) {
		throw new Error(
			`invalid retention window: ${JSON.stringify(blocks)}. A window is a distance in block numbers, so it must ` +
				`be a non-negative integer.`,
		);
	}

	const {finalityDepth} = options;
	if (finalityDepth === undefined) {
		throw new Error(
			`a retention window of ${blocks} blocks states no finality depth to protect. Reorg revert reopens versions ` +
				`closed after the fork point, so a window is only meaningful next to the depth it must not go under: pass ` +
				`the finality depth alongside it.`,
		);
	}
	if (blocks < finalityDepth) {
		throw new Error(
			`retention window of ${blocks} blocks is below the finality depth of ${finalityDepth}. Reorg revert reopens ` +
				`versions closed after the fork point, so the finality depth is retention's FLOOR and not a suggestion: a ` +
				`window of ${blocks} would prune the versions a revert needs. Set the window to ${finalityDepth} or more.`,
		);
	}

	return {kind: 'window', blocks};
}

/**
 * The finality depth is a NON-NEGATIVE INTEGER wherever one is supplied.
 *
 * Exported because it is the model's rule and not any one backend's: it is
 * checked once here, and `PatchStateStore` -- which resolves no retention at all
 * (it is `revert-only` by construction) -- calls it directly rather than keeping
 * the copy it used to carry.
 *
 * `undefined` is allowed and means "none stated". Only a retention WINDOW
 * requires one, and that requirement is stated where the window is resolved.
 */
export function assertFinalityDepth(finalityDepth: number | undefined): number | undefined {
	if (finalityDepth === undefined) return undefined;
	if (!Number.isInteger(finalityDepth) || finalityDepth < 0) {
		throw new Error(`invalid finality depth: ${JSON.stringify(finalityDepth)}. Expected a non-negative integer.`);
	}
	return finalityDepth;
}

/**
 * The block at or below which a CLOSED version can no longer be reached by any
 * legal read, and may therefore be deleted. `undefined` means "delete nothing".
 *
 * This is the ONE comparison the spec asks every backend to prune on, written
 * once so that the boundary a read is refused at and the boundary a row is
 * deleted at cannot drift apart: it is `retainedRange(...).from`, the oldest
 * block a caller may still ask about. A version whose `_upper` equals the floor
 * was already closed when that block was reached, so nothing inside the window
 * can see it; a version whose `_upper` is ABOVE the floor is still the answer
 * somewhere inside the window, and a LIVE version (no upper bound at all) is the
 * current state and is never in scope however old it is.
 *
 * The three kinds:
 *
 * - **`unbounded`** has no floor. Nothing is ever dropped, which is the whole
 *   claim, so pruning such a store is a no-op rather than an error.
 * - **`window`** floors at `tip - blocks`.
 * - **`revert-only`** keeps superseded versions "only as long as reorg revert
 *   needs them", and the depth a revert reaches is the FINALITY DEPTH, so that
 *   is its floor. A deployment that declared no depth has stated no floor, and
 *   gets no pruning rather than a guessed one: the alternative would be a store
 *   silently deleting against a number nobody wrote down.
 *
 * Never negative: a tip closer to genesis than the window means the store is
 * younger than its own retention, and there is nothing behind block 0.
 */
export function retentionFloor(retention: Retention, tip: number, finalityDepth?: number): number | undefined {
	switch (retention.kind) {
		case 'unbounded':
			return undefined;
		case 'window':
			return Math.max(0, tip - retention.blocks);
		case 'revert-only':
			return finalityDepth === undefined ? undefined : Math.max(0, tip - finalityDepth);
	}
}

/**
 * Validate a prune budget and return it as a number to count down from.
 *
 * Shared so that every backend refuses the same nonsense in the same words. Zero
 * is refused rather than treated as "do nothing", because a caller writing
 * `maxVersions: 0` has computed a budget wrongly, and a silent no-op would let a
 * store grow forever while its owner watched a prune run on schedule.
 */
export function pruneBudget(options: PruneOptions): number {
	const {maxVersions} = options;
	if (maxVersions === undefined) return Number.POSITIVE_INFINITY;
	if (!Number.isInteger(maxVersions) || maxVersions < 1) {
		throw new Error(
			`invalid prune budget: ${JSON.stringify(maxVersions)}. maxVersions is a whole number of versions to ` +
				`delete, at least 1; leave it unset to prune everything the retention floor allows.`,
		);
	}
	return maxVersions;
}

/**
 * The block numbers a store can answer about, given its retention and its tip.
 *
 * `undefined` means none of them: a `revert-only` store keeps superseded
 * versions for revert and answers no historical read, and that is an absence of
 * a range rather than an empty one.
 */
export function retainedRange(retention: Retention, tip: number): RetainedRange | undefined {
	switch (retention.kind) {
		case 'revert-only':
			return undefined;
		case 'window':
			return {from: Math.max(0, tip - retention.blocks), to: tip};
		case 'unbounded':
			return {from: 0, to: tip};
	}
}

/**
 * Refuse a historical read the store's declared capabilities do not cover.
 *
 * This is the enforcement half of the capability report, written once so that
 * every backend refuses identically and a caller can catch one error type
 * whatever it is reading from.
 *
 * The tip is a THUNK because most stores never need it: an `unbounded` store
 * refuses nothing and a `revert-only` store refuses everything, so only a
 * windowed store pays for the lookup. A store with no blocks applied yet has no
 * tip to measure a distance from, and is not refused: it has no history to be
 * outside of, and the read answers `undefined` honestly.
 *
 * A read ABOVE the tip is not refused either. "As of a block we have not reached"
 * is the tip state, which is what the version ranges already answer, and it is
 * `NoSuchBlockError`'s business (not retention's) when an address identifies no
 * block at all.
 *
 * The first thing it does is not about retention at all: it refuses an `at` that
 * is not a block NUMBER (`assertBlockNumber`). The guard rides here because this
 * is the one call every backend taking a resolved block number already makes on
 * every historical read, so one check covers all of them instead of three copies
 * drifting; and it comes FIRST, before the store's own claim is consulted,
 * because which refusal a caller gets is the point. A store answering no
 * historical read would otherwise report `{hash: '0x64'}` as "not retained",
 * sending its caller off to widen a retention window that was never the problem.
 */
export async function assertRetained(
	capabilities: StateStoreCapabilities,
	requested: number,
	tip: () => number | undefined | Promise<number | undefined>,
): Promise<void> {
	assertBlockNumber(requested);
	const retention = capabilities.retention;
	if (!capabilities.asOf || retention.kind === 'revert-only') {
		throw new BlockNotRetainedError(requested, undefined, 'no-historical-reads', retention);
	}
	if (retention.kind !== 'window') return;

	const at = await tip();
	if (at === undefined) return;

	const retained = retainedRange(retention, at);
	if (retained && requested < retained.from) {
		throw new BlockNotRetainedError(requested, retained, 'outside-window', retention);
	}
}
