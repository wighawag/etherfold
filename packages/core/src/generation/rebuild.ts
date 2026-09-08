import type {Abi} from 'abitype';
import type {EIP1193ProviderWithoutEvents} from 'eip-1193';
import {logs} from 'named-logs';

import {LogEventFetcher} from '../internal/decoding/LogEventFetcher.js';
import {
	batchStreamForDelivery,
	defaultFromBlockOf,
	generateStreamFromReplay,
	getFromBlock,
	stateMatches,
	wireContextOf,
} from '../internal/engine/utils.js';
import type {
	EventProcessor,
	FetchConfig,
	IndexingSource,
	LastSync,
	LogEvent,
	UsedStreamConfig,
	WireContext,
} from '../types.js';
import type {GenerationId} from './registry.js';

const namedLogger = logs('@etherfold/core');

/* ---------------------------------------------------------------------------
 * THE REBUILD: A SUCCESSOR CATCHES UP BY REPLAYING THE LOCAL STREAM, IN BOUNDED
 * CHUNKS, AGAINST A DURABLE CHECKPOINT.
 *
 * This is what makes a processor upgrade cost a LOCAL SCAN instead of a
 * re-index (ADR-0008, whose rebuild-alongside MECHANISM this is; its namespace
 * KEY and its drop-the-old RETENTION are superseded by the generation model).
 * The successor shares a STREAM with the incumbent, so it is a **follower**
 * (ADR-0044): it fetches NOTHING -- zero `eth_getLogs`, not fewer -- writes no
 * stream, and re-folds what is already on disk.
 *
 * ## Why it is a call the HOST schedules, doing bounded work (ADR-0022)
 *
 * The same shape `prune` and `compactEmissionPairs` already have, and for the
 * same reasons. A rebuild takes arbitrarily long, and the intended host is
 * serverless: it cannot hold a loop, so the work has to be re-invocable and the
 * position has to survive the invocation that computed it. So one call does a
 * bounded amount of work and REPORTS whether it finished; the CADENCE is
 * nobody's business here (a Node cron, a CLI loop, a browser idle callback and
 * ADR-0008's self-enqueueing Worker queue each want a different one).
 *
 * The three decisions below -- where the checkpoint lives, how a chunk is sized,
 * and what "caught up" is measured against -- are ADR-0056.
 *
 * ## WHERE THE CHECKPOINT LIVES: it IS the successor's own sync cursor
 *
 * There is no rebuild table and no second durable number. A chunk is applied
 * through `EventProcessor.process`, which persists the `LastSync` describing
 * each block IN THE SAME TRANSACTION as that block (ADR-0027; the cursor lives
 * behind the storage seam precisely because only the store holds that
 * transaction). So "the state and the checkpoint commit together" is not a
 * property this driver arranges -- it is the one the seam already guarantees,
 * and a second checkpoint beside it could only ever disagree with the state it
 * describes. A process killed mid-rebuild therefore resumes from what the store
 * committed, and a fresh object graph over the same database reads the same
 * position: this driver holds NO position of its own between calls.
 *
 * ## HOW A CHUNK IS SIZED: a budget in EMISSIONS, cut on a BLOCK boundary
 *
 * The budget is a number of stored emissions, because that is what the work is
 * proportional to. The CUT is on a block boundary, because a block is the
 * indivisible unit here: the stored stream is `seq`-ordered and a reorg puts an
 * application, its retraction and its replacement at ONE block but at
 * arbitrarily separated `seq` values, so a chunk ending mid-block would leave
 * rows below its own resume point and skip them for ever.
 *
 * So it is a BUDGET and not a bound, in two named places, and both of them are
 * bounded by something else instead:
 *
 * - a single BLOCK carrying more emissions than the budget is replayed whole;
 * - a chunk always reaches at least ONE BLOCK ABOVE what the fold already
 *   covers. It has to, because a resume point REACHES BACK over the reorg window
 *   (`getFromBlock`): a fold sitting inside that window re-reads blocks it has
 *   already folded, so a budget spent inside them would cut the chunk at or
 *   below the fold's own position and the rebuild would never advance again. The
 *   work that guarantee costs is bounded by the reorg window, which is exactly
 *   what one cycle of a live indexer already pays.
 *
 * The report says how many rows were actually read, so neither is silent.
 *
 * ## It is a REPLAY, so it HONOURS the verdicts the stream carries (ADR-0042)
 *
 * The rows are a DELTA that already records what was applied and what was taken
 * back. `generateStreamFromReplay` walks them and rebuilds the unconfirmed
 * window as it goes -- an applied block enters it, a retracted block LEAVES it
 * -- rather than filtering the `removed` entries out, which would leave both
 * branches of a reorg at one height. Nothing here derives a retraction from a
 * window a rebuild does not have.
 * ------------------------------------------------------------------------- */

