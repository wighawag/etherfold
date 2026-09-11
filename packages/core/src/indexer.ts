import {getBlockNumber} from './internal/engine/ethereum.js';

import {EIP1193ProviderWithoutEvents} from 'eip-1193';

import {logs} from 'named-logs';
import type {
	IndexingSource,
	EventProcessor,
	ProvidedIndexerConfig,
	UsedIndexerConfig,
	LastSync,
	ContextIdentifier,
	ProcessorDriftReport,
	ProvidedStreamConfig,
	SourceHashEntry,
	UsedStreamConfig,
	LogEvent,
	StoredLastSync,
	StoredLogEvent,
	StreamRead,
} from './types.js';
import {LogEventFetcher} from './internal/decoding/LogEventFetcher.js';
import type {Abi} from 'abitype';
import {
	assertAscendingByBlock,
	assertLogsCarryTimestamps,
	batchStreamForDelivery,
	defaultFromBlockOf,
	generateStreamFromReplay,
	generateStreamToAppend,
	getFromBlock,
	resolveStreamConfig,
	sourceInvalidationOf,
	stateMatches,
	streamConfigHashOf,
	streamMatches,
	type SourceInvalidation,
	wait,
} from './internal/engine/utils.js';
import {sourceHashesOf} from './internal/engine/eventRanges.js';
import {CancellablePromiseCancelled, CancelOperations, createAction} from './internal/utils/promises.js';
import {storedLastSyncOf, storedStreamOf} from './internal/stream/strip.js';
import {
	GenesisBlockNotServedError,
	GenesisCheckUnavailableError,
	GenesisHashMismatchError,
	InvalidBatchError,
	isOutOfSpace,
} from './errors.js';
import {declaredMethodsOnly, type MethodDeclaringProvider} from './providerSurface.js';

const namedLogger = logs('@etherfold/core');

/**
 * GENESIS, NAMED AS A BLOCK NUMBER AND NEVER AS THE `earliest` TAG.
 *
 * `earliest` reads like the expressive way to ask for genesis, and `0x0` reads
 * like a magic number, so this constant exists to stop the obvious tidy-up.
 * They are not the same question: the JSON-RPC tag means the lowest block the
 * CLIENT HAS, which is genesis only when the client has genesis.
 *
 * Two ordinary deployments where it is not. A PRUNED or partially-synced node's
 * lowest block is wherever its history begins. A chain that has had a REGENESIS
 * has nodes whose earliest block IS the regenesis point, by design, and several
 * L2s have done exactly that. In both, the tag answers with a real block whose
 * hash is not the genesis hash -- so the identity check refused to start
 * against a healthy node on the RIGHT chain, and said it was connected to a
 * DIFFERENT one. A false positive on the one check whose entire job is to be
 * trustworthy about identity.
 *
 * `0x0` asks for the bottom of the CHAIN rather than the bottom of this node's
 * history. A node that does not have it answers with nothing, which is an
 * honest absence and is reported as one (`GenesisBlockNotServedError`).
 */
const GENESIS_BLOCK = '0x0';

/**
 * Whether two entries of an emission stream are the same emission.
 *
 * A log is identified by its block HASH and its index in that block -- never by
 * its block NUMBER, which a reorg reuses for a different block. The retraction
 * flag is part of the identity because retracting an event and applying it are
 * two different emissions of the same log.
 */
function sameEvent<ABI extends Abi>(a: LogEvent<ABI>, b: LogEvent<ABI>): boolean {
	return a.blockHash === b.blockHash && a.logIndex === b.logIndex && !!a.removed === !!b.removed;
}

/**
 * ONE EMISSION, as small a thing as an equality test needs it to be.
 *
 * The same identity `sameEvent` uses -- block HASH, index in that block, and
 * whether this is the application or the retraction -- flattened to a string so
 * a follower can remember a WINDOW of them without holding the events
 * themselves. Never the block NUMBER, which a reorg reuses for a different
 * block; never the decoded `args`, which are what SOME ABI made of the bytes
 * (ADR-0034) and are re-derived on every replay anyway.
 *
 * It takes EITHER shape because it reads only the raw half, and the events it is
 * asked about arrive as both: the follower derives a mark from the STORED slice
 * a keeper handed back, and the same mark from the decoded events it folded. The
 * parameter is widened rather than the call site asserting -- an assertion there
 * would claim a decoded half that is not present, to answer a question that does
 * not read it.
 */
function emissionMarkOf<ABI extends Abi>(event: LogEvent<ABI> | StoredLogEvent): string {
	return `${event.blockHash}:${event.logIndex}:${event.removed ? 'R' : 'A'}`;
}

/**
 * THE CURSOR A KEEPER HANDED BACK, AS THE ENGINE'S OWN CURSOR: the stream's
 * three block numbers and its context, with `lastFromBlock` set to the block
 * this indexer ASKED for and an EMPTY unconfirmed window.
 *
 * Two things happen here and each is deliberate. The `lastFromBlock` assignment
 * is not new -- all three read paths did it, in place, on the object the keeper
 * returned -- and it is needed because `generateStreamFromReplay` refuses a
 * stream that does not reach back to where the cursor resumes, while the stored
 * cursor's own `lastFromBlock` is whatever the last fetch used. Doing it by
 * CONSTRUCTION also stops the engine writing into a value it does not own.
 *
 * The WINDOW is where the stream seam and the engine's cursor part company
 * (`StoredLastSync` versus `LastSync`): a keeper's holds raw events and the
 * engine's holds decoded ones. Nothing has to be converted between them, because
 * no keeper stores a window at all (ADR-0035, as amended) and a replay ignores
 * the one it is handed, rebuilding it by WALKING the events (ADR-0042). Emptying
 * it here says that out loud instead of carrying a value with no reader across
 * the boundary behind a cast. ADR-0060 records why the two types differ at all,
 * and why this is a construction rather than a widening of `replay`.
 */
function cursorFromStream<ABI extends Abi>(stored: StoredLastSync, lastFromBlock: number): LastSync<ABI> {
	return {
		context: stored.context,
		latestBlock: stored.latestBlock,
		lastFromBlock,
		lastToBlock: stored.lastToBlock,
		unconfirmedBlocks: [],
	};
}

export type LoadingState = 'Loading' | 'FetchingEventStream' | 'ProcessingEventStream' | 'Loaded';

/**
 * WHERE A GENERATION IS BETWEEN RUNNING AND A GENUINE IDLE.
 *
 * *Pausing* caps and drains; *draining* is the period of continued light
 * polling until every block the generation holds is FINAL. So there are three
 * positions and no more, and none of them is a state MACHINE: `pauseState` is
 * DERIVED, on every read, from the cap and the existing `getFromBlock`.
 *
 * - `running` -- not paused. No cap.
 * - `draining` -- paused, and the cap is still inside the reorg window, so each
 *   round re-scans a SHRINKING `[latestBlock - finality, cap]` and corrects
 *   anything the chain moved under it.
 * - `drained` -- paused, and the cap has fallen below `latestBlock - finality`.
 *   Every block it holds is final, so `getFromBlock` asks for a block above the
 *   capped `toBlock` and the existing "no new block" branch fetches nothing.
 *
 * A consumer watches this to know that a pause is not INSTANT: it takes up to
 * `finality` blocks of continued light polling to complete, and `drained` is the
 * moment it has.
 */
export type PauseState = 'running' | 'draining' | 'drained';

/**
 * What one attempt to write the cached stream DID, which is what decides whether
 * the batch may be processed.
 *
 * The whole of the hole fix is in this enum being consulted: the cursor moves
 * only for an outcome that leaves the stream covering the batch.
 */
export type StreamWriteOutcome =
	/** The batch (or the part of it not already stored) is on disk. */
	| 'written'
	/** Nothing to write: no keeper, or every event of this batch is already stored. */
	| 'skipped'
	/**
	 * Not attempted, because the stream is BEHIND the state and this batch does
	 * not reach back to it: writing it would put a HOLE behind a cursor claiming
	 * to cover it, and nothing detects one afterwards.
	 */
	| 'declined'
	/** The keeper threw, and the cache has not given up yet: do not process. */
	| 'failed'
	/** The keeper threw once too often: the cache is frozen and indexing goes on without it. */
	| 'frozen';

/** Consecutive failed writes before the cache is frozen; see `streamWriteRetry`. */
const DEFAULT_STREAM_WRITE_FAILURE_LIMIT = 3;
/** Seconds between attempts while writes are failing; see `streamWriteRetry`. */
const DEFAULT_STREAM_WRITE_RETRY_DELAY = 1;

/**
 * What a reconfigure DID, for the caller that has to react to it.
 *
 * `updateProcessor`, `updateIndexer` and `reset` all end in one of two very
 * different places: the state that existed is still the state, or it was thrown
 * away and is being recomputed. Which one happened is decided HERE, from the
 * version hash and the source hashes, and it used to be decided here and told to
 * nobody.
 *
 * That silence was a live defect for any caller holding a COPY of the state --
 * which is every UI, because a store, a signal or a hook is exactly that copy.
 * `onStateUpdated` fires when a state is adopted or produced, and a discard is
 * neither: the processor's fresh, empty state is not published by anything, so
 * a subscriber kept rendering the state the core had just discarded until the
 * next event happened to arrive. When the reconfigure was a contract redeploy,
 * the next event could be a long way off, or never (a freshly redeployed
 * implementation has emitted nothing yet), and "never" means the old contract's
 * state on screen for the rest of the session.
 *
 * Reported rather than inferred, because the alternative is every caller
 * re-deriving the version-hash rule -- including `force`, including the
 * source-hash comparison -- and a caller that gets that derivation wrong fails
 * in exactly the silent direction the report exists to close.
 */
export type ReconfigureOutcome = {
	/**
	 * True when the previously computed state is GONE and a fresh one is being
	 * built. A caller holding a copy must replace it; `Indexer.publishDiscard`
	 * (`container.ts`) is what does that for every caller driving a container, by
	 * republishing the read handle at the moment the fold goes.
	 */
	stateDiscarded: boolean;
	/**
	 * WHAT THE SOURCE COMPARISON DECIDED, for the caller that needs more than one
	 * bit -- and `undefined` when this reconfigure asked no source question.
	 *
	 * `stateDiscarded` is that verdict collapsed into "is the fold gone", which is
	 * all the caller who only re-seeds a store needs. It cannot say which HALF
	 * died or FROM WHICH BLOCK, and those are what a caller building a new
	 * generation beside the live one decides on: an invalid STREAM half means the
	 * fetch filter moved and the logs have to come from the node again, while a
	 * stream that stands with an invalid STATE half is a new fold over logs
	 * already on disk. `invalidFromBlock` is the point the new one starts from.
	 *
	 * Present on `updateIndexer`, which is the verb that moves the source or the
	 * stream config and therefore the only one that ASKS. Absent on
	 * `updateProcessor`, which moves neither, and on `reset`, which is a discard by
	 * fiat that also CLEARS the stream -- reporting "both halves valid" there would
	 * be true of the source and read as "the stream stands" about a stream that has
	 * just been deleted.
	 *
	 * REPORTED rather than re-derived, exactly like `stateDiscarded`: a caller
	 * hashing its own source to ask the same question gets a second answer that can
	 * disagree with the one the core acted on. And it is the VERDICT, never digest
	 * inequality -- `streamDigestOf` moves when an entry is appended ABOVE the
	 * cursor, which ADR-0034 makes free.
	 */
	sourceInvalidation?: SourceInvalidation;
};

