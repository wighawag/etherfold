import type {WireContext} from './types.js';

/**
 * Whether waiting could turn this failure into a success.
 *
 * It is a property of the ERROR and not a list kept somewhere else, because the
 * two are the same fact and a list drifts: adding a refusal type to this file
 * while the list lives in another one gets the new refusal RETRIED, silently and
 * forever, which is the exact failure ADR-0004's two refusal codes exist to make
 * impossible.
 *
 * Read STRUCTURALLY (`err.retryable === false`) rather than with `instanceof`,
 * so that an error crossing a package boundary from a second copy of this module
 * still classifies correctly.
 *
 * An error that does NOT carry it is treated as retryable, deliberately: those
 * are the ones this package did not throw -- a node's JSON-RPC error, a dropped
 * socket, a `fetch` rejection -- and transience is the honest default for them.
 * Everything thrown from HERE says so explicitly.
 */
export type RetryableError = Error & {readonly retryable: boolean};

/**
 * A store that refused a write because it is FULL.
 *
 * The one cache failure whose remedy is DELETION rather than patience: every
 * other persistent failure leaves the stored stream alone (it is a contiguous
 * prefix, and a usable partial seed), but out of space the cache IS the problem,
 * so freezing preserves the cause and clearing frees it.
 *
 * Said by the KEEPER, on the error it throws, and read STRUCTURALLY here for the
 * same reason `retryable` is (above): an error crossing a package boundary from
 * a second copy of this module still classifies correctly. The Web platform's
 * own `QuotaExceededError` counts as saying it, because IndexedDB is the
 * substrate every stream keeper in this repository is built on and its
 * `DOMException` is standardised rather than a vendor string -- a keeper that
 * lets one through unwrapped meant it. Nothing else is recognised by NAME: a
 * list of platform spellings kept here would be exactly the drifting list the
 * `retryable` note above refuses, so any other substrate says it with the flag.
 */
export type OutOfSpaceError = Error & {readonly outOfSpace: true};

/** Whether a keeper said its write failed for want of SPACE. */
export function isOutOfSpace(error: unknown): boolean {
	if ((error as OutOfSpaceError | undefined)?.outOfSpace === true) {
		return true;
	}
	return (error as Error | undefined)?.name === 'QuotaExceededError';
}

/**
 * A batch that did not start where the receiver said it must.
 *
 * ## Why this is a TYPE and not a message
 *
 * ADR-0004 makes the receiver authoritative about the cursor, and the whole
 * resumption protocol is this one refusal: the sender is told the block it must
 * re-send from, and it re-sends from there. A caller that has to read
 * `expectedFromBlock` out of an English sentence is a caller that breaks the
 * next time the sentence is reworded, and an HTTP layer on top has to put that
 * number in a response body. So the number is carried, not narrated.
 *
 * It is thrown by `generateStreamToAppend` itself rather than by a check placed
 * in front of it. That matters: a second check would be a second, parallel
 * mechanism that can disagree with the engine, which is exactly what ADR-0004
 * chose this design to avoid. There is one rule, in one function, and this is
 * the shape it refuses in.
 *
 * ## And why it is not an idempotency failure
 *
 * A re-sent batch after a lost acknowledgement lands here, because the cursor
 * has already moved past its `fromBlock`. That is not an error to paper over:
 * it IS the deduplication. At-least-once on the wire becomes exactly-once in
 * effect, with no dedupe table and no explicit key, because the cursor is the
 * key.
 */
export class UnexpectedFromBlockError extends Error {
	readonly name = 'UnexpectedFromBlockError';
	/** Re-sending the SAME batch never works; the sender re-sends from `expectedFromBlock` instead. */
	readonly retryable = false;

	constructor(
		/** Where the next batch must start. The sender re-sends from here. */
		readonly expectedFromBlock: number,
		/** Where this batch actually started. */
		readonly receivedFromBlock: number,
	) {
		super(
			`fromBlock (${receivedFromBlock}) not as expected (${expectedFromBlock}). ` +
				(receivedFromBlock > expectedFromBlock
					? `This is too far back, we could trim it automatically, but this is probably an error to send that, so we throw here`
					: `The fromBlock do not consider the potential of reorg, the only safe fromBlock is ${expectedFromBlock}`),
		);
	}
}

