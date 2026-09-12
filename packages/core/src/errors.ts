import type {SuspectResultCountSource} from './logFetcher.js';
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
 * Whether waiting could turn this failure into a success.
 *
 * The one place that reads the flag, so that "anything without the property is
 * retried" is decided once rather than in each loop that asks. Structural on
 * purpose (see `RetryableError`): an error that crossed a package boundary from
 * a second copy of this module still classifies correctly, and so does one from
 * a package that declares the flag without importing this type -- which is what
 * `@etherfold/state-store` does, having no dependencies at all.
 *
 * Every driver that retries on a timer owes its errors this question. A loop
 * that does not ask it turns a permanent refusal into an infinite retry, which
 * is silent: the work is re-attempted for ever and nothing reports a failure.
 */
export function isRetryable(error: unknown): boolean {
	return (error as RetryableError | undefined)?.retryable !== false;
}

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
 *
 * It names WHERE the count came from, because the fix depends on it: a count this
 * deployment CONFIGURED is wrong and should be corrected, while a count the
 * PROVIDER reported about itself is the node's own claim about its cap, and
 * overriding that means configuring one (configuration wins over a report).
 */
export class SuspectedTruncationError extends Error {
	readonly name = 'SuspectedTruncationError';
	/** The same block will return the same count next time. Waiting changes nothing. */
	readonly retryable = false;

	constructor(
		readonly blockNumber: number,
		readonly logCount: number,
		readonly source: SuspectResultCountSource,
	) {
		super(
			`block ${blockNumber} alone returned exactly ${logCount} logs, which is the count this fetcher treats as ` +
				`suspect (suspectResultCount, ${WHERE_THE_SUSPECT_COUNT_CAME_FROM[source]}). A capped answer cannot be told ` +
				`apart from a complete one, and delivering a short range as a complete one makes the receiver read the ` +
				`missing logs as a reorg and DELETE state. The range cannot be lowered any further, so nothing is pushed. ` +
				`Either this block genuinely holds ${logCount} logs, in which case ${THE_FIX_FOR[source]} (do not raise ` +
				`maxEventsPerFetch to get there: that also widens the span each fetch asks for, which makes truncation more ` +
				`likely, not less), or the node is capping and this source needs one that reports truncation instead of ` +
				`applying it silently.`,
		);
	}
}

/** How the count above is described to whoever has to act on it. */
const WHERE_THE_SUSPECT_COUNT_CAME_FROM: {[source in SuspectResultCountSource]: string} = {
	configured: 'configured by this deployment',
	reported: 'REPORTED by this provider as its own eth_getLogs result cap, this deployment having configured none',
	default: 'this fetcher default, which nothing configured and no provider reported',
};

/** What to do about it, which differs only for a count that was DISCOVERED. */
const THE_FIX_FOR: {[source in SuspectResultCountSource]: string} = {
	configured: `set suspectResultCount to the node's REAL cap`,
	reported: `set suspectResultCount explicitly, which WINS over anything a provider reports`,
	default: `set suspectResultCount to the node's REAL cap`,
};

/**
 * An endpoint that will not serve the HISTORY being asked for, whatever range it
 * is asked for it in.
 *
 * Serving logs for old blocks needs an archive node, and public endpoints
 * commonly token-gate it: `ethereum-rpc.publicnode.com` answers a backfill with
 * `-32602 "Archive requests require a personal token. Get one at: ..."`, captured
 * 2026-06-30 and again, byte-identical, on 2026-09-08
 * (`docs/spikes/a-provider-refusal-is-read-from-its-data-before-its-prose/`).
 *
 * Every other refusal the fetcher meets is a RANGE complaint, answered by asking
 * for less. This one is not: no range size satisfies it, so halving spends the
 * whole retry budget shrinking a window the endpoint was never going to serve,
 * and then fails with whatever the last error happened to be -- which is a range
 * error, about the wrong thing entirely. The operator reads "the range was too
 * big" and tunes `maxBlocksPerFetch`, when what they have is an endpoint that
 * does not serve history.
 *
 * So the class is recognised where the range hints are read and reported HERE,
 * naming the cause. `retryable` is `false` for the literal reason the flag
 * exists: waiting changes nothing, because nothing about this endpoint changes
 * until an operator points somewhere else or pays for a token.
 *
 * ## Why this is deliberately narrow
 *
 * The classifier matches only a refusal that IDENTIFIES itself as an archive or
 * history ACCESS problem (see `archiveRefusalFromError`), and everything else
 * keeps halving. A false terminal is worse than the grinding it replaces:
 * grinding is slow and visible, while a transient outage mistaken for a terminal
 * refusal stops an indexer fast, wrongly, and for good.
 */