/** What one bounded read of a stored stream was asked for. */
export type ReplayChunkQuery = {
	/** WHICH stream, as `streamDigestOf` renders it. Never omitted: it is half the key. */
	readonly stream: string;
	/**
	 * The block this fold resumes at, which is `getFromBlock` over its own
	 * checkpoint -- so it REACHES BACK over the reorg window once the fold is level.
	 */
	readonly fromBlock: number;
	/**
	 * The highest block this fold ALREADY covers (`lastToBlock`), which is what a
	 * chunk must end above.
	 *
	 * Handed over because `fromBlock` alone cannot say it: the resume point reaches
	 * BACK over the reorg window, so a fold sitting inside that window asks for
	 * blocks it has already folded, and a chunk cut at or below this one would
	 * advance nothing and be asked for again for ever.
	 */
	readonly foldedThrough: number;
	/**
	 * How many stored emissions this call SHOULD read.
	 *
	 * A BUDGET rather than a bound: see the module JSDoc for the two places a reader
	 * must exceed it, and what bounds it instead there.
	 */
	readonly maxEmissions: number;
};

/**
 * One bounded slice of a stored emission stream, in the shape a replay consumes.
 *
 * `eventStream` is in `seq` order with retractions INCLUDED at their original
 * block, because that is the order the fold concluded them in and the only order
 * a replay may honour them in.
 */
export type ReplayChunk<ABI extends Abi> = {
	/** The emissions of `[lastFromBlock, lastToBlock]`, `seq`-ordered, verdicts included. */
	readonly eventStream: LogEvent<ABI>[];
	/** Echoed from the query, so the engine can refuse a slice that does not start where the cursor resumes. */
	readonly lastFromBlock: number;
	/**
	 * How far THIS CHUNK covers, which is the stream's own claim when the budget
	 * did not cut it short and the last COMPLETE block otherwise.
	 */
	readonly lastToBlock: number;
	/** The chain tip the stream recorded, so a resumed fold reaches back over the finality window once level. */
	readonly latestBlock: number;
	/**
	 * Whether the stream reaches ABOVE this chunk's `lastToBlock`.
	 *
	 * The question a scheduler acts on, and deliberately not "did the read hit the
	 * budget": a fold level with the stream re-reads its reorg window on every call
	 * and would hit a small budget for ever, so a budget-shaped answer would mean
	 * "never finished" on a rebuild that finished.
	 */
	readonly truncated: boolean;
	/**
	 * The stream's high-water `seq` at the moment of the read.
	 *
	 * REPORTED rather than compared: a follower's completeness is a stream-space
	 * property and this is the number that expresses it, so an operator watching a
	 * rebuild sees the size of what is being folded rather than a block number that
	 * means nothing about rows. The DECISION that a chunk finished the stream is
	 * `truncated`, because the read covers the whole tail above the resume point
	 * unless the budget cut it.
	 */
	readonly highWater: number;
};

/**
 * WHERE A STORED STREAM IS READ IN BOUNDED SLICES.
 *
 * A PORT and not a stream keeper, because `ExistingStream.fetchFrom` is
 * deliberately unbounded -- it answers "the whole stream from here", which is
 * what a load wants and exactly what a serverless rebuild cannot ask for. The
 * two are the same rows read two ways, and this one is the read a scheduler can
 * afford.
 *
 * Implemented by whoever owns the storage (`storedEmissionReplaySource`,
 * `@etherfold/server`), so this package stays free of a database. It is
 * READ-ONLY by construction: there is no write on it at all, which is the
 * one-writer rule (ADR-0044) said in the shape of a type rather than in a no-op.
 */
