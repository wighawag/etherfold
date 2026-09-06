import type {Abi} from 'abitype';
import {logs} from 'named-logs';

import type {GenerationContext, GenerationSpec} from './container.js';
import type {EmissionAppender} from './emissionStream.js';
import {
	openGenerationRegistry,
	sameGeneration,
	type GenerationCaps,
	type GenerationId,
	type GenerationRecord,
	type GenerationRegistry,
	type GenerationRegistryPort,
} from './generation/registry.js';
import {resolveStreamConfig} from './internal/engine/utils.js';
import type {ReorgRecorder} from './reorgCounters.js';
import {StreamBuilder, type GenerationContainer} from './streamBuilder.js';
import {streamDigestOf} from './stream/identity.js';
import type {EventProcessor, IndexingSource, ProvidedStreamConfig, UsedStreamConfig} from './types.js';

const namedLogger = logs('@etherfold/core');

/* ---------------------------------------------------------------------------
 * THE GENERATION CONTAINER ON THE RECEIVING SIDE OF THE WIRE: the chain-free
 * SIBLING of `Indexer`.
 *
 * `Indexer` (`container.ts`) holds `IndexerGeneration` engines, and those open
 * `load()` with `eth_chainId` -- which is precisely why the half of a split
 * deployment that hosts the processor uses `StreamBuilder` instead and could
 * never use that container. So the server and the CLI had the generation MODEL
 * available and no way to run it, and a changed context reached
 * `processor.clear()`: the state the canonical generation answers from was
 * DISCARDED, and the deployment served progressively less until it had caught
 * up. That is the outage this module removes.
 *
 * ## What it is
 *
 * For ONE named indexer: the fold this host runs, the durable registry the
 * generations are recorded in, the caps that REFUSE, and the canonical pointer
 * reads resolve through. It builds its generation the way ADR-0043 says one is
 * built -- `createState` then `createProcessor(state)`, per generation -- and
 * REGISTERS it from the processor's own `getVersionHash()`, so nothing declares
 * an identity twice.
 *
 * ## The MODEL is `@etherfold/core`'s already and is consumed UNCHANGED
 *
 * Generation identity, stream identity, the caps and their refusal, the
 * registration-resolves rule and the first-generation-is-canonical rule are all
 * `openGenerationRegistry`'s, and `resolveGeneration` is three lines over it
 * rather than a second copy of any of them. The two factories are `GenerationSpec`'s,
 * reached through a `Pick` (`ReceivedGenerationSpec`) so that this container
 * inherits the ORDER and the keying rule instead of restating them.
 *
 * ## Three rules of the chain-facing container that deliberately do NOT come over
 *
 * 1. **It does not REFUSE a canonical generation it holds no engine for.**
 *    `CanonicalGenerationNotHeldError` is right where reads are answered by a
 *    generation's own processor, because nothing else could answer them. Here
 *    they are not: a generation's state is a TABLE NAMESPACE and the read tier
 *    resolves the canonical pointer to name it (ADR-0053), so the canonical
 *    generation goes on answering with no engine at all -- which is exactly what
 *    happens on the ordinary upgrade, where the host holds only the NEW
 *    processor. Refusing there would turn every upgrade into the outage this
 *    exists to remove.
 * 2. **It holds ONE LIVE WIRE CONTEXT**, so it builds one receiver. A batch is
 *    addressed by `{source, config}` and every generation over one stream asserts
 *    the same pair, so a second receiver here would be a second claim on one
 *    address. Holding several at once is the wire widening a FILTER-change
 *    successor needs (`one-registry-entry-holds-several-live-wire-contexts`), and
 *    it is why `IndexerRegistryEntry` is an entry OBJECT rather than a bare
 *    `LogIngestion`.
 * 3. **It advances nothing but the fold it was given.** How a successor CATCHES
 *    UP is determined by its stream (ADR-0044) and driven by the bounded-chunk
 *    rebuild (`the-rebuild-replays-the-local-stream-in-bounded-chunks`); moving
 *    the pointer is `the-canonical-pointer-moves-back-without-re-ingesting`.
 *    What is here is the CREATION, which is what stops the discard.
 *
 * ## What DOES come over, because ADR-0052 requires it: the ONE-WRITER RULE
 *
 * Only the INDEXING generation writes a stream, and `writerOf` says which one
 * that is -- the OLDEST SURVIVING generation registered on it, registration
 * order and never the canonical pointer (ADR-0044). So the emission appender is
 * handed to the WRITER and to nothing else. Without that, a successor on a
 * shared stream would append what the incumbent already stored, a second time,
 * which is exactly the double-append ADR-0052 names -- and the stream is what
 * every later generation re-folds, so a duplicate there is not an operational
 * blemish, it is a second history.
 *
 * It is DETERMINED and never configured, which is the same rule and the same
 * reasoning as the chain-facing container's `follows`; the value it is derived
 * from is the shared `writerOf`, not a second copy of the rule.
 * ------------------------------------------------------------------------- */

