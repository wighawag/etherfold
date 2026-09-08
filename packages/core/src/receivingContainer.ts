import type {Abi} from 'abitype';
import {logs} from 'named-logs';

import type {GenerationContext, GenerationSpec} from './container.js';
import type {EmissionAppender} from './emissionStream.js';
import {
	promotionOnAdd,
	readyForPromotion,
	resolvePromotionConfig,
	type PromotionConfig,
	type UsedPromotionConfig,
} from './generation/promotion.js';
import {GenerationRebuild, type RebuildReport, type ReplaySource} from './generation/rebuild.js';
import {
	openGenerationRegistry,
	sameGeneration,
	writerOf,
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
 * SAME stream, which asserts the SAME pair, so it gets NO RECEIVER AT ALL and is
 * caught up by re-folding the stored stream instead. Two receivers at one
 * address is a batch whose destination is decided by iteration order, so the
 * second fold on a stream is never one.
 *
 * ## FOLLOWER OR RECEIVER IS DETERMINED, NEVER CONFIGURED (ADR-0044)
 *
 * `add` decides it from the STREAM and from nothing else, exactly as the
 * chain-facing container's `follows` is decided: a fold on a stream this
 * container already holds FOLLOWS it -- it is handed a bounded rebuild over the
 * stored stream (`GenerationRebuild`) and no receiver -- and a fold on a stream
 * nobody here holds gets the receiver and, if it is the oldest on that stream,
 * the append duty. A flag would be wrong in both positions: "follow a stream
 * nobody writes" never advances, and "receive on a stream somebody else writes"
 * is a second writer.
 *
 * The catch-up itself is a call the HOST SCHEDULES (`rebuildMore`, ADR-0022),
 * never a side effect of a batch: a rebuild takes arbitrarily long and a
 * serverless host cannot hold a loop.
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
 * 2. **It publishes no state handle and notifies nobody.** Reads on this runtime
 *    resolve the canonical pointer to a TABLE NAMESPACE (ADR-0053) rather than
 *    subscribing to a container, so a promotion here is the registry write and
 *    the log line, and nothing else. Moving the pointer BACK is
 *    `the-canonical-pointer-moves-back-without-re-ingesting`.
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
	/**
	 * Where the STORED stream is read back, in bounded slices, so a FOLLOWER can
	 * catch up (`storedEmissionReplaySource`, `@etherfold/server`).
	 *
	 * The read counterpart of `appendEmissions`, supplied by the same host over the
	 * same database, and required for the same reason that one is: this package
	 * knows no database. A container given none holds no follower -- `add` REFUSES a
	 * fold on a stream it already holds rather than creating a successor that could
	 * never advance, which would be a generation registered against a rebuild nobody
	 * can drive.
	 */
	replay?: ReplaySource<ABI>;
	/**
	 * WHEN the canonical pointer moves on its own, and what happens to the
	 * generation left behind.
	 *
	 * Defaults to `on-catch-up` with nothing dropped, and that default is the same
	 * in every runtime: see `generation/promotion.ts` for why there is deliberately
	 * no per-runtime and no per-environment selection. The VALUES, the default and
	 * the trigger are that module's and are consumed unchanged here; what this
	 * container adds is where each is applied.
	 */
	promotion?: PromotionConfig;
	/**
	 * How many stored emissions ONE `rebuildMore` call replays per follower.
	 *
	 * Defaults to `DEFAULT_MAX_EMISSIONS_PER_CHUNK`. A host that wants shorter
	 * invocations lowers it and calls more often; the CADENCE is never decided here
	 * (ADR-0022).
	 */
	maxEmissionsPerChunk?: number;
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
	/**
	 * Whether this fold FOLLOWS a stream another generation on it writes.
	 *
	 * DETERMINED by whether the stream was already held here and never configured
	 * (ADR-0044), which is why it is reported beside `writesStream` rather than
	 * taken beside the factories. A follower has NO receiver and a `rebuild`; a
	 * non-follower has a receiver and no rebuild.
	 */
	readonly follows: boolean;
	/**
	 * THE RECEIVER: the one live wire context this fold answers to.
	 *
	 * ABSENT on a FOLLOWER, because a stream is ONE address on the wire: a batch
	 * carries `{source, config}` and nothing that could say which of two folds on
	 * one stream was meant, so a second receiver there would be reachable only by
	 * iteration order. A follower is fed by the stream instead of by the wire.
	 */
	readonly ingestion?: StreamBuilder<ABI, ProcessResultType>;
	/**
	 * THE BOUNDED REBUILD that advances this fold, present exactly when it FOLLOWS.
	 *
	 * Driven by `ReceivingIndexer.rebuildMore`, which a HOST schedules. It is the
	 * same object across the catch-up and the steady state: once level, a chunk
	 * finds nothing new and costs one read.
	 */
	readonly rebuild?: GenerationRebuild<ABI, ProcessResultType>;
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
	 *
	 * **It can CHANGE while this fold is held**, and that is the engine half of
	 * ADR-0044's succession rule: the writer is the oldest SURVIVING generation, so
	 * deleting a writer makes the next-oldest one the answer, and this container
	 * moves the wire to it (`ReceivingIndexer.liveIngestions`). It is still never
	 * SET by a caller -- it is re-derived from the records whenever they are read.
	 */
	readonly writesStream: boolean;
};

