import {
	openForReading,
	type ReadableStateStore,
	type StateStore,
	StoreWriterChangedError,
} from '@etherfold/state-store';
import {logs} from 'named-logs';

const namedLogger = logs('@etherfold/browser');

/**
 * ## LOSING IS A DEMOTION, NOT AN ERROR THE APPLICATION RENDERS (ADR-0078)
 *
 * A writer whose mutation is refused has not hit a fault. Its claim on the
 * storage was taken by a second writer (ADR-0075), the mutation landed nowhere,
 * and the honest response is to stop being a writer: drop the in-memory
 * `LastSync`, which is now a lie about a store somebody else is moving on, stop
 * fetching, and go on answering reads. That is what this module does, in ONE
 * function, because there are two ways to learn the same thing and they must not
 * grow two behaviours:
 *
 * - a **refused write** (`StoreWriterChangedError`, the guard), which is the one
 *   that is reachable today, and
 * - a **lost lease**, which is what a tab that loses the write duty to another
 *   tab will learn (`work/specs/proposed/one-tab-indexes-and-the-others-read.md`).
 *
 * The second one is not built here and does not need to be: what it needed was a
 * function to call, and this is it.
 *
 * ## Why it lives HERE and not in `@etherfold/core`, beside `pause`
 *
 * Because a demoted writer has to HOLD ITS STORE AS A READER, and the core has no
 * store: the state a generation folds into is an opaque type parameter handed to
 * it by a caller's `createState` factory, on both containers, so the core can stop
 * an engine and can never narrow a handle whose type it has never seen. This
 * package has all three halves -- the stores it built, the loop that fetches, and
 * the surface an app subscribes to -- and it is where the lease holder that reuses
 * this will live. See ADR-0078, including what it costs the receiving (server,
 * CLI) runtime, which is deliberately not served by it.
 *
 * ## What a demoted writer is NOT: a FOLLOWER
 *
 * A **follower** (ADR-0044) is read-only on the STREAM axis: it fetches nothing
 * and appends no segment, because another generation is indexing the stream it
 * folds. It is a full writer of STATE, and busily so -- it re-folds that stream
 * through `EventProcessor.process`, which calls `applyBlock` for every block and
 * persists a cursor in the same transaction. A demoted writer is restricted on
 * the OPPOSITE axis: what it must stop doing is writing STATE. So "become a
 * follower" would produce a generation that keeps mutating a store it no longer
 * holds, keeps being refused, and loops -- which is precisely the failure this
 * exists to end.
 *
 * ## And why it cannot promote itself back
 *
 * Nothing here re-claims. A backend never re-mints a claim it has committed
 * (ADR-0075: a writer that could silently re-claim would let two writers take a
 * store in turns), and the seam's own answer is that a demoted writer BUILDS A
 * NEW STORE and opens that (ADR-0077), which forces the re-read correctness
 * wants anyway. So a demotion is one-way for the writer it demotes, and becoming
 * a writer again is a fresh `init` over a fresh store rather than a flag flipping
 * back.
 */

/**
 * WHY this writer stopped being one.
 *
 * Two members, because there are two ways to lose and an app may legitimately
 * render them differently: a refused write means a second writer is already
 * moving this store on, while a lost lease means this tab handed the duty over
 * and another tab is about to start. Neither is an error, and no third member is
 * invented for "the app asked": an application that demotes for its own reasons
 * is doing one of these two things.
 */
export type DemotionReason = 'write-refused' | 'lease-lost';

/** WHAT A DEMOTION LEFT BEHIND: the reason, and the stores now held for reading. */
export type Demotion = {
	/** WHY, so an app can say something true rather than "something went wrong". */
	readonly reason: DemotionReason;
	/**
	 * The stores this writer was folding into, NARROWED to what it may still do
	 * with them.
	 *
	 * `openForReading` returns the very store it was handed (ADR-0077): the TYPE is
	 * the whole guard, and there is nothing to intercept, because a swallowed write
	 * would be a mutation that looked like it worked. So this is not a new object
	 * to swap in; it is the same storage, held as the thing a reader holds.
	 */
	readonly reading: readonly ReadableStateStore[];
};