// PROPOSAL FOR STATE ANCHORS
// we can have state anchor that get provided by the processor
// these set the minimum block to start fetching from

// What about prefetch
// proposal B1
// prefetch can fetch data and store it in logs.extra param
// prefecth need to keep track of its version
// we need to add more data to lastSync
// prefetchVersion
// if version change, we discard processor
//  - and we feed with prefetch to replace the extra field on each log + we resave that along with prefetch version in lastSync
// if no version changes, we are good
// whenever we process a log we perform a prefetch that add data to log.extra

// prefetch filter capabilities
// if prefetch can filter by for example returning a specific code
// then it would be great if we slim down the size of the stream by removing from it entirely
// the issue is that a new prefetch version would mean a need for indexing from scratch again
// Need to also care of reorg but this should be trivial : event removed whose event is not found is discarded

// conclusion:
// prefetch only filter capabilities should skip the event from being passed to the processor/
// but this is not very useful as the extra data could already allow the processor to skip the event picked
// so => no filter for pre-fetch
// but we could still have filter capabilties managed by another pass/process or has part of the indexer config
// and this one would slim down the event stream

/**
 * ONE GENERATION: one stream, one processor, one state.
 *
 * A **generation** is a stream plus a fold over it, and this class is exactly
 * that. An **indexer** is the CONTAINER that holds several generations and
 * points at the one that answers reads (`Indexer`, `container.ts`); `CONTEXT.md`
 * has said so since ADR-0036, and this class's name is what makes the code say
 * it too. Nothing about what it DOES changed with the name: it still fetches,
 * still derives reorgs, still drives one `EventProcessor`, and a container
 * drives one of these per generation.
 *
 * It is handed ONE already-constructed processor over ONE already-constructed
 * state, which is precisely what a container holding N generations cannot be
 * handed -- so a caller builds a container through `openIndexer` and hands it
 * the FACTORIES instead, and the container builds one of these per generation.
 */
export class IndexerGeneration<ABI extends Abi, ProcessResultType = void> {
	// ------------------------------------------------------------------------------------------------------------------
	// PUBLIC VARIABLES
	// ------------------------------------------------------------------------------------------------------------------

	public readonly defaultFromBlock!: number;
	public onLoad: ((state: LoadingState) => Promise<void>) | undefined;
	public onStateUpdated: ((state: ProcessResultType) => void) | undefined;
	public onLastSyncUpdated: ((lastSync: LastSync<ABI>) => void) | undefined;
	/**
	 * Called when the processor's declared version is unchanged but its code is
	 * not: the "author edited a handler and forgot to bump `version`" case.
	 *
	 * The report is ALSO logged at error level through `named-logs`, so a host
	 * that sets nothing is never silent; this exists because a log line is hard to
	 * alert on, and routing a drift to a pager or a CI failure is a decision only
	 * the host can make. Set `strictProcessorDrift` in the config to refuse to
	 * start instead.
	 */
	public onProcessorDrift: ((report: ProcessorDriftReport) => void) | undefined;

	// ------------------------------------------------------------------------------------------------------------------
	// INTERNAL VARIABLES
	// ------------------------------------------------------------------------------------------------------------------
	/**
	 * The node, behind the engine's declared surface (ADR-0073, ADR-0002).
	 *
	 * Wrapped rather than held raw so that every call this class and everything it
	 * builds makes is seen by ONE guard: `logEventFetcher` is constructed from this
	 * field, so the log path is covered by the same wrapper as the tip and identity
	 * reads. A method outside the declared set is REFUSED here rather than answered
	 * by whatever double or node happens to be underneath.
	 */
	protected provider!: MethodDeclaringProvider;
	protected source!: IndexingSource<ABI>;

	protected config!: UsedIndexerConfig<ABI>;
	protected finality!: number;

	protected sourceHashes!: SourceHashEntry[];
	protected streamConfigHash!: string;

	protected logEventFetcher!: LogEventFetcher<ABI>;

	protected lastSync: LastSync<ABI> | undefined;

	/**
	 * How far the STORED stream claims to reach, as this session last saw it, or
	 * `undefined` when there is no stream (none kept, absent, or just cleared).
	 *
	 * This is the whole of the no-hole rule. A batch is a DELTA against the
	 * STATE's cursor, so it is only safe to append when the stream is at or AHEAD
	 * of that cursor: then everything between what is stored and what the batch
	 * carries is already stored. When the stream is BEHIND -- which only a frozen
	 * cache can produce -- the blocks in between were emitted to nobody, and
	 * appending would claim coverage of them forever after.
	 *
	 * Comparing the two BLOCK RANGES instead would not do: the batch's fetch range
	 * reaches back into the finality window on every cycle, so it OVERLAPS a
	 * stream the state has already run past, while the events it carries start
	 * above the gap. That is the shape a keeper-side guard cannot see, which is
	 * why this lives here.
	 */
	protected streamLastToBlock: number | undefined;

	/**
	 * THE EMISSIONS THIS FOLLOWER HAS ALREADY FOLDED, over the range it resumes
	 * from -- and the whole of how a follower decides there is something new.
	 *
	 * A follower advances by re-reading the stream from `getFromBlock` and replaying
	 * what is beyond its own fold, so it needs a cheap "has this stream changed"
	 * question or every idle cycle re-walks and re-decodes the window. That question
	 * used to be asked of the stream's CURSOR (`lastToBlock`), and a cursor is a
	 * SUMMARY of a stream, which can lie: a PAUSED writer caps its `toBlock`
	 * (ADR-0045), so a reorg it detects at or below the cap is appended to the
	 * stream with the cursor NEVER MOVING, and a follower level with the cap
	 * concluded there was nothing to follow and kept a branch the chain had
	 * abandoned. The guard was written when a frozen cursor could not exist -- a
	 * running writer's `lastToBlock` rises with the tip every cycle -- so neither
	 * that rule nor pause is wrong on its own; the defect lived only where they met.
	 *
	 * So this remembers the EMISSIONS THEMSELVES (`emissionMarkOf`, in stream order)
	 * rather than a number describing them. It cannot go stale the way
	 * `lastToBlock` did, because it is not a claim the writer makes ABOUT the
	 * stream: it is the content of the stream over exactly the range this follower
	 * would replay, compared against the content it last folded. Anything appended
	 * there -- a retraction, its replacement, a block the cursor does not mention --
	 * makes the two differ, whatever any cursor says. ADR-0049 records the decision
	 * and why a cursor-derived shortcut is the thing to be suspicious of here.
	 *
	 * Set ONLY where this generation has just folded that exact slice, so "equal"
	 * always means "already folded", and `undefined` (nothing folded yet, or the
	 * stream this follows has changed underneath) means FOLD, which is the safe
	 * direction: a replay of what is already folded is de-duplicated against the
	 * unconfirmed window (`generateStreamFromReplay`) and delivers nothing.
	 */
	protected followedEmissions: string[] | undefined;

	/**
	 * The batch that IS written but that the processor has not accepted yet.
	 *
	 * The in-memory slot the deleted `streamNotYetSaved` list occupied, inverted:
	 * a high-water mark of what is written rather than a buffer of what is not,
	 * which is the honest thing to remember once the cursor can no longer run
	 * ahead of the write. A processor that throws leaves the events on disk and
	 * the cursor put, so the next cycle re-derives the same delta -- and without
	 * this the cache would grow by one duplicate copy per retry.
	 *
	 * In-memory is the right scope: it only has to survive the retry loop, and a
	 * reload is covered by the load path catching the state up to the stream.
	 */
	protected streamWrittenNotProcessed: LogEvent<ABI>[] | undefined;

	/** Consecutive failed writes, reset by any successful one. */
	protected streamWriteFailures: number = 0;

	/**
	 * The cache has failed too often and is no longer allowed to stop the indexer.
	 *
	 * FROZEN, not cleared: what is on disk is a contiguous prefix with a cursor
	 * that describes it honestly, which replays as a partial seed. Throwing it
	 * away would cost a re-fetch from the source's first block, which on a public
	 * node can be impossible.
	 */
	protected streamFrozen: boolean = false;

	/** So the decline is said once rather than once per cycle. */
	protected streamDeclineReported: boolean = false;

	/**
	 * Whether this generation has been asked to PAUSE. The cap itself is
	 * `pausedToBlock`, pinned by the first paused cycle.
	 */
	protected pauseRequested: boolean = false;

	/**
	 * `maxToBlock`: the block a paused generation will not fetch above, and the
	 * WHOLE of what a pause is.
	 *
	 * PINNED BY THE FIRST PAUSED CYCLE rather than by `pause()` itself, which is
	 * the one subtlety here. `pause()` is synchronous and a fetch may be in flight
	 * when it is called; a cap pinned from the cursor at that moment would then sit
	 * BELOW the cursor the racing batch leaves behind, and `getFromBlock` would
	 * immediately ask for a block above it -- so the generation would go idle
	 * holding an unconfirmed window it never re-scanned, which is exactly the
	 * hazard draining exists to remove. Pinned inside the serialized index action
	 * instead, it is by construction the cursor the paused generation actually has.
	 */
	protected pausedToBlock: number | undefined;

	protected streamWriteFailureLimit: number = DEFAULT_STREAM_WRITE_FAILURE_LIMIT;
	protected streamWriteRetryDelay: number = DEFAULT_STREAM_WRITE_RETRY_DELAY;

	// ------------------------------------------------------------------------------------------------------------------
	// ACTIONS
	// ------------------------------------------------------------------------------------------------------------------
	protected _index = createAction<LastSync<ABI>>(this.promiseToIndex.bind(this));
	protected _feed = createAction<
		LastSync<ABI>,
		{newEvents: LogEvent<ABI>[]; lastSyncFetched: LastSync<ABI>; replay?: boolean}
	>(this.promiseToFeed.bind(this));
	protected _load = createAction<LastSync<ABI>>(this.promiseToLoad.bind(this));
	protected _follow = createAction<LastSync<ABI>>(this.promiseToFollow.bind(this));
	protected _save = createAction<
		StreamWriteOutcome,
		{source: IndexingSource<ABI>; eventStream: LogEvent<ABI>[]; lastSync: LastSync<ABI>}
	>(this.promiseToSave.bind(this));

	// ------------------------------------------------------------------------------------------------------------------
	// CONSTRUCTOR
	// ------------------------------------------------------------------------------------------------------------------