/**
 * A batch that belongs to a different indexer.
 *
 * `context.source` and `context.config` are asserted by the SENDER and checked
 * on every batch, because the alternative is silently corrupted state: logs for
 * one source folded into the state of another, discovered later as a wrong
 * answer with nothing pointing at the cause. It is the wire-side half of the
 * hole `docs/reviews/todo-triage.md` found in every persistence layer.
 *
 * Deliberately NOT an `UnexpectedFromBlockError`, and the distinction is
 * operational rather than cosmetic. A cursor refusal is RECOVERABLE by the
 * sender on its own: re-send from the block named. A context mismatch is a
 * misconfiguration, and no block number makes it right; a sender that treated
 * the two alike would retry forever against a server that will never accept it.
 *
 * `context.processor` is absent from what is checked here, because the sender
 * cannot assert it: it has no idea which processor version runs on this side.
 * The receiver owns that third identity and checks it against its own persisted
 * cursor instead (see `StreamBuilder`).
 */
export class WireContextMismatchError extends Error {
	readonly name = 'WireContextMismatchError';
	readonly retryable = false;

	constructor(
		/** The `{source, config}` this receiver indexes. */
		readonly expected: WireContext,
		/** The `{source, config}` the batch claimed. */
		readonly received: WireContext,
	) {
		super(
			`this batch is for another {source, config}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(
				received,
			)}`,
		);
	}
}

/**
 * A batch whose envelope does not describe a contiguous, complete block range.
 *
 * The three things it catches are the three ways the wire contract can be broken
 * without lying about identity or position:
 *
 * - a range that is not a range (`toBlock < fromBlock`, a non-integer bound, a
 *   `toBlock` above the `latestBlock` the sender itself reported);
 * - a log outside `[fromBlock, toBlock]`, which means the payload is not the
 *   range it claims. **Completeness is an invariant, not a flag**: a payload
 *   holds every log in its range, and a truncated fetch is expressed by LOWERING
 *   `toBlock`, never by delivering a different set. A `complete: true` field
 *   would always be true and would therefore carry no information;
 * - a log already carrying `removed: true`. No reorg information crosses the
 *   wire (ADR-0004): the receiver derives retractions, so a sender that shipped
 *   them has reorg logic it must not have. Silently dropping them would be
 *   worse than refusing, since `groupLogsPerBlock` skips them and the sender
 *   would never learn its markers went nowhere.
 */
export class InvalidBatchError extends Error {
	readonly name = 'InvalidBatchError';
	readonly retryable = false;

	constructor(message: string) {
		super(message);
	}
}

/**
 * A result set that MIGHT be everything in the range, and might be all the node
 * felt like returning.
 *
 * The dangerous case this exists for is a provider that caps `eth_getLogs`
 * SILENTLY: no error, no marker, just exactly N logs back. That is
 * indistinguishable from a range that genuinely holds N, and the difference
 * matters more here than anywhere else in the system, because a short payload
 * delivered as a complete range is read by the receiver as an ABSENCE, and an
 * absence is a reorg, and a reorg DELETES state (ADR-0004; the same inference
 * produced the bug fixed in `d24872f`).
 *
 * So a fetch landing exactly on the cap is treated as suspect and the range is
 * halved until the answer comes back under it. This is thrown only when there is
 * nothing left to halve: a SINGLE block that still returns exactly the cap. At
 * that point there is no honest answer available, and refusing to push is the
 * only safe move -- delivering could destroy state, and lowering `toBlock`
 * further is not possible.
 *
 * The operator's fix is to raise the fetcher's `maxEventsPerFetch` above the
 * node's real cap (so a full answer no longer LOOKS like a capped one) or to use
 * a node that does not cap silently.
 */
