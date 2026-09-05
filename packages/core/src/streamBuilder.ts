import type {Abi} from 'abitype';
import {logs} from 'named-logs';
import {InvalidBatchError, WireContextMismatchError} from './errors.js';
import {
	assertAscendingByBlock,
	defaultFromBlockOf,
	generateStreamToAppend,
	getFromBlock,
	stateMatches,
	resolveStreamConfig,
	sameWireContext,
	wireContextOf,
	type ReorgDetection,
} from './internal/engine/utils.js';
import type {EmissionAppender} from './emissionStream.js';
import type {GenerationId} from './generation/registry.js';
import type {ReorgRecorder} from './reorgCounters.js';
import {streamDigestOf} from './stream/identity.js';
import type {
	EmittedLog,
	EventProcessor,
	IndexingSource,
	LastSync,
	ProvidedIndexerConfig,
	UntypedWireBatch,
	UsedStreamConfig,
	WireBatch,
	WireContext,
} from './types.js';
import {taggedBnReplacer, taggedBnReviver} from './utils/bigint.js';

const namedLogger = logs('@etherfold/core');

/**
 * What one accepted batch did, in the terms a HOST can act on.
 *
 * `expectedFromBlock` is where the NEXT one must start, handed back so an
 * acknowledged sender needs no second round-trip to ask.
 */
export type IngestionOutcome = {
	/** Events handed to the processor as canonical. */
	applied: number;
	/** Events handed to the processor as retractions, derived here and by nobody else. */
	retracted: number;
	/**
	 * The EMISSION STREAM this batch produced, in order: what was applied and what
	 * was taken back, retractions carrying their ORIGINAL block.
	 *
	 * Reported for the same reason `reorg` is, and with the same discipline: a host
	 * that reads this must not re-derive it, because a second derivation is a
	 * second answer, and the one thing this receiver is authoritative about is what
	 * the fold concluded. The counts above are this list partitioned on `removed`,
	 * kept because a caller that only reports progress should not have to walk it.
	 *
	 * It is REPORTED and no longer the only way a host can store the stream: the
	 * append is a port on this receiver (`EmissionAppender`, ADR-0052), taken once
	 * per batch and before the fold, so a caller that stored this list itself would
	 * store the shape that already went to disk a second time.
	 *
	 * Untyped in the ABI (`EmittedLog`), because a host that stores logs is not a
	 * host that decodes them.
	 */
	emissions: EmittedLog[];
	/** Where the next batch must start. */
	expectedFromBlock: number;
	/**
	 * Present only when this batch concluded a reorg; `cause` says HOW it was
	 * concluded.
	 *
	 * REPORTED, never delegated. A caller reads it to log, to answer a sender or
	 * to decide what to do next; it is NOT how the revert gets counted, and a
	 * caller that counted from it would count only on the shape it happens to be.
	 * The count is taken once, inside `receive`, through the injected
	 * `ReorgRecorder` (ADR-0050).
	 */
	reorg?: ReorgDetection;
};

/** The outcome plus the cursor itself, which only an ABI-aware caller can read. */
export type IngestionResult<ABI extends Abi> = IngestionOutcome & {lastSync: LastSync<ABI>};

/**
 * The receiving side of the wire, as everything above it needs to see it.
 *
 * A host (an HTTP route, a queue consumer, a test) needs exactly three things
 * from the stream-builder: the identity it indexes, where the next batch must
 * start, and a way to hand one over. Typing that as an INTERFACE rather than as
 * the class is what keeps `@etherfold/server` free of an ABI type parameter: the
 * server never inspects a log, so it has no business being generic over the ABI
 * of the processor it hosts.
 */
