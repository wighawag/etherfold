/**
 * What a store can do, as DATA a caller reads before it asks a question.
 *
 * The alternative is discovering a missing capability from a wrong answer in
 * production, which is the failure this whole seam exists to prevent: an as-of
 * read silently served from the tip is a plausible number that nothing
 * downstream can tell apart from a true one.
 *
 * This module is what a store REPORTS. What a deployment SETS, how it is
 * validated against the finality-depth floor, and the typed refusal that gives
 * the report teeth are all in `retention.ts`.
 *
 * The report is bounded by what a store can actually do, never by what it was
 * asked for. A store may claim a window only if it ENFORCES one, and enforcing
 * it has two halves: refusing a read outside it (`assertRetained`, which happens
 * on every read whatever the host does) and dropping the versions it no longer
 * covers (`StateStore.prune`, which the host schedules). A store that could do
 * neither would have to report `unbounded`, which is what both shipped stores
 * did until pruning existed.
 */

/**
 * How far back superseded versions are kept.
 *
 * The unit is BLOCK NUMBERS, and there is only one unit. Not updates: on the
 * real measured stream event-bearing blocks are median 429 blocks apart, so a
 * 64-block window holds exactly ONE event-bearing block, and reading a window of
 * N blocks as N updates of history is wrong by orders of magnitude on any sparse
 * contract. Not time either: wall-clock pruning would drop history a stalled
 * indexer never finished writing, and would expire the whole window of a halted
 * chain while its tip stands still. Retention keys on the thing that moves the
 * tip.
 */
export type Retention =
	// (what a deployment writes is `RetentionSetting` in `retention.ts`; this is
	// the resolved report shape)
	/**
	 * Superseded versions survive only as long as reorg revert needs them, which
	 * is the floor every store pays anyway. Historical reads are not available.
	 */
	| {readonly kind: 'revert-only'}
	/**
	 * Superseded versions are kept for `blocks` block numbers behind the tip, and
	 * `prune` is what drops the rest (`retentionFloor` is the one boundary both
	 * the refusal and the deletion are computed from).
	 */
	| {readonly kind: 'window'; readonly blocks: number}
	/** Nothing is ever pruned: the whole history is readable. */
	| {readonly kind: 'unbounded'};

/** What a store declares about itself, available before `migrate` and before any read. */
export type StateStoreCapabilities = {
	readonly retention: Retention;
	/**
	 * Whether the store answers as-of reads AT ALL.
	 *
	 * Separate from `retention` because they fail differently: a store with a
	 * window answers inside it and refuses outside it, while a store that cannot
	 * reconstruct history refuses everywhere. A `revert-only` store therefore
	 * reports `asOf: false`, and a caller that needs history knows at startup.
	 */
	readonly asOf: boolean;
	/**
	 * Whether a SECOND writer on this store's storage is refused rather than
	 * allowed to corrupt it.
	 *
	 * `true` means every mutating path carries a writer token checked in the same
	 * atomic unit as the write it guards, so a writer whose claim has been taken
	 * over is refused with `StoreWriterChangedError` and writes nothing
	 * (`writer.ts`, ADR-0075).
	 *
	 * It is REPORTED rather than assumed because not every backend can hold a
	 * meaningful guard, and pretending otherwise produces a vacuous test.
	 * `MemoryStateStore` and the patch store keep their storage in instance
	 * fields, so no second writer can reach it and a token there could only ever
	 * be compared with itself: green, tested, and meaningless. They report `false`
	 * honestly, and the conformance suite selects the contention cases on this
	 * claim.
	 *
	 * It is a fact about one unit of STORAGE and not about a process, a tab or an
	 * origin: two stores addressed apart (a second `databaseName`, a second table
	 * namespace) never contend, which is what keeps two generations of one indexer
	 * writing at once.
	 *
	 * Distinct from the ONE-WRITER RULE on the stream keeper, which says only the
	 * indexing generation APPENDS TO A STREAM and is structural (a follower is
	 * handed a read-only view, ADR-0044). Same words, different seam: that one
	 * decides who may write, this one enforces that whoever does is alone.
	 */
	readonly singleWriter: boolean;
};
