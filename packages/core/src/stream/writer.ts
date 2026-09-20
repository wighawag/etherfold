import type {Abi} from 'abitype';
import {logs} from 'named-logs';

import type {EmissionAppender} from '../emissionStream.js';
import {StreamHoleError, WireContextMismatchError} from '../errors.js';
import {
	defaultFromBlockOf,
	generateStreamToAppend,
	getFromBlock,
	resolveStreamConfig,
	sameWireContext,
	windowOfStoredStream,
	wireContextOf,
	type ReorgDetection,
} from '../internal/engine/utils.js';
import type {ReorgRecorder} from '../reorgCounters.js';
import {assertWellFormed, type IngestionResult, type LogIngestion} from '../streamBuilder.js';
import {streamDigestOf} from '../stream/identity.js';
import type {
	IndexingSource,
	LastSync,
	LogEvent,
	ProvidedStreamConfig,
	StoredLogEvent,
	UsedStreamConfig,
	WireBatch,
	WireContext,
} from '../types.js';

const namedLogger = logs('@etherfold/core');

/* ---------------------------------------------------------------------------
 * WHOEVER FETCHES A STREAM IS THE THING THAT APPENDS TO IT (ADR-0087)
 *
 * A stored stream has exactly ONE writer, and this is it. It is not a
 * generation: the DEPLOYMENT fetches a stream and appends to it, and every
 * generation merely READS it.
 *
 * ## What this replaces, and why the shape it replaces could not be repaired
 *
 * The append used to be a side effect of a GENERATION advancing: the container
 * handed the emission appender to whichever fold `writerOf` ELECTED by
 * registration order, and that fold's own cursor answered `expectedFromBlock`.
 * Both halves were wrong in the same way.
 *
 * The ELECTION named a generation that the process may hold no fold for -- the
 * ordinary restart with a changed processor, where the incumbent's code is not
 * in the build -- so the duty belonged to something absent and nothing appended
 * while a present fold folded happily. Handing the duty to the fold that IS
 * present stores the history a SECOND time (measured: 4 rows where 2 are
 * correct), because that fold's state is empty and it asks from
 * `defaultFromBlock`. Nor can the hand-over be timed: a reconciliation once per
 * cycle sees the fold BELOW the coverage and then ABOVE it and never ON it, and
 * handing over below duplicates while handing over above leaves a HOLE.
 *
 * There is no observation point that is neither, so the duty comes off the
 * generation entirely. The POSITION then has one honest source: the STREAM's own
 * stored coverage claim. An empty-state successor cannot drag it backwards,
 * because nothing about a fold is consulted at all.
 *
 * ## The two numbers, and where they come from now
 *
 * ADR-0038 made the ENGINE the arbiter of whether an append is safe, "the only
 * place that holds both numbers". The arbiter MOVES WITH THE DUTY: both numbers
 * belong to whoever fetches. `streamLastToBlock` is the coverage claim read
 * straight back through `StreamCursorSource`, and the window the retractions are
 * derived against is WALKED out of the stream's own tail
 * (`windowOfStoredStream`) rather than borrowed from a fold. So a generation's
 * state is a function of the stream BY CONSTRUCTION, which is ADR-0044's central
 * rule made structural instead of defended.
 *
 * ## It DELIVERS what it appended, and that is not a hand-over
 *
 * After the append -- which happened unconditionally, positioned from the stream,
 * before any fold was consulted -- the delta is offered to every fold on this
 * stream. A fold LEVEL with the stream applies it; one that is behind takes the
 * offer as a no-op and is carried by its own bounded rebuild instead. Nothing
 * about which fold is present, or whether one is, changes what was WRITTEN. That
 * is the whole difference from the rejected hand-over.
 * ------------------------------------------------------------------------- */

/**
 * THE STREAM'S OWN POSITION, as the substrate that stores it hands it back.
 *
 * The three block numbers of the coverage claim (ADR-0055) plus the TAIL of the
 * stored rows, which is what the unconfirmed window is walked out of. Absent
 * entirely where nothing has ever been stored under this stream -- which is the
 * documented ABSENCE of a stream and never an unknown position.
 */