export type ReplaySource<ABI extends Abi> = {
	/** The slice, or the VERDICT that says why there is not one. */
	readChunk(query: ReplayChunkQuery): Promise<ReplayRead<ABI>>;
};

/**
 * WHAT A BOUNDED READ HANDS BACK, as a verdict rather than a nullable.
 *
 * The same correction ADR-0069 made to `ExistingStream.fetchFrom`, applied to its
 * BOUNDED sibling, which was left behind (ADR-0070). These are the same
 * `_emissions` rows read two ways, so answering the same question two ways was
 * never defensible -- and the shipped implementation proved it was not
 * theoretical: `storedEmissionReplaySource` returned `undefined` both for
 * "nothing has ever been stored here" and for "a perfectly good stream that
 * starts ABOVE where this fold resumes".
 *
 * The difference is the whole scheduling decision. Nothing-stored is TRANSIENT --
 * the writing generation simply has not appended yet, and calling again is
 * exactly right. Does-not-reach-back is PERMANENT for this fold: it recurs on
 * every call, for ever, and no amount of polling fixes it. Collapsed into one
 * value, a host could only keep calling, burning a scheduled invocation per
 * follower with no signal that anything was wrong (`retryCanAdvance`).
 */
export type ReplayRead<ABI extends Abi> =
	/** A slice to fold. */
	| ({readonly status: 'chunk'} & ReplayChunk<ABI>)
	/** Nothing is stored under this stream yet. TRANSIENT: the writer may append later. */
	| {readonly status: 'absent'}
	/**
	 * A stream that starts ABOVE the block this fold resumes at.
	 *
	 * Nothing is wrong with it -- a fold resuming higher would be served -- which is
	 * why it is its own verdict and not damage, exactly as in `StreamRead`. For THIS
	 * fold it is terminal: a partial history replayed as though it were whole leaves
	 * the blocks under it simply absent from the rebuilt state, silently.
	 */
	| {readonly status: 'does-not-reach-back'; readonly startBlock: number}
	/**
	 * Something is stored and it does not hold together.
	 *
	 * No in-repo implementation reports this today (the SQL reader's rows are either
	 * claimed or they are not). It exists because a third party implementing this
	 * port over its own store has damage it can see and, without this, nowhere to
	 * put it -- which is how the conflation this type removes got started.
	 */
	| {readonly status: 'inconsistent'; readonly reason: string};

/**
 * How many stored emissions ONE call replays when the host names no budget.
 *
 * The unit is emissions because that is what both halves of the cost are
 * proportional to: rows read out of the stream, and blocks written into the
 * successor's own namespace. Two thousand is a few hundred `applyBlock`
 * transactions on the measured stream (31,332 logs over 13.4M blocks, median 429
 * blocks between event-bearing ones), which is a chunk a serverless invocation
 * finishes comfortably and a local CLI loop pays no visible pause for.
 *
 * A host that wants a shorter invocation passes a smaller `maxEmissions` and
 * calls more often; a host that wants a whole sweep loops while `complete` is
 * false. Neither cadence is invented here (ADR-0022).
 */
export const DEFAULT_MAX_EMISSIONS_PER_CHUNK = 2000;

/**
 * How many events one `process()` call inside a chunk carries, when the host
 * names none.
 *
 * The engine's own default for the same cut, restated here rather than reached
 * for through `ProvidedIndexerConfig`: this runtime builds no engine, and a
 * second NUMBER is cheaper to keep honest than a dependency on a config object
 * that carries a provider's worth of unrelated knobs.
 */
export const DEFAULT_FEED_BATCH_SIZE = 300;