/**
 * The same fold, writable, for the ONE thing that legitimately re-derives it:
 * WRITER SUCCESSION (ADR-0044).
 *
 * `HeldFold` is readonly because none of it is a caller's to choose. The container
 * itself must be able to move a fold between the two shapes -- follower with a
 * rebuild, writer with a receiver -- because which one it is is a function of
 * records that change underneath it.
 */
type MutableHeldFold<ABI extends Abi, ProcessResultType> = {
	-readonly [K in keyof HeldFold<ABI, ProcessResultType, unknown>]: HeldFold<ABI, ProcessResultType, unknown>[K];
};

/**
 * What a fold needs REMEMBERED so its engine half can be rebuilt later.
 *
 * The source and the stream config it was added with, because succession builds a
 * receiver for a fold that did not have one; and whether its rebuild has reported
 * LEVEL, because a fold that is still catching up must not be handed the wire (see
 * `reconcileWriters`).
 */
type FoldOrigin<ABI extends Abi> = {
	readonly source: IndexingSource<ABI>;
	readonly provided: ProvidedStreamConfig | undefined;
	level: boolean;
};

/**
 * A follower with no stream to follow, refused.
 *
 * A fold on a stream this container already holds is a FOLLOWER (ADR-0044): it
 * gets no receiver, because a stream is ONE address on the wire, and it advances
 * by re-folding what is stored. A host that supplied no `replay` source has
 * nowhere for it to read from, so creating it would register a generation that
 * can never advance and can never be promoted -- a silent, permanent
 * half-upgrade. Refused loudly instead, naming the port that is missing.
 */
function refuseFollowerWithNoStream(stream: string): never {
	throw new Error(
		`this indexer already holds a fold on the stream ${stream}, so a second one is a FOLLOWER: it gets no receiver ` +
			`(a stream is ONE address on the wire) and catches up by re-folding the stored stream (ADR-0044). This ` +
			`container was given no \`replay\` source, so there is nothing for it to re-fold and it could never advance. ` +
			`Supply \`replay\` (\`storedEmissionReplaySource\` over the database this host owns), or give this fold its ` +
			`own source or stream config so that it is a stream of its own.`,
	);
}

/**
 * `immediate` plus drop-on-promotion, refused rather than half-implemented.
 *
 * `immediate` promotes a generation that has caught up to NOTHING, so the drop
 * has to be DEFERRED until the successor reaches the cursor the previous
 * generation had at the promotion (ADR-0046). That interlock is bookkeeping the
 * chain-facing container keeps per advance and this one does not, and
 * accepting the combination without it would discard a complete state for an
 * empty one with no fallback -- accept-and-ignore, on the one setting where the
 * cost is unrecoverable.
 */