/**
 * WHAT A DEMOTION NEEDS OF THE WRITER IT DEMOTES: three verbs and no state.
 *
 * A port rather than a concrete indexer, because the two callers that matter
 * reach the same three things by different routes (the hook's own loop today, a
 * lease holder tomorrow) and because the ORDER they run in is this function's
 * guarantee rather than each caller's to remember.
 */
export type DemotableWriter = {
	/**
	 * STOP: no further fetch, no further fold, now.
	 *
	 * First, always. A writer that narrowed its handle while its loop was still
	 * running would go on issuing the very mutations the demotion exists to stop,
	 * and would be refused for each of them.
	 */
	stopFolding(): void;
	/**
	 * DROP the in-memory cursor and everything derived from it.
	 *
	 * The cursor is the dangerous half: a writer holding a stale `LastSync` is how
	 * a recorded position moves BACKWARDS, and `checkTxInclusion` answers from that
	 * window, so keeping it would have this tab report a transaction as indexed
	 * against a window nothing is maintaining.
	 */
	forgetCursor(): void;
	/** The state stores this writer was folding into, which become reads. */
	stores(): Iterable<StateStore>;
};

/**
 * DEMOTE A WRITER TO A READER: stop, forget, narrow, and SAY SO.
 *
 * ```ts
 * // the refusal handler, and a lease holder, call the same function
 * demoteToReader(writer, 'write-refused');
 * demoteToReader(writer, 'lease-lost');
 * ```
 *
 * The warning is issued HERE rather than left to the caller, because the failure
 * this whole path exists to remove is the QUIET one: an app following the
 * documented `createState` example would otherwise get a tab that stops indexing
 * for ever with nothing said anywhere. The caller publishes the returned
 * `Demotion` on the surface an app already subscribes to; the log is what a
 * developer finds when they wonder why the numbers stopped moving.
 *
 * It does not throw, it is idempotent from the caller's side (demoting a writer
 * that has already stopped costs three no-ops), and it never RE-CLAIMS: see the
 * module note above for why becoming a writer again is a new store rather than a
 * flag.
 */
export function demoteToReader(writer: DemotableWriter, reason: DemotionReason): Demotion {
	writer.stopFolding();
	writer.forgetCursor();
	const reading = [...writer.stores()].map((store) => openForReading(store));

	namedLogger.warn(
		`this indexer has been DEMOTED to a reader (${reason}): ` +
			(reason === 'write-refused'
				? `another writer has claimed the state store, so this one's mutations are refused and NOTHING it ` +
					`writes lands. `
				: `it no longer holds the write duty for this store. `) +
			`It has stopped fetching and folding, dropped its in-memory cursor, and goes on ANSWERING READS from the ` +
			`store the other writer is moving on -- so the data on screen stays correct. This is not an application ` +
			`error and there is nothing to retry: a writer never re-claims a store it lost. To index again, build a ` +
			`NEW store and initialise again, which re-reads everything. If the two writers were meant to be ` +
			`independent, address them apart (a database name per generation) rather than sharing one store.`,
	);

	return {reason, reading};
}

/**
 * Whether a failure is the guard saying this writer lost the store.
 *
 * Read STRUCTURALLY as well as by `instanceof`, on the same ground
 * `isOutOfSpace` is in `@etherfold/core`: a bundled application can end up with
 * two copies of `@etherfold/state-store`, and an error crossing that boundary is
 * the same refusal wearing a class this module cannot recognise. Getting it
 * wrong in that direction is expensive -- an unrecognised refusal is retried on
 * a timer for ever against a store that will never accept it -- and the `name`
 * is declared as a readonly literal on the class, so it is exactly as
 * authoritative as the constructor.
 *
 * NOT re-exported from this package's entry point, on purpose: the DEMOTION is
 * what this package offers, and a second published way to ASK the question would
 * invite a caller to write its own response to it.
 */
export function isStoreWriterChanged(error: unknown): boolean {
	return error instanceof StoreWriterChangedError || (error as Error | undefined)?.name === 'StoreWriterChangedError';
}