export type LogIngestion = {
	readonly context: WireContext;
	/**
	 * WHICH STREAM this receiver folds, as `streamDigestOf` renders it, and the
	 * value anything storing its emissions keys them on.
	 *
	 * Deliberately NOT `context`. The wire identity is a CHANGE DETECTOR between
	 * two halves of one deployment: its source half is 32-bit `simple_hash` per
	 * entry over the whole entry, kept that way on purpose (ADR-0034), so it moves
	 * on a decode-only change the fetch filter never saw. Keyed on it, a
	 * regenerated ABI would orphan every row already stored -- and 32 bits is ruled
	 * out as a KEY anyway, because a collision there is one indexer adopting
	 * another's logs. This is the wide digest over the fetch filter plus the stream
	 * config, and it is the same value the browser addresses a stream by
	 * (ADR-0035), so one stream has one name everywhere.
	 */
	readonly streamDigest: string;
	/**
	 * WHICH GENERATION this receiver is: the stream above, plus the fold over it.
	 *
	 * Here because the processor is the one thing a host CANNOT see -- it hands one
	 * over at construction and then holds an interface that never mentions it again
	 * -- while a host is exactly who has to report the answer's identity outward
	 * (`@etherfold/server` advertises it on every feed response, so a consumer can
	 * notice that the fold behind the feed changed; no cursor check can, because
	 * the stream did not move).
	 *
	 * DERIVED on every read, never a snapshot: `getVersionHash()` covers the
	 * processor's configuration as well as its version, and `configure()` can move
	 * it after construction. A field captured once would then advertise a fold that
	 * is no longer running, which is worse than not advertising at all. Its `stream`
	 * half is `streamDigest` itself, so the two can never disagree.
	 */
	readonly generation: GenerationId;
	expectedFromBlock(): Promise<number>;
	receive(batch: UntypedWireBatch): Promise<IngestionOutcome>;
};

/**
 * What a receiver is built with: the stream configuration half of the wire
 * identity, plus the one collaborator a receiver has that is not the processor.
 *
 * `stream` is HASHED into `context` and the two PORTS deliberately are not:
 * where a count and a stream are written down is a deployment's business, and a
 * receiver that hashed either would refuse every batch from a sender configured
 * identically but wired to a different database.
 */
export type StreamBuilderOptions<ABI extends Abi> = Pick<ProvidedIndexerConfig<ABI>, 'stream'> & {
	/**
	 * Where a concluded reorg is counted, supplied by whoever owns the store
	 * (ADR-0050). Absent on a host with nowhere to write, and then nothing is
	 * counted and nothing else changes.
	 */
	recordReorg?: ReorgRecorder;
	/**
	 * Where the emission stream is STORED, supplied by whoever owns the store
	 * (ADR-0052), closed over the NAMED INDEXER that host holds.
	 *
	 * The SIBLING of `recordReorg` and not its twin: this one runs BEFORE the fold
	 * and its failure REFUSES the batch, because a lost count is a number and a
	 * lost emission is a hole. Absent on a host that stores no stream, and then
	 * nothing is stored and nothing else changes.
	 */
	appendEmissions?: EmissionAppender;
};

/**
 * The STREAM-BUILDER of ADR-0003, and the receiving half of the wire contract of
 * ADR-0004.
 *
 * It takes contiguous ranges of raw logs from a stateless log-fetcher, derives
 * every retraction itself, drives an `EventProcessor`, and is authoritative
 * about where the next range must start. It makes NO chain calls, which is the
 * whole reason it is a separate object from `IndexerGeneration`: that class opens
 * `load()` with `eth_chainId`, so the half of a split deployment that hosts the
 * processor cannot use it (recorded in
 * `work/notes/observations/indexer-load-needs-a-chain-so-the-server-half-cannot-call-it.md`).
 *
 * ## Why the cursor is read on every call and never cached
 *
 * The intended host is serverless: several isolates may serve the same database,
 * and an instance can be created and destroyed between two batches. An
 * in-memory cursor would be one instance's private opinion of a value the
 * DATABASE owns, and two instances would disagree the moment either of them
 * moved it. So `expectedFromBlock()` and `receive()` both read the persisted
 * cursor through `processor.load()` first. That costs a read per batch and buys
 * the property the design is built on: the cursor a sender is told is the cursor
 * the state actually has.
 *
 * ## The three identities, and who checks which
 *
 * - `source` and `config` are asserted by the SENDER, on every batch, and
 *   checked here against what this receiver indexes (`WireContextMismatchError`).
 * - `processor` cannot be asserted by the sender at all, so it is checked
 *   against the PERSISTED cursor instead: a cursor written by another processor
 *   version, or for another source, is state that means something else, and it
 *   is discarded (`processor.clear()`) rather than resumed on top of. That is
 *   the hole `docs/reviews/todo-triage.md` found in every persistence layer.
 *
 * ## What it deliberately does not do
 *
 * It does not batch a large stream into several `process()` calls the way
 * `IndexerGeneration.feed` does. A batch is one HTTP request and the sender chose
 * its size; splitting it here would add a second place where a partially-applied
 * range is possible, and the processor already applies block by block
 * atomically.
 *
 * ## The two things it hands OUT, and the one it must not lose
 *
 * It knows no database, so both durable facts a fold concludes leave through a
 * PORT the store's owner supplies: the reorg COUNT (`recordReorg`, ADR-0050) and
 * the emission STREAM (`appendEmissions`, ADR-0052). Neither is a fact about the
 * transport, so neither may live on an entrance: a combined process folds
 * through `createDirectIngestion` and reaches no route, and putting either write
 * at both entrances would double it on the shape that both concludes and
 * receives.
 *
 * They are ORDERED DIFFERENTLY on purpose, and that is the only asymmetry
 * between them. The count is taken AFTER the batch was applied and its failure
 * is swallowed; the stream is written BEFORE, and its failure refuses the batch.
 * See `noteReorg` and `receive`.
 */
