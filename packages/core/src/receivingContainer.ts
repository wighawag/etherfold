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
import {StreamBuilder, type GenerationContainer, type LogIngestion} from './streamBuilder.js';
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
 * For ONE named indexer: the folds this host runs, the durable registry the
 * generations are recorded in, the caps that REFUSE, and the canonical pointer
 * reads resolve through. It builds each generation the way ADR-0043 says one is
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
 * ## ONE ENTRY, SEVERAL LIVE WIRE CONTEXTS -- and exactly ONE PER STREAM
 *
 * A batch is addressed by its own `{source, config}` and nothing else (the NAME
 * is a route segment, never a field in the ADR-0004 envelope), so the receivers
 * this container holds are a MAP from wire context to fold. That map is total in
 * one direction only: a FILTER or CONFIG change is a different stream and
 * therefore a different address, so it gets a receiver of its own and the
 * incumbent keeps being fed; a PROCESSOR change is a new generation over the
 * SAME stream, which asserts the SAME pair, so it gets no receiver at all and is
 * caught up by re-folding the stored stream instead (ADR-0044, and the
 * bounded-chunk rebuild). `add` REFUSES a second fold on a stream already held
 * here for exactly that reason: two receivers at one address is a batch whose
 * destination is decided by iteration order.
 *
 * WHICH of them are LIVE is DERIVED from the registry (`liveIngestions`) rather
 * than from any rule about promotion: a context is live while its generation is
 * registered, and it stops being live when that generation is deleted (and the
 * stream reaped with it, if it was the last on it). So the question "does a
 * RETIRED-BUT-RETAINED generation go on being fed" is a policy input to the
 * registry rather than a rewrite of this routing.
 *
 * ## Two rules of the chain-facing container that deliberately do NOT come over
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
 * 2. **It advances nothing but the folds it was given.** How a successor CATCHES
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
 * The one that is left out is left out because it would be ACCEPTED AND IGNORED
 * here, which this repository does not do: `stateOf` publishes a read handle to
 * a subscriber, and nothing subscribes to a receiver -- a read tier answers over
 * the database, by resolving the canonical pointer to a table namespace
 * (ADR-0053).
 *
 * `source` IS taken, because it is how a second LIVE WIRE CONTEXT is expressed:
 * a fold naming a different fetch filter is a different stream and therefore a
 * different address on the wire. So is the stream CONFIG, which the chain-facing
 * container cannot vary per generation (one keeper serves one indexer there, so
 * two configs would clobber one address) and this one can, because every fold
 * here gets a receiver of its own and a receiver holds its own config. Both
 * default to the container's, so a host with one fold states neither twice.
 */
export type ReceivedGenerationSpec<ABI extends Abi, ProcessResultType = unknown, State = unknown> = Pick<
	GenerationSpec<ABI, ProcessResultType, State>,
	'createState' | 'createProcessor' | 'source'
> & {
	/** The stream CONFIG this fold runs, when it is not the container's own. Hashed into both identities. */
	stream?: ProvidedStreamConfig;
};

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
	/** The fetch filter a fold that names none of its own folds, which is half the stream identity. */
	source: IndexingSource<ABI>;
	/** The stream config, which is the other half. Resolved and hashed into both identities. */
	stream?: ProvidedStreamConfig;
	/** The fold THIS host opens with: its state, then the processor over it. Others arrive through `add`. */
	generation: ReceivedGenerationSpec<ABI, ProcessResultType, State>;
	/** Where a concluded reorg is counted (ADR-0050). Handed to every receiver unchanged. */
	recordReorg?: ReorgRecorder;
	/**
	 * Where the emission stream is stored (ADR-0052).
	 *
	 * Handed to a receiver ONLY where the fold it drives is the WRITER of its
	 * stream. See `HeldFold.writesStream`.
	 */
	appendEmissions?: EmissionAppender;
};

/**
 * ONE FOLD this container holds: its generation record, the state it folds into,
 * the processor and the receiver addressed by its wire context.
 *
 * Handed back by `add` so a host can reach the state it just built (the state
 * factory's own value, untouched) without the container having to publish a
 * handle it does not own.
 */