	constructor(
		provider: EIP1193ProviderWithoutEvents,
		protected processor: EventProcessor<ABI, ProcessResultType>,
		source: IndexingSource<ABI>,
		config: ProvidedIndexerConfig<ABI> = {},
	) {
		this.reinit(provider, source, config);
	}

	reinit(provider: EIP1193ProviderWithoutEvents, source: IndexingSource<ABI>, config: ProvidedIndexerConfig<ABI>) {
		// THE seam. Idempotent, so a reconfigure re-entering here does not stack
		// wrappers, and everything built from `this.provider` below inherits the guard.
		this.provider = declaredMethodsOnly(provider);

		this.source = source;
		// One entry per event per NORMALISED live range, ordered so that an append
		// lands at the end of the list -- which is what lets an upgrade keep the
		// state AND the cached stream instead of re-fetching every block. A source
		// declaring no range still produces the single whole-source entry it always
		// did, so no existing deployment changes behaviour by upgrading.
		this.sourceHashes = sourceHashesOf(this.source);

		const streamConfig: UsedStreamConfig = resolveStreamConfig(config.stream);
		this.config = {feedBatchSize: 300, ...config, stream: streamConfig};

		// Resolved and hashed in ONE step, the same step `updateIndexer` reaches for:
		// the two used to be separate expressions and drifted apart, which turned an
		// ordinary reconfigure into a full re-index. See `streamConfigHashOf`.
		this.streamConfigHash = streamConfigHashOf(this.config.stream);
		this.finality = this.config.stream.finality;

		// The half of the stream's IDENTITY that does not travel with each call. A
		// keeper is handed a `source` on every operation and never the config, so a
		// keeper that ADDRESSES a stream by `{filter, config}` would otherwise key
		// two configs onto one subtree -- and a generation would adopt logs the
		// invalidation verdict has already declared invalid. Here rather than at the
		// keeper's construction site because this is where the config is RESOLVED,
		// and here rather than once in the constructor because `reinit` is also what
		// a RECONFIGURE goes through: the keeper follows onto the new stream and the
		// old one is left exactly where it is.
		this.config.keepStream?.setStreamConfig?.(this.config.stream);

		this.streamWriteFailureLimit =
			this.config.streamWriteRetry?.maxConsecutiveFailures ?? DEFAULT_STREAM_WRITE_FAILURE_LIMIT;
		this.streamWriteRetryDelay = this.config.streamWriteRetry?.delaySeconds ?? DEFAULT_STREAM_WRITE_RETRY_DELAY;
		// What is on DISK is deliberately NOT forgotten here. A reconfigure that
		// keeps the state cannot have invalidated the stream (an invalid stream is
		// always an invalid state too), so the extent still describes the stream this
		// indexer is about to go on writing -- and dropping it would remove the one
		// thing that stops a frozen cache being appended to. A reconfigure that DOES
		// discard reloads, and `load` re-reads the stored cursor on both branches.

		this.logEventFetcher = new LogEventFetcher(this.provider, source.contracts, config?.fetch, config.stream?.parse);

		(this.defaultFromBlock as any) = defaultFromBlockOf(this.source);
	}

	// ------------------------------------------------------------------------------------------------------------------
	// PUBLIC INTERFACE
	// ------------------------------------------------------------------------------------------------------------------

	/**
	 * The block the next batch of logs must start at.
	 *
	 * This is the value ADR-0004 makes the RECEIVER authoritative about. A
	 * log-fetcher holds no cursor, so before it fetches it asks the side that does,
	 * and a batch starting anywhere else is refused (`feed` throws, naming this
	 * number, because `generateStreamToAppend` already enforces exactly that check
	 * internally). Exposing it is what lets the two halves be pulled apart: without
	 * it the sender would have to compute the cursor itself, which is precisely the
	 * state a stateless component must not hold.
	 *
	 * It is NOT `lastToBlock + 1`. It deliberately reaches back to
	 * `latestBlock - finality` so the unconfirmed window is re-fetched every round,
	 * which is how a reorg is detected at all.
	 *
	 * Before anything has been indexed it is the source's earliest `startBlock`.
	 */
	/**
	 * The finality depth this indexer actually runs with, defaults applied.
	 *
	 * Exposed because it is not derivable from the config a caller PASSED (that
	 * one may leave `stream.finality` unset, and `resolveStreamConfig` fills it),
	 * and because it is what bounds the unconfirmed window: a consumer reasoning
	 * about that window (`checkTxInclusion`) needs the same number this indexer
	 * used, not a second copy of the default.
	 */
	get finalityDepth(): number {
		return this.finality;
	}

	/**
	 * The block this generation will not fetch above, or `undefined` when it is
	 * running. See `pausedToBlock`; `undefined` while paused means the cap has not
	 * been pinned yet, because no cycle has run since `pause()`.
	 */
	get maxToBlock(): number | undefined {
		return this.pauseRequested ? this.pausedToBlock : undefined;
	}

	/**
	 * DERIVED, never stored: the cap plus the existing `getFromBlock` already say
	 * where a pause has got to, and a second copy of that answer could disagree
	 * with the one the fetch loop acts on.
	 */
	get pauseState(): PauseState {
		if (!this.pauseRequested) {
			return 'running';
		}
		if (this.pausedToBlock === undefined || !this.lastSync) {
			// asked for, not yet pinned: no cycle has run, so nothing has drained
			return 'draining';
		}
		// The one condition, and it is the SAME expression the fetch loop takes its
		// "no new block" branch on: once `getFromBlock` asks for a block above the
		// capped `toBlock`, this generation fetches nothing ever again and everything
		// it holds is below `latestBlock - finality` and therefore final.
		return getFromBlock(this.lastSync, this.defaultFromBlock, this.finality) > this.pausedToBlock
			? 'drained'
			: 'draining';
	}

	/**
	 * PAUSE: stop indexing WITHOUT being deleted, and without ever answering with
	 * state a reorg has invalidated underneath.
	 *
	 * It caps `toBlock` at this generation's cursor and NOTHING ELSE. It truncates
	 * nothing, reverts nothing and never touches `revertTo`, so what this
	 * generation answers at the moment it pauses is what it goes on answering --
	 * which is what keeps a paused generation revertible-TO: moving the canonical
	 * pointer back to it restores its answers EXACTLY.
	 *
	 * ## Why it needs no new mechanism
	 *
	 * With `toBlock` capped at `x` and `lastToBlock = x`, the existing
	 * `getFromBlock` does the whole thing. While `latestBlock - finality <= x` it
	 * returns `latestBlock - finality`, so every round re-scans `[that, x]` -- a
	 * SHRINKING window that still corrects a reorg striking at or below the cap.
	 * Once `latestBlock - finality > x` it returns `x + 1`, which is above the
	 * capped `toBlock`, so the indexer takes its existing `fromBlock > toBlock`
	 * branch and fetches nothing. A paused generation self-terminates into a no-op
	 * poll; there is no timer, no branch and no state machine here to get wrong.
	 *
	 * `lastSync.latestBlock` deliberately keeps tracking the REAL head. Capping
	 * that too would make `getFromBlock` return `latestBlock - finality` forever
	 * and the drain would NEVER idle.
	 *
	 * ## What it is NOT
	 *
	 * It is NOT INSTANT: draining takes up to `finality` blocks of continued light
	 * polling, and a driver that stops calling `indexMore()` the moment it pauses
	 * leaves the generation holding an unconfirmed window forever. Watch
	 * `pauseState` for the moment it is `drained`.
	 *
	 * It is NOT `disableProcessing()`, which stops the engine where it stands --
	 * that IS the hazard: a generation carrying an unconfirmed window it can no
	 * longer correct never finds out that one of those blocks was reorged away, and
	 * its state permanently contains events from blocks that no longer exist.
	 *
	 * It is NOT persisted. A reload comes back running, and re-pausing costs one
	 * drain; making it durable is a registry record, which is the registry's to add
	 * when something needs it. It DOES survive a reconfigure in the session that
	 * asked for it -- `reinit` does not clear the cap -- because "do not go above
	 * x" is a decision about this generation and not about the source it was made
	 * under; `resume()` is the only thing that lifts it.
	 *
	 * It caps the verb that FETCHES (`indexMore`). A generation advanced with
	 * `followMore` goes exactly as far as the STREAM it folds and holds no
	 * `toBlock` of its own, so a cap would be a no-op that lied about being a
	 * pause: `Indexer.pause` refuses a follower for that reason
	 * (`CannotPauseFollowerError`).
	 */
	pause(): void {
		this.pauseRequested = true;
	}

	/** RESUME: remove the cap, and nothing else. The next round asks the head again. */
	resume(): void {
		this.pauseRequested = false;
		this.pausedToBlock = undefined;
	}

	get expectedFromBlock(): number {
		if (!this.lastSync) {
			return this.defaultFromBlock;
		}
		return getFromBlock(this.lastSync, this.defaultFromBlock, this.finality);
	}

	load(): Promise<LastSync<ABI>> {
		if (this._index.executing) {
			throw new Error(`indexing... should not load`);
		}

		if (this._feed.executing) {
			throw new Error(`feeding... should not load`);
		}

		// load only once, once loaded it will return the same result
		return this._load.once();
	}

	/**
	 * Hand over a FETCH: raw logs, complete over the range the cursor asks for,
	 * carrying no verdicts of their own.
	 *
	 * Every retraction is DERIVED here, by comparing the cursor's unconfirmed
	 * window against the incoming blocks, exactly as the live path derives it --
	 * which is why a batch carrying `removed` markers is refused rather than
	 * accepted with them dropped. A stream that already knows what it took back is
	 * a REPLAY and goes through `replay()`.
	 */
	async feed(eventStream: LogEvent<ABI>[], lastSyncFetched: LastSync<ABI>): Promise<LastSync<ABI>> {
		// we first check if this valid to be called
		if (this._index.executing) {
			throw new Error(`indexing... should not feed`);
		}

		if (this._feed.executing) {
			throw new Error(`already feeding... should not feed`);
		}

		// Ascending by block, or refused. A payload the engine reads out of order loses
		// the logs that arrive late, which is the one failure an indexer must not have
		// quietly (`assertAscendingByBlock` says why this is not sorted instead).
		assertAscendingByBlock(eventStream, 'the payload handed to `feed()`');

		const retracted = eventStream.find((event) => event.removed);
		if (retracted) {
			// Loud rather than silent, and this is the whole shape of the bug being
			// closed: `groupLogsPerBlock` DROPS these, so a stored stream fed through
			// here replayed both branches of a reorg as live blocks and reverted
			// nothing. The same refusal `assertWellFormed` makes on the wire, for the
			// same reason -- a fetch cannot know what was taken back.
			throw new InvalidBatchError(
				`a log at block ${retracted.blockNumber} (${retracted.blockHash}) is marked removed, so this is an ` +
					`emission STREAM and not a fetch. \`feed()\` derives every retraction from the cursor's unconfirmed ` +
					`window and would DISCARD the ones carried here. Replay a stored stream with \`replay()\`, which ` +
					`honours the verdicts it already carries.`,
			);
		}

		// we do next but as we check first that it is not executing the feed
		// we could as well say feed.ifNotExecuting
		return this._feed.next({
			newEvents: eventStream,
			lastSyncFetched,
		});
	}