export type StreamCursorRead = {
	/** The chain tip as it stood when the last batch was stored. */
	readonly latestBlock: number;
	/** The first block of the range that last batch covered. */
	readonly lastFromBlock: number;
	/** The last block this stream is claimed to cover. */
	readonly lastToBlock: number;
	/**
	 * Every stored emission at or above `lastToBlock - finality`, in `seq` order,
	 * retractions INCLUDED at their original block.
	 *
	 * The window is not stored by anybody (ADR-0035 as amended), so it is rebuilt by
	 * WALKING these rows. Reading only the tail is what keeps that cheap: a window
	 * reaches back `finality` blocks and no further, so nothing below that bound can
	 * be in it.
	 */
	readonly tail: readonly StoredLogEvent[];
};

/**
 * WHERE THE STREAM'S OWN POSITION IS READ.
 *
 * A PORT, implemented by whoever owns the storage (`streamCursorSourceOn`,
 * `@etherfold/server`), because this package knows no database. It is the READ
 * counterpart of `EmissionAppender`, and the two are supplied together: a
 * deployment that can append to a stream is exactly one that can read back how
 * far it reaches.
 *
 * It is deliberately NOT `ReplaySource`. That one is a FOLD's bounded read of a
 * stream it is catching up on, and it answers verdicts about reach-back that
 * belong to a fold's resume point; this is the writer asking where its own
 * stream ends.
 */
export type StreamCursorSource = {
	/** The stream's position and the tail its window is walked out of, or nothing where no stream is stored. */
	readStreamCursor(query: {stream: string; finality: number}): Promise<StreamCursorRead | undefined>;
};

/** WHAT ONE APPEND DID, offered to a fold that may or may not be level with it. */
export type StreamDelta<ABI extends Abi> = {
	/** WHICH stream, as `streamDigestOf` renders it. */
	readonly stream: string;
	/** What the fetch concluded, in order: applications and retractions together, verdicts included. */
	readonly eventStream: LogEvent<ABI>[];
	/** The stream's position once this batch is in. */
	readonly lastSync: LastSync<ABI>;
};

/** What a stream writer is built with: the stream's two ends, and where a reorg is counted. */
export type StreamWriterOptions<ABI extends Abi> = {
	/** The stream config this stream is identified under. Resolved here, as every other holder resolves it. */
	stream?: ProvidedStreamConfig;
	/** Where the stream's own position is read. Required: this is what replaces a fold's cursor. */
	cursor: StreamCursorSource;
	/** Where the stream is STORED (ADR-0052). Required: a writer that cannot write is not one. */
	appendEmissions: EmissionAppender;
	/** Where a concluded reorg is counted (ADR-0050). Absent on a host with nowhere to write one. */
	recordReorg?: ReorgRecorder;
	/**
	 * WHO IS OFFERED what was just appended.
	 *
	 * Called AFTER the append, so nothing about the folds present can change what was
	 * stored. A fold that is not level with the delta declines it and is carried by
	 * its own rebuild; see the module JSDoc for why that is not the rejected
	 * hand-over.
	 */
	deliver?: (delta: StreamDelta<ABI>) => Promise<void>;
};

/**
 * THE ONE WRITER OF ONE STREAM: it answers where the next range must start, and
 * it appends what comes back.
 *
 * It implements `LogIngestion`, so it is addressable on the wire exactly as a
 * receiver was -- a stream is ONE address (`{source, config}`) and this is what
 * that address now resolves to. What it does NOT carry is a `generation`: a
 * stream address has no single fold behind it any more, which is the whole
 * point, so the field is absent rather than filled in with whichever fold
 * happened to be first.
 */
export class StreamWriter<ABI extends Abi> implements LogIngestion {
	/** The earliest block this source can have anything to say about. */
	readonly defaultFromBlock: number;
	/** The resolved stream config, which is what `config` in the context hashes. */
	readonly streamConfig: UsedStreamConfig;
	/** The `{source, config}` a sender must assert to be talking to this writer. */
	readonly context: WireContext;
	/** WHICH stream this writes, as everything that stores its emissions keys them. */
	readonly streamDigest: string;

	private readonly finality: number;
	private readonly cursor: StreamCursorSource;
	private readonly appendEmissions: EmissionAppender;
	private readonly recordReorg: ReorgRecorder | undefined;
	private readonly deliver: ((delta: StreamDelta<ABI>) => Promise<void>) | undefined;

