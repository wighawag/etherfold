import type {Abi} from 'abitype';
import type {EIP1193ProviderWithoutEvents} from 'eip-1193';
import {logs} from 'named-logs';
import {
	NoFetchProgressError,
	SuspectedTruncationError,
	UnexpectedChainError,
	WireContextMismatchError,
	type RetryableError,
} from './errors.js';
import {LogEventFetcher} from './internal/decoding/LogEventFetcher.js';
import {blockFetcherFor, enrichEvents, type BlockTimestampCache} from './internal/engine/enrich.js';
import {getBlockNumber, getChainId} from './internal/engine/ethereum.js';
import {
	assertLogsCarryTimestamps,
	resolveStreamConfig,
	sameWireContext,
	wireContextOf,
	type ReorgDetection,
} from './internal/engine/utils.js';
import {resolveRetryPolicy, withRetries, type ResolvedRetryPolicy, type RetryPolicy} from './internal/utils/retry.js';
import {assertWellFormed} from './streamBuilder.js';
import type {
	FetchConfig,
	IndexingSource,
	LogEvent,
	ProvidedStreamConfig,
	UsedStreamConfig,
	WireBatch,
	WireContext,
} from './types.js';

const namedLogger = logs('@etherfold/core');

/** The receiver accepted a batch, and says where the next one starts. */
export type IngestionAcknowledgement = {
	accepted: true;
	/** Where the next batch must start. A HINT to the sender; the receiver remains authoritative. */
	expectedFromBlock: number;
	applied: number;
	retracted: number;
	/** Present when the receiver DERIVED a reorg from this batch. The sender did not detect it. */
	reorg?: ReorgDetection;
};

/**
 * The receiver refused a batch because it starts in the wrong place, and named
 * the right one. The ONE refusal that is not an error (ADR-0004).
 */
export type CursorCorrection = {
	accepted: false;
	expectedFromBlock: number;
};

export type IngestionResponse = IngestionAcknowledgement | CursorCorrection;

/**
 * Where batches go, as the fetcher needs to see it.
 *
 * A transport, and nothing more: it converts a refusal into either a
 * `CursorCorrection` (resumable) or a thrown `IngestionRefusedError` /
 * `IngestionUnavailableError` (fatal / retryable), and holds no opinion about
 * what to do next. That decision is policy and lives in `LogFetcher`, so it is
 * made once whether the transport is HTTP, a queue, or a direct in-process call.
 *
 * Typed as an interface rather than as the HTTP client for the same reason
 * `LogIngestion` is on the other side: it lets a test drive the REAL fetcher
 * against the REAL receiver with no HTTP in between, and lets a single-process
 * deployment skip the wire entirely.
 */
export type IngestionTarget = {
	/**
	 * Ask where the next batch must start, NAMING THE ASKER.
	 *
	 * The argument is the `{source, config}` this sender pushes. It is there
	 * because one named indexer can hold SEVERAL live wire contexts at once -- a
	 * filter-change successor being built beside the incumbent that is still being
	 * fed -- so "where does the next batch start" has one answer per context and
	 * only the sender knows which of them it is. A transport holding a single
	 * receiver may ignore it; the HTTP one selects with it.
	 *
	 * The `context` coming BACK is optional because not every transport can report
	 * one, but when it is there the fetcher checks it BEFORE fetching anything:
	 * finding out you are pointed at another indexer's server costs one round-trip
	 * that way, and a full range fetch plus a `400` the other way.
	 */
	expectedFromBlock(context: WireContext): Promise<{expectedFromBlock: number; context?: WireContext}>;
	send(batch: WireBatch<Abi>): Promise<IngestionResponse>;
};