	/**
	 * Hand over a STORED emission stream, verdicts included.
	 *
	 * The counterpart of `feed()`, and the entry a rebuild off a cached stream
	 * takes (`promiseToLoad`, both branches). What arrives here is not a re-read of
	 * a block range: it is the sequence of applies and retractions some earlier run
	 * already decided, so the engine HONOURS it instead of recomputing it from a
	 * window a rebuild does not have. It shares `promiseToFeed`'s delivery -- the
	 * per-block batching, and the rule that every retraction goes in ONE batch --
	 * and differs only in how the stream and the new cursor are derived; see
	 * `generateStreamFromReplay`.
	 *
	 * `lastSyncStored` is the stream's OWN cursor, whose `lastFromBlock` must be
	 * the block this indexer asked the keeper for. Its `unconfirmedBlocks` is
	 * ignored and may be empty: no stream keeper stores the window (ADR-0035), and
	 * the replay rebuilds it from the stream itself.
	 */
	async replay(eventStream: LogEvent<ABI>[], lastSyncStored: LastSync<ABI>): Promise<LastSync<ABI>> {
		if (this._index.executing) {
			throw new Error(`indexing... should not replay`);
		}

		if (this._feed.executing) {
			throw new Error(`already feeding... should not replay`);
		}

		return this._feed.next({newEvents: eventStream, lastSyncFetched: lastSyncStored, replay: true});
	}

	indexMore(): Promise<LastSync<ABI>> {
		// we first check if this valid to be called

		if (this._load.executing) {
			throw new Error(`loading not complete`);
		}

		if (this._feed.executing) {
			throw new Error(`feed is not complete`);
		}

		// if we call twice in a row, it will keep merging
		return this._index.ifNotExecuting();
	}

	/**
	 * ADVANCE FROM THE STORED STREAM ALONE, and fetch NOTHING.
	 *
	 * This is how a generation that does not OWN its stream moves: it reads what
	 * the stream now holds beyond its own cursor and REPLAYS it. `indexMore` is the
	 * other verb and the two are never both right for one generation -- which one
	 * applies is DETERMINED by whether this generation shares its stream with the
	 * one indexing it (`Indexer.add`), and is never a configuration knob.
	 *
	 * ## Why a follower must not poll the head
	 *
	 * Three things break at once if it does, and the third is the one that matters.
	 * The re-fetch stops being zero and becomes merely fewer. The one-writer rule
	 * goes, because the save is driven by the indexing loop rather than by the
	 * caller's intent (which is why the read-only stream view exists at all). And
	 * -- the load-bearing one -- this generation's state becomes a function of ITS
	 * OWN FETCH rather than of the stream, so re-folding the stored stream later
	 * yields a DIFFERENT state. A generation would stop being "a stream plus a fold
	 * over it", and the promise that moving the canonical pointer back restores
	 * answers EXACTLY would go with it.
	 *
	 * ## What it is, mechanically
	 *
	 * The CATCH-UP branch of `promiseToLoad`, made repeatable. The first call has
	 * no cursor, so it loads -- which re-folds the whole stored stream from the
	 * start -- and every call after it reads the stream from where this cursor
	 * resumes and replays what is new. Nothing here fetches, and nothing here
	 * writes or CLEARS: a stream this generation does not own is not its to repair,
	 * which is why every branch below simply returns rather than clearing as the
	 * load path does.
	 */
	followMore(): Promise<LastSync<ABI>> {
		if (this._load.executing) {
			throw new Error(`loading not complete`);
		}

		if (this._feed.executing) {
			throw new Error(`feed is not complete`);
		}

		return this._follow.ifNotExecuting();
	}

	disableProcessing() {
		// this will stop whatever it is doing
		// except reset
		this._load.cancel();
		this._feed.cancel();
		this._index.block();
		this._follow.block();
	}

	reenableProcessing() {
		this._index.unblock();
		this._follow.unblock();
	}

	async updateIndexer(update: {
		provider?: EIP1193ProviderWithoutEvents;
		source?: IndexingSource<ABI>;
		streamConfig?: ProvidedStreamConfig;
	}): Promise<ReconfigureOutcome> {
		this.disableProcessing();
		// The config this reconfigure will RUN under, hashed exactly as `reinit` will
		// hash it below -- through the one resolve-then-hash step, so an unset
		// `finality` cannot make the stored hash and the incoming one disagree for
		// ever. Left as `this.streamConfigHash` when no config was passed, because
		// "unchanged" is not "the default": this generation may be running a config
		// that is not the resolver's.
		const newConfigHash = update.streamConfig ? streamConfigHashOf(update.streamConfig) : this.streamConfigHash;

		const newSourceHashes = update.source ? sourceHashesOf(update.source) : this.sourceHashes;
		// Guarded HERE and not only at the `reinit` below, because the chain-identity
		// check a few lines down speaks to it BEFORE the reinit happens: a provider the
		// engine talks to is a provider behind the declared surface, with no window
		// where it is not (the wrapper is idempotent, so `this.provider` passes through).
		const newProvider = declaredMethodsOnly(update.provider || this.provider);
		const oldSource = this.source;

		// The CURSOR, and not 0. Whether an appended entry can be absorbed is exactly
		// the question "does it describe blocks nothing has indexed yet", so asking it
		// against block 0 answered "yes, always" and kept state that had been derived
		// over blocks the new entry describes.
		const cursor = this.lastSync?.lastToBlock ?? 0;
		const processorVersionHash = this.processor.getVersionHash();
		const invalidation = sourceInvalidationOf(newSourceHashes, newConfigHash, cursor, {
			source: this.sourceHashes,
			config: this.streamConfigHash,
			processor: processorVersionHash,
		});
		// The STATE half, and not the stream half: what a reset discards is the fold.
		// A stream that is no longer covered is dealt with where it is read, in
		// `promiseToLoad`, so a state discard whose stream SURVIVED rebuilds from the
		// cache instead of going back to the node. Today the only action is still a
		// full discard -- but the verdict is no longer thrown away with it: it rides
		// out on `ReconfigureOutcome.sourceInvalidation`, where a caller that wants the
		// other half or the block can read them. See `InvalidationVerdict`.
		const resetNeeded = !invalidation.state.valid;

		// TODO remove, this is the responsibility of the developer to ensure it pass correct data when indexer context changes
		// for now we do a minimum check of chainId
		// if this has been updated but the source remain unchanged, then the developer must have forgot to send a different source
		if (!resetNeeded) {
			const newChainIdAsHex = await newProvider.request({method: 'eth_chainId'});
			const newChainId = parseInt(newChainIdAsHex.slice(2), 16).toString();
			if (newChainId !== oldSource.chainId) {
				throw new Error(
					`
					Connected to a different chain (chainId : ${newChainId}) than the previous indexer context (${oldSource.chainId}).
					Indexer should reset.
					Did you forget to pass some new source?
					`,
				);
			}
		} else {
			if (this.config?.logLevel && this.config.logLevel >= 1) {
				namedLogger.info(`updateIndexer: Reset needed, Indexer do not match`, {
					invalidation,
					newSourceHashes,
					newConfigHash,
					sourceHashes: this.sourceHashes,
					streamConfigHash: this.streamConfigHash,
					processorVersionHash,
				});
			}
		}

		this._feed.reset();
		this._index.reset();
		this._save.reset();
		this._load.reset();
		this._follow.reset();
		// A reconfigure can point the keeper at a DIFFERENT stream, so what this
		// generation folded no longer describes what it is about to read. Forgetting it
		// costs one replay that de-duplicates to nothing; keeping it could skip one.
		this.followedEmissions = undefined;
		this.reinit(
			newProvider,
			update.source || this.source,
			update.streamConfig ? {...this.config, stream: update.streamConfig} : this.config,
		);

		if (resetNeeded) {
			await this.processor
				.reset()
				.then((v) => this.load())
				.then(() => this.reenableProcessing());
		} else {
			// The state SURVIVED a source that is not the one it was computed under, so
			// the context it carries has to say so. Leaving the old list there would
			// invalidate the state on the next reload: the appended entry would then be
			// compared against a cursor that has since moved past it, and an append that
			// cost nothing today would cost a full re-index tomorrow.
			if (this.lastSync) {
				this.lastSync.context.source = this.sourceHashes;
				this.lastSync.context.config = this.streamConfigHash;
				this._onLastSyncUpdated();
			}
			this.reenableProcessing();
		}
		return {stateDiscarded: resetNeeded, sourceInvalidation: invalidation};
	}

	async updateProcessor(
		newProcessor: EventProcessor<ABI, ProcessResultType>,
		options?: {force?: boolean},
	): Promise<ReconfigureOutcome> {
		// Align with updateIndexer: disable processing first so a racing index/feed tick cannot
		// interleave with the swap, then decide, then re-enable.
		this.disableProcessing();

		const oldProcessor = this.processor;
		const versionChanged = oldProcessor.getVersionHash() != newProcessor.getVersionHash();

		if (versionChanged || options?.force) {
			// Only swap once we have decided a change is needed; do not replace the running instance
			// on a no-op path.
			this.processor = newProcessor;
			this._feed.reset();
			this._index.reset();
			this._load.reset();
			this._follow.reset();
			// the fold that folded those emissions is being replaced, so the record of
			// what it folded goes with it
			this.followedEmissions = undefined;

			try {
				await oldProcessor.clear().then(() => this.load());
			} finally {
				this.reenableProcessing();
			}
			return {stateDiscarded: true};
		} else {
			// Same version hash and not forced: nothing to reset/reload, so we keep the running
			// processor instance. Warn in case the developer changed the processor but forgot to bump
			// its version hash (the new instance will NOT take effect). Pass `{force: true}` to swap
			// regardless of the version hash.
			namedLogger.warn(
				`updateProcessor: new processor has the same version hash as the current one; ` +
					`the swap was skipped. If this is unexpected, bump the processor's version hash or call ` +
					`updateProcessor(newProcessor, {force: true}).`,
			);
			this.reenableProcessing();
			return {stateDiscarded: false};
		}
	}

	async reset(): Promise<ReconfigureOutcome> {
		if (this._index.executing) {
			this._index.cancel();
		}
		if (this._feed.executing) {
			this._feed.cancel();
		}
		this._load.reset();

		await this.clearStoredStream();
		this.forgetStoredStream();
		await this.processor.clear().then(() => this.load());
		// Unconditional, and the only one of the three that is: `reset` IS the discard.
		return {stateDiscarded: true};
	}