export type HeldFold<ABI extends Abi, ProcessResultType = unknown, State = unknown> = {
	/** The generation this fold IS, as the registry recorded it. */
	readonly record: GenerationRecord;
	/** WHICH stream it folds, which is also its address on the wire. */
	readonly streamDigest: string;
	/** The stream config that digest was taken over, resolved. */
	readonly streamConfig: UsedStreamConfig;
	/** The state this fold folds into, as its factory built it. */
	readonly state: State;
	/** The processor over that state. */
	readonly processor: EventProcessor<ABI, ProcessResultType>;
	/** THE RECEIVER: the one live wire context this fold answers to. */
	readonly ingestion: StreamBuilder<ABI, ProcessResultType>;
	/**
	 * Whether this fold is the WRITER of its stream, and therefore the only one
	 * that may append to it (ADR-0052).
	 *
	 * REPORTED and never set, exactly like the chain-facing container's `follows`:
	 * it is a consequence of `writerOf` -- the oldest SURVIVING generation
	 * registered on the stream -- and a caller that could choose it would be
	 * choosing to break the one-writer rule.
	 *
	 * `false` means the emission appender was NOT handed to this receiver, so this
	 * fold stores nothing: the stream it folds is already stored by an older
	 * generation, and every generation re-folds that ONE history.
	 */
	readonly writesStream: boolean;
};

/**
 * A second receiver at ONE wire address, refused.
 *
 * A batch carries `{source, config}` and nothing else that could tell two folds
 * on one stream apart, so the second one would be reachable only by iteration
 * order. What such a fold actually is is a PROCESSOR-change successor, and
 * ADR-0044 already says how it advances: it re-folds the stream the writer
 * stores, rather than being fed a copy of the same batches.
 */
function refuseSecondReceiverOn(stream: string): never {
	throw new Error(
		`this indexer already holds a fold on the stream ${stream}, and a stream is ONE address on the wire: a batch ` +
			`carries {source, config} and nothing that could say which of two folds on it was meant. A fold over the same ` +
			`stream is a PROCESSOR change, and it catches up by re-folding the stored stream (ADR-0044) rather than by ` +
			`being fed the same batches twice. Give this fold its own source or stream config, or add it as a generation ` +
			`for the rebuild to advance instead of as a receiver.`,
	);
}

/**
 * Open the container: the registry (and its sweep), then the fold this host was
 * built with, then the receiver wired to both.
 *
 * The generation is REGISTERED here rather than on the first batch, so a cap
 * REFUSES at start-up -- where an operator reads it, naming what could be deleted
 * -- instead of on somebody's ingest. Nothing is written for a refused
 * generation, and nothing partial survives one: `openGenerationRegistry.create`
 * decides inside the substrate's own transaction, and the state factories this
 * runtime uses create no storage until the first write.
 *
 * A SECOND live wire context is added afterwards, through `add`, because that is
 * when it exists: a filter-change successor is created while the incumbent is
 * running, and its context becomes live at that moment.
 */