export class SuspectedTruncationError extends Error {
	readonly name = 'SuspectedTruncationError';
	/** The same block will return the same count next time. Waiting changes nothing. */
	readonly retryable = false;

	constructor(
		readonly blockNumber: number,
		readonly logCount: number,
	) {
		super(
			`block ${blockNumber} alone returned exactly ${logCount} logs, which is the count this fetcher was configured ` +
				`to treat as suspect (suspectResultCount). A capped answer cannot be told apart from a complete one, and ` +
				`delivering a short range as a complete one makes the receiver read the missing logs as a reorg and DELETE ` +
				`state. The range cannot be lowered any further, so nothing is pushed. Either this block genuinely holds ` +
				`${logCount} logs, in which case set suspectResultCount to the node's REAL cap (do not raise ` +
				`maxEventsPerFetch to get there: that also widens the span each fetch asks for, which makes truncation more ` +
				`likely, not less), or the node is capping and this source needs one that reports truncation instead of ` +
				`applying it silently.`,
		);
	}
}

/**
 * A NODE that answered a fetch with a log carrying no readable `blockTimestamp`.
 *
 * `blockTimestamp` on the log is `ethereum/execution-apis#639`, and the engine
 * reads it off the log rather than paying a request per event-bearing block for
 * it (ADR-0073). A node that does not serve it is REFUSED here rather than
 * silently compensated for, and the refusal names the NODE because every cause
 * is node-level and each one has a DIFFERENT fix -- which is why the message is
 * this long. "missing blockTimestamp" alone sends an operator to the wrong one.
 *
 * ## Why this is permanent machinery and not a transitional guard
 *
 * Two causes survive any version bump and neither improves with time: a node
 * being FORKED may predate the spec change (EDR types the field `Option<u64>`
 * precisely so an absent timestamp stays distinguishable from a real one, and
 * passes it through rather than defaulting it), and EDR's on-disk RPC response
 * cache is version-segmented, so entries written before the change keep
 * answering without the field until `rpc_cache` is dropped.
 *
 * ## Why it does not replace the fold-time refusal
 *
 * `blockPointer` (`@etherfold/processor-entities`) refuses the same absence at
 * the FOLD, naming the BLOCK, and that one cannot be dropped in favour of this:
 * a stream can reach a fold without passing a fetcher at all -- a seed install
 * writes through the keeper seam (ADR-0063), a fixture reader replays a captured
 * stream (ADR-0059) -- and this check would never see either. Two entry points,
 * two guards, deliberately.
 *
 * Neither of them guesses. A zero or interpolated timestamp does not fail, it
 * answers confidently about the wrong block for as long as the store lives, and
 * an as-of read has no way to tell a caller it was lied to.
 */
export class TimestamplessLogError extends Error {
	readonly name = 'TimestamplessLogError';
	/** A node does not grow a field while a scheduler waits. The fix is an operator's. */
	readonly retryable = false;

	constructor(
		/** The block the timestampless log sat in. */
		readonly blockNumber: number,
		/** Its block hash, so the claim is checkable against the node. */
		readonly blockHash: string,
		/** What was fetched, e.g. `the node's answer for [100, 200]`. */
		source: string,
	) {
		super(
			`${source} carries a log at block ${blockNumber} (${blockHash}) with no readable blockTimestamp. Nodes ` +
				`implementing execution-apis#639 (geth >= 1.16.0, reth, besu, erigon, anvil, and ` +
				`@nomicfoundation/edr >= 0.20.0) put it on the log itself, so this is a fact about the NODE: it ` +
				`predates the change, or it is a Hardhat version bundling an older EDR (3.16.0 still ships edr 0.19.0 ` +
				`-- override @nomicfoundation/edr to >=0.20.0 rather than waiting for the bump), or it is forking a ` +
				`node that predates it, or it is answering from an EDR RPC response cache written before the change ` +
				`(drop its rpc_cache). Nothing is folded, stored or pushed: the engine refuses here rather than ` +
				`guessing a timestamp, because a wrong one breaks the time axis silently.`,
		);
	}
}