	// ------------------------------------------------------------------------------------------------------------------
	// INTERNALS
	// ------------------------------------------------------------------------------------------------------------------

	protected async save(
		source: IndexingSource<ABI>,
		eventStream: LogEvent<ABI>[],
		lastSync: LastSync<ABI>,
	): Promise<StreamWriteOutcome> {
		return this._save.next({source, eventStream, lastSync});
	}

	/**
	 * A CACHE MUST NEVER WEDGE THE INDEXER, applied HERE because this is the caller
	 * the rule is about.
	 *
	 * `fetchFrom` and `clear` are called from the load path below with no
	 * `try`/`catch` above them, so a keeper that raises from either does not degrade
	 * a cache -- it makes `load()` reject, on this boot and every boot after it, for
	 * a LOCAL CACHE whose correct recovery is to throw the bytes away and index
	 * again. That is the difference between a slow app and a dead one, and it is
	 * story 12 of `a-reconfigure-is-not-an-outage`. Absent is the honest answer for a
	 * substrate that is simply unavailable (IndexedDB refused in private browsing,
	 * storage evicted, a database at a version this build cannot open), and it is the
	 * one the load path already knows what to do with.
	 *
	 * This USED to live in a `degradingStream` wrapper each keeper applied to itself,
	 * and it moved here because a policy at the SEAM binds every caller, including
	 * ones for whom it is false. "Absence is safe" is a statement about the load
	 * path: this generation responds to an absent stream by re-indexing, so losing
	 * one costs time. It is NOT true of a caller that responds to an absent stream by
	 * WRITING -- `installStreamSeed` reads emptiness as permission to install, so a
	 * swallowed read failure let it append a seed under a stream that was really
	 * there, duplicating events beneath a cursor moved backwards. A keeper cannot
	 * know which kind of caller it has, so it no longer decides for them: it raises,
	 * and each caller applies its own policy (ADR-0068).
	 *
	 * The WRITE side is deliberately not guarded here or anywhere: `promiseToSave`
	 * catches `saveNewEvents` itself and what it does with the failure is
	 * load-bearing -- it counts it, paces the retry, freezes the cache, and until
	 * then does not process the batch at all. A swallowed write failure would let the
	 * state advance past events the stream never received, which is a HOLE.
	 */
	protected async readStoredStream(
		fromBlock: number,
	): Promise<{eventStream: StoredLogEvent[]; lastSync: StoredLastSync} | undefined> {
		const keepStream = this.config.keepStream;
		if (!keepStream) return undefined;
		let read: StreamRead;
		try {
			read = await keepStream.fetchFrom(this.source, fromBlock);
		} catch (error) {
			this.cacheDegraded('read', error);
			// the SAME answer a never-written stream gives, which is why it is the safe
			// one HERE: this generation re-indexes on it
			return undefined;
		}
		if (read.status === 'stream') {
			return read;
		}
		if (read.status !== 'absent') {
			// THE REPAIR, and it is this caller's (ADR-0069). A keeper REPORTS what it
			// found and clears nothing, because the right response differs by caller: a
			// FOLLOWER reaches this same code through `readOnlyStream`, whose `clear` is a
			// no-op, so it can no longer destroy the stream its writer is still appending
			// to -- which is precisely what a keeper clearing on its own behalf used to do.
			//
			// For THIS generation the answer is what it has always been: throw the bytes
			// away and index again. Repairing them would cost more machinery than the
			// re-index it saves, and a `does-not-reach-back` stream is discarded for the
			// same reason it always was -- the events below its start would be missing from
			// a fold that believed it was whole.
			const why =
				read.status === 'inconsistent'
					? `it is inconsistent (${read.reason})`
					: `it starts at ${read.startBlock} and does not reach back to ${fromBlock}`;
			namedLogger.info(
				`the cached stream is being cleared and will rebuild, because ${why}. Nothing else reads it, so this ` +
					`costs a re-index and nothing more.`,
			);
			await this.clearStoredStream();
		}
		// Every non-`stream` verdict reaches the caller below as ABSENT, which is the
		// shape the load path has always branched on. The verdict changed WHO repairs,
		// not what this generation does about it.
		return undefined;
	}

	/** The other half of the rule above: a substrate that cannot be read cannot be emptied either. */
	protected async clearStoredStream(): Promise<void> {
		const keepStream = this.config.keepStream;
		if (!keepStream) return;
		try {
			await keepStream.clear(this.source);
		} catch (error) {
			// `fetchFrom` reporting absent is what MAKES the caller clear, so a raising
			// `clear` would put the outage back one line further down.
			this.cacheDegraded('cleared', error);
		}
	}

	private cacheDegraded(operation: string, error: unknown): void {
		namedLogger.error(
			`the cached stream could not be ${operation} on chain ${this.source.chainId}: ${error}. It is treated as ` +
				`ABSENT, so this generation re-indexes from its start block rather than failing to load at all -- a cache ` +
				`is an optimisation and must never wedge the indexer.`,
			error,
		);
	}

	/** There is no stream on disk any more, so nothing constrains the next write. */
	protected forgetStoredStream() {
		this.streamLastToBlock = undefined;
		this.streamWrittenNotProcessed = undefined;
		this.streamDeclineReported = false;
		// and nothing this generation folded describes what is there now
		this.followedEmissions = undefined;
	}

	/**
	 * Whether this slice of the stream is EXACTLY the one this generation last
	 * folded, emission for emission and in order.
	 *
	 * The replacement for the cursor comparison, and it is deliberately an equality
	 * and not an ordering: "the stream has not changed where I would read it" is the
	 * only question whose answer justifies doing nothing. Anything else -- a longer
	 * slice, a shorter one, one that shares a prefix -- falls through to the replay,
	 * which is always correct and merely costs a walk.
	 */
	protected hasAlreadyFolded(eventsStored: readonly (LogEvent<ABI> | StoredLogEvent)[]): boolean {
		const folded = this.followedEmissions;
		if (!folded || folded.length !== eventsStored.length) {
			return false;
		}
		for (let i = 0; i < folded.length; i++) {
			if (folded[i] !== emissionMarkOf(eventsStored[i])) {
				return false;
			}
		}
		return true;
	}

	/**
	 * The stronger half of the load-time identity guard: the chain's genesis
	 * block is the one this source declares.
	 *
	 * ## Three conditions, three refusals
	 *
	 * The check can fail in three unrelated ways and a caller does something
	 * DIFFERENT about each: a wrong chain is a configuration error (stop), a node
	 * that will not serve block 0 is an availability fact about the NODE (point
	 * elsewhere, or set `skipGenesisCheck`), and a failed request is transience
	 * (retry). They used to be one uncaught throw and one message, so a flaky
	 * endpoint at startup was indistinguishable from being pointed at the wrong
	 * chain -- and both of them announced a WRONG CHAIN, which is a claim only the
	 * first one is entitled to make.
	 */
	protected async checkGenesisHash(expectedGenesisHash: string): Promise<void> {
		let genesisBlock: {hash: string} | null | undefined;
		try {
			genesisBlock = await this.provider.request({method: 'eth_getBlockByNumber', params: [GENESIS_BLOCK, false]});
		} catch (error) {
			// nothing was learnt about the chain, so nothing is claimed about it
			throw new GenesisCheckUnavailableError(expectedGenesisHash, error);
		}
		const genesisHash = genesisBlock?.hash;
		if (!genesisHash) {
			throw new GenesisBlockNotServedError(expectedGenesisHash);
		}
		if (genesisHash !== expectedGenesisHash) {
			throw new GenesisHashMismatchError(expectedGenesisHash, genesisHash);
		}
	}