export class StreamBuilder<ABI extends Abi, ProcessResultType = unknown> implements LogIngestion {
	/** The earliest block this source can have anything to say about. */
	readonly defaultFromBlock: number;
	/** The resolved stream config, which is what `config` in the context hashes. */
	readonly streamConfig: UsedStreamConfig;
	/** The `{source, config}` a sender must assert to be talking to this receiver. */
	readonly context: WireContext;
	/** WHICH stream this folds, as everything that stores its emissions keys them. See `LogIngestion`. */
	readonly streamDigest: string;

	/**
	 * WHICH generation this is: the stream it folds, and the fold itself.
	 *
	 * A GETTER rather than a field, so the processor half is read at the moment it
	 * is asked for -- exactly as `currentLastSync` reads it on every call, and for
	 * the same reason: `getVersionHash()` covers the processor's config too, so a
	 * value captured in the constructor can stop being true. See `LogIngestion`.
	 */
	get generation(): GenerationId {
		return {stream: this.streamDigest, processor: this.processor.getVersionHash()};
	}

	private readonly finality: number;
	private readonly recordReorg: ReorgRecorder | undefined;
	private readonly appendEmissions: EmissionAppender | undefined;

	constructor(
		private readonly processor: EventProcessor<ABI, ProcessResultType>,
		private readonly source: IndexingSource<ABI>,
		config: StreamBuilderOptions<ABI> = {},
	) {
		this.recordReorg = config.recordReorg;
		this.appendEmissions = config.appendEmissions;
		// The defaults MUST match `IndexerGeneration`'s and the sending `LogFetcher`'s,
		// because the hash of the resolved config is half the wire identity: a
		// receiver that defaulted `finality` differently would refuse every batch a
		// fetcher sent, naming a config hash neither side can see. Hence the one
		// shared resolver rather than three copies of the same object literal.
		this.streamConfig = resolveStreamConfig(config.stream);
		this.finality = this.streamConfig.finality;
		this.defaultFromBlock = defaultFromBlockOf(source);
		this.context = wireContextOf(source, this.streamConfig);
		// The RESOLVED config again, not the provided one: the digest is what a stored
		// stream is addressed by, so an unset `finality` and the default written out
		// have to be one stream here exactly as they are one config everywhere else.
		this.streamDigest = streamDigestOf(source, this.streamConfig);
	}

	/**
	 * Where the next batch must start.
	 *
	 * It is NOT `lastToBlock + 1`: it reaches back to `latestBlock - finality` so
	 * the unconfirmed window is re-delivered every round, which is the only way a
	 * reorg is ever detected. A sender that computed this itself would be holding
	 * the state that makes it stateless.
	 *
	 * **Reading this can WRITE**, in one case: a persisted cursor belonging to
	 * another source, config or processor version is cleared here rather than
	 * merely ignored (see `currentLastSync`). That is deliberate. The alternative
	 * is answering with a number derived from state this server is about to wipe,
	 * so the read and the following write would disagree. Nothing is lost that was
	 * not already invalid, and the same reconciliation happens on `load()` in the
	 * single-process shape.
	 */
	async expectedFromBlock(): Promise<number> {
		return getFromBlock(await this.currentLastSync(), this.defaultFromBlock, this.finality);
	}