function refuseImmediateDrop(): never {
	throw new Error(
		`promotion policy 'immediate' with dropOnPromotion is not available on this runtime. 'immediate' makes a ` +
			`successor canonical BEFORE it has caught up, so the previous generation must be RETAINED until the ` +
			`successor reaches the cursor it had at the promotion (ADR-0046) -- and that deferral is not built here. ` +
			`Use 'on-catch-up' (the default) with dropOnPromotion, or 'immediate' while retaining.`,
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
 * A SECOND fold is added afterwards, through `add`, because that is when it
 * exists: a successor is created while the incumbent is running.
 */
export async function openReceivingIndexer<ABI extends Abi, ProcessResultType = unknown, State = unknown>(
	options: ReceivingIndexerOptions<ABI, ProcessResultType, State>,
): Promise<ReceivingIndexer<ABI, ProcessResultType, State>> {
	const registry = await openGenerationRegistry(options.port, options.caps ?? SERVER_GENERATION_CAPS);
	const indexer = new ReceivingIndexer<ABI, ProcessResultType, State>(registry, options);
	await indexer.open();
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
 * It also ANSWERS what the indexer-server's registry asks a name
 * (`IndexerRegistryEntry`, `@etherfold/server`): `liveIngestions` and
 * `canonicalGeneration` are exactly the two questions the ingest routes and the
 * feed put to an entry, so a host registers this container itself rather than an
 * adapter that could answer them differently. What a host must add beside it is
 * the DATABASE that name owns (ADR-0053, `indexerEntryOn`), which is not
 * expressible here: this package knows no database, which is why the state a
 * generation folds into is a type parameter.
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

	/** The promotion policy this indexer runs under, with nothing left to decide. */
	private readonly promotionConfig: UsedPromotionConfig;

	/**
	 * Whether the fold this container OPENED with has been added.
	 *
	 * The same gate the chain-facing container keeps, for the same reason: the
	 * generations an indexer is opened with are the set it holds, and which of them
	 * is canonical is the registry's durable answer. Applying the policy at open
	 * would let `immediate` promote whatever the host happened to be built with, and
	 * `on-catch-up` undo a revert recorded in a previous session. A fold added
	 * AFTERWARDS is a successor, and that is the only thing the policy has an
	 * opinion about.
	 */
	private opened = false;

	/**
	 * WHICH folds are armed for automatic promotion (ADR-0046).
	 *
	 * IN MEMORY, exactly as the chain-facing container keeps it and for the same
	 * reason: the registry records what a generation IS, and being a candidate is
	 * what a container is DOING with one. It is deliberately not "every
	 * non-canonical generation is a candidate", which would re-promote a successor
	 * on the cycle after a REVERT.
	 */
	private readonly candidates = new Set<HeldFold<ABI, ProcessResultType, unknown>>();

	/**
	 * WHICH held folds the canonical pointer has EVER named, which is how a REVERT
	 * is told from a PROMOTION.
	 *
	 * The chain-facing container's `everCanonical` flag, kept here as a set for the
	 * same reason the candidates are: what a container is DOING with a generation is
	 * not what the registry records it IS. A move to a generation the pointer has
	 * named before is going BACK to it, and a backwards move must drop NOTHING --
	 * dropping what it moved away from would delete the very generation a second
	 * move forward wants (ADR-0046, and `Indexer.arrangeDrop` says the same).
	 *
	 * It is deliberately not `createdAt`: two generations registered in the same
	 * millisecond compare equal, which is a fine total order for a listing and no
	 * basis at all for deciding whether to DELETE one.
	 *
	 * In memory, so it does not survive a restart -- and the direction that costs is
	 * the safe one, because a fold this process has not seen the pointer on is
	 * treated as a revert and nothing is dropped.
	 */
	private readonly everCanonical = new Set<HeldFold<ABI, ProcessResultType, unknown>>();

	/**
	 * What `resolveGeneration` has already answered, so a per-batch cursor read
	 * costs nothing after the first.
	 *
	 * Only SUCCESSES are kept. A cap refusal is not remembered, because the
	 * operator's response to one is to delete a generation, and a remembered
	 * refusal would go on refusing after they had.
	 */
	private readonly records = new Map<string, GenerationRecord>();

	/**
	 * What each held fold was BUILT FROM, so its engine half can be rebuilt when the
	 * records say it is now the writer of its stream. See `FoldOrigin`.
	 */
	private readonly origins = new WeakMap<HeldFold<ABI, ProcessResultType, unknown>, FoldOrigin<ABI>>();

	constructor(registry: GenerationRegistry, options: ReceivingIndexerOptions<ABI, ProcessResultType, State>) {
		this.registry = registry;
		this.options = options;
		this.promotionConfig = resolvePromotionConfig(options.promotion);
		if (this.promotionConfig.dropOnPromotion && this.promotionConfig.policy === 'immediate') {
			refuseImmediateDrop();
		}
	}

	/**
	 * Add the fold this host was built with, and only then let the policy speak.
	 *
	 * Called by `openReceivingIndexer`; separate from the constructor because
	 * registering a generation is a write and a CAP refuses here, at start-up, where
	 * an operator reads it.
	 */
	async open(): Promise<void> {
		await this.add(this.options.generation);
		// LAST: from here on, a fold handed to `add` is a SUCCESSOR beside a live one,
		// which is the only thing the promotion policy has an opinion about.
		this.opened = true;
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
	 *
	 * The opening fold is the FIRST on its stream, so it is never a follower and
	 * always has one; the assertion says so rather than widening every caller's type
	 * for a case `open` cannot produce.
	 */
	get ingestion(): StreamBuilder<ABI, ProcessResultType> {
		const ingestion = this.opening.ingestion;
		if (!ingestion) {
			throw new Error(
				`the opening fold of this ReceivingIndexer has no receiver, which \`open\` cannot produce: the first fold ` +
					`held on a stream is never a follower.`,
			);
		}
		return ingestion;
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
	 * WHICH GENERATION ANSWERS READS, as an identity a host can report -- or NOTHING,
	 * which is a real answer and never an empty one.
	 *
	 * The narrow form of `canonical` above, and the one a serving host asks for: both
	 * halves in ONE read, so a response can never pair one generation's stream with
	 * another's fold.
	 *
	 * ## Why `undefined` is PASSED THROUGH and not covered over
	 *
	 * This used to fall back to the OPENING FOLD, on the reasoning that any registry a
	 * generation has been created in has a pointer (the first one registered takes it,
	 * which is the registry's own rule), so nothing could ever ask. That reasoning
	 * predates the answer being expressible at all: `openGenerationRegistry.canonical()`
	 * resolves the pointer AGAINST THE RECORDS, so it answers nothing when the pointer
	 * names a generation whose record has gone -- another process deleting it, or a
	 * half-written substrate.
	 *
	 * In that case the opening fold is NOT the generation the pointer named, so the
	 * fallback served reads from a generation nobody asked for, silently, where a read
	 * tier over the same rows refuses (`503 no-canonical-generation`, ADR-0058). One
	 * database, two answers, decided by which process happened to be asking. Passing
	 * the registry's answer through makes every host agree, and the refusal an operator
	 * sees is then a fact about the DATABASE rather than about the reader.
	 *
	 * A host holding folds still holds them and still folds: this says which generation
	 * ANSWERS, and "none of them, yet" is a state the read surface already knows how to
	 * report.
	 */
	async canonicalGeneration(): Promise<GenerationId | undefined> {
		const canonical = await this.registry.canonical();
		if (!canonical) {
			namedLogger.info(
				`the registry names no canonical generation, so this container answers NONE rather than falling back to the ` +
					`fold it opened with ({stream: ${this.generation.stream}, processor: ${this.generation.processor}}). A read ` +
					`is refused rather than served from a generation the pointer does not name (ADR-0058).`,
			);
			return undefined;
		}
		return {stream: canonical.stream, processor: canonical.processor};
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
		// BEFORE the list is answered, because the answer is what the wire routes on:
		// deleting a stream's writer makes the next-oldest generation the writer, and a
		// batch arriving after that must reach the fold that now holds the duty.
		await this.reconcileWriters(registered);
		return this.folds
			.filter((fold) => !!fold.ingestion && registered.some((record) => sameGeneration(record, fold.record)))
			.map((fold) => fold.ingestion as StreamBuilder<ABI, ProcessResultType>);
	}

	/**
	 * WRITER SUCCESSION, the engine half: move the wire to the generation the records
	 * now say writes each stream.
	 *
	 * ADR-0044 says the writer of a stream is the OLDEST SURVIVING generation held on
	 * it, and that succession is atomic with a delete BECAUSE IT IS STORED NOWHERE --
	 * the commit that removes the record is already the commit that makes the
	 * next-oldest generation the answer. That is the DURABLE half, and it has been
	 * true since the registry landed. This is the other half: in a running process,
	 * the surviving generation must actually be handed the engine, or the records say
	 * one thing while the host does another and the stream quietly stops being fed.
	 *
	 * Without this, deleting a writer removed the only RECEIVER its stream had: the
	 * context stopped being live, an incoming batch resolved to nothing, and `/status`
	 * went on looking healthy while the cursor stopped -- the exact silent stall the
	 * amendment was written to close.
	 *
	 * It is a RECONCILIATION and not an event handler, for the reason everything else
	 * here is derived: a generation can be deleted by another process, so there is no
	 * moment this host is told about. It runs where the records are already being read
	 * and costs nothing when nothing moved.
	 *
	 * ## Why a fold that is still CATCHING UP does not take the wire
	 *
	 * A receiver answers `expectedFromBlock` from ITS OWN fold position, and under
	 * ADR-0052 a re-sent batch is APPENDED AGAIN. So handing the wire to a follower
	 * that is still mid-rebuild would make it ask for everything back to its own
	 * cursor and store a second copy of that whole range -- indistinguishable
	 * afterwards from real emissions, which is the corruption ADR-0055's coverage
	 * claim exists to prevent. A fold that is LEVEL asks for at most the one batch the
	 * stream may already be ahead by, which is the duplicate ADR-0052 already accepts
	 * and bounds.
	 *
	 * So succession WAITS for the survivor to catch up. That is not a stall: the
	 * follower's rebuild is still advancing it (nothing about a deleted writer stops
	 * the stored stream being re-foldable), so the next reconciliation hands over the
	 * wire. The stream is unfed in the meantime, which is visible and recoverable,
	 * where a duplicated range is neither.
	 */
	private async reconcileWriters(registered: readonly GenerationRecord[]): Promise<void> {
		for (const fold of this.folds) {
			if (!registered.some((record) => sameGeneration(record, fold.record))) continue;
			const writer = writerOf(registered, fold.streamDigest);
			const shouldWrite = !!writer && sameGeneration(writer, fold.record);
			if (shouldWrite === fold.writesStream) continue;

			const origin = this.origins.get(fold);
			if (!origin) continue;
			if (shouldWrite && !origin.level) {
				namedLogger.info(
					`the fold {stream: ${fold.record.stream}, processor: ${fold.record.processor}} is now the oldest surviving ` +
						`generation on its stream and so its WRITER, but it has not finished re-folding that stream yet. The wire ` +
						`is NOT handed over: a receiver asks from its own position, and under ADR-0052 the re-sent range would be ` +
						`APPENDED A SECOND TIME. Its rebuild keeps advancing it; it takes the wire once it is level.`,
				);
				continue;
			}
			this.handOverTheWire(fold as MutableHeldFold<ABI, ProcessResultType>, origin, shouldWrite);
		}
	}

	/**
	 * Give this fold the engine half the records say it should have, and take away
	 * the one it should not.
	 *
	 * A fold is one of exactly two shapes (`HeldFold.ingestion` / `HeldFold.rebuild`),
	 * and succession moves it between them: a FOLLOWER that inherits the duty stops
	 * following and gets a receiver with the appender; a fold that already had a
	 * receiver but not the appender is rebuilt with it. The processor and the state
	 * are untouched, so nothing re-reads and nothing re-folds -- a `StreamBuilder`
	 * holds no position of its own, it reads the fold's persisted cursor, so a fresh
	 * one resumes exactly where the old one was.
	 */
	private handOverTheWire(
		fold: MutableHeldFold<ABI, ProcessResultType>,
		origin: FoldOrigin<ABI>,
		writesStream: boolean,
	): void {
		const was = fold.follows ? 'a FOLLOWER' : 'a receiver that did not write';
		fold.writesStream = writesStream;
		fold.follows = false;
		fold.rebuild = undefined;
		fold.ingestion = new StreamBuilder<ABI, ProcessResultType>(fold.processor, origin.source, {
			...(origin.provided ? {stream: origin.provided} : {}),
			...(this.options.recordReorg ? {recordReorg: this.options.recordReorg} : {}),
			...(this.options.appendEmissions && writesStream ? {appendEmissions: this.options.appendEmissions} : {}),
			container: this,
		});
		namedLogger.info(
			`WRITER SUCCESSION on the stream ${fold.streamDigest}: {stream: ${fold.record.stream}, processor: ` +
				`${fold.record.processor}} was ${was} and is now its writer, because it is the oldest generation still ` +
				`registered on it (ADR-0044). It has been given the receiver and the emission appender, so the stream goes ` +
				`on being fed and on being stored.`,
		);
	}

	/** Every FOLLOWER held: the folds a rebuild advances rather than the wire. */
	followers(): readonly HeldFold<ABI, ProcessResultType, unknown>[] {
		return this.folds.filter((fold) => fold.follows);
	}

	/** The promotion policy this indexer runs under, resolved, so a host can see WHICH value is in force. */
	get promotion(): UsedPromotionConfig {
		return this.promotionConfig;
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
	 * WHETHER IT GETS A RECEIVER OR A REBUILD IS DETERMINED HERE, from the stream
	 * and from nothing else (ADR-0044). A fold on a stream this container already
	 * holds FOLLOWS it: no receiver, because a stream is ONE address on the wire,
	 * and a `GenerationRebuild` over the stored stream instead. A fold on a stream
	 * nobody here holds gets the receiver.
	 */
	async add<S>(spec: ReceivedGenerationSpec<ABI, ProcessResultType, S>): Promise<HeldFold<ABI, ProcessResultType, S>> {
		const source = spec.source ?? this.options.source;
		const provided = spec.stream ?? this.options.stream;
		// The RESOLVED config, exactly as `StreamBuilder` resolves it, so the digest
		// this container files a generation under and the digest that receiver stores
		// its emissions under cannot be two different streams.
		const streamConfig = resolveStreamConfig(provided);
		const context: GenerationContext = {stream: streamDigestOf(source, streamConfig)};
		// DETERMINED, never configured: this is the receiving twin of `Indexer.add`'s
		// `follows`, decided from the same fact for the same reason.
		const follows = this.folds.some((fold) => fold.streamDigest === context.stream);
		const replay = this.options.replay;
		if (follows && !replay) {
			refuseFollowerWithNoStream(context.stream);
		}

		// STATE FIRST, then the fold over it (ADR-0043). The identity is OBSERVED after
		// both, from the processor's own hash, so nothing declares it twice.
		const state = await spec.createState(context);
		const processor = await spec.createProcessor(state, context);

		const canonicalBefore = await this.registry.canonical();
		const record = await this.registry.create({stream: context.stream, processor: processor.getVersionHash()});
		noteSuccessor(canonicalBefore, record);
		this.records.set(keyOf(record), record);
		// WHETHER THIS FOLD IS THE ONE THE POINTER NAMES, derived rather than re-read:
		// `create` leaves the pointer where it was, and takes it only when there was
		// none. It is recorded because a later move BACK to it must be readable as a
		// revert -- including the opening fold of a host that comes up already canonical.
		const canonicalOnAdd = !canonicalBefore || sameGeneration(canonicalBefore, record);
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
			follows,
			...(follows
				? {
						rebuild: new GenerationRebuild<ABI, ProcessResultType>(processor, source, {
							stream: context.stream,
							streamConfig,
							replay: replay as ReplaySource<ABI>,
							...(this.options.maxEmissionsPerChunk === undefined
								? {}
								: {maxEmissions: this.options.maxEmissionsPerChunk}),
						}),
					}
				: {
						ingestion: new StreamBuilder<ABI, ProcessResultType>(processor, source, {
							...(provided ? {stream: provided} : {}),
							...(this.options.recordReorg ? {recordReorg: this.options.recordReorg} : {}),
							// THE ONE-WRITER RULE, structural rather than conventional: a fold that does
							// not write its stream is not handed the thing that appends to it.
							...(this.options.appendEmissions && writesStream ? {appendEmissions: this.options.appendEmissions} : {}),
							container: this,
						}),
					}),
		};
		this.folds.push(fold as HeldFold<ABI, ProcessResultType, unknown>);
		// REMEMBERED for succession: a follower that later becomes its stream's writer
		// needs a receiver built from the same source and stream config it was added
		// with. `level` starts false for a follower, which is what stops a fold that has
		// not caught up from being handed the wire (see `reconcileWriters`), and true for
		// a fold that already has a receiver, because the wire is what feeds it.
		this.origins.set(fold as HeldFold<ABI, ProcessResultType, unknown>, {
			source,
			provided,
			level: !follows,
		});
		if (canonicalOnAdd) {
			this.everCanonical.add(fold as HeldFold<ABI, ProcessResultType, unknown>);
		}
		await this.applyPolicyTo(fold as HeldFold<ABI, ProcessResultType, unknown>);
		return fold;
	}

	// ------------------------------------------------------------------------------------------------------------------
	// THE REBUILD, and the promotion that ends it
	// ------------------------------------------------------------------------------------------------------------------

	/**
	 * ADVANCE EVERY FOLLOWER BY ONE BOUNDED CHUNK, then settle the pointer.
	 *
	 * The call a HOST SCHEDULES (ADR-0022), and the shape `prune` and
	 * `compactEmissionPairs` already have: bounded work per invocation, and a REPORT
	 * a scheduler acts on. It is never a side effect of a batch -- a rebuild takes
	 * arbitrarily long, and putting it on the write path would stall whichever batch
	 * happened to arrive during an upgrade, for work that batch did not cause.
	 *
	 * A scheduler loops while a report is `complete: false` AND `retryCanAdvance`
	 * says another call can help; a serverless host re-invokes itself instead. Both
	 * halves are load-bearing: three of the six `RebuildStop` reasons recur
	 * identically on every call, so looping on `complete === false` alone polls them
	 * for ever at full rate while the follower never becomes level (ADR-0070). A
	 * report that is incomplete and cannot advance needs a human, not another call.
	 * Nothing here invents a cadence, and a call with nothing to do costs one read
	 * per follower.
	 *
	 * The pointer is settled AFTER the chunks, once, so a successor that became
	 * level during this call is promoted in the same call rather than on the next
	 * one -- and at most ONE move happens, because promoting twice inside one
	 * advance would publish a generation nobody ever read from.
	 */
	async rebuildMore(options?: {maxEmissions?: number}): Promise<RebuildReport[]> {
		const registered = await this.registry.list();
		const reports: RebuildReport[] = [];
		for (const fold of [...this.folds]) {
			if (!fold.rebuild) continue;
			// A generation that has been DELETED is not advanced: its state is gone, so
			// folding into it would be writing into nothing -- the same rule
			// `liveIngestions` applies to a receiver.
			if (!registered.some((record) => sameGeneration(record, fold.record))) continue;
			const report = await fold.rebuild.more(options);
			// LEVEL is what lets this fold take the wire if it inherits its stream's write
			// duty; see `reconcileWriters` for why a fold that is behind must not.
			const origin = this.origins.get(fold);
			if (origin) origin.level = report.complete;
			reports.push(report);
		}
		// AFTER the chunks, so a follower that became level in this very call can inherit
		// a vacant write duty now rather than a call later.
		await this.reconcileWriters(registered);
		await this.settlePromotion();
		return reports;
	}

	/**
	 * MOVE THE CANONICAL POINTER: one small write, forwards or BACKWARDS.
	 *
	 * The verb, ungated by the policy under every value: `manual` means "only when
	 * asked" rather than "never", and moving the pointer BACK is the SAME call at a
	 * different target -- promotion and revert are one mechanism and this is it (the
	 * operator-facing affordance over it is `POST /{indexer}/admin/canonical-generation`,
	 * `@etherfold/server`).
	 *
	 * ## It does NOT require this container to hold a FOLD for the target
	 *
	 * That is the whole of what makes the way back real on this runtime, and it is
	 * rule 1 of the module JSDoc applied to the WRITE side: reads here resolve the
	 * pointer to a table NAMESPACE (ADR-0053), so the canonical generation answers
	 * with no engine at all. The ORDINARY revert is exactly that case -- a host
	 * redeployed with the new processor holds only the new fold, and the generation
	 * an operator wants back is in the durable registry with its state in its own
	 * namespace -- so refusing here would mean the revert could only be performed by
	 * a process that had first been rebuilt with the old processor, which is the
	 * re-index this design exists to remove.
	 *
	 * The refusal is therefore the REGISTRY's (`UnknownGenerationError`): a
	 * generation nothing registered is refused rather than reported as a silent
	 * success, and that is the one question worth asking here.
	 */
	async promote(id: GenerationId): Promise<GenerationRecord> {
		return this.movePointer(
			id,
			this.folds.find((held) => sameGeneration(held.record, id)),
		);
	}

	/**
	 * What the policy does about a fold that has just been ADDED beside the live
	 * one.
	 *
	 * Nothing at all during `open` (see `opened`), and nothing for a fold that is
	 * already the canonical generation, which is not a successor to anything. The
	 * MAPPING from policy to action is `generation/promotion.ts`'s and is shared
	 * with the chain-facing container.
	 */
	private async applyPolicyTo(fold: HeldFold<ABI, ProcessResultType, unknown>): Promise<void> {
		if (!this.opened) return;
		const canonical = await this.registry.canonical();
		if (canonical && sameGeneration(canonical, fold.record)) return;
		switch (promotionOnAdd(this.promotionConfig.policy)) {
			case 'promote':
				await this.movePointer(fold.record, fold);
				return;
			case 'arm':
				this.candidates.add(fold);
				// Evaluated at once as well as per chunk: a fold added when it is already
				// level (one named a second time across a restart, mid-rebuild) is ready NOW.
				await this.settlePromotion();
				return;
			case 'wait':
				return;
		}
	}

	/**
	 * THE TRIGGER: promote the armed fold that has reached the CANONICAL
	 * generation's cursor.
	 *
	 * The rule is `readyForPromotion`'s, shared with the chain-facing container so
	 * that there is one answer to "when does the pointer move on its own". What this
	 * runtime supplies is the VIEW: a cursor here is not a field an engine publishes,
	 * it is the `lastToBlock` each fold has PERSISTED -- read live on every settle,
	 * never snapshotted, because a snapshot would let a successor be promoted while
	 * the incumbent had moved on.
	 *
	 * A canonical generation this container holds no fold for is not an error here
	 * (see the module JSDoc): reads answer from a table namespace with no engine at
	 * all. It simply means there is nothing to compare a successor against, so the
	 * pointer does not move on its own.
	 */
	private async settlePromotion(): Promise<void> {
		if (this.candidates.size === 0) return;
		const canonical = await this.registry.canonical();
		if (!canonical) return;
		const current = this.folds.find((fold) => sameGeneration(fold.record, canonical));
		if (!current) return;

		const cursors = new Map<HeldFold<ABI, ProcessResultType, unknown>, number | undefined>();
		for (const fold of this.folds) {
			cursors.set(fold, await this.cursorOf(fold));
		}
		const ready = readyForPromotion(this.folds, current, {
			isCandidate: (fold) => this.candidates.has(fold),
			cursorOf: (fold) => cursors.get(fold),
		});
		if (ready) {
			await this.movePointer(ready.record, ready);
		}
	}

	/**
	 * HOW FAR THIS FOLD HAS GOT, read from where it is durable.
	 *
	 * The persisted cursor and never an in-memory copy, for the reason
	 * `StreamBuilder` reads its own on every call: several isolates may serve one
	 * database, and a cursor held in a process is that process's private opinion of
	 * a value the database owns. A cursor written by ANOTHER fold answers
	 * `undefined` rather than a number, so a generation that has folded nothing can
	 * never be read as level with one that has.
	 */
	private async cursorOf(fold: HeldFold<ABI, ProcessResultType, unknown>): Promise<number | undefined> {
		const processorHash = fold.processor.getVersionHash();
		const loaded = await fold.processor.load(this.options.source, fold.streamConfig);
		if (!loaded || loaded.lastSync.context.processor !== processorHash) {
			return undefined;
		}
		return loaded.lastSync.lastToBlock;
	}

	/**
	 * THE MOVE: one small write, and the generation left behind is RETAINED.
	 *
	 * Retaining is what makes moving the pointer BACK a revert rather than a
	 * re-index, which is why drop-on-promotion is OFF by default -- and why, when it
	 * is on, it still never drops the WRITER of a stream another held generation
	 * follows (ADR-0046): that would leave the follower folding a stream nothing
	 * appends to. On the ordinary processor upgrade the superseded generation IS
	 * that writer, so the drop is declined and said out loud.
	 *
	 * The FOLD is optional, and its absence is a case rather than a refusal. A held
	 * fold is what the in-memory bookkeeping hangs off -- disarming it as a candidate,
	 * and reading whether the pointer has EVER named it -- and there is none for a
	 * generation this process was not built with, which is the ordinary
	 * post-redeploy revert (see `promote`).
	 */
	private async movePointer(
		id: GenerationId,
		fold: HeldFold<ABI, ProcessResultType, unknown> | undefined,
	): Promise<GenerationRecord> {
		const supersededRecord = await this.registry.canonical();
		/**
		 * Read BEFORE the move applies, because that is what makes it readable at all:
		 * a generation the pointer has named before is one this is going BACK to. A
		 * target this container holds NO fold for is treated as a revert too, which is
		 * the safe direction -- it is what an operator naming an older generation after
		 * a redeploy is doing, and the only consequence is that nothing is dropped.
		 */
		const wasRevert = !fold || this.everCanonical.has(fold);
		const record = await this.registry.moveCanonicalTo(id);
		if (fold) {
			// It is canonical: it is no longer waiting to become so, and a REVERT past it
			// later must not re-promote it on the next chunk.
			this.candidates.delete(fold);
			this.everCanonical.add(fold);
		}
		if (!supersededRecord || sameGeneration(supersededRecord, record)) {
			return record;
		}
		namedLogger.info(
			`the canonical pointer moved ${wasRevert ? 'BACK ' : ''}to {stream: ${record.stream}, processor: ` +
				`${record.processor}}. The generation {stream: ${supersededRecord.stream}, processor: ` +
				`${supersededRecord.processor}} is RETAINED: it keeps its own state, keeps folding, and is what the pointer ` +
				`moves BACK to.`,
		);
		const superseded = this.folds.find((held) => sameGeneration(held.record, supersededRecord));
		// A BACKWARDS MOVE DROPS NOTHING, which is the chain-facing container's rule
		// (`arrangeDrop`) and ADR-0046's: drop-on-promotion discards a generation a
		// promotion SUPERSEDED, and a revert supersedes nothing -- it moves away from a
		// generation that is exactly what a second move forward would want back.
		if (this.promotionConfig.dropOnPromotion && superseded && fold && !wasRevert) {
			await this.dropSuperseded(superseded, fold);
		}
		return record;
	}

	/**
	 * Drop a superseded generation, unless dropping it would strand a follower.
	 *
	 * Which generation WRITES a stream is the oldest surviving one registered on it
	 * and never the canonical one (ADR-0044), precisely so a promotion does not hand
	 * the append duty to a different engine mid-flight. So dropping a writer another
	 * held generation follows would leave that one folding a stream nothing appends
	 * to: the drop is DECLINED rather than refused, and the bytes are kept.
	 */
	private async dropSuperseded(
		superseded: HeldFold<ABI, ProcessResultType, unknown>,
		successor: HeldFold<ABI, ProcessResultType, unknown>,
	): Promise<void> {
		const strands = this.folds.some(
			(fold) => fold !== superseded && fold.follows && fold.streamDigest === superseded.streamDigest,
		);
		if (!superseded.follows && strands) {
			namedLogger.info(
				`drop-on-promotion DECLINED for {stream: ${superseded.record.stream}, processor: ` +
					`${superseded.record.processor}}: it WRITES a stream another generation follows, and dropping it would ` +
					`leave that one folding a stream nothing appends to. It is retained; delete it explicitly once nothing ` +
					`follows its stream.`,
			);
			return;
		}
		// Out of the held list FIRST, so nothing drives a fold whose state is being
		// dropped underneath it.
		this.folds.splice(this.folds.indexOf(superseded), 1);
		this.candidates.delete(superseded);
		try {
			const deletion = await this.registry.deleteGeneration(superseded.record);
			namedLogger.info(
				`dropped the superseded generation {stream: ${superseded.record.stream}, processor: ` +
					`${superseded.record.processor}} on the promotion of {stream: ${successor.record.stream}, processor: ` +
					`${successor.record.processor}}` +
					`${deletion.reaped ? `, reaping the stream ${deletion.reaped} with it` : ''}.`,
			);
		} catch (err) {
			namedLogger.error(
				`failed to drop the superseded generation {stream: ${superseded.record.stream}, processor: ` +
					`${superseded.record.processor}}`,
				err,
			);
		}
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