/** What ONE call of the rebuild did, as data rather than as a log line. */
export type RebuildReport = {
	/** WHICH generation this call advanced. */
	readonly generation: GenerationId;
	/** The block this chunk resumed at: `getFromBlock` over the durable checkpoint. */
	readonly fromBlock: number;
	/** How far the fold now claims to cover, or `undefined` when nothing was folded. */
	readonly toBlock: number | undefined;
	/** How many stored emissions were read. The bound on this call's work, made visible. */
	readonly scanned: number;
	/** How many reached the processor. Fewer than `scanned` where a catch-up re-offered its own window. */
	readonly replayed: number;
	/** Of those, retractions. Non-zero means this chunk replayed a reorg the stream carries. */
	readonly retracted: number;
	/** The stream's high-water `seq` at the moment of this call. See `ReplayChunk.highWater`. */
	readonly highWater: number;
	/**
	 * Whether the fold has consumed the whole stream as it stood at this call.
	 *
	 * ONE question, the same one `PairCompactionReport.complete` and
	 * `PruneReport.complete` answer. WHY it stopped is `stopped`, and a scheduler
	 * that only loops while this is false is the caller ADR-0070 exists for: three
	 * of the six stop reasons recur for ever.
	 */
	readonly complete: boolean;
	/**
	 * WHY this call stopped, stated rather than left to be re-derived.
	 *
	 * This replaces an `absent: boolean` that answered two questions at once and a
	 * `complete: false` that answered three, so the only way to tell "call again" from
	 * "calling again will do exactly this for ever" was an undocumented
	 * `toBlock === undefined && !absent`. See `retryCanAdvance`.
	 */
	readonly stopped: RebuildStop;
};

/**
 * WHY a rebuild chunk stopped. Six reasons, three of which a retry cannot fix.
 *
 * Reported rather than thrown throughout, because none of it is this generation's
 * to repair: the stream belongs to the generation still appending to it, and a
 * follower owns neither those rows nor their cursor.
 */
export type RebuildStop =
	/** The fold reached the end of the stream as it stood. `complete` is true. */
	| {readonly reason: 'stream-consumed'}
	/** The chunk budget cut it short. More is waiting NOW; call again. */
	| {readonly reason: 'budget'}
	/** Nothing is stored under this stream yet. The writer may append later; call again later. */
	| {readonly reason: 'nothing-stored'}
	/**
	 * The stored stream starts above where this fold resumes.
	 *
	 * RECURS FOR EVER: the resume point is derived from this fold's own durable
	 * checkpoint, so nothing about calling again changes the comparison. A seeded
	 * generation is the shape that produces it. It needs a seed reaching further
	 * back, a lower resume point, or a re-index -- never another poll.
	 */
	| {readonly reason: 'does-not-reach-back'; readonly startBlock: number}
	/**
	 * A stored emission has no raw log to decode, so the chunk cannot be replayed on
	 * trust (ADR-0034). RECURS FOR EVER: the same rows are read again next call.
	 */
	| {readonly reason: 'undecodable'}
	/** The source reported its stored stream does not hold together. RECURS FOR EVER. */
	| {readonly reason: 'inconsistent'; readonly detail: string};

/** The read's verdict, as the reason a chunk did not happen. */
function stopFor(read: Exclude<ReplayRead<Abi>, {status: 'chunk'}>): RebuildStop {
	switch (read.status) {
		case 'absent':
			return {reason: 'nothing-stored'};
		case 'does-not-reach-back':
			return {reason: 'does-not-reach-back', startBlock: read.startBlock};
		case 'inconsistent':
			return {reason: 'inconsistent', detail: read.reason};
	}
}

/** The stop reason in words, for the one log line that has to explain itself. */
function describe(stopped: RebuildStop): string {
	switch (stopped.reason) {
		case 'does-not-reach-back':
			return `the stored stream starts at block ${stopped.startBlock}`;
		case 'undecodable':
			return `a stored emission has no raw log to decode`;
		case 'inconsistent':
			return `the stored stream does not hold together (${stopped.detail})`;
		default:
			return stopped.reason;
	}
}

/**
 * Whether calling `more()` again can make progress, or whether this needs a human.
 *
 * The one derivation every scheduler would otherwise write for itself, and get
 * subtly wrong: `budget` means more is waiting right now, `nothing-stored` and
 * `stream-consumed` mean the writer may add more later, and the other three recur
 * identically on every call until something outside this loop changes. A host that
 * loops on `complete === false` alone spins at full rate on all three, for ever,
 * with only a log line to say why -- which is the defect ADR-0070 removes.
 */
export function retryCanAdvance(stopped: RebuildStop): boolean {
	return stopped.reason === 'budget' || stopped.reason === 'nothing-stored' || stopped.reason === 'stream-consumed';
}