	/**
	 * Apply one batch, or refuse it having applied nothing.
	 *
	 * The order of the three refusals is deliberate. Identity first, because a
	 * batch for another source must never be told to resume from a block number
	 * that means nothing to it. Then the envelope, which is cheap and local. Then
	 * the cursor, which is `generateStreamToAppend`'s own check and therefore the
	 * engine's, not a second one that could disagree with it.
	 */
	async receive(batch: WireBatch<ABI>): Promise<IngestionResult<ABI>> {
		this.assertContext(batch.context);
		assertWellFormed(batch);

		const lastSync = await this.currentLastSync();
		const {eventStream, newLastSync, reorg} = generateStreamToAppend(lastSync, this.defaultFromBlock, batch.logs, {
			newLatestBlock: batch.latestBlock,
			newLastFromBlock: batch.fromBlock,
			newLastToBlock: batch.toBlock,
			finality: this.finality,
		});

		// THE STREAM GOES DOWN FIRST, AND A BATCH THAT COULD NOT BE STORED IS NOT
		// FOLDED. Not the shape the count below has, and deliberately so: a failed
		// count loses a number, while a state that advanced past events the stream
		// never received is a HOLE -- invisible to the gap check, silent, permanent and
		// self-consistent, because on the next state discard the stream replays as
		// though it were whole (`CONTEXT.md`, "hole" versus "gap"; ADR-0038). So there
		// is no try/catch here: the failure propagates, the processor sees nothing, the
		// cursor does not move, and the next cycle re-derives exactly this delta.
		//
		// What this ordering costs, accepted rather than hidden: if the APPEND lands
		// and the FOLD then fails, the stream is one batch AHEAD of the state and the
		// re-derived delta is appended again. The stream may be ahead of the state or
		// level with it, never behind (ADR-0038), so that is the survivable side of the
		// trade and a hole is not.
		await this.storeEmissions(eventStream);

		await this.processor.process(eventStream, newLastSync);

		if (reorg) {
			// ONCE per concluded revert, and HERE rather than in whatever called us. A
			// combined process folds through `createDirectIngestion` and an HTTP one
			// through a route; putting the count at either entrance leaves the other
			// shape blind, and putting it at both double-counts the shape that does both.
			// This is the one place every shape passes through exactly once (ADR-0050).
			await this.noteReorg(reorg);
		}

		return {
			applied: eventStream.filter((event) => !event.removed).length,
			retracted: eventStream.filter((event) => event.removed).length,
			// handed over rather than re-derivable: this is the one place that knows what
			// the fold concluded, and a host storing the stream must not compute a second
			// opinion of it
			emissions: eventStream,
			lastSync: newLastSync,
			expectedFromBlock: getFromBlock(newLastSync, this.defaultFromBlock, this.finality),
			reorg,
		};
	}

	// -- internals -----------------------------------------------------------

	/**
	 * Hand this batch's emissions to whoever stores the stream, and let a refusal
	 * through.
	 *
	 * The one write in this class that is NOT best-effort. It is called before
	 * `processor.process` and it catches nothing, so a store that cannot take the
	 * batch refuses the batch: on the wire that is a `500` and the sender's
	 * ordinary `409` recovery is unaffected (nothing was applied, so the cursor it
	 * is corrected to is the one it already had), and in a combined process the
	 * fetcher's cycle fails and is retried, re-deriving the same delta.
	 *
	 * An EMPTY batch writes nothing: a cycle that emitted no logs still advances the
	 * cursor, and there is nothing about it for a stream to hold.
	 */
	private async storeEmissions(emissions: EmittedLog[]): Promise<void> {
		if (!this.appendEmissions || emissions.length === 0) return;
		await this.appendEmissions({stream: this.streamDigest, emissions});
	}