/**
 * A range fetch that reported covering less than the block it started at.
 *
 * Should be unreachable: `RangeLogFetcher` either answers for `[fromBlock, N]`
 * with `N >= fromBlock` or throws. It is typed rather than left as a bare
 * `Error` because this module's policy is that the TYPE tells a host what to do,
 * and an untyped throw defaults to "transient" -- so a node answering nonsense
 * would be asked four more times, on a delay, before anybody was told.
 */
export class NoFetchProgressError extends Error {
	readonly name = 'NoFetchProgressError';
	readonly retryable = false;

	constructor(
		readonly fromBlock: number,
		readonly reportedToBlock: number,
	) {
		super(
			`the range fetcher made no progress at block ${fromBlock}: it reported covering up to ${reportedToBlock}, ` +
				`which is below where it was asked to start. Nothing is pushed.`,
		);
	}
}

/**
 * A provider that is not serving the chain the source names.
 *
 * Checked by the log-fetcher before it fetches and again before it pushes,
 * because it is the one corruption the receiving half cannot possibly catch: the
 * receiver makes no chain calls at all (ADR-0003), so logs from the wrong chain
 * arrive carrying a perfectly valid `{source, config}` and are indexed as if
 * they were ours. An endpoint behind a load balancer, or a wallet provider the
 * user switched networks on, is enough to produce it.
 */
export class UnexpectedChainError extends Error {
	readonly name = 'UnexpectedChainError';
	/** A provider does not wander back onto the right chain while a sender waits. */
	readonly retryable = false;

	constructor(
		readonly expectedChainId: string,
		readonly actualChainId: string,
		when: 'before' | 'after',
	) {
		super(
			`the provider is on chain ${actualChainId} but this source indexes chain ${expectedChainId} ` +
				`(checked ${when} fetching). Nothing is pushed: the receiver makes no chain calls, so it could not catch this.`,
		);
	}
}

/**
 * A refusal from the receiver that no re-send will fix.
 *
 * The counterpart of `UnexpectedFromBlockError`, and the distinction is the
 * whole of a sender's retry policy. A cursor refusal is RESUMABLE: it carries
 * the block to re-send from and recovery is automatic. Everything else -- a
 * foreign `{source, config}`, a malformed envelope, a payload that is not the
 * range it claims, a bad token, a server hosting no processor -- is a
 * MISCONFIGURATION. Retrying it changes nothing, and retrying it forever is the
 * failure mode this type exists to make impossible to write by accident.
 *
 * It carries the transport's own status so an operator sees which wall was hit,
 * and never the credential that was presented.
 */
export class IngestionRefusedError extends Error {
	readonly name = 'IngestionRefusedError';
	/** The whole point of the type: no block number, and no amount of waiting, makes this right. */
	readonly retryable = false;

	constructor(
		/** The transport's status, e.g. an HTTP `400`, `401` or `501`. */
		readonly status: number,
		/** The receiver's own error code, e.g. `context-mismatch`, `invalid-batch`, `unauthorized`. */
		readonly code: string,
		message: string,
	) {
		super(`the receiver refused this batch and no block number fixes it (${status} ${code}): ${message}`);
	}
}

/**
 * A receiver that could not be reached or could not answer right now.
 *
 * Kept apart from `IngestionRefusedError` because the correct response is the
 * opposite one: this is retried with backoff, that one is surfaced immediately.
 * A `5xx`, a dropped connection and a timeout are all this: the batch may or may
 * not have been applied, and the sender does not need to know, because the
 * cursor decides on the next attempt (a batch applied before the acknowledgement
 * was lost earns a `409`, which is a correction and not a duplicate).
 */
export class IngestionUnavailableError extends Error {
	readonly name = 'IngestionUnavailableError';
	/** The one thrown by this package that IS worth another attempt. */
	readonly retryable = true;

	constructor(
		message: string,
		/** The transport's status when there was one; absent for a network-level failure. */
		readonly status?: number,
	) {
		super(message);
	}
}