/**
 * HOW THIS RUNTIME BUILDS ONE GENERATION: the state, then the fold over it.
 *
 * The chain-facing container's `GenerationSpec` narrowed to the two factories
 * that mean something on a receiver, and narrowed by a `Pick` rather than
 * restated, so the build ORDER and the "key the state on the generation you are
 * building" rule are inherited from the one place they are written down.
 *
 * The two that are left out are left out because they would be ACCEPTED AND
 * IGNORED here, which this repository does not do:
 *
 * - `stateOf` publishes a read handle to a subscriber, and nothing subscribes to
 *   a receiver: a read tier answers over the database, by resolving the canonical
 *   pointer to a table namespace (ADR-0053).
 * - `source` names a DIFFERENT fetch filter, which is a different stream and
 *   therefore a second live wire context. That is
 *   `one-registry-entry-holds-several-live-wire-contexts`, not this.
 */
export type ReceivedGenerationSpec<ABI extends Abi, ProcessResultType = unknown, State = unknown> = Pick<
	GenerationSpec<ABI, ProcessResultType, State>,
	'createState' | 'createProcessor'
>;

/**
 * THE GENERATION CAPS THIS RUNTIME DEFAULTS TO, and the number is a decision
 * rather than a placeholder.
 *
 * A cap is a COUNT that REFUSES at the bound and never evicts, so the only cost
 * of a generous one is disk and the only cost of a mean one is a refusal an
 * operator has to act on. A server or a CLI should be far more generous than a
 * browser tab (`BROWSER_GENERATION_CAPS`, two of each, because a tab keeps the
 * previous generation only until the successor is promoted), because here the
 * database IS the durable artifact and the retained generation is what the
 * pointer moves BACK to.
 *
 * **Four generations** is the ordinary lifecycle plus headroom: the incumbent,
 * the successor being built beside it, the predecessor kept so the revert stays
 * free after the promotion, and one spare so a routine upgrade never meets the
 * bound as a surprise. **Two streams**, and deliberately NOT four: a generation
 * is a re-fold of a stream that is already stored, while a STREAM is the
 * expensive thing (the raw logs, fetched from a node that may not serve old ones
 * at all), and the case that needs a second one is a filter change whose
 * predecessor's stream is retained until its successor is promoted -- which is
 * the browser's own reasoning, at the same number, for the same resource.
 *
 * It is a DEFAULT and not a policy: a host states its own
 * (`ReceivingIndexerOptions.caps`) and gets the refusal at its own bound.
 */
export const SERVER_GENERATION_CAPS: GenerationCaps = {maxGenerations: 4, maxStreams: 2};

/** What `openReceivingIndexer` needs: where the generations are recorded, what is folded, and how to build it. */
export type ReceivingIndexerOptions<ABI extends Abi, ProcessResultType = unknown, State = unknown> = {
	/**
	 * The SUBSTRATE the generation records live on, NOT an already-opened registry.
	 *
	 * Taken this way round because the CAPS are this container's input:
	 * `openGenerationRegistry` takes them as an argument, so a host that opened the
	 * registry itself would have had to decide them first, in whichever module
	 * happened to build the port -- which is how a bound nobody can see gets chosen
	 * by a substrate. Opening it here also puts the SWEEP (every stream subtree no
	 * registered generation claims) at the moment this container opens, which is
	 * the one moment the known set is authoritative.
	 */
	port: GenerationRegistryPort;
	/**
	 * The bound this indexer may not exceed. Defaults to `SERVER_GENERATION_CAPS`.
	 *
	 * A host SUPPLIES it -- the server from its options, the CLI from its config --
	 * because a cap nobody can set is not a bound, it is a constant.
	 */
	caps?: GenerationCaps;
	/** The fetch filter every generation here folds, which is half the stream identity. */
	source: IndexingSource<ABI>;
	/** The stream config, which is the other half. Resolved once and hashed into both identities. */
	stream?: ProvidedStreamConfig;
	/** The fold THIS host runs: its state, then the processor over it. */
	generation: ReceivedGenerationSpec<ABI, ProcessResultType, State>;
	/** Where a concluded reorg is counted (ADR-0050). Handed to the receiver unchanged. */
	recordReorg?: ReorgRecorder;
	/**
	 * Where the emission stream is stored (ADR-0052).
	 *
	 * Handed to the receiver ONLY when the generation this host folds is the WRITER
	 * of its stream. See `ReceivingIndexer.writesStream`.
	 */
	appendEmissions?: EmissionAppender;
};