	/**
	 * Say what was reverted, and count it if this deployment gave us somewhere to.
	 *
	 * AFTER the batch was applied, and best-effort by design -- the opposite of
	 * `storeEmissions` above, on purpose: the state and the cursor already moved
	 * atomically inside the processor, so a failure here loses a count rather than
	 * a block. An operational counter that could roll back the
	 * state it describes -- or fail the request that earned it, telling a sender to
	 * re-send a batch which was in fact applied -- would be a far worse trade. That
	 * guarantee used to belong to the ingest route (`recordReorgSafely`); it is
	 * here now, so every deployment shape has it.
	 *
	 * The log line is here for the same reason the count is: an absence-driven
	 * revert is the one an operator must see, and a combined process has no route
	 * to log it from.
	 */
	private async noteReorg(reorg: ReorgDetection): Promise<void> {
		if (reorg.cause === 'absence') {
			namedLogger.error(
				`reverted state from an ABSENCE at block ${reorg.blockNumber} (${reorg.blockHash}) for ` +
					`${JSON.stringify(this.context)}. Absence is an inference, not proof: it is indistinguishable from a ` +
					`sender that under-delivered the range. A rising rate of these means truncation or misconfiguration.`,
				reorg,
			);
		} else {
			namedLogger.info(`reverted state from a hash contradiction at block ${reorg.blockNumber}`, reorg);
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

	/**
	 * The persisted cursor if it is ours, a fresh one otherwise.
	 *
	 * "Otherwise" is doing real work: a cursor whose context does not match is not
	 * ignored, it is CLEARED, because the state it points at was computed by a
	 * different processor or for a different source and would otherwise be indexed
	 * on top of. This mirrors `IndexerGeneration.promiseToLoad`'s discard branch,
	 * minus the chain calls that branch is wrapped in.
	 */
	private async currentLastSync(): Promise<LastSync<ABI>> {
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
			namedLogger.info(`STATE DISCARDED AS PROCESSOR CHANGED`, {
				context: this.context,
				storedContext: lastSync.context,
				processorHash,
			});
			await this.processor.clear();
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

function isBlockNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * The envelope checks, which are the ones a receiver can make before it knows
 * anything about its own cursor.
 *
 * Separate from `StreamBuilder` because they are a fact about the BATCH and not
 * about this receiver, so a sender-side test and a host that wants to reject
 * early can both reach for them.
 */
export function assertWellFormed<ABI extends Abi>(batch: WireBatch<ABI>): void {
	if (!isBlockNumber(batch.fromBlock) || !isBlockNumber(batch.toBlock) || !isBlockNumber(batch.latestBlock)) {
		throw new InvalidBatchError(
			`a batch's fromBlock, toBlock and latestBlock must be whole non-negative numbers, got ` +
				`{fromBlock: ${batch.fromBlock}, toBlock: ${batch.toBlock}, latestBlock: ${batch.latestBlock}}`,
		);
	}
	if (batch.toBlock < batch.fromBlock) {
		throw new InvalidBatchError(
			`a batch is a contiguous range, but toBlock (${batch.toBlock}) is below fromBlock (${batch.fromBlock})`,
		);
	}
	if (batch.toBlock > batch.latestBlock) {
		throw new InvalidBatchError(
			`a batch cannot cover blocks above the chain tip it reports: toBlock (${batch.toBlock}) > latestBlock (${batch.latestBlock})`,
		);
	}
	if (!Array.isArray(batch.logs)) {
		throw new InvalidBatchError(`a batch must carry a logs array, got ${typeof batch.logs}`);
	}
	assertAscendingByBlock(batch.logs, 'a batch');
	for (const log of batch.logs) {
		if (!isBlockNumber(log?.blockNumber) || log.blockNumber < batch.fromBlock || log.blockNumber > batch.toBlock) {
			throw new InvalidBatchError(
				`a log at block ${log?.blockNumber} is outside the range [${batch.fromBlock}, ${batch.toBlock}] the batch ` +
					`claims to cover. A payload holds every log in its range and nothing else; a truncated fetch is ` +
					`expressed by lowering toBlock.`,
			);
		}
		if (log.removed) {
			throw new InvalidBatchError(
				`a log at block ${log.blockNumber} is marked removed. No reorg information crosses the wire: the ` +
					`receiver derives every retraction, so a sender that ships them holds reorg logic it must not have.`,
			);
		}
	}
}

/**
 * A batch as JSON, with BigInts tagged.
 *
 * The codec is here, next to the envelope, so that both halves of the wire use
 * the same one: a decoded log's `args` hold a BigInt for every `uint256` an ABI
 * declares, `JSON.stringify` throws outright on those, and the `"123n"` suffix
 * convention would revive a contract-emitted string ending in `n` as a number.
 * See `taggedBnReplacer`.
 */
export function serializeWireBatch<ABI extends Abi>(batch: WireBatch<ABI>): string {
	return JSON.stringify(batch, taggedBnReplacer);
}

/** The inverse of `serializeWireBatch`. Shape is NOT validated here; see `assertWellFormed`. */
export function parseWireBatch<ABI extends Abi>(text: string): WireBatch<ABI> {
	return JSON.parse(text, taggedBnReviver) as WireBatch<ABI>;
}