export async function openReceivingIndexer<ABI extends Abi, ProcessResultType = unknown, State = unknown>(
	options: ReceivingIndexerOptions<ABI, ProcessResultType, State>,
): Promise<ReceivingIndexer<ABI, ProcessResultType, State>> {
	const registry = await openGenerationRegistry(options.port, options.caps ?? SERVER_GENERATION_CAPS);
	const indexer = new ReceivingIndexer<ABI, ProcessResultType, State>(registry, options);
	await indexer.add(options.generation);
	return indexer;
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
 * pointer, and one receiver per LIVE WIRE CONTEXT.
 *
 * Built through `openReceivingIndexer`. See the module JSDoc for what it adds
 * over a bare `StreamBuilder` and which of the chain-facing container's rules
 * deliberately do not come over.
 *
 * It is also, structurally, what the indexer-server's registry resolves a name
 * to (`IndexerRegistryEntry`, `@etherfold/server`): `liveIngestions` and
 * `canonicalGeneration` are exactly the two questions the ingest routes and the
 * feed ask of an entry, so a host that holds one of these registers it directly
 * rather than through an adapter that could answer them differently.
 */
export class ReceivingIndexer<
	ABI extends Abi,
	ProcessResultType = unknown,
	State = unknown,
> implements GenerationContainer {
	/** Which generations this indexer holds, which one is canonical, and the caps that refuse. */
	readonly registry: GenerationRegistry;

	/**
	 * THE FOLDS THIS INDEXER HOLDS, in the order they were added, at most ONE PER
	 * STREAM.
	 *
	 * Each carries a receiver, and a receiver is addressed by its stream's
	 * `{source, config}`: that is the map the ingest route selects through once the
	 * route segment has selected the indexer.
	 */
	private readonly folds: HeldFold<ABI, ProcessResultType, unknown>[] = [];

	private readonly options: ReceivingIndexerOptions<ABI, ProcessResultType, State>;

	/**
	 * What `resolveGeneration` has already answered, so a per-batch cursor read
	 * costs nothing after the first.
	 *
	 * Only SUCCESSES are kept. A cap refusal is not remembered, because the
	 * operator's response to one is to delete a generation, and a remembered
	 * refusal would go on refusing after they had.
	 */
	private readonly records = new Map<string, GenerationRecord>();

	constructor(registry: GenerationRegistry, options: ReceivingIndexerOptions<ABI, ProcessResultType, State>) {
		this.registry = registry;
		this.options = options;
	}

	/**
	 * The fold this host OPENED with, which is the first one added.
	 *
	 * Every singular accessor below reads through it, so a host holding one fold --
	 * which is every host until a filter change creates a successor -- says
	 * `indexer.ingestion` and never indexes into a list of one.
	 */
	get opening(): HeldFold<ABI, ProcessResultType, State> {
		const first = this.folds[0];
		if (!first) {
			throw new Error(
				`this ReceivingIndexer holds no fold yet: it is built by openReceivingIndexer, which adds the one it was ` +
					`opened with before handing it over.`,
			);
		}
		return first as HeldFold<ABI, ProcessResultType, State>;
	}

	/** Every fold held, oldest first. At most one per stream; see the module JSDoc. */
	held(): readonly HeldFold<ABI, ProcessResultType, unknown>[] {
		return this.folds;
	}

	/** WHICH STREAM the opening fold folds, as `streamDigestOf` renders it. */
	get streamDigest(): string {
		return this.opening.streamDigest;
	}
	/** The stream config that digest was taken over, resolved. */
	get streamConfig(): UsedStreamConfig {
		return this.opening.streamConfig;
	}
	/** The state the opening fold folds into, as its factory built it. */
	get state(): State {
		return this.opening.state;
	}
	/** The processor the opening fold runs. */
	get processor(): EventProcessor<ABI, ProcessResultType> {
		return this.opening.processor;
	}
	/**
	 * THE RECEIVER of the opening fold, and the live wire context a single-fold
	 * host has.
	 *
	 * It is built with this container attached, which is the whole point: a
	 * persisted cursor carrying another fold no longer reaches `processor.clear()`.
	 */
	get ingestion(): StreamBuilder<ABI, ProcessResultType> {
		return this.opening.ingestion;
	}
	/** Whether the opening fold WRITES its stream (ADR-0052). See `HeldFold.writesStream`. */
	get writesStream(): boolean {
		return this.opening.writesStream;
	}

	/** WHICH generation the opening fold is: the stream above, plus the fold over it. */
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

	/** The generation reads resolve through, which is NOT necessarily one folding here. */
	canonical(): Promise<GenerationRecord | undefined> {
		return this.registry.canonical();
	}

	/**
	 * WHICH GENERATION ANSWERS READS, as an identity a host can report.
	 *
	 * The narrow, never-absent form of `canonical` above, and the one a serving
	 * host asks for: both halves in ONE read, so a response can never pair one
	 * generation's stream with another's fold. Any registry a generation has been
	 * created in has a canonical pointer (the FIRST one registered takes it, which
	 * is the registry's own rule), so the fallback to the opening fold is for a
	 * substrate that answered nothing rather than a case a host has to handle.
	 */
	async canonicalGeneration(): Promise<GenerationId> {
		const canonical = await this.registry.canonical();
		return canonical ? {stream: canonical.stream, processor: canonical.processor} : this.generation;
	}

	/**
	 * THE LIVE WIRE CONTEXTS, DERIVED FROM THE REGISTRY rather than from a rule
	 * about promotion.
	 *
	 * A fold is live while the generation it was registered as is still registered.
	 * That is the whole lifetime: it BEGINS when the successor is created (`add`,
	 * which registers before it builds a receiver) and ENDS when that generation is
	 * DELETED -- and, if it was the last on its stream, when the stream is reaped
	 * with it. A batch for a fold that has fallen out of this list finds no receiver
	 * and is refused as a foreign context, which is right: its state has been
	 * dropped, so folding into it would be writing into nothing.
	 *
	 * What it deliberately does NOT consult is the canonical pointer. A superseded
	 * generation is RETAINED under the caps rather than dropped, so "the successor
	 * became canonical" is not by itself a reason to stop feeding the old context;
	 * whether it should be is a POLICY that sets what the registry holds, and this
	 * routing follows the registry either way.
	 */
	async liveIngestions(): Promise<readonly LogIngestion[]> {
		const registered = await this.registry.list();
		return this.folds
			.filter((fold) => registered.some((record) => sameGeneration(record, fold.record)))
			.map((fold) => fold.ingestion);
	}

	/**
	 * Build a fold BESIDE the ones already held, and make its wire context live.
	 *
	 * The receiving twin of `Indexer.add`, and the same order for the same reason:
	 * STATE FIRST, then the fold over it (ADR-0043), then the REGISTRY -- which is
	 * written before the receiver exists, because a stream subtree no registered
	 * generation claims is what the sweep collects, so nothing may write a stream
	 * ahead of its registration.
	 *
	 * A cap REFUSES here and nothing partial is left behind: the record is not
	 * written, no receiver is built, and the state factories this runtime uses
	 * create no storage until the first write.
	 *
	 * A fold on a stream this container ALREADY holds is refused rather than added:
	 * see `refuseSecondReceiverOn`.
	 */
	async add<S>(spec: ReceivedGenerationSpec<ABI, ProcessResultType, S>): Promise<HeldFold<ABI, ProcessResultType, S>> {
		const source = spec.source ?? this.options.source;
		const provided = spec.stream ?? this.options.stream;
		// The RESOLVED config, exactly as `StreamBuilder` resolves it, so the digest
		// this container files a generation under and the digest that receiver stores
		// its emissions under cannot be two different streams.
		const streamConfig = resolveStreamConfig(provided);
		const context: GenerationContext = {stream: streamDigestOf(source, streamConfig)};
		if (this.folds.some((fold) => fold.streamDigest === context.stream)) {
			refuseSecondReceiverOn(context.stream);
		}

		// STATE FIRST, then the fold over it (ADR-0043). The identity is OBSERVED after
		// both, from the processor's own hash, so nothing declares it twice.
		const state = await spec.createState(context);
		const processor = await spec.createProcessor(state, context);

		const canonicalBefore = await this.registry.canonical();
		const record = await this.registry.create({stream: context.stream, processor: processor.getVersionHash()});
		noteSuccessor(canonicalBefore, record);
		this.records.set(keyOf(record), record);
		// AFTER the record exists, because the rule reads the records: only the WRITER
		// of a stream may append to it (ADR-0052/ADR-0044), and a generation registered
		// beside an older one on the same stream is not it.
		const writer = await this.registry.writerOf(context.stream);
		const writesStream = !!writer && sameGeneration(writer, record);
		if (!writesStream) {
			namedLogger.info(
				`the fold {stream: ${record.stream}, processor: ${record.processor}} does NOT write its stream: ` +
					`{stream: ${writer?.stream}, processor: ${writer?.processor}} is the oldest surviving generation on it and ` +
					`is therefore its writer. Nothing this receiver folds is appended, because the stream already holds it and ` +
					`appending it again would be a second history for every generation that re-folds it.`,
			);
		}

		const fold: HeldFold<ABI, ProcessResultType, S> = {
			record,
			streamDigest: context.stream,
			streamConfig,
			state,
			processor,
			writesStream,
			ingestion: new StreamBuilder<ABI, ProcessResultType>(processor, source, {
				...(provided ? {stream: provided} : {}),
				...(this.options.recordReorg ? {recordReorg: this.options.recordReorg} : {}),
				// THE ONE-WRITER RULE, structural rather than conventional: a fold that does
				// not write its stream is not handed the thing that appends to it.
				...(this.options.appendEmissions && writesStream ? {appendEmissions: this.options.appendEmissions} : {}),
				container: this,
			}),
		};
		this.folds.push(fold as HeldFold<ABI, ProcessResultType, unknown>);
		return fold;
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