export type ProvidedLogFetcherConfig = {
	/**
	 * MUST match the receiver's, since the resolved object is hashed into the wire
	 * identity. A mismatch is refused as a context mismatch rather than silently
	 * indexing something else.
	 */
	stream?: ProvidedStreamConfig;
	fetch?: FetchConfig;
	providerSupportsETHBatch?: boolean;
	/**
	 * The result count at which a fetch is treated as SUSPECT rather than complete.
	 *
	 * **SET THIS TO YOUR NODE'S REAL `eth_getLogs` CAP.** It defaults to
	 * `fetch.maxEventsPerFetch` (itself 10000, the most common cap), and the default
	 * only detects a node that caps at exactly that number. A node capping SILENTLY
	 * at, say, 5000 returns 5000 logs, which is under the default, so the guard
	 * never fires and a short range is pushed as a complete one -- the receiver then
	 * reads the missing logs as an absence, concludes a reorg, and deletes state.
	 *
	 * The detection is exact-count matching and cannot be otherwise: a capped answer
	 * and a complete one differ in nothing else. So this knob is the whole of it,
	 * and a deployment that leaves it at the default is asserting that its node caps
	 * at 10000 or does not cap silently at all.
	 *
	 * Do NOT try to reach the same effect by raising `fetch.maxEventsPerFetch`: that
	 * also raises the span each fetch asks for (it targets 80% of it), which makes
	 * truncation MORE likely. The two knobs are set independently and mean different
	 * things -- one is what this fetcher asks for, the other is what the node will
	 * silently refuse to exceed.
	 */
	suspectResultCount?: number;
	/**
	 * How many `409` corrections one cycle will follow before giving up and letting
	 * the next cycle start over. Default 2.
	 */
	maxCorrectionsPerCycle?: number;
	retry?: RetryPolicy;
};

export type FetchCycleOutcome =
	| {
			status: 'pushed';
			fromBlock: number;
			toBlock: number;
			latestBlock: number;
			logs: number;
			applied: number;
			retracted: number;
			/** The receiver's own answer for where the next batch starts. */
			expectedFromBlock: number;
			/** Set when the RECEIVER concluded a reorg from the raw range this cycle pushed. */
			reorg?: ReorgDetection;
			/** How many `409`s this cycle followed before landing. Normally 0. */
			corrections: number;
	  }
	| {status: 'up-to-date'; expectedFromBlock: number; latestBlock: number}
	| {
			/**
			 * Corrected `corrections` times and still refused, so this cycle gave up
			 * without landing anything.
			 *
			 * It states what this side DID, not why, because this side cannot know why:
			 * the usual cause is another sender moving the cursor between our fetch and
			 * our push, which is ordinary for redundant fetchers, but a receiver whose
			 * cursor moves for some other reason produces exactly the same thing. A host
			 * that sees this repeatedly is looking at a signal worth investigating, not
			 * at a diagnosis -- which is why `corrections` is carried.
			 */
			status: 'yielded';
			expectedFromBlock: number;
			latestBlock: number;
			corrections: number;
	  };

/**
 * Whether waiting could help, asked of the ERROR rather than of a list kept here.
 *
 * Structural on purpose (`retryable === false`, not `instanceof`), so an error
 * that crossed a package boundary from a second copy of `@etherfold/core` still
 * classifies correctly. Anything without the property is retried, which is the
 * right default for the errors this package did NOT throw: a node's JSON-RPC
 * error, a dropped socket, a `fetch` rejection.
 */
function isRetryable(error: unknown): boolean {
	return (error as RetryableError | undefined)?.retryable !== false;
}

const passThrough = <T>(promise: Promise<T>) => promise;

