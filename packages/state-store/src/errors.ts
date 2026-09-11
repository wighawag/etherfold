import type {RetainedRange} from './retention.js';
import type {Retention} from './capabilities.js';

/**
 * A read about a block this store cannot answer for.
 *
 * The family ADR-0015 opened: "there is no such block" and "that block is known
 * and the entity was absent from it" are different news and must not arrive in
 * the same shape, so the unanswerable case is an ERROR and the absent case is
 * `undefined`. Its members are distinguishable by type and each carries what it
 * needs to say what went wrong:
 *
 * - `NoSuchBlockError` (`@etherfold/state-store-sqlite`): the ADDRESS resolves to
 *   no recorded block, because it was never indexed or has been reorged out.
 * - `BlockNotRetainedError` (here): the block is a perfectly good block, and the
 *   store no longer keeps -- or never keeps -- the versions needed to answer
 *   about it.
 *
 * The base exists so a caller that only wants to know "my historical read did
 * not happen" can catch one thing, while a caller that must distinguish a reorg
 * from a retention boundary still can. It lives at the seam because the second
 * member is thrown by every backend, and two classes of one name in two packages
 * would break `instanceof` across the boundary.
 *
 * What is NOT a member, deliberately: `InvalidBlockNumberError` below. Every
 * member of this family is a fact about the store; that one is a fact about the
 * call, and no retention setting makes a non-block answerable.
 */
export abstract class BlockUnavailableError extends Error {}

/**
 * Thrown by a read whose `at` is not a block number at all.
 *
 * **Deliberately not a member of `BlockUnavailableError`, and that is the whole
 * decision.** Every member of that family is a fact about the STORE: the block
 * is real, and this store cannot answer about it. A caller acts on one by
 * widening retention, re-pinning, or telling a user their pinned block is gone.
 * This one is a fact about the CALL: `{hash: '0x64'}`, `'100'` or `undefined`
 * names no block, so there is no store configuration under which it becomes
 * answerable and nothing to catch it for. It is a programmer error, so it is a
 * `TypeError`, and a caller that catches `BlockUnavailableError` to handle "my
 * historical read did not happen" does not swallow it.
 *
 * It is also not `undefined`, which is the answer this guard exists to prevent:
 * a non-number `at` compares unequal to every version range, so without the
 * guard the read matches nothing and returns the ordinary "the entity was absent
 * then" -- a plausible answer to a question nobody asked.
 *
 * A backend with an addressing layer above the seam resolves its address to a
 * block number first (`@etherfold/state-store-sqlite` takes a height, a `{hash}`
 * or a `{timestamp}`), and throws this for the HEIGHT axis for the same reason:
 * a height that is not a whole non-negative number is not a block either. An
 * address that resolves to no recorded block is the other thing entirely, and
 * stays `NoSuchBlockError`.
 */
export class StoreWriteRefusedError extends Error {
	readonly name = 'StoreWriteRefusedError';

	/**
	 * Waiting cannot turn this into a success, and that is the whole point of the
	 * flag.
	 *
	 * Every refusal wearing this name says the write is wrong ABOUT THE STORE it
	 * was offered to -- a height already recorded, a hash already recorded, a
	 * height the tip has passed -- and the store does not move on its own, so the
	 * identical offer is refused identically for ever. Read structurally
	 * (`err.retryable === false`); see `StoreWriterChangedError` for why the flag
	 * is a bare property rather than an imported type.
	 *
	 * Deliberately NOT the same thing as `StoreWriterChangedError`, which is also
	 * non-retryable but means the opposite: that one says the caller LOST A RACE
	 * and should become a reader, this one says the CALLER IS WRONG and should
	 * revert before applying, or stop. Two non-retryable refusals with two
	 * remedies.
	 */
	readonly retryable = false;
}

export class InvalidBlockNumberError extends TypeError {
	readonly name = 'InvalidBlockNumberError';

	constructor(
		/** What was passed instead of a block number. */
		readonly received: unknown,
		/** An override for a caller that can say more, e.g. which address axis it came from. */
		message?: string,
	) {
		super(
			message ??
				`invalid block number: ${describeValue(received)}. A read as of a block takes a whole, ` +
					`non-negative block NUMBER; this store has no addressing layer that resolves a hash or a timestamp to ` +
					`one. Answering would mean matching nothing and reporting the entity as absent, which is an ordinary ` +
					`answer to a question that was never asked.`,
		);
	}
}

/**
 * Thrown by a read or a write that names an entity the declarations do not
 * describe.
 *
 * It is a NAMED refusal rather than a bare `Error` because it is the one the
 * caller furthest from the store meets: a read surface generated from one set of
 * declarations, asked of a store built with another. Same-thread, the mismatch
 * is caught at CONSTRUCTION and the class is there to catch; across a port, an
 * error's class does not survive structured clone and the `name` is what a tab
 * acts on, so pinning it as a readonly field is what makes the refusal
 * actionable at all (`@etherfold/browser`, ADR-0082).
 *
 * It lives at the seam, like `BlockNotRetainedError` and for the same reason:
 * every backend raises it through `mustGet`, and two classes of one name in two
 * packages would break `instanceof` across the package boundary.
 *
 * It is deliberately NOT a `BlockUnavailableError`: that family is about a BLOCK
 * this store cannot answer for, which a caller answers by re-pinning or widening
 * retention. This says the declarations and the store disagree, which no store
 * configuration makes answerable -- the remedy is the ONE declaration this seam
 * exists to have (`{name, id, fields}` drives the storage AND the reads).
 */