export class ArchiveRefusedError extends Error {
	readonly name = 'ArchiveRefusedError';
	/** The endpoint does not grow an archive while a scheduler waits. The fix is an operator's. */
	readonly retryable = false;

	constructor(
		/** The block the refused fetch started at. */
		readonly fromBlock: number,
		/** The block it asked to reach. */
		readonly toBlock: number,
		/** What the provider said, verbatim, so the claim is checkable against the node. */
		readonly providerMessage: string,
	) {
		super(
			`the provider refused [${fromBlock}, ${toBlock}] because serving that history needs ARCHIVE access it will ` +
				`not give this connection: "${providerMessage}". This is not a range problem and no range size fixes it, ` +
				`so nothing is retried and the range is not halved. Either point this source at an archive endpoint (or an ` +
				`authenticated plan on this one), or start indexing from a block this endpoint still serves.`,
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
 * One cause survives any version bump, in two lifetimes, and neither improves
 * with time. A node being FORKED may predate the spec change: EDR types the
 * field `Option<u64>` precisely so an absent timestamp stays distinguishable
 * from a real one, and passes the absence through rather than defaulting it.
 * And EDR's on-disk RPC response cache REPLAYS such an absence once it has
 * recorded one, until `rpc_cache` is dropped -- so the fork can be long gone and
 * the answer still arrive without the field.
 *
 * Note what this is NOT, because three of this repo's own documents said it and
 * it reads backwards: it is not that pre-0.20 cache entries keep answering.
 * `@nomicfoundation/edr@0.20.0` moved the cache to `rpc_cache/v2` and IGNORES
 * everything else in `rpc_cache`, so entries written before the change are not
 * served at all. The hazard is a CURRENT-format entry holding an absence read
 * from a pre-spec remote.
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
				`node that predates it, or it is replaying an EDR RPC response cache entry that recorded the absence ` +
				`from such a node (drop its rpc_cache). Nothing is folded, stored or pushed: the engine refuses here rather than ` +
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
/**
 * A fetch width that can never reach the tip, so the cursor would never move.
 *
 * Every cycle rewinds by the unconfirmed window before it fetches
 * (`getFromBlock`: `min(lastToBlock + 1, latestBlock - finality)`), so a range
 * CEILING at or below `stream.finality` re-asks for blocks that are already
 * folded and stops short of the ones that are not. With `finality: 3` and
 * `maxBlocksPerFetch: 2`, a cursor at 103 asks for 102..103, applies nothing
 * new, and asks for 102..103 again, for ever.
 *
 * ## Why this is a refusal rather than a clamp
 *
 * Both numbers are deliberate statements about a deployment -- how deep a reorg
 * it will tolerate, and how wide a range its node will serve -- so silently
 * raising one to satisfy the other would overrule an operator on exactly the
 * axis they were being explicit about. It is refused at CONSTRUCTION, where
 * both values are in hand, because the alternative is a process that starts
 * cleanly, reports `catching-up` truthfully, and never indexes a block: a fold
 * that makes no progress and says nothing is the worst shape a defect can take,
 * and it was measured at 50+ identical `eth_getLogs` ranges in three seconds.
 *
 * Only the CEILING is checked. `numBlocksToFetchAtStart` may legitimately sit
 * below the finality depth, because the fetcher adapts it upwards towards
 * `maxBlocksPerFetch`; the ceiling is the one it can never grow past.
 */
export class FetchRangeBelowFinalityError extends TypeError {
	readonly name = 'FetchRangeBelowFinalityError';

	constructor(
		/** The configured `fetch.maxBlocksPerFetch`. */
		readonly maxBlocksPerFetch: number,
		/** The resolved `stream.finality` it has to clear. */
		readonly finality: number,
	) {
		super(
			`fetch.maxBlocksPerFetch (${maxBlocksPerFetch}) must be GREATER than stream.finality (${finality}), and it ` +
				`is not. Every cycle rewinds by the unconfirmed window before it fetches, so a range this narrow re-asks ` +
				`for blocks that are already folded and never reaches the ones that are not: the cursor would stand ` +
				`still for ever while the indexer went on reporting that it was catching up. Raise maxBlocksPerFetch ` +
				`above ${finality}, or lower stream.finality below ${maxBlocksPerFetch}.`,
		);
	}
}

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
 * WHERE a chain-identity check caught a provider on the wrong chain.
 *
 * One axis, not two: every value names a POINT at which the question is asked,
 * and the two deployment shapes (ADR-0003) simply ask it at different points.
 * `'before'` and `'after'` are the split deployment's log-fetcher, named for
 * the side of the fetch they sit on; `'cycle'`, `'load'` and `'reconfigure'`
 * are the in-process engine's three.
 *
 * `'before'` is no longer reachable from a fetch cycle (ADR-0081 deleted the
 * before-fetch call) and is kept anyway: this error is exported, narrowing the
 * union is a breaking change, and a host classifying a refusal still has to be
 * able to name that side.
 */
export type ChainIdentityCheckPoint = 'before' | 'after' | 'cycle' | 'load' | 'reconfigure';

/**
 * What each check point says about ITSELF: where it caught the provider, and
 * the consequence that actually holds there.
 *
 * The consequence is per-point and NOT one sentence for all of them, because
 * the fetcher's -- "nothing is pushed, and the receiver could not have caught
 * this" -- is a claim about a RECEIVER, which exists on that path alone. Said
 * from the engine it would describe machinery the deployment does not have,
 * and a refusal that asserts something untrue about the path it was thrown
 * from is worse than one that says less. The wording lives HERE, in one table,
 * rather than at the throw sites, so the five refusals cannot drift into five
 * spellings of one condition, which is the state ADR-0081 exists to end.
 */
const CHAIN_IDENTITY_CHECK_POINTS: Record<ChainIdentityCheckPoint, {where: string; consequence: string}> = {
	before: {
		where: 'checked before fetching',
		consequence: 'Nothing is pushed: the receiver makes no chain calls, so it could not catch this.',
	},
	after: {
		where: 'checked after fetching',
		consequence: 'Nothing is pushed: the receiver makes no chain calls, so it could not catch this.',
	},
	cycle: {
		where: 'checked after the fetch, before anything was written or folded',
		consequence:
			'Nothing is written or folded: the fetched logs are dropped and the cursor stays where it was, so the ' +
			'next cycle asks for the same range again.',
	},
	load: {
		where: 'checked at load, before a single log was fetched',
		consequence:
			'Nothing is loaded or indexed: point the indexer at a node for the chain this source names, or correct ' +
			"the source's chainId if the node is the one you meant.",
	},
	reconfigure: {
		where: "checked while reconfiguring, against the previous context's chain",
		consequence:
			'Nothing is reconfigured: a provider on another chain needs a source for that chain, which resets the ' +
			'state derived from the previous one. Did you forget to pass a new source?',
	},
};

/**
 * A provider that is not serving the chain the source names.
 *
 * The ONE refusal for that condition, in both deployment shapes (ADR-0081), so
 * that an operator reads one refusal rather than a spelling per call site. The
 * log-fetcher asks once a cycle, after the fetch and before the push, because
 * it is the one corruption the receiving half cannot possibly catch: the
 * receiver makes no chain calls at all (ADR-0003), so logs from the wrong chain
 * arrive carrying a perfectly valid `{source, config}` and are indexed as if
 * they were ours. The in-process engine asks at its own three points (see
 * {@link ChainIdentityCheckPoint}), where there is no receiver and nothing is
 * pushed -- which is why the consequence is per-point and the two ids are not.
 * An endpoint behind a load balancer, or a wallet provider the user switched
 * networks on, is enough to produce any of them.
 */
export class UnexpectedChainError extends Error {
	readonly name = 'UnexpectedChainError';
	/** A provider does not wander back onto the right chain while a sender waits. */
	readonly retryable = false;

	constructor(
		readonly expectedChainId: string,
		readonly actualChainId: string,
		/** Where it was caught, which also decides the consequence the message states. */
		when: ChainIdentityCheckPoint,
	) {
		const {where, consequence} = CHAIN_IDENTITY_CHECK_POINTS[when];
		super(
			`the provider is on chain ${actualChainId} but this source indexes chain ${expectedChainId} ` +
				`(${where}). ${consequence}`,
		);
	}
}

/**
 * A provider serving a chain whose GENESIS BLOCK is not the one the source
 * declares.
 *
 * The stronger of the two identity checks the load path makes, and the reason
 * it exists: two chains can share a `chainId` and cannot share a genesis block,
 * so a node that passed `eth_chainId` can still be the wrong node. Indexing a
 * fork's logs into a state that claims to be the canonical chain's is silent
 * and permanent, so this refuses at LOAD, before a single log is fetched.
 *
 * It carries both hashes, because "these two differ" is not actionable and the
 * numbers are what an operator compares against their contracts file. This is
 * the ONLY one of the three genesis-check refusals that is a claim about WHICH
 * CHAIN the node is on; the other two (`GenesisBlockNotServedError`,
 * `GenesisCheckUnavailableError`) mean the check could not be MADE, and saying
 * so in this one's wording is what used to send operators hunting for a
 * misconfiguration that was not there.
 */
export class GenesisHashMismatchError extends Error {
	readonly name = 'GenesisHashMismatchError';
	/** A node does not wander onto another chain's genesis while a caller waits. */
	readonly retryable = false;

	constructor(
		/** The `genesisHash` the source declares. */
		readonly expectedGenesisHash: string,
		/** The hash the node answered for block `0x0`. */
		readonly receivedGenesisHash: string,
	) {
		super(
			`this provider is serving a different chain: block 0 hashes to ${receivedGenesisHash}, and this source ` +
				`declares genesisHash ${expectedGenesisHash}. A chain id can be shared and a genesis block cannot, so ` +
				`this is the check that settles it. Nothing is indexed: point at a node for the chain this source names, ` +
				`or correct the source's genesisHash if the node is the one you meant.`,
		);
	}
}

/**
 * A provider that answered the genesis read with NO BLOCK.
 *
 * Not a verdict about the chain: the node did not say it has a different
 * genesis, it said it does not have block 0 to show. That is ordinary on a
 * pruned or partially-synced node, and it is the failure the `earliest` tag
 * used to hide -- the tag means the lowest block the client HAS, so such a node
 * answered with a real block whose hash could not match and the check reported
 * a WRONG CHAIN. Asking for `0x0` turns that into an honest absence, which is
 * this error, and the wording is deliberately about not being able to CHECK.
 *
 * `retryable` is `false` because a node does not acquire history while a caller
 * waits: the remedies are an archive/full node, or `skipGenesisCheck` for a
 * deployment that accepts `eth_chainId` alone as the identity guard.
 */
export class GenesisBlockNotServedError extends Error {
	readonly name = 'GenesisBlockNotServedError';
	/** A pruned node does not grow its history back while a caller waits. */
	readonly retryable = false;

	constructor(
		/** The `genesisHash` the source declares, which is what could not be checked. */
		readonly expectedGenesisHash: string,
	) {
		super(
			`this provider served no block 0, so the genesis hash could not be CHECKED against the declared ` +
				`${expectedGenesisHash}. This says nothing about which chain the node is on: a pruned or ` +
				`partially-synced node simply does not hold genesis. Point at a node that serves block 0, or set ` +
				`skipGenesisCheck to accept the chainId check alone as this deployment's identity guard.`,
		);
	}
}

/**
 * A genesis read that never completed: a timeout, a rate limit, a dropped
 * connection, a JSON-RPC error.
 *
 * The third of the three, and the common one. It used to propagate out of the
 * load path as a bare failure indistinguishable from a real mismatch, which
 * means a flaky endpoint at startup read as "you are pointed at the wrong
 * chain". Nothing was learnt about the chain here, so nothing is claimed about
 * it, and unlike its two siblings this one IS worth another attempt -- the same
 * position `IngestionUnavailableError` holds on the ingestion path.
 */
export class GenesisCheckUnavailableError extends Error {
	readonly name = 'GenesisCheckUnavailableError';
	/** Nothing was learnt about the chain, and the endpoint may well answer next time. */
	readonly retryable = true;

	constructor(
		/** The `genesisHash` the source declares, which is what could not be checked. */
		readonly expectedGenesisHash: string,
		/** What the provider (or the transport) threw, kept so the cause is not retold as prose. */
		readonly cause: unknown,
	) {
		super(
			`the genesis read failed, so the genesis hash could not be CHECKED against the declared ` +
				`${expectedGenesisHash}: ${cause instanceof Error ? cause.message : String(cause)}. This says nothing ` +
				`about which chain the node is on -- a timeout, a rate limit or a dropped connection all land here -- ` +
				`so it is worth another attempt.`,
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