	constructor(
		private readonly source: IndexingSource<ABI>,
		options: StreamWriterOptions<ABI>,
	) {
		// The RESOLVED config and never the provided one, for the reason every other
		// holder resolves it: an unset `finality` and the default written out have to be
		// ONE stream here exactly as they are one config everywhere else.
		this.streamConfig = resolveStreamConfig(options.stream);
		this.finality = this.streamConfig.finality;
		this.defaultFromBlock = defaultFromBlockOf(source);
		this.context = wireContextOf(source, this.streamConfig);
		this.streamDigest = streamDigestOf(source, this.streamConfig);
		this.cursor = options.cursor;
		this.appendEmissions = options.appendEmissions;
		this.recordReorg = options.recordReorg;
		this.deliver = options.deliver;
	}

	/**
	 * Where the next batch must start -- read from the STREAM and from no fold.
	 *
	 * It is NOT `lastToBlock + 1`: it reaches back to `latestBlock - finality` so the
	 * unconfirmed window is re-delivered every round, which is the only way a reorg
	 * is ever detected. That rule is `getFromBlock`'s and is shared with every other
	 * thing that resumes; what moved is WHOSE three numbers it is applied to.
	 *
	 * This is the line the whole change turns on. Answered from a fold's cursor, a
	 * restarted deployment with an empty-state successor asks for history the stream
	 * already holds and stores it a second time; answered from the stream, there is
	 * nothing about any fold that could drag it backwards.
	 *
	 * Reading this WRITES NOTHING. A receiver's read used to register a generation
	 * and could clear a foreign cursor; a stream has no fold to reconcile.
	 */
	async expectedFromBlock(): Promise<number> {
		return getFromBlock(await this.streamLastSync(), this.defaultFromBlock, this.finality);
	}

	/**
	 * Append one batch to the stream, or refuse it having appended nothing.
	 *
	 * The order is the same one `StreamBuilder.receive` established and it is still
	 * load-bearing: identity first (a batch for another source must never be told to
	 * resume from a block number that means nothing to it), then the envelope, then
	 * the cursor -- which is `generateStreamToAppend`'s own check, so the engine and
	 * not a second opinion beside it.
	 *
	 * The APPEND is not best-effort and nothing catches it: a state that advanced
	 * past events the stream never received is a HOLE, so a batch that could not be
	 * stored is not delivered to anybody. The failure propagates, no fold sees it,
	 * the stream's position does not move, and the next cycle re-derives exactly this
	 * delta.
	 */
	async receive(batch: WireBatch<ABI>): Promise<IngestionResult<ABI>> {
		this.assertContext(batch.context);
		assertWellFormed(batch);

		const stored = await this.cursor.readStreamCursor({stream: this.streamDigest, finality: this.finality});
		const lastSync = this.lastSyncOf(stored);
		const {eventStream, newLastSync, reorg} = generateStreamToAppend(lastSync, this.defaultFromBlock, batch.logs, {
			newLatestBlock: batch.latestBlock,
			newLastFromBlock: batch.fromBlock,
			newLastToBlock: batch.toBlock,
			finality: this.finality,
		});

		await this.storeStream(stored, eventStream, newLastSync);

		if (reorg) {
			// ONCE per concluded revert, and here because this is the one place every
			// deployment shape passes through exactly once now that the derivation is the
			// writer's (ADR-0050). A fold re-folding the stored stream replays the verdicts
			// this concluded and must not count them again.
			await this.noteReorg(reorg);
		}

		// AFTER the append, and only ever an OFFER: what was written is already
		// decided, so a fold that is behind simply declines and its rebuild carries it.
		await this.deliver?.({stream: this.streamDigest, eventStream, lastSync: newLastSync});

		return {
			applied: eventStream.filter((event) => !event.removed).length,
			retracted: eventStream.filter((event) => event.removed).length,
			emissions: eventStream,
			lastSync: newLastSync,
			expectedFromBlock: getFromBlock(newLastSync, this.defaultFromBlock, this.finality),
			reorg,
		};
	}

	// -- internals -----------------------------------------------------------

	/** The stream's own cursor, read back. */
	private async streamLastSync(): Promise<LastSync<ABI>> {
		return this.lastSyncOf(await this.cursor.readStreamCursor({stream: this.streamDigest, finality: this.finality}));
	}