/**
 * The LOG-FETCHER of ADR-0003: the chain-facing half of a split deployment,
 * whose defining property is that it holds no state worth losing.
 *
 * One operation, `fetchAndPush()`: work out where to start, fetch a contiguous
 * range of logs, and push it. WHEN that runs is a host's business (a Node loop,
 * a Worker cron), which is why nothing here schedules anything.
 *
 * ## What it does not have, and why that is the design
 *
 * No cursor, no unconfirmed window, no reorg logic. The receiver owns all three
 * (ADR-0004), and that is what makes at-least-once on the wire exactly-once in
 * effect: the cursor IS the idempotency key, so a batch re-sent after a lost
 * acknowledgement is refused with a `409` and corrected instead of applied
 * twice. A fetcher that persisted its own cursor and trusted it would have
 * re-introduced the split brain the contract removes: two opinions of one value,
 * one of which is wrong exactly when it matters.
 *
 * What it DOES keep between cycles is a HINT (`cursorHint`): the last
 * `expectedFromBlock` the receiver reported. It is a cache, never an authority.
 * It saves one round-trip per cycle in the ordinary case; it is dropped the
 * moment a push fails, since a failed push may or may not have been applied; and
 * when it is wrong, the `409` that follows is not an error but the normal
 * correction path. Losing it costs one extra request and nothing else, which is
 * the test for whether a piece of state is safe to hold here.
 *
 * ## The one thing it must never get wrong
 *
 * **A payload holds EVERY log in `[fromBlock, toBlock]`.** Providers cap
 * `eth_getLogs`, and a short payload delivered as a complete range is read by
 * the receiver as an absence, an absence is a reorg, and a reorg deletes state.
 * So truncation is expressed by LOWERING `toBlock` (never by delivering part of
 * a range), a result set landing exactly on the cap is treated as suspect rather
 * than as an answer, and the envelope is checked with the receiver's own
 * `assertWellFormed` before it is sent.
 *
 * The half of that a DEPLOYMENT owns is `suspectResultCount`: a node that caps
 * silently is caught by matching its cap exactly, so a node capping at anything
 * other than the default 10000 must say so in configuration. See that option; it
 * is the sharpest edge on this class.
 *
 * ## Chain-bound, deliberately
 *
 * Every chain call in the deployment is here (`eth_chainId`, `eth_blockNumber`,
 * `eth_getLogs`, and the block/transaction reads a stream config asks for). The
 * receiver makes none, so the chain identity check is one only this side can
 * perform, and it is made both before fetching and before pushing.
 */
export class LogFetcher<ABI extends Abi> {
	/** The `{source, config}` every batch asserts. Computed exactly as the receiver computes it. */
	readonly context: WireContext;
	readonly streamConfig: UsedStreamConfig;

	private readonly logEventFetcher: LogEventFetcher<ABI>;
	private readonly blockTimestampCache: BlockTimestampCache = new Map();
	private readonly retryPolicy: ResolvedRetryPolicy;
	private readonly suspectResultCount: number;
	private readonly maxCorrectionsPerCycle: number;

	/**
	 * The last thing the receiver said about where to start. A CACHE, not a cursor:
	 * see the class docblock. Nothing persists it, and nothing trusts it beyond one
	 * push.
	 */
	private expectedFromBlockHint: number | undefined;

	constructor(
		private readonly provider: EIP1193ProviderWithoutEvents,
		private readonly source: IndexingSource<ABI>,
		private readonly target: IngestionTarget,
		private readonly config: ProvidedLogFetcherConfig = {},
	) {
		this.streamConfig = resolveStreamConfig(config.stream);
		this.context = wireContextOf(source, this.streamConfig);
		this.logEventFetcher = new LogEventFetcher<ABI>(
			provider,
			source.contracts as never,
			config.fetch ?? {},
			config.stream?.parse,
		);
		this.retryPolicy = resolveRetryPolicy(config.retry);
		this.suspectResultCount = config.suspectResultCount ?? config.fetch?.maxEventsPerFetch ?? 10000;
		this.maxCorrectionsPerCycle = config.maxCorrectionsPerCycle ?? 2;
	}

	/** What the receiver last said, or `undefined` when this fetcher has yet to be told. */
	get cursorHint(): number | undefined {
		return this.expectedFromBlockHint;
	}