/**
 * Open the container: the registry (and its sweep), then the generation, then
 * the receiver wired to both.
 *
 * The generation is REGISTERED here rather than on the first batch, so a cap
 * REFUSES at start-up -- where an operator reads it, naming what could be deleted
 * -- instead of on somebody's ingest. Nothing is written for a refused
 * generation, and nothing partial survives one: `openGenerationRegistry.create`
 * decides inside the substrate's own transaction, and the state factories this
 * runtime uses create no storage until the first write.
 */
export async function openReceivingIndexer<ABI extends Abi, ProcessResultType = unknown, State = unknown>(
	options: ReceivingIndexerOptions<ABI, ProcessResultType, State>,
): Promise<ReceivingIndexer<ABI, ProcessResultType, State>> {
	const registry = await openGenerationRegistry(options.port, options.caps ?? SERVER_GENERATION_CAPS);
	// The RESOLVED config, exactly as `StreamBuilder` resolves it, so the digest
	// this container files a generation under and the digest that receiver stores
	// its emissions under cannot be two different streams.
	const streamConfig = resolveStreamConfig(options.stream);
	const context: GenerationContext = {stream: streamDigestOf(options.source, streamConfig)};

	// STATE FIRST, then the fold over it (ADR-0043). The identity is OBSERVED after
	// both, from the processor's own hash, so nothing declares it twice.
	const state = await options.generation.createState(context);
	const processor = await options.generation.createProcessor(state, context);

	const canonicalBefore = await registry.canonical();
	const record = await registry.create({stream: context.stream, processor: processor.getVersionHash()});
	noteSuccessor(canonicalBefore, record);
	// AFTER the record exists, because the rule reads the records: only the WRITER
	// of a stream may append to it (ADR-0052/ADR-0044), and a generation registered
	// beside an older one on the same stream is not it.
	const writer = await registry.writerOf(context.stream);
	const writesStream = !!writer && sameGeneration(writer, record);
	if (!writesStream) {
		namedLogger.info(
			`the fold {stream: ${record.stream}, processor: ${record.processor}} does NOT write its stream: ` +
				`{stream: ${writer?.stream}, processor: ${writer?.processor}} is the oldest surviving generation on it and ` +
				`is therefore its writer. Nothing this receiver folds is appended, because the stream already holds it and ` +
				`appending it again would be a second history for every generation that re-folds it.`,
		);
	}

	return new ReceivingIndexer<ABI, ProcessResultType, State>(
		registry,
		streamConfig,
		state,
		processor,
		options,
		record,
		writesStream,
	);
}

/** Say out loud that a generation was registered BESIDE the one that answers reads. */
function noteSuccessor(canonicalBefore: GenerationRecord | undefined, record: GenerationRecord): void {
	if (!canonicalBefore || sameGeneration(canonicalBefore, record)) {
		return;
	}
	namedLogger.info(
		`the fold {stream: ${record.stream}, processor: ${record.processor}} is a SUCCESSOR: it was registered BESIDE ` +
			`the canonical generation {stream: ${canonicalBefore.stream}, processor: ${canonicalBefore.processor}}, which ` +
			`keeps its own state and goes on answering every read. Nothing was discarded.`,
	);
}

/**
 * A NAMED INDEXER on the receiving side: several generations, one canonical
 * pointer, one fold running.
 *
 * Built through `openReceivingIndexer`. See the module JSDoc for what it adds
 * over a bare `StreamBuilder` and which of the chain-facing container's rules
 * deliberately do not come over.
 */
export class ReceivingIndexer<
	ABI extends Abi,
	ProcessResultType = unknown,
	State = unknown,