	/**
	 * The stored position as a cursor the engine speaks, with the window WALKED out
	 * of the stream's own tail.
	 *
	 * The `processor` half of the context is deliberately EMPTY: a stream has no
	 * fold, so there is nothing honest to put there, which is exactly what
	 * `storedEmissionStream` already records about the same rows. Nothing on this
	 * path reads it -- `generateStreamToAppend` carries the context through
	 * untouched.
	 */
	private lastSyncOf(stored: StreamCursorRead | undefined): LastSync<ABI> {
		if (!stored) {
			return {
				context: {source: this.context.source, config: this.context.config, processor: ''},
				latestBlock: 0,
				lastFromBlock: 0,
				lastToBlock: 0,
				unconfirmedBlocks: [],
			};
		}
		return {
			context: {source: this.context.source, config: this.context.config, processor: ''},
			latestBlock: stored.latestBlock,
			lastFromBlock: stored.lastFromBlock,
			lastToBlock: stored.lastToBlock,
			unconfirmedBlocks: windowOfStoredStream(
				stored.tail as unknown as LogEvent<ABI>[],
				stored.lastToBlock,
				this.finality,
			),
		};
	}

	/**
	 * Hand this batch to whoever stores the stream, having first refused to punch a
	 * HOLE in it.
	 *
	 * ## The guard, and why it belongs here rather than on `streamCanReceive`
	 *
	 * ADR-0087's amendment corrects its own attribution: the duplicate it measured
	 * went through an append-only `EmissionAppender`, which reads nothing back and
	 * had no hole guard of ANY kind, while `streamCanReceive` sits over a stream the
	 * load path always reads first. So the guard belongs with whoever moves the write
	 * duty, which is this. See `StreamHoleError`.
	 *
	 * An ABSENT stream is PERMISSIVE, which is the same correction that amendment
	 * makes about `streamLastToBlock === undefined`: no stored stream is the
	 * documented ABSENCE of one, nothing constrains the next write, and refusing
	 * there would decline the first save of every fresh deployment.
	 *
	 * An EMPTY batch is still handed over, because the `coverage` claim moved: a
	 * range that carried no logs moves the stream's reach without adding a row, and
	 * nothing else can say that it did.
	 */
	private async storeStream(
		stored: StreamCursorRead | undefined,
		emissions: LogEvent<ABI>[],
		newLastSync: LastSync<ABI>,
	): Promise<void> {
		if (stored && newLastSync.lastFromBlock > stored.lastToBlock + 1) {
			throw new StreamHoleError(this.streamDigest, stored.lastToBlock, newLastSync.lastFromBlock);
		}
		await this.appendEmissions({
			stream: this.streamDigest,
			coverage: {
				source: this.context.source,
				config: this.context.config,
				latestBlock: newLastSync.latestBlock,
				lastFromBlock: newLastSync.lastFromBlock,
				lastToBlock: newLastSync.lastToBlock,
			},
			emissions,
		});
	}

	/**
	 * Say what was reverted, and count it if this deployment gave us somewhere to.
	 *
	 * Best-effort by design and AFTER the append, which is the same asymmetry
	 * `StreamBuilder` had between its two ports: a lost count is a number, and
	 * failing the batch that earned it would tell a sender to re-send a range that
	 * was in fact stored.
	 */
	private async noteReorg(reorg: ReorgDetection): Promise<void> {
		if (reorg.cause === 'absence') {
			namedLogger.error(
				`reverted the stream ${this.streamDigest} from an ABSENCE at block ${reorg.blockNumber} ` +
					`(${reorg.blockHash}). Absence is an inference, not proof: it is indistinguishable from a sender that ` +
					`under-delivered the range. A rising rate of these means truncation or misconfiguration.`,
				reorg,
			);
		} else {
			namedLogger.info(
				`reverted the stream ${this.streamDigest} from a hash contradiction at block ${reorg.blockNumber}`,
				reorg,
			);
		}
		if (!this.recordReorg) return;
		try {
			await this.recordReorg(reorg);
		} catch (err) {
			namedLogger.error(`could not record the reorg counter: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private assertContext(received: WireContext | undefined): void {
		if (!sameWireContext(this.context, received)) {
			throw new WireContextMismatchError(this.context, received as WireContext);
		}
	}
}