	/**
	 * One cycle: find the start, fetch a complete range, push it.
	 *
	 * Every outcome is a normal one. `pushed` is the ordinary case, `up-to-date`
	 * means the chain has not produced anything above the cursor yet, and `yielded`
	 * means the cycle was corrected repeatedly without landing anything and stopped
	 * trying, which is what redundant fetchers do to each other. Anything that is
	 * NOT a normal outcome throws, and the error's own `retryable` says whether a
	 * host should try again later (`IngestionUnavailableError`, provider trouble) or
	 * stop and tell somebody (`IngestionRefusedError`, `WireContextMismatchError`,
	 * `UnexpectedChainError`, `SuspectedTruncationError`).
	 */
	async fetchAndPush(): Promise<FetchCycleOutcome> {
		await this.assertChain('before');

		let fromBlock = this.expectedFromBlockHint ?? (await this.askWhereToStart());
		const latestBlock = await this.withRetries(() => getBlockNumber(this.provider), 'reading the chain tip');

		let corrections = 0;
		for (;;) {
			if (fromBlock > latestBlock) {
				// The receiver is ahead of what this provider can see: another fetcher on a
				// better-synced node, or simply nothing new. Either way there is no range to
				// send, and inventing one would mean claiming a tip we did not observe.
				namedLogger.info(`nothing to fetch: next batch starts at ${fromBlock}, the chain tip is ${latestBlock}`);
				return {status: 'up-to-date', expectedFromBlock: fromBlock, latestBlock};
			}

			const {events, toBlock} = await this.fetchCompleteRange(fromBlock, latestBlock);

			// The TIME AXIS, checked on the node's own answer before anything is pushed:
			// a receiver makes no chain calls (ADR-0003), so a timestampless range crossing
			// the wire is one only this side could have caught, and it would be refused at
			// the fold instead, a whole range later and naming the block rather than the
			// node that produced it (ADR-0073).
			//
			// Deliberately OUTSIDE the retrying fetch below: no node grows the field on a
			// second ask. Skipped while `alwaysFetchTimestamps` is set, because the enrich
			// call below then resolves it; that flag and this condition go together, in a
			// later task of this spec.
			if (!this.streamConfig.alwaysFetchTimestamps) {
				assertLogsCarryTimestamps(events, `the node's answer for [${fromBlock}, ${toBlock}]`);
			}

			// after the fetch and BEFORE the push, because this is the last moment at
			// which logs from another chain can still be stopped from being indexed
			await this.assertChain('after');

			await enrichEvents(
				events,
				{
					streamConfig: this.streamConfig,
					latestBlock,
					cache: this.blockTimestampCache,
					getBlocks: blockFetcherFor(this.provider, this.config.providerSupportsETHBatch),
				},
				passThrough,
			);

			const batch: WireBatch<ABI> = {context: this.context, fromBlock, toBlock, latestBlock, logs: events};
			// the receiver's OWN envelope check, run here first. It costs nothing and it
			// turns a truncation bug in this package into a local throw instead of a
			// `400` from a server that has already been handed a lie.
			assertWellFormed(batch);

			const response = await this.push(batch);
			if (response.accepted) {
				this.expectedFromBlockHint = response.expectedFromBlock;
				if (response.reorg) {
					namedLogger.info(
						`the receiver derived a ${response.reorg.cause} reorg at block ${response.reorg.blockNumber} from the range [${fromBlock}, ${toBlock}]`,
					);
				}
				return {
					status: 'pushed',
					fromBlock,
					toBlock,
					latestBlock,
					logs: events.length,
					applied: response.applied,
					retracted: response.retracted,
					expectedFromBlock: response.expectedFromBlock,
					reorg: response.reorg,
					corrections,
				};
			}

			// A `409`. NOT an error: it is how a fetcher that holds no cursor learns
			// where it really is, after a restart, after a lost acknowledgement, or
			// because another fetcher pushed in between.
			this.expectedFromBlockHint = response.expectedFromBlock;
			corrections++;
			namedLogger.info(
				`the receiver refused a batch at ${fromBlock} and expects ${response.expectedFromBlock}: re-sending from there`,
			);
			if (corrections > this.maxCorrectionsPerCycle) {
				// Being corrected again and again means the cursor is moving while we fetch.
				// Looping would be a race with no end; the next cycle picks up whatever is
				// left to do, from wherever the receiver says it starts.
				namedLogger.info(
					`corrected ${corrections} times in one cycle without landing a batch, so this cycle gives up. The ` +
						`ordinary cause is another sender moving the cursor; a run of these is worth looking at.`,
				);
				return {status: 'yielded', expectedFromBlock: response.expectedFromBlock, latestBlock, corrections};
			}
			fromBlock = response.expectedFromBlock;
		}
	}

	// -- internals -----------------------------------------------------------

	/**
	 * Ask the receiver where the next batch must start.
	 *
	 * A POST, on the HTTP transport, because answering it can WRITE: reconciling a
	 * cursor left by another source, config or processor version clears it. That is
	 * the transport's business; what matters here is that the answer is the
	 * receiver's and this side merely caches it.
	 */
	private async askWhereToStart(): Promise<number> {
		const answer = await this.withRetries(
			// NAMING THE ASKER: a receiver may hold several live wire contexts, and only
			// this side knows which of them this fetcher pushes
			() => this.target.expectedFromBlock(this.context),
			'asking the receiver where to start',
		);
		if (answer.context && !sameWireContext(answer.context, this.context)) {
			// Caught here rather than on the first `400`, so a misconfigured deployment
			// fails before it fetches a single log, naming both identities.
			throw new WireContextMismatchError(answer.context, this.context);
		}
		this.expectedFromBlockHint = answer.expectedFromBlock;
		return answer.expectedFromBlock;
	}