/** What the rebuild needs besides the fold itself. */
export type GenerationRebuildOptions<ABI extends Abi> = {
	/** WHICH stream this generation folds, as `streamDigestOf` renders it. */
	stream: string;
	/** The stream config that digest was taken over, resolved. Its `finality` is what bounds the window. */
	streamConfig: UsedStreamConfig;
	/** Where the stored stream is read in bounded slices. */
	replay: ReplaySource<ABI>;
	/** The budget one call spends when the caller names none. Defaults to `DEFAULT_MAX_EMISSIONS_PER_CHUNK`. */
	maxEmissions?: number;
	/**
	 * How many events one `process()` call inside a chunk carries.
	 *
	 * The same knob and the same default the engine's feed path has
	 * (`ProvidedIndexerConfig.feedBatchSize`), because it is the same cut
	 * (`batchStreamForDelivery`). Distinct from `maxEmissions`, which bounds the
	 * CALL: this bounds one transaction inside it.
	 */
	feedBatchSize?: number;
	/** Fetcher configuration, taken only for the parse side of it; nothing here ever fetches. */
	fetch?: FetchConfig;
};

/**
 * A PROVIDER THAT REFUSES EVERY CALL, which is what "it replays, it does not
 * fetch" looks like from inside.
 *
 * `LogEventFetcher` is constructed here for its DECODER alone: the stored rows
 * carry the raw log and never `args` or `eventName` (those are what SOME ABI
 * made of those bytes, ADR-0034), so a replay decodes again against the source
 * running now -- the same `reparse` every other replay path uses, rather than a
 * second decoding rule that could disagree with it. Its constructor makes no
 * chain call, and this is what it holds instead of a node: a rebuild that ever
 * reached for one would fail loudly here rather than quietly costing a re-index.
 */
const NEVER_FETCHES = {
	async request(args: {method: string}): Promise<never> {
		throw new Error(
			`a rebuild replays the LOCAL stream and must never reach the chain, but ${args.method} was called. A ` +
				`successor on a shared stream is a FOLLOWER: it fetches NOTHING (ADR-0044), which is what makes a ` +
				`processor upgrade cost a local scan instead of a re-index.`,
		);
	},
} as unknown as EIP1193ProviderWithoutEvents;

/**
 * THE BOUNDED REBUILD OF ONE GENERATION: the chain-free, chunked counterpart of
 * `IndexerGeneration.followMore`.
 *
 * That one is a single unbounded advance driven by an engine that owns a
 * provider; this one is a slice at a time, over a stream read through a port, on
 * a runtime that has no chain at all. The RULES are shared and not restated:
 * where a fold resumes is `getFromBlock`, what a stored stream becomes is
 * `generateStreamFromReplay`, and what the raw rows decode to is
 * `LogEventFetcher.reparse`.
 *
 * **It holds no position between calls, on purpose.** Everything it needs is
 * read at the top of `more()` from the processor's persisted cursor, so a fresh
 * object graph -- a new process, a new isolate, a new container over the same
 * database -- resumes exactly where the last committed chunk left off. A field
 * remembering the last chunk would be the one thing a kill between two chunks
 * could lose.
 */
export class GenerationRebuild<ABI extends Abi, ProcessResultType = unknown> {
	/** The earliest block this source can have anything to say about. */
	readonly defaultFromBlock: number;
	/** WHICH stream is folded, and the key every read of it carries. */
	readonly stream: string;

	private readonly streamConfig: UsedStreamConfig;
	private readonly finality: number;
	private readonly replay: ReplaySource<ABI>;
	private readonly maxEmissions: number;
	private readonly feedBatchSize: number;
	private readonly context: WireContext;
	private readonly decoder: LogEventFetcher<ABI>;

	constructor(
		private readonly processor: EventProcessor<ABI, ProcessResultType>,
		private readonly source: IndexingSource<ABI>,
		options: GenerationRebuildOptions<ABI>,
	) {
		this.stream = options.stream;
		this.streamConfig = options.streamConfig;
		this.finality = options.streamConfig.finality;
		this.replay = options.replay;
		this.maxEmissions = budgetOf(options.maxEmissions);
		this.feedBatchSize = options.feedBatchSize ?? DEFAULT_FEED_BATCH_SIZE;
		this.defaultFromBlock = defaultFromBlockOf(source);
		// The same identity `StreamBuilder` writes onto a cursor on this runtime, so
		// the cursor this rebuild persists and the one a receiver persists describe
		// their contexts the same way.
		this.context = wireContextOf(source, options.streamConfig);
		this.decoder = new LogEventFetcher<ABI>(NEVER_FETCHES, source.contracts, options.fetch, options.streamConfig.parse);
	}