	protected async promiseToLoad(): Promise<LastSync<ABI>> {
		const chainId = await this.provider.request({method: 'eth_chainId'});
		if (parseInt(chainId.slice(2), 16).toString() !== this.source.chainId) {
			throw new Error(
				`Connected to a different chain (chainId : ${chainId}). Expected chainId === ${this.source.chainId}`,
			);
		}
		if (this.source.genesisHash && !this.config.skipGenesisCheck) {
			await this.checkGenesisHash(this.source.genesisHash);
		}

		let currentLastSync: LastSync<ABI> | undefined = undefined;
		await this._onLoad('Loading');
		const processorHash = this.processor.getVersionHash();
		const loaded = await this.processor.load(this.source, this.config.stream);
		if (loaded) {
			const {lastSync: loadedLastSync, state} = loaded;
			if (
				processorHash === loadedLastSync.context.processor &&
				this.stateMatches(loadedLastSync.lastToBlock, loadedLastSync.context)
			) {
				// The state is about to be ADOPTED, which is the only branch where drift can
				// matter: a differing version hash discards the state anyway (a deliberate
				// bump is never a drift), and no persisted state means nothing stale to
				// serve. Checked BEFORE adopting, so strict mode refuses without ever
				// handing the stale state to a listener.
				this.reportProcessorDriftIfAny(loadedLastSync.context, processorHash);
				currentLastSync = loadedLastSync;
				// The state is valid under the CURRENT source, so record it as such. Without
				// this an absorbed append would be re-judged on every reload against the
				// stored list it was absorbed into, and would flip to a re-index as soon as
				// the cursor passed the appended entry's own block.
				currentLastSync.context.source = this.sourceHashes;
				this._onStateUpdated(state);
			} else {
				namedLogger.info(`STATE DISCARDED AS PROCESSOR CHANGED`);
				if (this.config?.logLevel && this.config.logLevel >= 1) {
					namedLogger.info(
						`State Discarded: processor changed`,
						JSON.stringify(
							{
								sourceHashes: this.sourceHashes,
								loadedSourceHashes: loaded.lastSync.context.source,
								streamConfigHash: this.streamConfigHash,
								loadedStreamConfigHash: loaded.lastSync.context.config,
								processorHash,
								loadedProcessorHash: loadedLastSync.context.processor,
							},
							null,
							2,
						),
					);
				}
				await this.processor.clear();
			}
		}
		// if mismatch found, we get a fresh sync
		if (!currentLastSync) {
			currentLastSync = this.freshLastSync(processorHash);
			this.lastSync = currentLastSync;
			this._onLastSyncUpdated();

			// but we might have some stream still valid here
			if (this.config.keepStream) {
				await this._onLoad('FetchingEventStream');
				// we start from scratch
				const fromBlock = this.defaultFromBlock;
				const existingStreamData = await this.readStoredStream(fromBlock);

				// we assume the stream is correct and start from the requested number
				if (existingStreamData) {
					const eventsFetched = existingStreamData.eventStream;
					// the requested `fromBlock`, and the engine's own cursor shape: see
					// `cursorFromStream`
					const lastSyncFetched = cursorFromStream<ABI>(existingStreamData.lastSync, fromBlock);

					// the STREAM half: these are raw logs under a topic-and-address filter, so
					// they are reusable whenever that filter did not GROW -- which is what lets
					// a discarded state be rebuilt without re-fetching a block
					if (this.streamMatches(lastSyncFetched.lastToBlock, lastSyncFetched.context)) {
						// What survived is the RAW half. `args` and `eventName` are a decode some
						// earlier ABI made of those bytes, and a change can move the decode without
						// moving the fetch at all -- a renamed non-indexed parameter leaves every
						// cached log exactly right and every cached `args` filed under a key the
						// handler no longer reads. So the stream is decoded AGAIN, against the
						// source running now, before a single event reaches the processor.
						const replayable = this.logEventFetcher.reparse(eventsFetched);
						if (!replayable) {
							// An event with no raw log left to decode, which nothing written by this
							// version can be: it is a stream an OLDER version wrote, back when a parse
							// config could project `topics` or `data` away. So this stream cannot be
							// re-read and must not be replayed on trust (ADR-0034).
							await this.clearStoredStream();
							this.forgetStoredStream();
						} else {
							// we update the processorHash in case it was changed
							currentLastSync.context.processor = processorHash;
							this.streamLastToBlock = lastSyncFetched.lastToBlock;
							if (replayable.length > 0) {
								await this._onLoad('ProcessingEventStream');
								// REPLAY and not feed: this stream carries its own verdicts, and this
								// cursor is FRESH, so there is no window to derive them from. Fed as
								// a fetch, a stored reorg replayed as two live branches at one height.
								await this.replay(replayable, lastSyncFetched);
							} else {
								// A stream that holds a CURSOR and no events -- the ordinary state of a
								// deployment whose contracts have emitted nothing yet, and what an empty
								// save writes. Adopting it only as a side effect of feeding left the
								// in-memory cursor at `freshLastSync`, whose `latestBlock` is 0, so the
								// scan restarted from the start block on every reload, forever. The empty
								// WINDOW is correct rather than lossy: there are no stored events, so
								// there is nothing a reorg could retract, and the next fetch rebuilds it.
								this.lastSync = {
									context: currentLastSync.context,
									lastFromBlock: lastSyncFetched.lastFromBlock,
									lastToBlock: lastSyncFetched.lastToBlock,
									latestBlock: lastSyncFetched.latestBlock,
									unconfirmedBlocks: [],
								};
								currentLastSync = this.lastSync;
								this._onLastSyncUpdated();
							}
						}
					} else {
						await this.clearStoredStream();
						this.forgetStoredStream();
					}
				} else {
					await this.clearStoredStream();
					this.forgetStoredStream();
				}
			}
		} else {
			// BEFORE the stream is consulted, not after: feeding below moves the cursor
			// to where the stream reaches, and an assignment after the block would throw
			// that catch-up away.
			this.lastSync = currentLastSync;
			this._onLastSyncUpdated();
			if (this.config.keepStream) {
				await this._onLoad('FetchingEventStream');
				const fromBlock = getFromBlock(currentLastSync, this.defaultFromBlock, this.finality);
				// we still need to clear if it does not matches, as otherwise it will be written as if it contained all logs
				const existingStreamData = await this.readStoredStream(fromBlock);
				if (existingStreamData) {
					const eventsFetched = existingStreamData.eventStream;
					// the requested `fromBlock`, taken onto the fetched cursor exactly as the
					// discarded branch does: `generateStreamToAppend` refuses a batch whose
					// `lastFromBlock` is not the one the current cursor asks for, and the stored
					// cursor's own is whatever the last fetch used
					const lastSyncFetched = cursorFromStream<ABI>(existingStreamData.lastSync, fromBlock);
					if (!this.streamMatches(lastSyncFetched.lastToBlock, lastSyncFetched.context)) {
						await this.clearStoredStream();
						this.forgetStoredStream();
					} else {
						this.streamLastToBlock = lastSyncFetched.lastToBlock;
						if (lastSyncFetched.lastToBlock > currentLastSync.lastToBlock) {
							// The stream is AHEAD of the state, which is what the tab closing between
							// the write and the process leaves behind, and it is the benign direction
							// only because the processor catches up FROM THE CACHE. Fetching those
							// blocks from the node instead would append them to the stream a second
							// time, and the next rebuild would see every one of them twice.
							//
							// Re-decoded on the way through, like the discarded branch: the stored
							// `args` are what SOME earlier ABI made of those bytes (ADR-0034), and one
							// decoding rule for a replayed stream is better than two.
							const replayable = this.logEventFetcher.reparse(eventsFetched);
							if (!replayable) {
								await this.clearStoredStream();
								this.forgetStoredStream();
							} else if (replayable.length > 0) {
								await this._onLoad('ProcessingEventStream');
								// The catch-up shape of the same replay: this cursor DOES hold a
								// window, and it is what stops the events it already applied from
								// being applied a second time on the way back through.
								await this.replay(replayable, lastSyncFetched);
							}
						}
					}
				}
			}
		}
		await this._onLoad('Loaded');
		return this.lastSync;
	}

	/**
	 * One FOLLOW step: what the stream holds beyond this cursor, replayed.
	 *
	 * Every early return leaves the stream exactly where it is. The load path
	 * CLEARS on each of these shapes because it owns the stream it is reading; this
	 * does not own it, and a follower that cleared would delete the indexing
	 * generation's history out from under it. The cost of returning instead is one
	 * idle cycle, and the next one asks again.
	 */
	protected async promiseToFollow({unlessCancelled}: CancelOperations): Promise<LastSync<ABI>> {
		if (!this.lastSync) {
			// The FIRST advance is the whole re-fold: `load` replays the stored stream
			// from the start into this generation's own fresh state.
			await unlessCancelled(this.load());
		}
		const current = this.lastSync as LastSync<ABI>;
		const keepStream = this.config.keepStream;
		if (!keepStream) {
			// nothing to follow: a generation with no stream to read has no other way to
			// advance, and inventing one here would be the head-following poller
			return current;
		}

		const fromBlock = getFromBlock(current, this.defaultFromBlock, this.finality);
		const existingStreamData = await unlessCancelled(this.readStoredStream(fromBlock));
		if (!existingStreamData) {
			return current;
		}

		const eventsStored = existingStreamData.eventStream;
		// the requested `fromBlock`, taken onto the fetched cursor exactly as both load
		// branches do: `generateStreamFromReplay` refuses a stream that does not reach
		// back to where this cursor resumes
		const lastSyncStored = cursorFromStream<ABI>(existingStreamData.lastSync, fromBlock);
		if (!this.streamMatches(lastSyncStored.lastToBlock, lastSyncStored.context)) {
			// The stream was fetched under a filter this source is not covered by. The
			// indexing generation is the one that decides what happens to it.
			return current;
		}
		this.streamLastToBlock = lastSyncStored.lastToBlock;
		// NOTHING TO FOLLOW is a question about the STREAM, and it is asked of the
		// stream. The cursor is consulted only for the half it cannot be wrong about:
		// a stream reaching PAST this fold is new by definition and there is no need to
		// compare anything. The other half -- a cursor level with or behind this fold --
		// used to be the whole test and is exactly where a PAUSED writer's frozen
		// `lastToBlock` hid an appended retraction (see `followedEmissions`), so what
		// settles it is whether the emissions themselves are the ones already folded.
		if (lastSyncStored.lastToBlock <= current.lastToBlock && this.hasAlreadyFolded(eventsStored)) {
			// level with the stream, and the stream says the same thing it said last time:
			// there is nothing yet to follow
			return current;
		}

		// Re-decoded on the way through, like both load branches: the stored `args` are
		// what SOME earlier ABI made of those bytes (ADR-0034), and one decoding rule
		// for a replayed stream is better than two.
		const replayable = this.logEventFetcher.reparse(eventsStored);
		if (!replayable) {
			// not folded, so nothing is remembered: the next cycle asks again rather than
			// concluding it is level with a stream it could not read
			return current;
		}
		// Taken from the STORED slice and not from `replayable`, because the stored
		// slice is what the next cycle re-reads and is therefore what it can be
		// compared against. It is only REMEMBERED once the fold below has returned: a
		// replay that throws part-way has not folded this slice, and the next cycle
		// re-offers the whole of it (`generateStreamFromReplay` de-duplicates whatever
		// did land against the window).
		const folded = eventsStored.map(emissionMarkOf);
		if (replayable.length === 0) {
			// The stream moved and carried no events into this range, which is what an
			// empty save writes. The CURSOR still has to move, or `getFromBlock` would
			// ask from the same block forever. The window is carried forward untouched:
			// nothing was applied and nothing was taken back, and the next replay prunes
			// it against the tip it is given.
			this.lastSync = {
				context: current.context,
				latestBlock: lastSyncStored.latestBlock,
				lastFromBlock: lastSyncStored.lastFromBlock,
				lastToBlock: lastSyncStored.lastToBlock,
				unconfirmedBlocks: current.unconfirmedBlocks,
			};
			this.followedEmissions = folded;
			this._onLastSyncUpdated();
			return this.lastSync;
		}

		// REPLAY and not feed: this stream carries its own verdicts (ADR-0042), and a
		// follower has no fetch window to derive them from.
		await unlessCancelled(this.replay(replayable, lastSyncStored));
		// AFTER the replay, and only on the way out of a successful one: a fold that
		// threw has not folded this slice, and remembering it as folded would make the
		// next cycle skip exactly the emissions that never landed.
		this.followedEmissions = folded;
		return this.lastSync as LastSync<ABI>;
	}

	protected async promiseToFeed(
		params: {
			newEvents: LogEvent<ABI>[];
			lastSyncFetched: LastSync<ABI>;
			/** The events are a stored STREAM carrying its own verdicts, not a fetch. */
			replay?: boolean;
		},
		{unlessCancelled}: CancelOperations,
	): Promise<LastSync<ABI>> {
		const newEvents = params.newEvents;
		const lastSyncFetched = params.lastSyncFetched;

		if (!this.lastSync) {
			this.lastSync = this.freshLastSync(this.processor.getVersionHash());
			this._onLastSyncUpdated();
		}

		const bounds = {
			newLatestBlock: lastSyncFetched.latestBlock,
			newLastToBlock: lastSyncFetched.lastToBlock,
			newLastFromBlock: lastSyncFetched.lastFromBlock,
			finality: this.finality,
		};
		// The IN direction splits on the KIND of what arrived, and only here. A fetch
		// carries no verdicts, so they are derived from the cursor's window; a stored
		// stream carries its own, so they are honoured. Routing the second through the
		// first is what made a rebuild replay a reorged history as if both branches
		// were live -- `groupLogsPerBlock` drops the `removed` events, which is right
		// for a fetch (that rule is untouched) and wrong for a replay.
		const {eventStream, newLastSync} = params.replay
			? generateStreamFromReplay(this.lastSync, this.defaultFromBlock, newEvents, bounds)
			: generateStreamToAppend(this.lastSync, this.defaultFromBlock, newEvents, bounds);

		// THE CUT IS SHARED, and deliberately so: `GenerationRebuild` delivers a
		// replayed stream on a runtime that has no engine at all, and two copies of the
		// retraction batching and the per-batch cursor narrowing would be two answers to
		// "what is one `process()` call". See `batchStreamForDelivery` for the three
		// rules and what each of them costs when it is missing. What stays HERE is what
		// only this engine has: the notifications, the cancellation window and the pacing.
		for (const batch of batchStreamForDelivery(eventStream, newLastSync, this.config.feedBatchSize)) {
			const currentLastSync = batch.lastSync;
			// Cancelled AFTER this batch landed is still landed: see the same window in
			// `promiseToIndex`. Recording it here is what keeps the loop's next entry, and
			// the next cycle, from re-delivering a batch the processor already holds.
			let outcome: ProcessResultType;
			try {
				outcome = await unlessCancelled(this.processor.process(batch.events, currentLastSync));
			} catch (error) {
				if (error instanceof CancellablePromiseCancelled) {
					this.lastSync = currentLastSync;
					this._onLastSyncUpdated();
				}
				throw error;
			}
			this.lastSync = currentLastSync;
			this._onLastSyncUpdated();

			this._onStateUpdated(outcome);

			await unlessCancelled(wait(0.001));
		}
		this.lastSync = newLastSync;

		return this.lastSync;
	}