	/**
	 * Every log in `[fromBlock, toBlock]`, with `toBlock` LOWERED as far as the
	 * node's limits require and never a log fewer than the range holds.
	 *
	 * Two different truncations are handled here, and only one of them announces
	 * itself:
	 *
	 * - the node ERRORS with a result-cap or range-too-wide message. `RangeLogFetcher`
	 *   already re-asks for a smaller range and reports how far it got, so the
	 *   answer is complete for the range it reports and `toBlockUsed` becomes the
	 *   batch's `toBlock`.
	 * - the node SILENTLY returns exactly the cap. Nothing distinguishes that from a
	 *   range that genuinely holds that many, so it is not believed: the range is
	 *   halved and re-fetched until the answer comes back under the cap. A single
	 *   block that still returns exactly the cap has nothing left to halve and is a
	 *   `SuspectedTruncationError`, because at that point the only alternatives are
	 *   pushing a possibly-short range (which can delete state) and stopping.
	 */
	private async fetchCompleteRange(
		fromBlock: number,
		latestBlock: number,
	): Promise<{events: LogEvent<ABI>[]; toBlock: number}> {
		let requestedToBlock = latestBlock;
		for (;;) {
			const {events, toBlockUsed} = await this.withRetries(
				() => this.logEventFetcher.getLogEvents({fromBlock, toBlock: requestedToBlock}, passThrough),
				`fetching logs [${fromBlock}, ${requestedToBlock}]`,
			);

			if (toBlockUsed < fromBlock) {
				throw new NoFetchProgressError(fromBlock, toBlockUsed);
			}

			if (events.length < this.suspectResultCount) {
				return {events, toBlock: toBlockUsed};
			}

			if (toBlockUsed <= fromBlock) {
				throw new SuspectedTruncationError(fromBlock, events.length);
			}

			requestedToBlock = fromBlock + Math.floor((toBlockUsed - fromBlock) / 2);
			namedLogger.error(
				`[${fromBlock}, ${toBlockUsed}] returned exactly ${events.length} logs, the count this fetcher treats as ` +
					`suspect: a silently capped answer looks exactly like this. Re-fetching [${fromBlock}, ${requestedToBlock}] ` +
					`rather than pushing a range that may be short.`,
			);
		}
	}

	private async push(batch: WireBatch<ABI>): Promise<IngestionResponse> {
		try {
			return await this.withRetries(
				() => this.target.send(batch as unknown as WireBatch<Abi>),
				`pushing [${batch.fromBlock}, ${batch.toBlock}]`,
			);
		} catch (err) {
			// Whatever went wrong, this side's idea of the cursor is now a guess: a
			// batch whose acknowledgement was lost may well have been applied. Drop the
			// hint so the next cycle ASKS instead of pushing a range from a number it
			// has no reason to believe.
			this.expectedFromBlockHint = undefined;
			throw err;
		}
	}

	/**
	 * Refuse to fetch from, or push logs read from, a provider serving another
	 * chain.
	 *
	 * The receiver cannot make this check: it has no provider, by design. So a
	 * fetcher pointed at the wrong endpoint would hand it another chain's logs
	 * under a perfectly valid identity, and every layer below would treat them as
	 * ours.
	 */
	private async assertChain(when: 'before' | 'after'): Promise<void> {
		const chainId = await this.withRetries(() => getChainId(this.provider), `checking the chain id (${when} fetch)`);
		if (chainId !== this.source.chainId) {
			throw new UnexpectedChainError(this.source.chainId, chainId, when);
		}
	}

	private withRetries<T>(operation: () => Promise<T>, what: string): Promise<T> {
		return withRetries(operation, {
			policy: this.retryPolicy,
			retryable: isRetryable,
			what,
			onRetry: ({error, attempt, delayMs}) =>
				namedLogger.info(
					`${what} failed (attempt ${attempt}): ${error instanceof Error ? error.message : String(error)}. ` +
						`Retrying in ${delayMs}ms.`,
				),
		});
	}
}