export class UnknownEntityError extends Error {
	readonly name = 'UnknownEntityError';

	constructor(
		/** The entity that was asked for. */
		readonly entity: string,
		/** What the store WAS built with, so the refusal names both halves of the disagreement. */
		readonly declared: readonly string[],
		/** An override for a caller that can say more about where the surface came from. */
		message?: string,
	) {
		super(
			message ??
				`unknown entity ${JSON.stringify(entity)}: it was not declared to the store, which was built with ` +
					`(${declared.join(', ') || 'no entities'}).`,
		);
	}
}

/** Which way a historical read fell outside what the store keeps. */
export type NotRetainedReason =
	/** The store answers as-of reads, but not that far back: it is outside the window. */
	| 'outside-window'
	/** The store answers no as-of read at all (`revert-only`): revert is all it kept history for. */
	| 'no-historical-reads';

/**
 * Thrown by an as-of read the store's declared retention does not cover.
 *
 * It is deliberately NOT the tip value and NOT `undefined`. An as-of read
 * silently served from the tip is a plausible wrong number that nothing
 * downstream can tell apart from a true one, and `undefined` would read as "the
 * entity was absent then", which is an ordinary answer a caller acts on
 * normally. The error says what was ASKED and what is KEPT, so the caller can
 * either widen the retention or stop asking.
 *
 * `retained` is `undefined` exactly when nothing is retained for reading (a
 * `revert-only` store), which is why it is not spelled as an empty range: an
 * empty range would invite arithmetic on a boundary that does not exist.
 */
export class BlockNotRetainedError extends BlockUnavailableError {
	readonly name = 'BlockNotRetainedError';

	constructor(
		/** The block number the read asked about. */
		readonly requested: number,
		/** The block numbers this store can still answer about, or `undefined` if none. */
		readonly retained: RetainedRange | undefined,
		readonly reason: NotRetainedReason,
		readonly retention: Retention,
	) {
		super(
			retained
				? `block ${requested} is outside what this store retains: it keeps blocks ${retained.from} to ` +
						`${retained.to} (a window of ${retained.to - retained.from} blocks behind the tip). The versions needed ` +
						`to answer as of ${requested} are gone, and answering from the tip would be a plausible wrong number ` +
						`rather than an error.`
				: `this store answers no historical read, so state as of block ${requested} is not available: its ` +
						`retention is \`${retention.kind}\`, which keeps superseded versions for reorg revert and nothing else. ` +
						`Read its capabilities at startup rather than discovering this at the call.`,
		);
	}
}

/**
 * Thrown by a mutation whose writer no longer holds the store's claim.
 *
 * A second writer claimed the storage, which invalidated this writer's claim, so
 * this mutation was refused INSIDE the atomic unit that would have written it:
 * nothing was applied, nothing was applied late, and the store is exactly as it
 * was. See `writer.ts` for the mechanism and ADR-0075 for why it is ADR-0054
 * rather than a new idea.
 *
 * **It is not an application error, and it is the opposite of the other refusal
 * on this path.** "Applying the same block twice is a caller bug" says the
 * CALLER is wrong; this says the caller LOST A RACE it could not have avoided,
 * and the correct response is to drop the in-memory `LastSync` that is now a
 * lie, stop fetching, and become a reader. That demotion is the caller's and is
 * specified separately; what the store owes is a distinct, catchable name.
 *
 * It lives at the seam because EVERY backend that enforces a single writer
 * throws it and core catches it, and two classes of one name in two packages
 * would break `instanceof` across the boundary -- the same reason
 * `BlockNotRetainedError` is here.
 *
 * It carries no token. A token is opaque (`writer.ts`): nothing compares two of
 * them for order, parses one, or reads a time out of one, and publishing one in
 * an error message would be the first invitation to do so.
 */
export class StoreWriterChangedError extends Error {
	readonly name = 'StoreWriterChangedError';

	/**
	 * Waiting cannot turn this into a success, so a loop that retries on a timer
	 * must not retry THIS.
	 *
	 * Read structurally (`err.retryable === false`) by hosts, which is why the flag
	 * is a plain property and this package imports nothing to declare it: an error
	 * crossing a package boundary still classifies correctly. A claim is never
	 * re-minted for a writer that lost it, so every later mutation is refused
	 * identically -- a driver that re-armed a timer here would fetch a chain for
	 * ever in order to be refused by every write it made.
	 */
	readonly retryable = false;

	constructor(
		/** Which mutating path was refused, e.g. `applyBlock`. */
		readonly operation: string,
		message?: string,
	) {
		super(
			message ??
				`${operation} was refused: another writer has claimed this store, so this writer's claim is no longer ` +
					`held and NOTHING was written. This is a lost race rather than a caller bug: a second instance of the ` +
					`indexer is writing to the same storage. Drop the in-memory cursor, which is now a lie, and stop ` +
					`writing; if the two were meant to be independent, address them apart (a database name, a table ` +
					`namespace) rather than sharing one store.`,
		);
	}
}

/** A value in a message, without `JSON.stringify` throwing on a BigInt or a cycle. */
function describeValue(value: unknown): string {
	if (typeof value === 'bigint') return `${value}n`;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}