	/**
	 * Write the batch to the cached stream, and SAY what happened.
	 *
	 * It reports rather than swallows, because the caller's next move depends on
	 * it: a batch that was not written must not be processed, or the state
	 * advances past events the stream never received and the cursor claims
	 * coverage of a range whose events are simply absent.
	 *
	 * What used to be here was an in-memory list of unsaved events carried to the
	 * next save on the save action's promise CONTEXT. It never fired -- the
	 * context survives only when a save is queued onto one still in flight, and
	 * the index cycle awaits its save, so the list was empty at push time every
	 * time. It existed only to compensate for processing first; with the order
	 * flipped and the cursor held back, the next cycle re-derives those events
	 * from the same cursor, so it is redundant and it is gone.
	 */
	protected async promiseToSave(params: {
		source: IndexingSource<ABI>;
		eventStream: LogEvent<ABI>[];
		lastSync: LastSync<ABI>;
	}): Promise<StreamWriteOutcome> {
		const {eventStream, source, lastSync} = params;
		const keepStream = this.config.keepStream;
		if (!keepStream) {
			return 'skipped';
		}

		if (!this.streamCanReceive()) {
			if (!this.streamDeclineReported) {
				this.streamDeclineReported = true;
				namedLogger.error(
					`the cached stream stops here: it holds blocks up to ${this.streamLastToBlock} and the state has ` +
						`moved on to ${this.lastSync?.lastToBlock}, so appending this batch would claim coverage of blocks ` +
						`the stream never received. What is stored is a contiguous prefix and is kept as one; it is replayed ` +
						`and the remainder re-fetched the next time the state is rebuilt.`,
				);
			}
			return 'declined';
		}

		const toWrite = this.streamRemainderOf(eventStream);
		// THE STRIP, and it happens HERE rather than in a keeper. `ExistingStream` is
		// third-party-implementable and has several implementations already, so a rule
		// each of them had to remember would drift; what a keeper is handed is the raw
		// log plus the reorg verdict, and the decoded half is re-derived on read
		// (ADR-0034). Both halves of what the saver takes are stripped: the batch, and
		// the cursor's unconfirmed window, whose stored copy is read back for its block
		// numbers and its context and never as events. Neither strip mutates -- the
		// events are the ones `process` is about to fold, and this very `lastSync`
		// object is handed to the STATE keeper on the same tick.
		const toStore = storedStreamOf(toWrite);
		const lastSyncToStore = storedLastSyncOf(lastSync);
		let saved: void | 'declined';
		try {
			// No conversion: the seam takes exactly what the strip produced, on both
			// halves. `StreamSaver` is declared over `StoredLogEvent` / `StoredLastSync`,
			// so a keeper that expected the decoded half would not compile against it
			// rather than receiving `undefined` at runtime.
			saved = await keepStream.saveNewEvents(source, {eventStream: toStore, lastSync: lastSyncToStore});
		} catch (e) {
			return this.onStreamWriteFailed(e, source);
		}
		if (saved === 'declined') {
			// The KEEPER refused this batch, for the same reason `streamCanReceive` refuses
			// one here: appending it would leave a hole behind a cursor claiming to cover
			// it. It is not a failure and must not be retried, but treating a decline as a
			// write was worse than either -- `streamLastToBlock` would move to a block the
			// stream never received, so `streamCanReceive` kept answering true and every
			// later decline was invisible as well.
			if (!this.streamDeclineReported) {
				this.streamDeclineReported = true;
				namedLogger.error(
					`the cached stream declined this batch: it does not continue what is stored, so appending it would ` +
						`leave a hole no later check could see. Nothing is written and nothing is cleared; a contiguous ` +
						`batch is accepted again as soon as one arrives.`,
				);
			}
			return 'declined';
		}
		if (this.streamWriteFailures > 0 || this.streamFrozen) {
			namedLogger.info(`the cached stream is writable again after ${this.streamWriteFailures} failed write(s)`);
		}
		this.streamWriteFailures = 0;
		this.streamFrozen = false;
		this.streamLastToBlock = lastSync.lastToBlock;
		this.streamWrittenNotProcessed = eventStream;
		return toWrite.length === 0 && eventStream.length > 0 ? 'skipped' : 'written';
	}

	/**
	 * Whether the stream is at or AHEAD of the state, which is the only position
	 * from which an append cannot leave a hole. See `streamLastToBlock`.
	 */
	protected streamCanReceive(): boolean {
		if (this.streamLastToBlock === undefined || !this.lastSync) {
			return true;
		}
		return this.streamLastToBlock >= this.lastSync.lastToBlock;
	}

	/**
	 * The part of this batch that is not already on disk, with a retraction for
	 * anything written that the chain has since moved under.
	 *
	 * The batch handed to a save is a delta against the IN-MEMORY cursor, and that
	 * cursor only advances after `process` RETURNS -- so a processor that throws
	 * leaves its events written and the next cycle re-derives the same list plus
	 * whatever the tip has added. Appending that again would grow the cache by one
	 * duplicate copy per retry, and those duplicates would replay twice once the
	 * handler is fixed.
	 *
	 * Where the two lists DIVERGE, the chain reorged under events the processor
	 * never accepted: the state cannot retract them (it never applied them), and a
	 * replay of the stream would apply a dead branch. So they are retracted HERE,
	 * at their original block, which is exactly what the emission stream is for.
	 */
	protected streamRemainderOf(eventStream: LogEvent<ABI>[]): LogEvent<ABI>[] {
		const written = this.streamWrittenNotProcessed;
		if (!written || written.length === 0) {
			return eventStream;
		}
		let common = 0;
		while (common < written.length && common < eventStream.length && sameEvent(written[common], eventStream[common])) {
			common++;
		}
		const superseded = written.slice(common).filter((event) => !event.removed);
		const retractions = superseded.map((event) => ({...event, removed: true}) as LogEvent<ABI>);
		return [...retractions, ...eventStream.slice(common)];
	}

	/**
	 * A write that threw: count it, clear ONLY for the cause the cache itself is,
	 * and give up on the cache once it has failed too often.
	 */
	protected async onStreamWriteFailed(e: unknown, source: IndexingSource<ABI>): Promise<StreamWriteOutcome> {
		this.streamWriteFailures++;
		if (isOutOfSpace(e)) {
			// the one cause where the cache IS the problem: freezing preserves it,
			// deleting frees it
			namedLogger.error(
				`the store is out of space, so the cached stream is being cleared rather than kept: ${e}. ` +
					`Indexing continues and the stream rebuilds from here.`,
			);
			try {
				await this.config.keepStream?.clear(source);
				this.forgetStoredStream();
			} catch (clearError) {
				namedLogger.error(`could not clear the cached stream after an out-of-space write: ${clearError}`);
			}
		} else {
			namedLogger.error(
				`could not save the stream (${this.streamWriteFailures} consecutive failure(s) of ` +
					`${this.streamWriteFailureLimit}): ${e}. The batch is NOT processed and the cursor does not move, so ` +
					`the next cycle re-derives it and nothing is lost.`,
			);
		}
		if (this.streamWriteFailures >= this.streamWriteFailureLimit) {
			if (!this.streamFrozen) {
				namedLogger.error(
					`the cached stream is FROZEN after ${this.streamWriteFailures} consecutive failed writes. Indexing ` +
						`carries on WITHOUT the cache: a cache is an optimisation and must never wedge the indexer. What is ` +
						`already stored is kept as a contiguous prefix and is not cleared, so it still seeds a rebuild.`,
				);
			}
			this.streamFrozen = true;
			return 'frozen';
		}
		return 'failed';
	}