	/** WHICH generation this rebuilds: the stream above, plus the fold over it. */
	get generation(): GenerationId {
		return {stream: this.stream, processor: this.processor.getVersionHash()};
	}

	/**
	 * ONE CHUNK: resume from the durable checkpoint, replay a bounded slice, and
	 * report.
	 *
	 * The order is the whole of the resumability guarantee. The checkpoint is READ
	 * first, from the store, so nothing in this process decides where to resume.
	 * The slice is then applied through `process`, which writes the state and the
	 * cursor describing it in ONE transaction (ADR-0027), so the call either
	 * advanced both or neither. Nothing is written here afterwards: there is no
	 * second durable value that a crash could leave disagreeing with the state.
	 *
	 * Nothing is CLEARED on any branch, unlike the load path, and for the reason
	 * `readOnlyStream` gives: this generation owns neither the stream it reads nor
	 * the cursor of whatever else wrote into a namespace it can see. An absent or
	 * unreadable stream costs one idle call and the next one asks again.
	 */
	async more(options?: {maxEmissions?: number}): Promise<RebuildReport> {
		const generation = this.generation;
		const budget = options?.maxEmissions === undefined ? this.maxEmissions : budgetOf(options.maxEmissions);

		const lastSync = await this.checkpoint();
		const fromBlock = getFromBlock(lastSync, this.defaultFromBlock, this.finality);

		const chunk = await this.replay.readChunk({
			stream: this.stream,
			fromBlock,
			foldedThrough: lastSync.lastToBlock,
			maxEmissions: budget,
		});
		if (chunk.status !== 'chunk') {
			const stopped = stopFor(chunk);
			const idle = {
				generation,
				fromBlock,
				toBlock: undefined,
				scanned: 0,
				replayed: 0,
				retracted: 0,
				highWater: 0,
				complete: false,
				stopped,
			} as const;
			if (retryCanAdvance(stopped)) {
				namedLogger.info(
					`the rebuild of {stream: ${generation.stream}, processor: ${generation.processor}} found no stored ` +
						`stream to replay from block ${fromBlock}. Nothing is cleared and nothing advances; the next call ` +
						`asks again.`,
				);
			} else {
				// LOUD, because this one does not clear itself: the resume point comes from
				// this fold's own durable checkpoint, so every later call reads the same
				// answer. A host looping on `complete === false` would poll for ever.
				namedLogger.error(
					`the rebuild of {stream: ${generation.stream}, processor: ${generation.processor}} cannot advance from ` +
						`block ${fromBlock}: ${describe(stopped)}. Calling again will not change this -- it needs a stream ` +
						`that reaches further back, a lower resume point, or a re-index.`,
				);
			}
			return idle;
		}

		// Re-decoded on the way through, exactly as every other replay path does:
		// the stored rows are the raw log the node reported, and `args` / `eventName`
		// are what SOME ABI made of those bytes (ADR-0034).
		const replayable = this.decoder.reparse(chunk.eventStream);
		if (!replayable) {
			namedLogger.error(
				`the stored stream ${this.stream} holds an emission with no raw log to decode, so this chunk cannot be ` +
					`replayed on trust. Nothing was folded and nothing was deleted: this generation does not own these rows.`,
			);
			return {
				generation,
				fromBlock,
				toBlock: undefined,
				scanned: chunk.eventStream.length,
				replayed: 0,
				retracted: 0,
				highWater: chunk.highWater,
				complete: false,
				// the same rows are read again next call, so this recurs identically
				stopped: {reason: 'undecodable'},
			};
		}

		// REPLAY and not feed: these rows carry their own verdicts (ADR-0042), and a
		// rebuild has no fetch window to derive them from. The window is rebuilt by
		// WALKING the slice, which is also what de-duplicates the part of it this fold
		// has already applied.
		const {eventStream, newLastSync} = generateStreamFromReplay(lastSync, this.defaultFromBlock, replayable, {
			newLatestBlock: chunk.latestBlock,
			newLastFromBlock: chunk.lastFromBlock,
			newLastToBlock: chunk.lastToBlock,
			finality: this.finality,
		});

		// The state and the CHECKPOINT, committed together by the store (ADR-0027), one
		// delivery batch at a time. The CUT is the engine's own
		// (`batchStreamForDelivery`) and not a second one: a replayed stream can carry an
		// application, its retraction and the replacement at ONE block, and handing all
		// three to one `process()` call would revert to the fork and then apply two
		// blocks at the same height.
		const batches = batchStreamForDelivery(eventStream, newLastSync, this.feedBatchSize);
		for (const batch of batches) {
			await this.processor.process(batch.events, batch.lastSync);
		}
		if (batches.length === 0) {
			// A slice that carried nothing this fold had not already applied. The CURSOR
			// still has to move, or the next call would read the same slice for ever --
			// which is exactly what an empty save writes on the keeper side (ADR-0035).
			await this.processor.process([], newLastSync);
		}

		return {
			generation,
			fromBlock,
			toBlock: chunk.lastToBlock,
			scanned: chunk.eventStream.length,
			replayed: eventStream.length,
			retracted: eventStream.filter((event) => event.removed).length,
			highWater: chunk.highWater,
			complete: !chunk.truncated,
			stopped: chunk.truncated ? {reason: 'budget'} : {reason: 'stream-consumed'},
		};
	}

