import type {Abi} from 'abitype';
import {logs} from 'named-logs';

import type {GenerationContext, GenerationSpec} from './container.js';
import type {EmissionAppender} from './emissionStream.js';
import {generationDigestOf} from './generation/identity.js';
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
	slotHolding,
	SLOT_NAMES,
	unslottedGenerations,
	writerOf,
	type GenerationCaps,
	type GenerationDeletion,
	type GenerationId,
	type GenerationRecord,
	type GenerationRegistry,
	type GenerationRegistryPort,
	type SlottedGenerations,
} from './generation/registry.js';
import {resolveStreamConfig} from './internal/engine/utils.js';
import type {ReorgRecorder} from './reorgCounters.js';
import {StateMovedPublisher, type StateMovedDetach, type StateMovedHandler} from './stateMoved.js';
import {StreamBuilder, type GenerationContainer, type LogIngestion} from './streamBuilder.js';
import {streamDigestOf} from './stream/identity.js';
import type {
	EventProcessor,
	FoldReport,
	IndexingSource,
	ProcessorDriftReport,
	ProvidedStreamConfig,
	UsedStreamConfig,
} from './types.js';

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
 * ## A GENERATION IS HELD BY A DURABLE NAMED SLOT (ADR-0084)
 *
 * The registry holds three assignments and `canonical` is merely the first:
 * `successor` is the generation being built beside the incumbent and holds AT
 * MOST ONE, and `predecessor` is what a revert moves back to. `add` registers
 * into `successor`, so a second registration REPLACES the first pending one --
 * and because the slot is a ROW, a FRESH PROCESS replaces what it finds there
 * having registered nothing and remembered nothing, which is the property no
 * in-memory rule could have. What that replaced is DROPPED, exactly as this
 * container already dropped a superseded generation: the registry row, the state
 * namespace (ADR-0053) and the stream where nothing is left folding it.
 *
 * `predecessor` is ASSIGNED by the pointer move that creates one, in the same
 * commit, and is never inferred -- which generation a revert wants is precisely
 * the fact the rows never held, and the reason two in-memory sets used to stand
 * here (see where they were declared, below).
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
 * 2. **It publishes no state handle.** Reads on this runtime resolve the
 *    canonical pointer to a TABLE NAMESPACE (ADR-0053) rather than subscribing
 *    to a container, so `stateOf` is left out of `ReceivedGenerationSpec` and a
 *    host reaches the state it built through `HeldFold.state`. Moving the
 *    pointer BACK is `the-canonical-pointer-moves-back-without-re-ingesting`.
 *
 *    **That is a state HANDLE and never a NOTIFICATION**, and the two are
 *    deliberately not the same withholding. This container DOES tell the sides
 *    that are reading when it moved the state (`onStateMoved`, ADR-0083): every
 *    server and CLI deployment folds through THIS container, so a signal it did
 *    not publish would be a signal no deployment that runs on a server could
 *    have. What goes out is four facts and no data -- no rows, no mutations and,
 *    exactly as before, no state handle -- so a reader re-reads through the
 *    surface it already has, which on this runtime is the table namespace the
 *    canonical pointer names.
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
 * here, which this repository does not do: `stateOf` publishes a read HANDLE, and
 * nothing on this runtime reads through one -- a read tier answers over the
 * database, by resolving the canonical pointer to a table namespace (ADR-0053).
 * That is unchanged by this container publishing the state-moved SIGNAL
 * (`ReceivingIndexer.onStateMoved`): the signal says WHAT MOVED and carries no
 * handle, precisely so that a reader re-reads through the surface it already
 * has.
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

/**
 * ONE GENERATION RECLAIMED: what went, and what came back with it.
 *
 * NAMED rather than counted, which is the whole point of the report: an operator
 * runs the verb because a cap refused or because a disk is full, so "three
 * generations were reclaimed" leaves them exactly as uncertain as they were. The
 * IDENTITY is what they match against a listing, and the stream is the expensive
 * thing -- the raw logs, which a public node may not serve again -- so whether one
 * was reaped is the fact worth reading twice.
 */
export type ReclaimedGeneration = {
	/** The generation whose row and state namespace are gone (ADR-0053 makes that a `DROP`). */
	readonly generation: GenerationRecord;
	/** The stream reaped with it, present exactly when no registered generation was left folding it. */
	readonly reaped?: string;
	/** How many substrate records that reaped subtree held. Absent where no stream was reaped. */
	readonly records?: number;
};

/**
 * ONE GENERATION NOT RECLAIMED, and WHY -- because a verb that quietly did less
 * than it was asked to is worse than one that refused.
 *
 * Two reasons, and they are different situations for the operator. A generation
 * that WRITES a stream another held fold follows is kept on purpose (ADR-0044):
 * dropping it would leave that fold folding a stream nothing appends to, so it
 * goes once nothing follows its stream, and the answer is "ask again later". A
 * deletion that FAILED is the substrate saying no, and the generation is still
 * named by no slot, so the next call tries again.
 */
export type DeclinedReclaim = {
	/** The generation that was left alone. Its state and its stream are exactly where they were. */
	readonly generation: GenerationRecord;
	/** WHICH of the two situations this is. */
	readonly reason: 'writes-a-followed-stream' | 'deletion-failed';
	/** What to do about it, in words an operator can act on. */
	readonly message: string;
};