	protected async promiseToIndex({unlessCancelled}: CancelOperations): Promise<LastSync<ABI>> {
		if (!this.lastSync) {
			namedLogger.info(`load lastSync...`);
			await this.load();
		}

		// as precautious measure, we check chainId in case the provider is now pointing to a new chain
		// while this is valid use, it is important to warn the indexer as soon as possible via chainChanged event
		// and pausing the call to index until the correct chain is connected again
		const before_fetch_chainIdAsHex = await unlessCancelled(this.provider.request({method: 'eth_chainId'}));
		const before_fetch_chainId = parseInt(before_fetch_chainIdAsHex.slice(2), 16).toString();
		if (before_fetch_chainId !== this.source.chainId) {
			throw new Error(`chainId changed before fetch`);
		}

		// A per-cycle genesis check used to sit here, commented out, carrying the
		// `earliest`-means-genesis bug this file no longer has. It is DELETED rather
		// than repaired: dead code cannot be tested, so it would have gone stale
		// again, and reviving a per-cycle genesis read is a decision about cost per
		// cycle (`work/specs/tasked/one-chain-identity-check-per-cycle-not-two.md`)
		// rather than a line to uncomment. `checkGenesisHash` above is the one place
		// this question is asked, and whoever revives it calls that.

		const previousLastSync = this.lastSync as LastSync<ABI>;
		const {lastSync: newLastSync, eventStream} = await this.fetchLogsFromProvider(previousLastSync, unlessCancelled);

		// as precautious measure, we check chainId in case the provider is now pointing to a new chain
		const chainIdAsHex = await unlessCancelled(this.provider.request({method: 'eth_chainId'}));
		const chainId = parseInt(chainIdAsHex.slice(2), 16).toString();
		if (chainId !== this.source.chainId) {
			throw new Error(`chainId changed after fetch`);
		}

		// ----------------------------------------------------------------------------------------
		// WRITE THE STREAM FIRST, AND DO NOT PROCESS A BATCH THAT WAS NOT WRITTEN
		// ----------------------------------------------------------------------------------------
		// A cache must never be behind the thing it exists to replay into. The state
		// advances inside `process` (a processor persists its own state there), so
		// processing first and saving after means a failed save leaves the stream a
		// batch behind -- and the NEXT cycle computes its delta from the already
		// advanced cursor, so the stream's cursor jumps over a range its events never
		// received. Nothing detects that afterwards.
		const written = await unlessCancelled(this.save(this.source, eventStream, newLastSync));
		if (written === 'failed') {
			// The cycle achieves nothing and the next one tries again, which is the
			// whole recovery: nothing is lost, nothing is skipped, and the stream
			// cannot fall behind the state even by one batch. Paced, because a driver
			// that loops until the tip advances would otherwise spin hot on a store
			// that is refusing.
			await unlessCancelled(wait(this.streamWriteRetryDelay));
			// The CURSOR did not move -- the in-memory one is untouched, so the next
			// fetch asks for exactly the same range -- but the tip this cycle observed
			// is not a secret. A driver that loops until `lastToBlock` reaches
			// `latestBlock` has to keep looping rather than conclude it is done, and on
			// the very first cycle of a fresh index the stored cursor still says
			// `latestBlock: 0`. Returned as a VALUE and not assigned: `getFromBlock`
			// reads `latestBlock === 0` as "nothing indexed yet", so writing this one
			// back would drag the next fetch below the source's start block.
			return {...(this.lastSync as LastSync<ABI>), latestBlock: newLastSync.latestBlock};
		}

		// ----------------------------------------------------------------------------------------
		// MAKE THE PROCESSOR PROCESS IT
		// ----------------------------------------------------------------------------------------
		// A CANCELLATION HERE MUST NOT LOSE A BATCH THAT ALREADY LANDED.
		//
		// `unlessCancelled` rejects the CALLER; it cannot stop the work, and it only
		// throws once the promise it wraps has RESOLVED. So when it fires here the
		// processor has applied this batch and persisted it -- state and cursor in one
		// transaction (ADR-0027) -- and throwing before the lines below left the engine
		// believing it never happened. The next cycle re-derived the same range and
		// handed the SAME events over again: a wedge on a store that refuses a
		// re-applied block, a silent double-apply on one that does not. Every
		// reconfigure verb calls `disableProcessing()` first, so this is the ordinary
		// path and not an exotic one.
		//
		// Reverting the batch instead is not available and would be worse: `process` is
		// the processor's OWN transaction, the interface has no per-batch undo (only
		// `reset`/`clear`, which discard everything), and the write is already durable.
		// So the completed work is recorded and the cancellation is then honoured, which
		// leaves the in-memory cursor agreeing with what is on disk.
		let outcome: ProcessResultType;
		try {
			outcome = await unlessCancelled(this.processor.process(eventStream, newLastSync));
		} catch (error) {
			if (error instanceof CancellablePromiseCancelled) {
				this.streamWrittenNotProcessed = undefined;
				this.lastSync = newLastSync;
				this._onLastSyncUpdated();
			}
			throw error;
		}
		// accepted: the cursor is about to move past this batch, so the written
		// high-water mark has done its job
		this.streamWrittenNotProcessed = undefined;

		this.lastSync = newLastSync;
		this._onLastSyncUpdated();

		if (eventStream.length > 0) {
			// state should not be updated if there is zero events
			this._onStateUpdated(outcome);
		}

		return this.lastSync;
		// ----------------------------------------------------------------------------------------
	}

	async fetchLogsFromProvider<ABI extends Abi>(
		lastSync: LastSync<ABI>,
		unlessCancelled: <T>(p: Promise<T>) => Promise<T>,
	): Promise<{lastSync: LastSync<ABI>; eventStream: LogEvent<ABI>[]}> {
		const lastUnconfirmedBlocks = lastSync.unconfirmedBlocks;

		// ----------------------------------------------------------------------------------------
		// COMPUTE fromBlock
		// ----------------------------------------------------------------------------------------
		const fromBlock = getFromBlock(lastSync, this.defaultFromBlock, this.finality);

		// ----------------------------------------------------------------------------------------

		// ----------------------------------------------------------------------------------------
		// FETCH LOGS
		// ----------------------------------------------------------------------------------------
		const latestBlock = await unlessCancelled(getBlockNumber(this.provider));

		let toBlock = latestBlock;

		// ----------------------------------------------------------------------------------------
		// THE PAUSE CAP, and it goes HERE: on `toBlock`, BEFORE the guard below
		// ----------------------------------------------------------------------------------------
		// This is the whole of pause. Capped before the guard, the drain falls out of
		// the existing arithmetic: while the cap is inside the reorg window the guard
		// passes and this re-scans `[latestBlock - finality, cap]`, and once the cap
		// falls out of it `getFromBlock` asks for `cap + 1`, the guard fires, and this
		// fetches nothing. Capped AFTER the guard instead, a head above the cap would
		// take the guard's other branch and the drain would never idle.
		//
		// `latestBlock` above is deliberately NOT capped: it is the REAL head, and it is
		// what the cursor keeps recording, so `getFromBlock` can eventually reach past
		// the cap. Cap that too and it returns `latestBlock - finality` forever.
		if (this.pauseRequested) {
			// pinned HERE, inside the serialized index action, so the cap is the cursor
			// this generation actually has rather than one a racing batch has moved past
			this.pausedToBlock ??= lastSync.lastToBlock;
			if (toBlock > this.pausedToBlock) {
				toBlock = this.pausedToBlock;
			}
		}

		if (fromBlock > toBlock) {
			namedLogger.info(`no new block`);
			return {lastSync, eventStream: []};
		}

		const {events: eventsFetched, toBlockUsed: newToBlock} = await this.logEventFetcher.getLogEvents(
			{
				fromBlock,
				toBlock: toBlock,
			},
			unlessCancelled,
		);
		toBlock = newToBlock;

		// The node's answer, checked for the one property the fold depends on and
		// cannot verify later. `eth_getLogs` returns logs ascending, so an unordered
		// answer means something between here and the chain reordered them, and the
		// engine would silently drop whatever arrived late.
		assertAscendingByBlock(eventsFetched as LogEvent<ABI>[], `the node's answer for [${fromBlock}, ${toBlock}]`);

		// ...and for the TIME AXIS, which the node puts on the log itself
		// (execution-apis#639). Refused HERE, one round trip in, rather than after the
		// range has been folded and stored -- and naming the node, because every cause
		// of an absent timestamp is node-level (ADR-0073).
		//
		// UNCONDITIONAL: there is no configuration that turns it off, because there is
		// no longer a fallback for it to defer to. The engine reads the timestamp off
		// the log and never fetches one.
		assertLogsCarryTimestamps(eventsFetched as LogEvent<ABI>[], `the node's answer for [${fromBlock}, ${toBlock}]`);

		// ----------------------------------------------------------------------------------------
		// PROCESS THE STREAM FOR REORG
		// ----------------------------------------------------------------------------------------
		const {eventStream, newLastSync} = generateStreamToAppend(
			lastSync,
			this.defaultFromBlock,
			eventsFetched as LogEvent<ABI>[],
			{
				// TODO investigate: why need to type it here ?
				newLatestBlock: latestBlock,
				newLastToBlock: toBlock,
				newLastFromBlock: fromBlock,
				finality: this.finality,
			},
		);
		// ----------------------------------------------------------------------------------------

		return {lastSync: newLastSync, eventStream};
	}

	/** Whether the persisted STATE is still a fold over what this source means. */
	protected stateMatches(lastToBlock: number, context: ContextIdentifier): boolean {
		return stateMatches(this.sourceHashes, this.streamConfigHash, lastToBlock, context);
	}

	/** Whether the cached raw log STREAM was fetched under a filter this source is still covered by. */
	protected streamMatches(lastToBlock: number, context: ContextIdentifier): boolean {
		return streamMatches(this.sourceHashes, this.streamConfigHash, lastToBlock, context);
	}

	/**
	 * Compare the fingerprint of the code that computed the persisted state with
	 * the code loaded now, and report if they differ.
	 *
	 * Either side missing means "unknown", never "drifted": a cursor written
	 * before this field existed, or a processor that cannot fingerprint itself,
	 * must not report on every boot. The stored fingerprint is deliberately NOT
	 * refreshed afterwards, because it describes the code that produced the state, so the
	 * report repeats every boot until the author bumps `version` (which discards
	 * the state) rather than going quiet after being seen once.
	 */
	protected reportProcessorDriftIfAny(context: ContextIdentifier, processorHash: string): void {
		const storedFingerprint = context.processorFingerprint;
		const currentFingerprint = this.processor.getCodeFingerprint();
		if (!storedFingerprint || !currentFingerprint || storedFingerprint === currentFingerprint) {
			return;
		}

		const message =
			`PROCESSOR DRIFT: the processor's version hash is unchanged (${processorHash}) but its handler code is not ` +
			`(state was computed by ${storedFingerprint}, running ${currentFingerprint}). ` +
			`The persisted state was computed by DIFFERENT logic and is being reused as if it were current. ` +
			`Bump the processor's \`version\` to discard and recompute it. ` +
			`If no logic changed, this is a re-minification or a transpiler change and can be ignored ` +
			`(the fingerprint is advisory and never discards state on its own).`;
		const report: ProcessorDriftReport = {processorHash, storedFingerprint, currentFingerprint, message};

		namedLogger.error(message);
		if (this.onProcessorDrift) {
			try {
				this.onProcessorDrift(report);
			} catch (err) {
				namedLogger.error(`onProcessorDrift listener threw`, err);
			}
		}
		if (this.config.strictProcessorDrift) {
			throw new Error(message);
		}
	}

	protected freshLastSync(processorHash: string): LastSync<ABI> {
		if (!this.sourceHashes || !this.streamConfigHash) {
			throw new Error(`no sourceHashes or configHash computed, please load first`);
		}
		return {
			context: {
				source: this.sourceHashes,
				config: this.streamConfigHash,
				processor: processorHash,
				// Recorded on the FRESH cursor, so that the state this run computes carries
				// the identity of the code that computed it, and the next boot has something
				// to compare against.
				processorFingerprint: this.processor.getCodeFingerprint(),
			},
			lastToBlock: 0,
			lastFromBlock: 0,
			latestBlock: 0,
			unconfirmedBlocks: [],
		};
	}

	protected _onStateUpdated(outcome: ProcessResultType) {
		if (this.onStateUpdated) {
			try {
				this.onStateUpdated(outcome);
			} catch (err) {
				namedLogger.error(`onStateUpdated listener threw`, err);
			}
		}
	}

	protected _onLastSyncUpdated() {
		if (this.lastSync && this.onLastSyncUpdated) {
			try {
				this.onLastSyncUpdated(this.lastSync);
			} catch (err) {
				namedLogger.error(`onLastSyncUpdated listener threw`, err);
			}
		}
	}

	protected async _onLoad(state: LoadingState) {
		if (this.onLoad) {
			try {
				await this.onLoad(state);
			} catch (err) {
				namedLogger.error(`onLoad listener threw`, err);
			}
		}
	}
}