> implements GenerationContainer {
	/** Which generations this indexer holds, which one is canonical, and the caps that refuse. */
	readonly registry: GenerationRegistry;
	/** WHICH STREAM every generation here folds, as `streamDigestOf` renders it. */
	readonly streamDigest: string;
	/** The stream config that digest was taken over, resolved. */
	readonly streamConfig: UsedStreamConfig;
	/** The state THIS generation folds into, as its factory built it. */
	readonly state: State;
	/** The fold this host runs. */
	readonly processor: EventProcessor<ABI, ProcessResultType>;
	/**
	 * THE RECEIVER, and the one live wire context this container holds.
	 *
	 * It is built with this container attached, which is the whole point: a
	 * persisted cursor carrying another fold no longer reaches `processor.clear()`.
	 */
	readonly ingestion: StreamBuilder<ABI, ProcessResultType>;
	/**
	 * Whether this generation is the WRITER of its stream, and therefore the only
	 * one that may append to it (ADR-0052).
	 *
	 * REPORTED and never set, exactly like the chain-facing container's `follows`:
	 * it is a consequence of `writerOf` -- the oldest SURVIVING generation
	 * registered on the stream -- and a caller that could choose it would be
	 * choosing to break the one-writer rule. Resolved when this container opened,
	 * like everything else about its receiver.
	 *
	 * `false` means the emission appender was NOT handed to the receiver, so this
	 * fold stores nothing: the stream it folds is already stored by an older
	 * generation, and every generation re-folds that ONE history.
	 */
	readonly writesStream: boolean;

	/**
	 * What `resolveGeneration` has already answered, so a per-batch cursor read
	 * costs nothing after the first.
	 *
	 * Only SUCCESSES are kept. A cap refusal is not remembered, because the
	 * operator's response to one is to delete a generation, and a remembered
	 * refusal would go on refusing after they had.
	 */
	private readonly records = new Map<string, GenerationRecord>();

	constructor(
		registry: GenerationRegistry,
		streamConfig: UsedStreamConfig,
		state: State,
		processor: EventProcessor<ABI, ProcessResultType>,
		options: ReceivingIndexerOptions<ABI, ProcessResultType, State>,
		record: GenerationRecord,
		writesStream: boolean,
	) {
		this.registry = registry;
		this.streamDigest = record.stream;
		this.streamConfig = streamConfig;
		this.state = state;
		this.processor = processor;
		this.writesStream = writesStream;
		this.records.set(keyOf(record), record);
		this.ingestion = new StreamBuilder<ABI, ProcessResultType>(processor, options.source, {
			...(options.stream ? {stream: options.stream} : {}),
			...(options.recordReorg ? {recordReorg: options.recordReorg} : {}),
			// THE ONE-WRITER RULE, structural rather than conventional: a fold that does
			// not write its stream is not handed the thing that appends to it.
			...(options.appendEmissions && writesStream ? {appendEmissions: options.appendEmissions} : {}),
			container: this,
		});
	}

	/** WHICH generation this host folds: the stream above, plus the fold over it. */
	get generation(): GenerationId {
		return this.ingestion.generation;
	}

	/** The caps in force, reported so a host can see the bound rather than re-derive the default. */
	get caps(): GenerationCaps {
		return this.registry.caps;
	}

	/** Every registered generation, oldest first. */
	generations(): Promise<GenerationRecord[]> {
		return this.registry.list();
	}

	/** The generation reads resolve through, which is NOT necessarily the one folding here. */
	canonical(): Promise<GenerationRecord | undefined> {
		return this.registry.canonical();
	}

	/**
	 * RESOLVE-OR-CREATE the generation an identity names, which is the whole of
	 * what the receiver above needs from a container.
	 *
	 * Every rule is the registry's: creating one already registered RESOLVES it, a
	 * CAP refuses rather than evicting and names what could be deleted, and the
	 * FIRST generation registered becomes canonical while a later one does not. A
	 * second copy of any of them here would be a second source of truth that
	 * drifts, so there is none.
	 *
	 * What is here is the memo and the log line: a receiver calls this on every
	 * cursor read (`StreamBuilder.currentLastSync`), and a generation created
	 * BESIDE a live one is the moment an operator most wants to see in a log.
	 */
	async resolveGeneration(id: GenerationId): Promise<GenerationRecord> {
		const key = keyOf(id);
		const known = this.records.get(key);
		if (known) {
			return known;
		}
		const canonicalBefore = await this.registry.canonical();
		const record = await this.registry.create(id);
		this.records.set(key, record);
		noteSuccessor(canonicalBefore, record);
		return record;
	}
}

/**
 * The memo's key. NUL is producible by neither a digest nor a version hash, so
 * it cannot be read as part of either half; the IDENTITY stays two fields, per
 * the registry.
 */
function keyOf(id: GenerationId): string {
	return `${id.stream}\u0000${id.processor}`;
}