/**
 * WHAT ONE RECLAIM DID, in three outcomes that are deliberately not one shape
 * with a count in it.
 *
 * The three answers exist because "nothing happened" has three causes an operator
 * must be able to tell apart, exactly as `ReconfigureReport`'s do one surface out:
 *
 * - **`reclaimed`** -- at least one generation went, and `reclaimed` names each of
 *   them with what came back.
 * - **`declined`** -- something was reclaimABLE and none of it could go yet, with
 *   the reason per generation. Reporting this as "nothing to reclaim" would be a
 *   lie of exactly the kind the verb exists to end.
 * - **`nothing-to-reclaim`** -- every generation this indexer holds is named by a
 *   slot. A SUCCESS that says so, and distinguishable from having done work.
 *
 * `slots` carries what was NOT reclaimable and never could be: the generation that
 * answers reads, the pending successor and the revert target. It is in the report
 * because the operator asking "what did you free" is also asking "what is left",
 * and answering both from one read of the registry is what stops the two being
 * paired across somebody else's write.
 */
export type ReclaimReport = {
	/** WHICH of the three answers this is. */
	readonly outcome: 'reclaimed' | 'declined' | 'nothing-to-reclaim';
	/** Every generation that went, oldest last: the order they were dropped in. */
	readonly reclaimed: readonly ReclaimedGeneration[];
	/** Every generation no slot names that was NOT dropped, with the reason. */
	readonly declined: readonly DeclinedReclaim[];
	/** What each slot names, which is what a reclaim never touches. */
	readonly slots: SlottedGenerations;
	/** The whole of the above in one sentence, so a log line and a response say the same thing. */
	readonly message: string;
};

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
	 * THE SIGNAL, and the token it carries: what this container tells the sides that
	 * are READING (ADR-0083).
	 *
	 * The SAME class the chain-facing container holds and deliberately not a second
	 * implementation of it: there are two things in this system that apply blocks,
	 * both publish the same signal, and one notification model is the claim being
	 * made -- two producers that drift is how that claim dies. So the subscription,
	 * the containment of a throwing handler and the token's rotation are all
	 * `StateMovedPublisher`'s, and what is here is the half only a container knows:
	 * WHICH generation applied the block, and whether it is the one that answers
	 * reads.
	 *
	 * It matters most HERE rather than on the chain-facing twin: every server and
	 * CLI deployment folds through this container, so a reader of a hosted indexer
	 * has no other producer to be told by.
	 */
	protected readonly stateMoved = new StateMovedPublisher();

	/**
	 * THE FOLDS THIS INDEXER HOLDS, in the order they were added, at most ONE PER
	 * STREAM.
	 *
	 * Each carries a receiver, and a receiver is addressed by its stream's
	 * `{source, config}`: that is the map the ingest route selects through once the
	 * route segment has selected the indexer.
	 */
	private readonly folds: HeldFold<ABI, ProcessResultType, unknown>[] = [];

	/**
	 * BE TOLD that a fold this container holds adopted state computed by DIFFERENT
	 * handler code at the same declared version (`ProcessorDriftReport`).
	 *
	 * The same field the chain-facing container publishes, so a host wires ONE name
	 * whichever side of the wire it runs on. What it is NOT is the only surface: the
	 * report is logged at error level by whichever engine noticed it, so a deployment
	 * that sets nothing here still learns from its logs.
	 *
	 * Reports from EVERY held fold come through, and deliberately not the canonical
	 * one's alone as on the chain-facing side. A generation that answers no read yet
	 * is precisely the one being built to answer them next, and a report suppressed
	 * until it is promoted would arrive after the upgrade it was about. Which fold a
	 * report is about is `processorHash`.
	 */
	public onProcessorDrift: ((report: ProcessorDriftReport) => void) | undefined;

	/**
	 * What is handed to each engine, so the field above stays LIVE: a host that sets
	 * it after `openReceivingIndexer` returned -- which is every host, since the
	 * container builds its opening fold before it exists -- is still heard, and a
	 * receiver rebuilt by writer succession keeps the wiring.
	 */
	private readonly relayProcessorDrift = (report: ProcessorDriftReport): void => {
		this.onProcessorDrift?.(report);
	};

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

	/* ------------------------------------------------------------------------------
	 * WHAT USED TO BE HERE, and what reads it now (ADR-0084)
	 *
	 * Two in-memory sets stood here and both are DELETED rather than left beside the
	 * slot agreeing with it most of the time:
	 *
	 * - `everCanonical`, "which generations the pointer has ever named, as far as
	 *   THIS container has seen", which is how a REVERT was told from a PROMOTION.
	 *   The slots answer it durably and better: a promotion is a move onto what
	 *   `successor` names, and every other move -- a revert to what `predecessor`
	 *   names, or an operator naming any other generation -- drops nothing. What that
	 *   set actually held was a record of the moves ONE PROCESS had seen, so after a
	 *   restart it was empty and every move read as a revert.
	 * - `successorsAddedHere`, "which generations this container registered as a
	 *   successor since it opened", which was the only thing a drop could reach. Its
	 *   whole purpose was to approximate "this generation is a pending successor"
	 *   from what one process remembered, and that is exactly what the `successor`
	 *   slot IS -- durably, for every process, across every restart.
	 * ---------------------------------------------------------------------------- */

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

	/**
	 * WHICH held fold the canonical pointer names, as of the last time this container
	 * READ the pointer -- the one thing that must be answerable SYNCHRONOUSLY,
	 * because a fold reports a block from inside `process()` and only the canonical
	 * fold publishes.
	 *
	 * IN MEMORY, for the reason `candidates` above is: the registry records what a
	 * generation IS, and this is which HELD FOLD OBJECT answers for it right now,
	 * which is a fact about this process. It is DERIVED and never set by a caller --
	 * `noteCanonical` re-reads it
	 * from the records wherever this container already reads the pointer, which is
	 * every path that precedes a fold (`liveIngestions` before a batch is routed,
	 * `rebuildMore` before a chunk is replayed) as well as every move this process
	 * makes itself.
	 *
	 * `undefined` is a real answer and the common one on a redeployed host: the
	 * canonical generation needs no engine here (see the module JSDoc, rule 1), so a
	 * process holding only a successor holds no canonical fold and publishes nothing
	 * until the pointer moves onto one it does hold.
	 *
	 * What it COSTS is stated rather than discovered: a pointer moved by ANOTHER
	 * process is not seen until the next read, so this container can briefly publish
	 * from a fold that has just stopped being canonical elsewhere. That is the same
	 * in-process pointer the chain-facing container keeps (`Indexer.current`), and
	 * the signal is best-effort by decision -- the next notification after the read
	 * carries the truth, and the token the move rotated is what a reader acts on.
	 */
	private canonicalFold: HeldFold<ABI, ProcessResultType, unknown> | undefined;

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

	/**
	 * BE TOLD THE STATE MOVED: one notification per block the CANONICAL fold applied,
	 * and one per branch it took back, with a token that says whether anything else a
	 * reader holds may now be wrong (ADR-0083). Returns the detach.
	 *
	 * ```ts
	 * const detach = container.onStateMoved((moved) => {
	 *   if (moved.coherence !== held) {held = moved.coherence; return invalidateEverything();}
	 *   if (moved.kind === 'applied') for (const entity of moved.entities) invalidate(entity);
	 * });
	 * ```
	 *
	 * This is the HOST's attachment point, and it is the same name and the same shape
	 * as the chain-facing container's, so a transport adapts to ONE surface: the
	 * server registers this container under a name (`indexerEntryOn`,
	 * `@etherfold/server`, which forwards this method), and the CLI's `index` command
	 * forwards it on the entry it writes out.
	 *
	 * It is a SIGNAL and not a delivery of data: no rows, no mutations and no state
	 * handle, which is why it does not disturb rule 2 of the module JSDoc. Best-effort,
	 * with nothing held per subscriber: see `StateMovedPublisher`.
	 */
	onStateMoved(handler: StateMovedHandler): StateMovedDetach {
		return this.stateMoved.subscribe(handler);
	}

	/**
	 * THE COHERENCE TOKEN IN FORCE RIGHT NOW: the one the next notification will
	 * carry, read without waiting for one.
	 *
	 * OPAQUE exactly as it is on a notification -- COMPARED, never parsed -- and it is
	 * a READ rather than a second way of publishing: nothing rotates here, nothing is
	 * delivered, and a reader that asks twice between two blocks gets the same value.
	 *
	 * It exists for a transport that must tell a client, AT CONNECT, whether what that
	 * client already holds may be stale. The BROWSER transports need no such thing,
	 * because a tab attaching part way through simply READS the store it shares; a
	 * REMOTE reader has neither that store nor a state query surface yet (the query
	 * layer is deferred to `the-same-query-runs-against-a-worker-and-a-server`), so
	 * ADR-0083 makes its convergence "be told the current position and token on
	 * connect" instead. That is what this answers, and the server's state-moved
	 * stream is its one caller today.
	 *
	 * It is deliberately NOT a notification for a late joiner, which would have a
	 * reader invalidate for a block it may already have read: a notification is a
	 * thing that HAPPENED, and this is a fact about the producer's history.
	 */
	coherenceNow(): string {
		return this.stateMoved.token;
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
	async canonical(): Promise<GenerationRecord | undefined> {
		return this.noteCanonical(await this.registry.canonical());
	}

	/**
	 * WHAT EACH SLOT NAMES, resolved against the records, in ONE read (ADR-0084).
	 *
	 * The operator's SEE half, and the registry's own answer forwarded rather than
	 * re-derived: which generation answers reads, which one is pending beside it, and
	 * which one a revert would move back to. Everything registered and named by NONE
	 * of them is what `reclaim` takes, so the two are read from the same place and
	 * cannot disagree about what a slot holds.
	 *
	 * ONE read rather than three, for the reason the registry gives: the three answers
	 * are used together, and three reads could answer from either side of another
	 * process's write.
	 */
	async slots(): Promise<SlottedGenerations> {
		const held = await this.registry.slots();
		this.noteCanonical(held.canonical);
		return held;
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
		const canonical = this.noteCanonical(await this.registry.canonical());
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
		// ...and WHICH fold answers reads, for the same reason one step further out: the
		// batch this list is being answered for is about to be FOLDED, and only the
		// canonical fold publishes what it applied (ADR-0083). Read here rather than
		// cached at open, because the pointer is durable and shared.
		this.noteCanonical(await this.registry.canonical());
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
			onProcessorDrift: this.relayProcessorDrift,
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
	 * A cap REFUSES here and no GENERATION is left behind: the record is not
	 * written and no receiver is built, so nothing names or reads whatever the
	 * state factory happened to open.
	 *
	 * What a refusal MAY leave is storage the factory itself created, and that is the
	 * host's business rather than this container's: a factory that claims its store
	 * (`openForWriting`, ADR-0077) migrates, and the cap is enforced one step later
	 * because the record needs the processor's version hash, which needs the
	 * processor, which needs the state (ADR-0043). The CLI's SQL factory therefore
	 * leaves an empty namespace behind, reused verbatim if the bound is raised. This
	 * order cannot be swapped: a pre-check on the COUNT alone would refuse re-opening
	 * a generation this container already holds, which is the case `create`
	 * deliberately RESOLVES.
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

		const wanted: GenerationId = {stream: context.stream, processor: processor.getVersionHash()};
		// READ ONCE, BEFORE anything is registered or dropped. The SLOTS decide whether
		// this fold is a successor at all and what it displaces; the records decide which
		// held folds are still registered and which generation writes each stream.
		const registeredBefore = await this.registry.list();
		const slotsBefore = await this.registry.slots();
		const canonicalBefore = this.noteCanonical(slotsBefore.canonical);
		// WHAT THE SUCCESSOR SLOT HELD GOES FIRST, so the room this registration needs is
		// already free when the CAP is decided. It is deliberately not cap-PRESSURE
		// eviction: a replaced successor is dead the moment a newer one takes its place,
		// whether the registry holds two generations or none to spare, and a rule that
		// fired only near the bound would make a deterministic lifecycle a heuristic.
		await this.replaceTheSuccessor(wanted, registeredBefore, slotsBefore, context.stream);
		// INTO THE `successor` SLOT, which holds AT MOST ONE. The registry decides what
		// that means for this identity: the first generation of an empty registry takes
		// `canonical` instead, and a generation some slot ALREADY names stays where it is
		// -- so a restart on the canonical processor stays canonical, and one on the
		// generation a revert returned to is not re-armed by the act of starting up.
		const record = await this.registry.create(wanted, {slot: 'successor'});
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
							onProcessorDrift: this.relayProcessorDrift,
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
							onProcessorDrift: this.relayProcessorDrift,
						}),
					}),
		};
		this.folds.push(fold as HeldFold<ABI, ProcessResultType, unknown>);
		// WHICH fold answers reads, re-derived from what was just read and written rather
		// than inferred later: it is the fold added here when the pointer named it or took
		// it, and otherwise whichever held fold the pointer already named.
		this.noteCanonical(canonicalOnAdd ? record : canonicalBefore);
		// THE SIGNAL's relay, attached BEFORE anything folds and to EVERY fold rather
		// than to the canonical one: the pointer moves, and a relay attached only to the
		// fold that happens to be canonical now would have to be re-attached at every
		// promotion. The filter is in `publishFoldReport`, at the moment a report arrives.
		this.relayFoldReports(fold as HeldFold<ABI, ProcessResultType, unknown>, processor);
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
		// BEFORE the chunks, because a chunk FOLDS: only the canonical fold publishes what
		// it applied, and a follower re-folding a whole stored stream must publish nothing
		// (ADR-0083). Read here for the reason `liveIngestions` reads it -- the pointer is
		// durable and shared, so a move made elsewhere is seen where the records are.
		this.noteCanonical(await this.registry.canonical());
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
		const canonical = this.noteCanonical(await this.registry.canonical());
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
	 * fold is what the in-memory bookkeeping hangs off -- disarming it as a candidate
	 * -- and there is none for a generation this process was not built with, which is
	 * the ordinary post-redeploy revert (see `promote`).
	 */
	private async movePointer(
		id: GenerationId,
		fold: HeldFold<ABI, ProcessResultType, unknown> | undefined,
	): Promise<GenerationRecord> {
		const slotsBefore = await this.registry.slots();
		const supersededRecord = slotsBefore.canonical;
		/**
		 * WHICH KIND OF MOVE THIS IS, read from the SLOTS before it applies rather than
		 * from what this process happens to have seen.
		 *
		 * A PROMOTION is a move onto what `successor` names: that generation was built
		 * beside the incumbent precisely to take over, so a promotion demonstrated
		 * something and drop-on-promotion may discard what it superseded. EVERY OTHER
		 * MOVE DROPS NOTHING -- a move back to what `predecessor` names is a revert, and
		 * an operator naming any other generation is treated the same way, which is the
		 * safe direction: the only consequence is that a generation is kept.
		 *
		 * This is what `everCanonical` used to approximate in memory, and it is strictly
		 * better: that set was empty after a restart, so a restarted process read every
		 * move as a revert and a genuine promotion dropped nothing.
		 */
		const wasPromotion = !!slotsBefore.successor && sameGeneration(slotsBefore.successor, id);
		const record = await this.registry.moveCanonicalTo(id);
		if (!supersededRecord || !sameGeneration(supersededRecord, record)) {
			// THE TOKEN ROTATES, because a DIFFERENT FOLD answers from here on and that is
			// indistinguishable, to a cache, from "everything you hold may be wrong"
			// (ADR-0083). The same mechanism a retraction uses and deliberately not a second
			// event kind, and the same one line at the same point the chain-facing container
			// puts it at (`Indexer.movePointerTo`) -- one rule, two containers.
			//
			// Nothing is PUBLISHED here: a pointer move has no block to name and no fold
			// applied anything, so what a reader receives is the NEXT notification carrying a
			// token it has never seen. AFTER the registry write, so a move that did not happen
			// does not invalidate every reader's cache; and EVERY move rather than the forward
			// ones alone, because a REVERT changes which fold answers exactly as a promotion
			// does, which is the only thing a reader can see of either.
			this.stateMoved.rotate(
				`a pointer move: reads are answered by the generation {stream: ${record.stream}, processor: ` +
					`${record.processor}} from here on`,
			);
		}
		// The fold that answers reads NOW, which is what the publication filter reads.
		// `undefined` where this container holds no fold for the target, which is the
		// ordinary post-redeploy revert: nothing here publishes then, and nothing should.
		this.noteCanonical(record);
		if (fold) {
			// It is canonical: it is no longer waiting to become so, and a REVERT past it
			// later must not re-promote it on the next chunk. The registry took it out of the
			// `successor` slot in the same commit as the move, for the same reason.
			this.candidates.delete(fold);
		}
		if (!supersededRecord || sameGeneration(supersededRecord, record)) {
			return record;
		}
		namedLogger.info(
			`the canonical pointer moved ${wasPromotion ? '' : 'BACK '}to {stream: ${record.stream}, processor: ` +
				`${record.processor}}. The generation {stream: ${supersededRecord.stream}, processor: ` +
				`${supersededRecord.processor}} is what \`predecessor\` names from here on: it keeps its own state, keeps ` +
				`folding, and is what the pointer moves BACK to.`,
		);
		const superseded = this.folds.find((held) => sameGeneration(held.record, supersededRecord));
		// A MOVE THAT IS NOT A PROMOTION DROPS NOTHING, which is the chain-facing
		// container's rule (`arrangeDrop`) and ADR-0046's: drop-on-promotion discards a
		// generation a promotion SUPERSEDED, and a revert supersedes nothing -- it moves
		// away from a generation that is exactly what a second move forward would want
		// back.
		if (this.promotionConfig.dropOnPromotion && superseded && wasPromotion) {
			await this.dropSuperseded(superseded, record);
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
		successor: GenerationRecord,
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
		// ...and nothing relays what it did: this container no longer drives it, and a
		// dropped fold that went on reporting would be a channel into a publisher nothing
		// can reach it through any more.
		superseded.processor.setFoldReporter?.(undefined);
		try {
			const deletion = await this.registry.deleteGeneration(superseded.record);
			namedLogger.info(
				`dropped the superseded generation {stream: ${superseded.record.stream}, processor: ` +
					`${superseded.record.processor}} on the promotion of {stream: ${successor.stream}, processor: ` +
					`${successor.processor}}` +
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

	// ------------------------------------------------------------------------------------------------------------------
	// THE OTHER HALF OF THE LIFECYCLE: the SUCCESSOR SLOT holds ONE, so a newer one REPLACES it
	// ------------------------------------------------------------------------------------------------------------------

	/**
	 * MAKE ROOM IN THE `successor` SLOT, because the registration about to happen is
	 * what takes it.
	 *
	 * The container knew ONE kind of supersession and it is a PROMOTION: the incumbent
	 * becomes the predecessor and is RETAINED, because the pointer must be able to
	 * move back to it (`dropSuperseded`, above). This is the other half. A successor
	 * that is still catching up and that a NEWER one has just replaced is dead work in
	 * every case and a WALL in the one that matters: it keeps its registry row, keeps
	 * its state namespace and keeps being advanced by the scheduled rebuild, so a
	 * developer saving twice, or a deployment whose `version` is generated at build
	 * time, reaches `maxGenerations` within a few tries and has to delete generations by
	 * hand. A cap is the right mechanism against slow accumulation and the wrong one
	 * against CHURN, so the count is bounded by dropping what is provably dead rather
	 * than by raising a bound, which only moves the wall.
	 *
	 * ## The PREDICATE is the whole safety argument, and it is now a ROW
	 *
	 * "Not canonical right now" is NOT the test: a predecessor kept for a revert is not
	 * canonical right now either, and dropping it would silently destroy the way back.
	 * Nor is it "has never been canonical", which is the question the rows cannot
	 * answer and which the previous rule approximated IN MEMORY, from what one process
	 * had registered and seen since it opened -- so a restart answered "nothing" and
	 * dropped nothing. The test is now the SLOT: a generation `successor` names is a
	 * pending successor, and one that `canonical` or `predecessor` names is not
	 * reachable from here at all. That is a durable fact any process reads, which is
	 * why a FRESH process replaces what it finds in the slot having remembered nothing
	 * (ADR-0084).
	 *
	 * Two kinds of generation are dropped and they are the same rule seen twice: what
	 * the slot NAMES (whether or not a fold for it is held here -- after a restart it
	 * is not), and every fold THIS CONTAINER HOLDS that no slot names, which is what a
	 * declined drop leaves behind. A generation this container holds no fold for and no
	 * slot names is left alone: reclaiming those is an operator's verb
	 * (`a-generation-no-slot-names-is-reclaimed-on-request`), not something a
	 * registration does to rows it never touched.
	 *
	 * ## "THE SAME ROLE" MEANS THE SLOT, REGARDLESS OF STREAM
	 *
	 * There is ONE `successor` slot, so the cross-stream question is answered
	 * structurally rather than by fiat: a newer successor replaces the pending one
	 * wherever either sits, because there is only one place for a pending successor to
	 * be. That is also what frees a STREAM slot -- `maxStreams` counts the distinct
	 * streams among registered generations, and the churn this exists for opens with a
	 * source change.
	 *
	 * NEWEST FIRST, which is what lets a whole replaced chain go in ONE pass: the
	 * ordinary churn leaves a replaced WRITER with a replaced FOLLOWER on its stream,
	 * and the writer is only droppable once the follower is gone (see
	 * `wouldStrandAFollower`). A follower is always the younger of the two, so walking
	 * back to front drops them in the order that frees both.
	 */
	private async replaceTheSuccessor(
		arriving: GenerationId,
		registered: readonly GenerationRecord[],
		slots: SlottedGenerations,
		arrivingStream: string,
	): Promise<void> {
		// A fold that IS the canonical generation, or one some slot already names, takes
		// nobody's place: `create` leaves it where it is, so nothing is displaced and
		// nothing may be dropped for it.
		if (!slots.canonical || slotHolding(slots, arriving)) return;

		const displaced = [...registered]
			.filter((record) => {
				if (sameGeneration(record, arriving)) return false;
				const slot = slotHolding(slots, record);
				// THE PROPERTY THE WHOLE RULE IS SAFE ON, asserted here rather than left to
				// follow from the loop below: a generation ANY OTHER slot names is untouchable,
				// which covers the incumbent and the revert target in ONE clause.
				if (slot) return slot === 'successor';
				// ...and what a declined drop left behind: a fold held here that no slot names.
				return this.folds.some((fold) => sameGeneration(fold.record, record));
			})
			.sort((a, b) => b.createdAt - a.createdAt);

		const surviving = [...registered];
		for (const record of displaced) {
			if (this.wouldStrandAFollower(record, surviving, arrivingStream)) {
				namedLogger.info(
					`the replaced successor {stream: ${record.stream}, processor: ${record.processor}} is RETAINED for now: ` +
						`it WRITES the stream ${record.stream}, which another fold here follows, and dropping it would leave ` +
						`that one folding a stream nothing appends to (ADR-0044). No slot names it any more, so it goes when ` +
						`nothing follows its stream -- or when an operator reclaims what no slot names.`,
				);
				continue;
			}
			if (await this.dropReplaced(record, arriving)) {
				surviving.splice(
					surviving.findIndex((held) => sameGeneration(held, record)),
					1,
				);
			}
		}
	}

	/**
	 * Whether dropping this generation would leave a stream being folded by something
	 * with nothing appending to it.
	 *
	 * `dropSuperseded`'s rule, applied one moment earlier and with one more follower in
	 * view. Which generation WRITES a stream is the oldest SURVIVING one registered on
	 * it (ADR-0044), so dropping a writer another held generation follows leaves that
	 * one folding a stream nothing appends to. The fold about to be ADDED counts as such
	 * a follower, because it is about to be one: it was already decided to FOLLOW this
	 * stream (a stream is ONE address on the wire), and dropping its writer here would
	 * also reap the stored stream out from under it and send it back to the chain for
	 * a history it already has.
	 *
	 * It reads the RECORDS rather than a held fold's `writesStream`, because the
	 * generation the slot names may be one this process holds no fold for at all --
	 * which is exactly the restart case, and the case the durable slot exists for.
	 *
	 * `arrivingStream` is ABSENT where nothing is arriving, which is the operator's
	 * `reclaim`: there the followers to protect are the ones already held, and there
	 * is no fold about to become one.
	 */
	private wouldStrandAFollower(
		record: GenerationRecord,
		registered: readonly GenerationRecord[],
		arrivingStream: string | undefined,
	): boolean {
		const writer = writerOf(registered, record.stream);
		if (!writer || !sameGeneration(writer, record)) return false;
		if (arrivingStream !== undefined && record.stream === arrivingStream) return true;
		return this.folds.some(
			(held) => !sameGeneration(held.record, record) && held.follows && held.streamDigest === record.stream,
		);
	}

	/**
	 * Drop ONE replaced successor: its registry row, its state namespace, and every
	 * trace of it in this container.
	 *
	 * Deleting a generation is already a `DROP` of its table namespace, injected by
	 * whoever named the tables (ADR-0053) and performed by the registry, so nothing new
	 * is invented here: what is new is deciding WHEN, without being asked. The stream is
	 * REAPED with it exactly when no registered generation is left folding it, which is
	 * the registry's own rule and the reason the drop is declined above where anything
	 * still needs it.
	 *
	 * The REGISTRY GOES FIRST, which is the opposite order from `dropSuperseded` and
	 * deliberately so: there the drop is the last act of a promotion that has already
	 * happened, while here a registration is about to be decided on the result, so a
	 * failure must leave the container exactly as it was rather than holding a fold it
	 * has stopped driving. Nothing folds into it in the meantime either -- both drive
	 * paths (`liveIngestions`, `rebuildMore`) skip a fold whose generation is no longer
	 * registered.
	 *
	 * A FAILED DROP DOES NOT STOP THE REPLACEMENT, and the slot is what makes that
	 * safe: the arriving generation takes `successor` regardless, so what failed to go
	 * is left named by no slot -- which is the definition of collectable, and the next
	 * registration (or the operator's reclaim verb) tries again. Refusing the
	 * registration instead would make a stuck deletion an outage for the deployment
	 * that is trying to move forward.
	 *
	 * It is REPORTED rather than silent, because an operator watching a development
	 * loop must see bounded churn instead of generations quietly disappearing.
	 */
	private async dropReplaced(record: GenerationRecord, arriving: GenerationId): Promise<boolean> {
		let reaped: string | undefined;
		try {
			reaped = (await this.registry.deleteGeneration(record)).reaped;
		} catch (err) {
			namedLogger.error(
				`failed to drop the replaced successor {stream: ${record.stream}, processor: ${record.processor}}; it is ` +
					`still registered, and the arriving generation takes the \`successor\` slot anyway -- so nothing names it ` +
					`and it can be reclaimed later`,
				err,
			);
			return false;
		}
		this.stopDriving(record);
		namedLogger.info(
			`the generation {stream: ${record.stream}, processor: ${record.processor}} was what the \`successor\` slot ` +
				`held, and {stream: ${arriving.stream}, processor: ${arriving.processor}} REPLACES it there: the slot holds ` +
				`AT MOST ONE, so it has been DROPPED. It was safe because no slot named it once it was replaced -- it is ` +
				`neither the canonical generation nor what \`predecessor\` holds, so nothing can revert to it and re-folding ` +
				`it would be work for a result nobody will ever ask for. Its state namespace is gone` +
				`${reaped ? `, and the stream ${reaped} was reaped with it, no registered generation being left on it` : ''}. ` +
				`The canonical generation and the revert target are untouched.`,
		);
		return true;
	}

	/**
	 * STOP DRIVING a generation whose record has gone: out of the held folds, out of
	 * the armed candidates, out of the memo, and off the reporter.
	 *
	 * One function rather than the same four lines wherever a generation is deleted,
	 * because the fourth is the one that is easy to forget and the worst to omit: a
	 * dropped fold that went on REPORTING would be a channel into a publisher nothing
	 * can reach it through any more. The memo matters for the opposite reason -- a
	 * later fold on the same identity must be REGISTERED again rather than resolved
	 * from a record that no longer exists.
	 *
	 * A generation this container holds no fold for is the ordinary case (a restart
	 * holds only its own), and then there is simply nothing to stop driving.
	 */
	private stopDriving(record: GenerationId): void {
		const fold = this.folds.find((held) => sameGeneration(held.record, record));
		if (fold) {
			this.folds.splice(this.folds.indexOf(fold), 1);
			this.candidates.delete(fold);
			fold.processor.setFoldReporter?.(undefined);
		}
		this.records.delete(keyOf(record));
	}

	// ------------------------------------------------------------------------------------------------------------------
	// THE OPERATOR'S VERB: RECLAIM every generation no slot names
	// ------------------------------------------------------------------------------------------------------------------

	/**
	 * RECLAIM WHAT NOTHING NAMES: drop every registered generation no slot holds, and
	 * report what came back.
	 *
	 * ## Why this exists at all
	 *
	 * A cap REFUSES at its bound and never evicts, which is sound and was the ONLY
	 * instrument an operator had: when it fires they are told what they COULD delete
	 * and given nothing to delete it with, so the remedy was hand-written SQL or a
	 * deleted database. Slots make the missing verb expressible for the first time --
	 * a generation no slot names is garbage BY DEFINITION rather than by an operator's
	 * judgement about digests and timestamps (ADR-0084) -- and the deletion itself is
	 * not new: it is the registry's `deleteGeneration`, which drops the row, drops the
	 * state namespace (ADR-0053 makes that a `DROP`) and REAPS the stream where no
	 * registered generation is left folding it.
	 *
	 * ## It is a VERB an operator runs, and deliberately NOT a garbage COLLECTOR
	 *
	 * Nothing calls it on a timer and nothing calls it at `open`. An automatic reclaim
	 * is a different decision with a different risk profile -- it deletes with nobody
	 * present -- and ADR-0084 does not make it. The one deletion that DOES happen
	 * without being asked is bounded to what a registration itself displaced
	 * (`replaceTheSuccessor`), which is a generation this process just replaced rather
	 * than rows it never touched.
	 *
	 * The CAPS are untouched by it. This gives an operator an instrument; it does not
	 * raise a bound or make a refusal less likely.
	 *
	 * ## What it will NEVER take, which is the property that makes it safe
	 *
	 * A generation ANY slot names -- and `predecessor` is the one worth saying out
	 * loud, because it is not canonical right now and is exactly the way back from a
	 * bad upgrade. The rule is read as a REFCOUNT over the slot rows
	 * (`unslottedGenerations`) and never as "not canonical", which would delete the
	 * revert target and the pending successor both.
	 *
	 * It also DECLINES, rather than refusing the whole call, where dropping would
	 * leave a fold folding a stream nothing appends to: the writer of a stream another
	 * held fold follows is kept (ADR-0044), exactly as the existing drops decline it.
	 * NEWEST FIRST, so a replaced follower goes before the writer it strands, and one
	 * pass frees both.
	 */
	async reclaim(): Promise<ReclaimReport> {
		// ONE read of the records and ONE of the slots, before anything is dropped: the
		// rule is a comparison between the two, and reading them twice could pair a
		// listing with slot assignments from either side of another process's write.
		const registered = await this.registry.list();
		const slots = await this.registry.slots();
		this.noteCanonical(slots.canonical);

		const garbage = unslottedGenerations(registered, slots).sort((a, b) => b.createdAt - a.createdAt);
		const reclaimed: ReclaimedGeneration[] = [];
		const declined: DeclinedReclaim[] = [];
		const surviving = [...registered];

		for (const record of garbage) {
			if (this.wouldStrandAFollower(record, surviving, undefined)) {
				const message =
					`it WRITES the stream ${record.stream}, which another fold held here FOLLOWS, and dropping it would ` +
					`leave that one folding a stream nothing appends to (ADR-0044). It is retained with its state and its ` +
					`stream exactly where they were; no slot names it, so it goes on the next reclaim once nothing follows ` +
					`its stream.`;
				namedLogger.info(`reclaim DECLINED for {stream: ${record.stream}, processor: ${record.processor}}: ${message}`);
				declined.push({generation: record, reason: 'writes-a-followed-stream', message});
				continue;
			}
			let deletion: GenerationDeletion;
			try {
				deletion = await this.registry.deleteGeneration(record);
			} catch (err) {
				const message =
					`it could not be deleted (${err instanceof Error ? err.message : String(err)}). It is still ` +
					`registered and still named by no slot, so nothing reads it and the next reclaim tries again.`;
				namedLogger.error(
					`reclaim FAILED for {stream: ${record.stream}, processor: ${record.processor}}: ${message}`,
					err,
				);
				declined.push({generation: record, reason: 'deletion-failed', message});
				continue;
			}
			// ...and this container stops driving it, for the reason a replaced successor
			// does: its state has been dropped, so folding into it would be writing into
			// nothing.
			this.stopDriving(record);
			surviving.splice(
				surviving.findIndex((held) => sameGeneration(held, record)),
				1,
			);
			reclaimed.push({
				generation: record,
				...(deletion.reaped === undefined ? {} : {reaped: deletion.reaped}),
				...(deletion.records === undefined ? {} : {records: deletion.records}),
			});
			namedLogger.info(
				`RECLAIMED the generation {stream: ${record.stream}, processor: ${record.processor}}: no slot named it, ` +
					`so nothing answered reads from it, nothing could revert to it and nothing was waiting for it to catch ` +
					`up. Its registry row and its state namespace are gone` +
					`${
						deletion.reaped
							? `, and the stream ${deletion.reaped} was reaped with it (${deletion.records ?? 0} record(s)), no ` +
								`registered generation being left folding it`
							: ''
					}.`,
			);
		}

		const report: ReclaimReport = {
			outcome: reclaimed.length > 0 ? 'reclaimed' : declined.length > 0 ? 'declined' : 'nothing-to-reclaim',
			reclaimed,
			declined,
			slots,
			message: reclaimMessage(reclaimed, declined, slots),
		};
		namedLogger.info(`reclaim: ${report.message}`);
		return report;
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
	// ------------------------------------------------------------------------------------------------------------------
	// THE SIGNAL: which fold answers reads, and what it tells the sides that are reading
	// ------------------------------------------------------------------------------------------------------------------

	/**
	 * Remember WHICH HELD FOLD this record names, and hand the record back unchanged.
	 *
	 * Called wherever this container already reads or writes the canonical pointer, so
	 * there is no read added for it anywhere the pointer was not being consulted
	 * anyway -- except deliberately on the two paths that PRECEDE a fold
	 * (`liveIngestions`, `rebuildMore`), where the answer is what decides whether the
	 * blocks about to be applied are published at all.
	 *
	 * A record naming a generation this container holds no FOLD for leaves it
	 * `undefined`, which is a real state and not a failure: reads here are answered
	 * from a table namespace with no engine (module JSDoc, rule 1), so a host may
	 * perfectly well fold only generations that do not answer reads -- and it must
	 * then publish nothing.
	 */
	private noteCanonical(record: GenerationRecord | undefined): GenerationRecord | undefined {
		this.canonicalFold = record ? this.folds.find((fold) => sameGeneration(fold.record, record)) : undefined;
		return record;
	}

	/**
	 * RELAY: hand this fold the reporter it names what it did to.
	 *
	 * The entity set is produced where the mutations are, and the fork point where the
	 * `removed` markers are read and `revertTo` is called -- both one package down --
	 * and this container assembles the signal from them plus what only a container
	 * holds (ADR-0083). It is the chain-facing container's `relayFoldReports` over this
	 * container's own unit of bookkeeping, so a fold reports through ONE channel
	 * whichever container is driving it.
	 *
	 * A fold that implements nothing here reports nothing and therefore publishes
	 * nothing, which is the honest coarse answer rather than a fabricated one: core
	 * cannot know which blocks such a fold applied, what they touched, or what it took
	 * back.
	 */
	private relayFoldReports(
		fold: HeldFold<ABI, ProcessResultType, unknown>,
		processor: EventProcessor<ABI, ProcessResultType>,
	): void {
		processor.setFoldReporter?.((report) => this.publishFoldReport(fold, report));
	}

	/**
	 * ASSEMBLE and PUBLISH one thing a fold did, and ONLY for the CANONICAL fold.
	 *
	 * Every rule here is the chain-facing container's (`Indexer.publishFoldReport`),
	 * consumed rather than restated, because both containers publish ONE signal.
	 *
	 * The FILTER is the load-bearing half on this runtime: a follower here re-folds a
	 * whole stored stream to catch up (`GenerationRebuild`), so publishing per block
	 * there would fire one notification per past block while nothing a reader can see
	 * has moved -- thousands of them, on the deployment shape an upgrade actually
	 * takes. It covers the TOKEN as well as the notification, so a follower replaying
	 * a stored stream's reorg rotates nothing; rotating there would have every reader
	 * of the canonical fold throw its cache away because a second generation caught up.
	 *
	 * It fires AS THE BLOCK LANDS, inside the `process()` call that applied it, which
	 * is safe in the direction that matters: a block and its cursor are ONE atomic unit
	 * behind the storage seam (ADR-0027), so a reader that re-reads the instant it is
	 * told sees that block's effects. Holding the reports back until the batch was
	 * acknowledged would BUFFER, which is the one thing the producer must not do.
	 */
	private publishFoldReport(fold: HeldFold<ABI, ProcessResultType, unknown>, report: FoldReport): void {
		if (fold !== this.canonicalFold) {
			return;
		}
		// Rendered as everything that REPORTS which generation answered already renders it
		// (`generationDigestOf`): ONE opaque value, compared and never parsed.
		const generation = generationDigestOf(fold.record);
		if (report.kind === 'retracted') {
			// ROTATES as it publishes, inside the publisher: see `publishRetraction`.
			this.stateMoved.publishRetraction({forkPoint: report.forkPoint, generation});
			return;
		}
		this.stateMoved.publish({
			block: report.block,
			entities: report.entities,
			generation,
		});
	}

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

/**
 * WHAT A RECLAIM DID, in one sentence that NAMES things.
 *
 * An operator runs the verb because something refused or because a disk is full,
 * so a count on its own -- "reclaimed three generations" -- leaves them exactly as
 * uncertain as they were: which three, and did anything actually come back? So the
 * sentence names each generation, says which streams were reaped and how many
 * records went with them, and says what is still held and why nothing else could
 * go.
 *
 * It is built ONCE and carried on the report, rather than rendered again by every
 * surface that reports one, so a log line and an HTTP response say the same thing.
 */
function reclaimMessage(
	reclaimed: readonly ReclaimedGeneration[],
	declined: readonly DeclinedReclaim[],
	slots: SlottedGenerations,
): string {
	const named = (id: GenerationId) => `{stream: ${id.stream}, processor: ${id.processor}}`;
	const holding = SLOT_NAMES.filter((name) => !!slots[name])
		.map((name) => `${name} ${named(slots[name] as GenerationRecord)}`)
		.join(', ');
	const held = holding.length > 0 ? `What the slots hold is untouched: ${holding}.` : `No slot holds anything.`;

	if (reclaimed.length === 0 && declined.length === 0) {
		return `NOTHING was reclaimed, because every generation this indexer holds is named by a slot. ${held}`;
	}
	const went =
		reclaimed.length === 0
			? `NOTHING was reclaimed.`
			: `RECLAIMED ${reclaimed.length} generation(s) no slot named: ${reclaimed
					.map(
						(one) =>
							`${named(one.generation)}${
								one.reaped ? ` (its stream ${one.reaped} was reaped with it, ${one.records ?? 0} record(s))` : ''
							}`,
					)
					.join(', ')}. Each one's state namespace is gone.`;
	const kept =
		declined.length === 0
			? ''
			: ` ${declined.length} was/were named by no slot and NOT taken: ${declined
					.map((one) => `${named(one.generation)} -- ${one.message}`)
					.join(' ')}`;
	return `${went}${kept} ${held}`;
}