	/**
	 * THE DURABLE CHECKPOINT, read back: this generation's own persisted cursor.
	 *
	 * A cursor that is not this fold's is left exactly where it is and NOT cleared,
	 * which is the one difference from `StreamBuilder.currentLastSync`. There the
	 * discard is the only honest thing a receiver holding a single store can do;
	 * here a generation's state is its own table namespace (ADR-0053), so a foreign
	 * cursor is a neighbour's and deleting it would be reaching into another
	 * generation's state -- the very thing the whole model exists to stop.
	 */
	private async checkpoint(): Promise<LastSync<ABI>> {
		const processorHash = this.processor.getVersionHash();
		const loaded = await this.processor.load(this.source, this.streamConfig);
		if (loaded) {
			const {lastSync} = loaded;
			if (
				processorHash === lastSync.context.processor &&
				stateMatches(this.context.source, this.context.config, lastSync.lastToBlock, lastSync.context)
			) {
				return lastSync;
			}
			namedLogger.info(
				`the persisted cursor at this generation's store was written by another fold, so the rebuild of ` +
					`{stream: ${this.stream}, processor: ${processorHash}} starts from scratch. Nothing was cleared: a ` +
					`generation's state is its own namespace (ADR-0053), so this cursor is somebody else's.`,
			);
		}
		return {
			context: {
				source: this.context.source,
				config: this.context.config,
				processor: processorHash,
				processorFingerprint: this.processor.getCodeFingerprint(),
			},
			lastToBlock: 0,
			lastFromBlock: 0,
			latestBlock: 0,
			unconfirmedBlocks: [],
		};
	}
}

/**
 * Validate the budget, in the words every bounded verb in this repo uses.
 *
 * Zero is refused rather than read as "do nothing": a caller that computed a
 * budget of zero computed it wrongly, and a silent no-op would leave a rebuild
 * running on schedule for ever without moving.
 */
function budgetOf(maxEmissions: number | undefined): number {
	if (maxEmissions === undefined) return DEFAULT_MAX_EMISSIONS_PER_CHUNK;
	if (!Number.isInteger(maxEmissions) || maxEmissions < 1) {
		throw new Error(
			`invalid rebuild budget: ${JSON.stringify(maxEmissions)}. maxEmissions is a whole number of stored ` +
				`EMISSIONS one call may replay, at least 1; leave it unset for ${DEFAULT_MAX_EMISSIONS_PER_CHUNK}. It is a ` +
				`budget rather than a bound: a single block carrying more than this is replayed whole, because a chunk ` +
				`that ended mid-block would leave rows below its own resume point.`,
		);
	}
	return maxEmissions;
}
