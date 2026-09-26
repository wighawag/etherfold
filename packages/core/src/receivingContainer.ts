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
	displacedBySuccessor,
	openGenerationRegistry,
	sameGeneration,
	slotHolding,
	SLOT_NAMES,
	unslottedGenerations,
	type GenerationCaps,
	type GenerationDeletion,
	type GenerationId,
	type GenerationRecord,
	type GenerationRegistry,
	type GenerationRegistryPort,
	type SlottedGenerations,
	UnknownGenerationError,
} from './generation/registry.js';
import {resolveStreamConfig} from './internal/engine/utils.js';
import {requireProcessorIdentity} from './internal/processorIdentity.js';
import type {ReorgRecorder} from './reorgCounters.js';
import {StateMovedPublisher, type StateMovedDetach, type StateMovedHandler} from './stateMoved.js';
import type {GenerationContainer, LogIngestion} from './streamBuilder.js';
import {streamDigestOf} from './stream/identity.js';
import {StreamWriter, type StreamCursorSource, type StreamDelta} from './stream/writer.js';
import type {EventProcessor, FoldReport, IndexingSource, ProvidedStreamConfig, UsedStreamConfig} from './types.js';

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
 * REGISTERS it under the identity the ARRIVAL supplied (ADR-0086), so nothing
 * declares an identity twice.
 *
 * ## The MODEL is `@etherfold/core`'s already and is consumed UNCHANGED
 *
 * Generation identity, stream identity, the caps and their refusal, the
 * registration-resolves rule and the first-generation-is-canonical rule are all
 * `openGenerationRegistry`'s, and `resolveGeneration` is a lookup over it rather
 * than a second copy of any of them. The two factories are `GenerationSpec`'s,
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
 * ## EVERY GENERATION FOLDS THE STREAM; THE DEPLOYMENT FETCHES IT (ADR-0087)
 *
 * The `follows` question DISSOLVED. It used to decide which ONE fold per stream
 * got the receiver and the pen, and which ones re-folded what that one stored --
 * so it was the election in another spelling, and it inherited the election's
 * defect: the fold it named could be a generation this process holds no fold for.
 *
 * Under ADR-0087 there is nothing to decide. The receiver at a stream's address
 * is the `StreamWriter` -- the DEPLOYMENT's own writer of that stream, positioned
 * from the STREAM's stored coverage claim and from no fold -- and EVERY generation
 * over that stream READS it. So a fold is one shape and not two: it has a
 * `GenerationRebuild` and never a receiver.
 *
 * A fold advances TWO ways and they are ONE code path (`GenerationRebuild`): it
 * takes the delta the writer just appended if it is LEVEL with it, and otherwise
 * its bounded rebuild reads the stored rows back. The offer is made AFTER the
 * append, so what a fold does or does not take changes nothing about what was
 * stored -- which is the whole difference from the hand-over ADR-0087 rejects.
 *
 * The catch-up itself is a call the HOST SCHEDULES (`rebuildMore`, ADR-0022),
 * never a side effect of a batch: a rebuild takes arbitrarily long and a
 * serverless host cannot hold a loop.
 *
 * WHICH wire contexts are LIVE is DERIVED from the registry (`liveIngestions`)
 * rather than from any rule about promotion: a stream's writer is live while at
 * least one registered generation this container holds folds that stream. So a
 * deployment whose every held fold is a SUCCESSOR re-folding stored history STILL
 * FETCHES, which is exactly the failure this replaces -- a restarted deployment
 * that asked the node for `["eth_chainId"]` and nothing else, for ever.
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
 * ## THE ONE-WRITER RULE IS KEPT AND ITS SUBJECT MOVED (ADR-0052/ADR-0044/ADR-0087)
 *
 * A stored stream still has exactly ONE writer, and a second history on it is
 * still the worst thing that can happen here -- the stream is what every later
 * generation re-folds. What changed is WHICH THING: it is the deployment's
 * `StreamWriter` for that stream, of which this container holds one per stream,
 * so "one writer" is a fact about the object graph rather than a duty handed to
 * one of several folds. No generation is ever given an appender at all.
 *
 * ## A STREAM OUTLIVES EVERY FOLD OVER IT
 *
 * Nothing here reaps a stream. Dropping a generation -- whether a registration
 * displaced it or a promotion superseded it -- takes its registry row and its
 * state namespace and leaves the stream exactly where it is, RECORDED by the
 * registry so the sweep on the next open does not undo the keep. Deletion is a
 * VERB: `reclaim` reaps what an operator asks for, and `deleteStream` is
 * unchanged.
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
	'createState' | 'createProcessor' | 'source' | 'processorIdentity'
> & {
	/** The stream CONFIG this fold runs, when it is not the container's own. Hashed into both identities. */
	stream?: ProvidedStreamConfig;
	/**
	 * THE BUNDLE THAT FOLDS THIS GENERATION: the exact octets whose hash is
	 * `processorIdentity` (ADR-0086), which the registration STORES beside the
	 * generation's state and deletes with it (ADR-0092).
	 *
	 * REQUIRED, because this container is what a Node deployment folds through, and on
	 * that runtime holding a generation means holding something runnable rather than
	 * something readable. A spec without one is REFUSED at `add` before anything is
	 * built: an optional field would make two classes of generation, resumable and
	 * frozen, differing invisibly until the day a revert needs the difference -- which
	 * is the "optional bundling" ADR-0092 rejects, and ADR-0086's deleted `version`
	 * growing back as a registration nothing names by its bytes.
	 *
	 * The container does not re-hash it: core cannot, since the derivation is the
	 * ARRIVAL's (`processorArtifactIdentity`, `@etherfold/utils`), and a host hands
	 * over the identity and the bytes that one arrival produced together.
	 */
	bundle: Uint8Array;
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
	/**
	 * The fetch filter a fold that names none of its own folds, which is half the stream
	 * identity: the source this deployment was CONFIGURED to fetch.
	 *
	 * OPTIONAL, and absent only together with `generation`, for a deployment started
	 * with NOTHING configured (ADR-0093). Such a container is not handed a placeholder:
	 * it holds no source until its FIRST FOLD brings one (`fetchedSource`) -- the
	 * canonical generation instantiated at `open` from its stored bundle, or the first
	 * generation an arrival adds -- and every spec it is handed must then name its own.
	 */
	source?: IndexingSource<ABI>;
	/** The stream config, which is the other half. Resolved and hashed into both identities. */
	stream?: ProvidedStreamConfig;
	/**
	 * The fold THIS host opens with: its state, then the processor over it. Others arrive
	 * through `add`.
	 *
	 * ABSENT on a deployment started with NOTHING configured (ADR-0093), which is a MODE
	 * and not a default: `open` then registers nothing of its own, instantiates the
	 * registry's canonical generation from its stored bundle where there is one, and
	 * otherwise holds no fold at all until one ARRIVES through `add`. No placeholder
	 * generation stands in for the missing one, because a defaulted fold is the thing
	 * ADR-0048 refuses: it folds something nobody chose and looks healthy doing it.
	 */
	generation?: ReceivedGenerationSpec<ABI, ProcessResultType, State>;
	/** Where a concluded reorg is counted (ADR-0050). Handed to every receiver unchanged. */
	recordReorg?: ReorgRecorder;
	/**
	 * Where the stream this deployment FETCHES is stored (ADR-0052, ADR-0087).
	 *
	 * Handed to the `StreamWriter` of each stream and to NO fold. It used to be
	 * handed to whichever fold `writerOf` elected, which is the duty ADR-0087 takes
	 * off the generation: a fold never appends, so there is no gate left to get wrong.
	 *
	 * One of the STREAM's THREE ENDS, supplied together by the host that owns the
	 * database: this one WRITES, `streamCursor` says where the stream REACHES, and
	 * `replay` READS it back in bounded slices.
	 */
	appendEmissions?: EmissionAppender;
	/**
	 * WHERE THE STREAM'S OWN POSITION IS READ (`streamCursorSourceOn`,
	 * `@etherfold/server`).
	 *
	 * The half that makes moving the write duty SAFE. Whatever answers
	 * `expectedFromBlock` must be the STREAM's position rather than any one fold's,
	 * or a restarted deployment with an empty-state successor asks for history the
	 * stream already holds and stores it a second time (measured: 4 rows where 2 are
	 * correct). Supplied beside `appendEmissions`, because it is the same rows read
	 * the other way.
	 */
	streamCursor?: StreamCursorSource;
	/**
	 * Where the STORED stream is read back, in bounded slices, so a fold can catch
	 * up (`storedEmissionReplaySource`, `@etherfold/server`).
	 *
	 * The read counterpart of `appendEmissions`, supplied by the same host over the
	 * same database, and required for the same reason that one is: this package
	 * knows no database. EVERY generation here folds the stored stream (ADR-0087), so
	 * a container given none can hold no fold at all and `add` REFUSES rather than
	 * registering a generation that could never advance.
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
	/**
	 * HOW STORED BYTES BECOME A FOLD: the host's answer, injected, and never this
	 * package's (ADR-0092).
	 *
	 * A Node deployment stores each generation's bundle on its registry row, so the
	 * generation a revert moves the pointer onto is something this deployment can RUN
	 * again even when the running build carries only the new processor. Turning those
	 * bytes into a processor is the loader's (`loadProcessorArtifact`,
	 * `@etherfold/utils`), and `@etherfold/utils` depends on this package, so the
	 * container cannot call it: the host supplies it, the same way it supplies
	 * `dropState` and `readStateCursor`. What it hands back is what `add` is handed --
	 * the state factory, the fold over it and the identity -- built by the host's own
	 * namespacing convention, so a resumed generation folds into the very tables it
	 * answered reads from.
	 *
	 * CALLED WHEN A GENERATION HAS TO FOLD and this process holds no fold for it, which
	 * is two moments and one act. At a POINTER MOVE, because the generation a revert
	 * lands on has to fold from that moment. And at `open`, for the CANONICAL
	 * generation ALONE, because it answers every read from the moment the process
	 * starts: a restart with a changed processor would otherwise serve the incumbent
	 * frozen for the whole of the successor's catch-up. No other stored generation is
	 * instantiated at `open`: a `predecessor` nobody reads needs no engine.
	 *
	 * The `identity` it returns is CHECKED against the record it was asked for: the
	 * host derives it from the bytes (ADR-0086), so a mismatch is stored code that does
	 * not name the generation it is stored under, and it is refused with the rest of a
	 * failed instantiation (`GenerationInstantiationError`).
	 *
	 * OPTIONAL because a host that stores no bytes (the in-memory test worlds, a host
	 * that only reads) has nothing to instantiate; a pointer move onto a generation
	 * such a host holds no fold for still moves, and says out loud that nothing here
	 * folds what now answers reads.
	 */
	instantiateGeneration?: (
		id: GenerationId,
		bundle: Uint8Array,
	) => Promise<Omit<ReceivedGenerationSpec<ABI, ProcessResultType, State>, 'bundle'>>;
};

/**
 * A STORED GENERATION THAT COULD NOT BE MADE TO FOLD, so the pointer did NOT move
 * onto it (ADR-0092).
 *
 * Raised by a pointer move onto a generation this container holds no fold for, when
 * the host's `instantiateGeneration` cannot turn the stored bundle into one: no bytes
 * are stored for it, the loader refused them, the identity they hash to is not the
 * one the generation is registered under, or the fold's factories threw.
 *
 * ONLY BROKEN CODE is refused. A generation on a DIFFERENT stream than this
 * container can name (a filter change's predecessor) is not: nothing here fetches
 * its stream, so it is the freeze a filter change already is, and the pointer
 * moves onto it with that said out loud (`promote`).
 *
 * REFUSED rather than moved-and-reported, because the move is the one thing that can
 * still be declined: moving the pointer onto a generation nothing folds would have a
 * deployment serve a state frozen at a known point while it went on folding the one
 * the operator rejected -- the inverted state ADR-0092 exists to remove. Declining
 * leaves everything exactly as it was, and the operator reads why.
 */
export class GenerationInstantiationError extends Error {
	readonly name = 'GenerationInstantiationError';

	constructor(
		readonly id: GenerationId,
		readonly why: string,
		options?: {cause?: unknown},
	) {
		super(
			`the generation {stream: ${id.stream}, processor: ${id.processor}} could not be instantiated from the bundle ` +
				`stored for it, so the canonical pointer was NOT moved onto it: ${why}. A pointer moved onto a generation ` +
				`nothing here folds would answer reads that never advance again (ADR-0092), so the move is refused and the ` +
				`generation that answered reads before this call still does.`,
			options,
		);
	}
}

/**
 * WHY A GENERATION CAN FOLD NOWHERE HERE, each a different thing for an operator to do
 * about it (ADR-0092).
 *
 * - **`no-bundle`**: no bytes are stored on its row. Its CODE IS GONE, so nothing can
 *   ever make it fold again; this container's own `add` never registers such a
 *   generation, so it is a row written some other way.
 * - **`no-instantiator`**: bytes are stored and this host was given no
 *   `instantiateGeneration`, so it cannot run them (a host that only reads, a test
 *   world). Another host over the same database may.
 * - **`instantiation-failed`**: THIS PROCESS tried and the stored code could not be
 *   built (`GenerationInstantiationError`: the loader refused the bytes, they name
 *   another fold, or its factories threw). Remembered from the attempt rather than
 *   re-tried to answer a question, and forgotten when a later attempt succeeds.
 * - **`stream-not-fetched`**: the code is fine and its stream is not the one this
 *   deployment fetches (a filter change's generation), so a move onto it moves the
 *   pointer and freezes, which is what a revert across a filter change is.
 */
export type FrozenReason = 'no-bundle' | 'no-instantiator' | 'instantiation-failed' | 'stream-not-fetched';

/**
 * WHETHER ONE REGISTERED GENERATION CAN FOLD ON THIS DEPLOYMENT, which is what an
 * operator needs to know before a revert and what a stalled deployment otherwise
 * never says (ADR-0092; the spec's stories 2 and 8).
 *
 * - **`held`**: this process folds it now.
 * - **`instantiable`**: not folded here, and nothing known stops the bundle stored on
 *   its row from being instantiated the moment it has to fold (a move onto it, or
 *   `open` while it is canonical). A CLAIM, not a proof: proving it would mean
 *   evaluating the code and opening its state for a generation nobody reads, which is
 *   the eager instantiation ADR-0092 rejects. The attempt that finally makes it fold
 *   is the proof, and if that attempt fails the answer becomes `frozen`.
 * - **`frozen`**: neither, with the reason (`FrozenReason`) in words an operator can
 *   act on. A frozen CANONICAL generation answers reads and does not advance.
 */
export type GenerationFolding =
	| {readonly generation: GenerationRecord; readonly folding: 'held' | 'instantiable'}
	| {
			readonly generation: GenerationRecord;
			readonly folding: 'frozen';
			readonly frozen: {readonly reason: FrozenReason; readonly message: string};
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
	 * THE BOUNDED REBUILD THAT ADVANCES THIS FOLD, which every fold here has.
	 *
	 * Driven by `ReceivingIndexer.rebuildMore`, which a HOST schedules, AND by the
	 * stream's writer offering it each delta as it is appended
	 * (`GenerationRebuild.follow`). ONE object and ONE code path for both, so "a
	 * generation is a stream plus a fold over it" has one implementation rather than
	 * two that agree on the day they were written.
	 *
	 * It used to be present only on a FOLLOWER, beside an `ingestion` on the one fold
	 * per stream that held the pen, and beside a `writesStream` flag saying which of
	 * the two shapes this was. All three are gone: no generation fetches and no
	 * generation appends (ADR-0087), so there is ONE fold shape.
	 */
	readonly rebuild: GenerationRebuild<ABI, ProcessResultType>;
};

/**
 * What a stored generation's bundle came to at a pointer move: a fold built from it,
 * with what its stream's writer is built from and not yet held, or, for a generation
 * on a stream this container cannot name, NO fold and the reason it stays frozen.
 */
type ResumedFold<ABI extends Abi, ProcessResultType> =
	| {
			readonly fold: HeldFold<ABI, ProcessResultType, unknown>;
			readonly source: IndexingSource<ABI>;
			readonly provided: ProvidedStreamConfig | undefined;
	  }
	| {readonly fold: undefined; readonly frozen: string};

/**
 * A fold with no stream to fold, refused.
 *
 * EVERY generation here advances by re-folding the stored stream (ADR-0087), so a
 * container given no `replay` source has nowhere for any of them to read from.
 * Creating one would register a generation that can never advance and can never be
 * promoted -- a silent, permanent half-upgrade. Refused loudly instead, naming the
 * port that is missing.
 *
 * It used to fire only on the SECOND fold of a stream, because the first one was
 * fed by the wire. That asymmetry went with the election.
 */
function refuseFoldWithNoStream(stream: string): never {
	throw new Error(
		`this container was given no \`replay\` source, so a fold on the stream ${stream} would have nothing to fold. ` +
			`Every generation here READS the stored stream the deployment fetches (ADR-0087) -- no generation fetches ` +
			`and none appends -- so a fold with no way to read that stream could never advance and could never be ` +
			`promoted. Supply \`replay\` (\`storedEmissionReplaySource\` over the database this host owns).`,
	);
}

/**
 * A container asked to hold a fold with no way to STORE the stream it folds,
 * refused.
 *
 * The deployment that FETCHES a stream is the thing that appends to it
 * (ADR-0087), and it needs both ends of that: somewhere to WRITE
 * (`appendEmissions`) and the stream's own position to write FROM
 * (`streamCursor`). A container missing either can never fetch a block, so every
 * fold it held would sit for ever on whatever the stream already contained --
 * promoted, serving reads, reporting healthy, and permanently dead. That is
 * precisely the failure ADR-0087's second amendment measured, so it is refused
 * here rather than discovered by reading which methods a node was asked for.
 */
/**
 * A fold that names no source, on a container that has none to lend it.
 *
 * Only a container opened with NOTHING configured (ADR-0093) can reach this, and only
 * before its first fold: every fold arriving there must say what it indexes, because
 * there is no configured source to default it to and inventing one would be the
 * defaulted input ADR-0048 refuses.
 */
function refuseFoldWithNoSource(): never {
	throw new Error(
		`this generation names no source and this container has none to lend it: it was opened with nothing ` +
			`configured (ADR-0093), so it fetches nothing until a fold says what to index. Hand \`add\` a spec that ` +
			`names its own \`source\` (an upload always does: it carries its own contracts).`,
	);
}

function refuseContainerThatCannotFetch(missing: string): never {
	throw new Error(
		`this container was given no \`${missing}\`, so it has no way to write the stream it would fetch. Under ` +
			`ADR-0087 the DEPLOYMENT fetches a stream and appends to it, positioned from the stream's own coverage ` +
			`claim, and every generation merely reads it -- so without both \`appendEmissions\` (where the stream is ` +
			`stored) and \`streamCursor\` (where it reaches) nothing would ever fetch a block, while the folds went on ` +
			`looking healthy. Supply both, over the database this host owns.`,
	);
}

/**
 * A fold handed over WITHOUT the code that folds it, refused (ADR-0092).
 *
 * On this runtime a registered generation must be one the deployment can run
 * again: that is what lets a revert resume folding instead of freezing at a known
 * good point. So the bytes are required on the spec, and a caller that has none --
 * a module resolved through the module system, a substituted arrival that stated a
 * name instead of bytes -- is told so before any state is opened or anything is
 * registered.
 */
function requireBundle(bundle: Uint8Array | undefined): Uint8Array {
	if (bundle instanceof Uint8Array && bundle.length > 0) {
		return bundle;
	}
	throw new Error(
		`a generation on this container must be handed the BUNDLE that folds it, and this one supplied ` +
			`${bundle instanceof Uint8Array ? 'an empty one' : JSON.stringify(bundle)}. A Node deployment stores each ` +
			`generation's code beside its state (ADR-0092), so that holding a generation means holding something it can ` +
			`run again -- and a generation registered with no bytes would be one a revert could move the pointer to and ` +
			`never advance. Hand over the octets whose hash is the processor identity.`,
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
 * ONE reason, where there used to be two. The other was a generation that WROTE a
 * stream another held fold followed, kept on purpose (ADR-0044) because dropping
 * it would have left that fold folding a stream nothing appends to, and answered
 * as "ask again later". Under ADR-0087 no generation writes a stream at all -- the
 * DEPLOYMENT that fetches it appends, and every generation over it merely reads --
 * so there is no duty to strand and nothing can produce that answer. It is DELETED
 * rather than left in the union unreachable: a reason an operator can read in the
 * type and never receive is a promise about behaviour that no longer exists.
 *
 * What is left is the substrate saying no. The generation is still registered and
 * still named by no slot, so nothing reads it and the next call tries again.
 */
export type DeclinedReclaim = {
	/** The generation that was left alone. Its state and its stream are exactly where they were. */
	readonly generation: GenerationRecord;
	/** WHICH situation this is. One member, and it is a union so that a second reason can be told apart. */
	readonly reason: 'deletion-failed';
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
	 * STREAM per generation.
	 *
	 * None of them carries a receiver. What is addressed on the wire is the STREAM,
	 * and what answers at that address is the stream's WRITER below; a fold READS
	 * what that writer stored (ADR-0087).
	 */
	private readonly folds: HeldFold<ABI, ProcessResultType, unknown>[] = [];

	/**
	 * ONE WRITER PER STREAM THIS CONTAINER HOLDS A FOLD ON -- the deployment's own,
	 * and never a generation's (ADR-0087).
	 *
	 * This is what `{source, config}` resolves to on the wire, and it is where the
	 * one-writer rule now LIVES: a stream has exactly one entry here, so "one writer"
	 * is a fact about the object graph rather than a duty one of several folds was
	 * elected to. Keyed on the stream digest, because that IS the address.
	 *
	 * A writer is built when the first fold on its stream is added and is never
	 * rebuilt, because nothing about it depends on which folds are present: it reads
	 * the STREAM's own coverage claim for its position and appends through the
	 * deployment's appender.
	 */
	private readonly writers = new Map<string, StreamWriter<ABI>>();

	/**
	 * ONE ADVANCE AT A TIME PER FOLD, which is what stops the two ways a fold moves
	 * from interleaving.
	 *
	 * A fold advances by taking a delta the writer just appended and by its own
	 * scheduled rebuild chunk, and on a host that schedules rebuilds while it serves
	 * ingests those two can arrive concurrently. Both read the fold's durable
	 * checkpoint and then apply from it, so an overlap would have both decide from
	 * the same position -- and the storage seam would refuse the second at its
	 * duplicate-height guard, failing whichever call happened to be second for a
	 * reason that is not its caller's fault.
	 *
	 * A promise chain per fold, and nothing more: the work is already serialised
	 * within one call, this only stops two calls from overlapping, and a failure is
	 * contained to the call that caused it rather than poisoning the chain.
	 */
	private readonly advancing = new WeakMap<HeldFold<ABI, ProcessResultType, unknown>, Promise<unknown>>();

	/**
	 * THE FOLDS THIS PROCESS INSTANTIATED FROM STORED BYTES (ADR-0092), as opposed to
	 * the ones it was HANDED (`add`: the fold it was built with, or a reconfigure).
	 *
	 * Such a fold exists only because its generation HAD TO FOLD -- it was canonical at
	 * `open`, or a revert moved the pointer onto it -- so it is held for as long as the
	 * pointer names it and no longer. A revert already stops folding what it leaves;
	 * this is what lets a PROMOTION do the same for these folds, so an upgrading restart
	 * does not end with an engine for the incumbent nobody reads any more. A fold that
	 * was handed to this container keeps the retention it always had.
	 *
	 * In memory, rightly: which OBJECT this process built from bytes is a fact about
	 * this process, like `canonicalFold`, and nothing durable is inferred from it.
	 */
	private readonly instantiatedHere = new WeakSet<HeldFold<ABI, ProcessResultType, unknown>>();

	/**
	 * WHAT THE LAST ATTEMPT TO INSTANTIATE A GENERATION CAME TO, where it did not end in a
	 * fold: keyed like `records`, and read by `folding` (ADR-0092).
	 *
	 * It is how a generation whose stored code could not be built at `open` stops being a
	 * silent stall: that attempt is logged and the deployment starts, and without this
	 * the only other trace was a log line. In memory, like `instantiatedHere`: it is what
	 * THIS process tried, and another process over the same rows may have a different
	 * loader. A later attempt that succeeds deletes the entry.
	 */
	private readonly lastAttempt = new Map<string, {readonly reason: FrozenReason; readonly message: string}>();

	private readonly options: ReceivingIndexerOptions<ABI, ProcessResultType, State>;

	/** The promotion policy this indexer runs under, with nothing left to decide. */
	private readonly promotionConfig: UsedPromotionConfig;

	/* ------------------------------------------------------------------------------
	 * WHAT USED TO BE HERE, and what reads it now (ADR-0084)
	 *
	 * FOUR in-memory facts stood here and all of them are DELETED rather than left
	 * beside the slot agreeing with it most of the time:
	 *
	 * - `opened`, "has the fold this host was built with been added yet", which
	 *   gated the promotion policy so that it spoke for nothing arriving at `open`.
	 *   Its REASONING was right and is preserved exactly: applying the policy at open
	 *   would have let `immediate` promote whatever the host happened to be built
	 *   with, and `on-catch-up` undo a revert recorded in a previous session. Both
	 *   hazards are now ruled out by the SLOT rather than by the moment of arrival
	 *   (see `applyPolicyTo`), which is what lets a successor that arrived at `open`
	 *   -- a RESTART with a changed processor -- finish its upgrade instead of
	 *   waiting for ever for a promotion that could never happen.
	 * - `candidates`, "which held folds are armed for automatic promotion", which
	 *   was in memory because nothing durable said what a generation was FOR. The
	 *   `successor` slot says it, for every process, across every restart -- so
	 *   promotion READS the slot and the set is gone rather than kept beside it.
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
	 * WHICH held fold the canonical pointer names, as of the last time this container
	 * READ the pointer -- the one thing that must be answerable SYNCHRONOUSLY,
	 * because a fold reports a block from inside `process()` and only the canonical
	 * fold publishes.
	 *
	 * IN MEMORY, and it is the ONE fact here that legitimately is: the registry
	 * records what a generation IS, and this is which HELD FOLD OBJECT answers for it
	 * right now, which is a fact about this process and about no other. It is DERIVED
	 * and never set by a caller --
	 * `noteCanonical` re-reads it
	 * from the records wherever this container already reads the pointer, which is
	 * every path that precedes a fold (`liveIngestions` before a batch is routed,
	 * `rebuildMore` before a chunk is replayed) as well as every move this process
	 * makes itself.
	 *
	 * `undefined` is a real answer: the canonical generation needs no engine here
	 * (see the module JSDoc, rule 1), so a process holding only a successor holds no
	 * canonical fold and publishes nothing until the pointer moves onto one it does
	 * hold. It is no longer the common one on a redeployed host where the host injects
	 * `instantiateGeneration`, because the canonical generation is then instantiated at
	 * `open` from its stored bundle (ADR-0092); it remains the answer for a host with
	 * no such seam, a canonical generation on a stream this deployment does not fetch,
	 * and one whose stored code could not be built.
	 *
	 * What it COSTS is stated rather than discovered: a pointer moved by ANOTHER
	 * process is not seen until the next read, so this container can briefly publish
	 * from a fold that has just stopped being canonical elsewhere. That is the same
	 * in-process pointer the chain-facing container keeps (`Indexer.current`), and
	 * the signal is best-effort by decision -- the next notification after the read
	 * carries the truth, and the token the move rotated is what a reader acts on.
	 */
	private canonicalFold: HeldFold<ABI, ProcessResultType, unknown> | undefined;

	/**
	 * THE SOURCE A DEPLOYMENT STARTED WITH NOTHING CONFIGURED TOOK FROM ITS FIRST FOLD
	 * (ADR-0093), and never set on one that was configured with a source.
	 *
	 * Set ONCE, by the first fold this container holds, and never moved afterwards: it
	 * is what the deployment FETCHES, and a host builds its one fetcher over it, so a
	 * later fold on another stream (an upload carrying different contracts) is a
	 * successor on a new stream exactly as it is on a deployment whose source came from
	 * its processor module. In memory, like `canonicalFold`: it is which stream THIS
	 * process fetches, and a restart takes it again from the fold it comes up with.
	 */
	private adopted: IndexingSource<ABI> | undefined;

	constructor(registry: GenerationRegistry, options: ReceivingIndexerOptions<ABI, ProcessResultType, State>) {
		this.registry = registry;
		this.options = options;
		this.promotionConfig = resolvePromotionConfig(options.promotion);
		if (this.promotionConfig.dropOnPromotion && this.promotionConfig.policy === 'immediate') {
			refuseImmediateDrop();
		}
	}

	/**
	 * Add the fold this host was built with, and let the policy speak about it on
	 * exactly the same terms as any other (ADR-0084).
	 *
	 * Called by `openReceivingIndexer`; separate from the constructor because
	 * registering a generation is a write and a CAP refuses here, at start-up, where
	 * an operator reads it.
	 *
	 * There is no longer a gate saying "the policy is silent during `open`", and that
	 * is the correctness cliff ADR-0084 exists to remove: a generation registered at
	 * `open` could never be promoted -- not late, ever -- so restarting with a changed
	 * processor left a successor that caught up and then sat there for ever, with
	 * nothing reported and no policy value that changed it. What the gate was
	 * PROTECTING is protected by the slot instead; see `applyPolicyTo`.
	 */
	async open(): Promise<void> {
		// NOTHING CONFIGURED is a mode, not a missing argument (ADR-0093): there is no fold
		// of this host's own to register, and the canonical generation below is the only
		// thing `open` may come up folding.
		if (this.options.generation) {
			await this.add(this.options.generation);
		}
		await this.foldTheCanonicalGeneration();
	}

	/**
	 * THE SOURCE THIS DEPLOYMENT FETCHES: the one it was configured with, or, on a
	 * deployment started with NOTHING configured (ADR-0093), the one its FIRST FOLD
	 * carried -- the canonical generation instantiated at `open` from its stored bundle,
	 * or the first generation an arrival added.
	 *
	 * `undefined` is a real answer and not a gap to paper over: such a deployment has
	 * been told nothing about what to fetch yet, so it fetches nothing and says it is
	 * WAITING. A host that builds its fetcher over a source asks this, and builds it the
	 * moment there is one.
	 */
	get fetchedSource(): IndexingSource<ABI> | undefined {
		return this.options.source ?? this.adopted;
	}

	/**
	 * THE CANONICAL GENERATION FOLDS FROM `open`, whatever this process was built with
	 * (ADR-0092).
	 *
	 * A restart with a changed processor holds a fold for the NEW one only, and the
	 * canonical generation is the one every read is answered from, so without this its
	 * answers froze for the whole time the successor took to catch up. So where the
	 * pointer names a generation this process holds no fold for, it is instantiated
	 * from the bundle stored on its row -- through the SAME `instantiate` a revert
	 * uses, so there is one way stored bytes become a fold -- and folds until the
	 * pointer leaves it (`movePointer`).
	 *
	 * EXACTLY ONE generation, and only the canonical one. ADR-0092 rules out
	 * instantiating every stored generation at open (live engines for generations
	 * nobody reads), and this is its "when it has to fold" applied at the one moment
	 * the canonical generation starts having to.
	 *
	 * AFTER `add`, and that order is load-bearing. The policy has already spoken about
	 * the configured fold by then, so under `immediate` (or an `on-catch-up` successor
	 * that caught up in a previous process) the pointer has ALREADY left the incumbent
	 * and nothing is instantiated for a generation nobody reads any more. It also keeps
	 * `opening` the configured fold. Nothing here assumes the configured fold is the
	 * successor: whatever the pointer names, and this process does not fold, is what is
	 * instantiated.
	 *
	 * A generation whose stored code cannot be built does NOT stop the deployment
	 * starting: it is logged as an error and the canonical generation answers reads
	 * frozen, which is exactly what a restart did before retained code existed, while
	 * the configured fold goes on catching up and can still be promoted. Refusing to
	 * start would turn a broken predecessor bundle into an outage of the new build too.
	 * A generation on a stream this deployment does not fetch (a filter change) is not
	 * broken code and is not folded either, for `instantiate`'s reason.
	 */
	private async foldTheCanonicalGeneration(): Promise<void> {
		const instantiateGeneration = this.options.instantiateGeneration;
		if (!instantiateGeneration) return;
		const canonical = this.noteCanonical(await this.registry.canonical());
		if (!canonical || this.canonicalFold) return;
		let resumed: ResumedFold<ABI, ProcessResultType>;
		try {
			resumed = await this.instantiate(canonical, instantiateGeneration);
		} catch (err) {
			if (!(err instanceof GenerationInstantiationError)) throw err;
			namedLogger.error(
				`the canonical generation {stream: ${canonical.stream}, processor: ${canonical.processor}} could not be ` +
					`instantiated at open, so it answers reads from its own state and does NOT advance until the pointer ` +
					`leaves it (ADR-0092): ${err.why}`,
				err,
			);
			return;
		}
		if (!resumed.fold) {
			namedLogger.error(
				`the canonical generation {stream: ${canonical.stream}, processor: ${canonical.processor}} is not folded ` +
					`by this process: it answers reads from its own state and does not advance. ${resumed.frozen} (ADR-0092).`,
			);
			return;
		}
		this.hold(resumed.fold, resumed.source, resumed.provided);
		this.noteCanonical(canonical);
		namedLogger.info(
			`the canonical generation {stream: ${canonical.stream}, processor: ${canonical.processor}} was INSTANTIATED ` +
				`at open from the bundle stored for it (ADR-0092): this process was not built with its code, and it goes ` +
				`on folding, so the reads it answers keep advancing until the pointer leaves it.`,
		);
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
				`this ReceivingIndexer holds no fold yet: it was opened with NOTHING configured (ADR-0093), its registry ` +
					`named no canonical generation it could fold, and no generation has arrived since. There is no opening ` +
					`fold to report until one does.`,
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
	 * THE WRITER of the stream the opening fold folds: the live wire context a
	 * single-stream host has.
	 *
	 * It is the DEPLOYMENT's writer of that stream and not the opening fold's engine
	 * (ADR-0087), which is why it is here at all: a fold has no receiver, and this
	 * getter used to reach for one and THROW when the opening fold turned out to be a
	 * follower -- a crash that stopped a restarted deployment from starting, in an
	 * assembly three commands share.
	 *
	 * It exists for as long as this container holds a fold, because a writer is built
	 * with the first fold on its stream; the assertion says so rather than widening
	 * every caller's type for a case `open` cannot produce.
	 */
	get ingestion(): StreamWriter<ABI> {
		const writer = this.writers.get(this.opening.streamDigest);
		if (!writer) {
			throw new Error(
				`this ReceivingIndexer holds no writer for the stream ${this.opening.streamDigest}, which \`open\` cannot ` +
					`produce: a writer is built with the first fold on a stream.`,
			);
		}
		return writer;
	}

	/** WHICH generation the opening fold is: the stream above, plus the fold over it. */
	get generation(): GenerationId {
		return {stream: this.opening.record.stream, processor: this.opening.record.processor};
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
	 * WHETHER EACH REGISTERED GENERATION CAN FOLD HERE: held, instantiable from its
	 * stored bundle, or frozen and why (`GenerationFolding`, ADR-0092).
	 *
	 * The operator's question before a revert, answered for every generation in the
	 * order the registry lists them, so two generations that answer reads the same way
	 * are no longer two states an operator cannot tell apart. It is also where a
	 * generation whose stored code could not be built at `open` is REPORTED, which is
	 * the spec's story 8: that deployment starts and serves the generation frozen, and
	 * before this only a log line said why.
	 *
	 * It BUILDS NOTHING. `instantiable` is decided from what is known without running
	 * the code: bytes are stored, this host can instantiate bytes, nothing in this
	 * process has failed to, and the generation's stream is the one an instantiation
	 * here would fold (the container's own, which is what a host whose seam names no
	 * source of its own folds; such a host's own source is known only by trying, and the
	 * try is remembered). Evaluating every stored bundle to answer a question would be
	 * the eager instantiation ADR-0092 rejects, with state opened for generations nobody
	 * reads.
	 *
	 * One read of the records, then one read of the stored bytes per generation not
	 * held here, which the generation caps bound.
	 */
	async folding(): Promise<GenerationFolding[]> {
		const registered = await this.registry.list();
		const fetched = this.fetchedStream();
		const reports: GenerationFolding[] = [];
		for (const generation of registered) {
			reports.push(await this.foldingIn(generation, fetched));
		}
		return reports;
	}

	/**
	 * THE SAME ANSWER as `folding`, for ONE generation: held, instantiable, or frozen and
	 * why.
	 *
	 * For a host that needs one generation's answer and not the whole listing's, which is
	 * `/status` asking about the CANONICAL generation on every refresh: `folding` reads
	 * the stored bytes of every registered generation not held here, and a page an
	 * operator refreshes should pay for the one it reports. It is the same derivation,
	 * not a second one, so the two surfaces cannot disagree about a generation.
	 */
	async foldingOf(generation: GenerationRecord): Promise<GenerationFolding> {
		return this.foldingIn(generation, this.fetchedStream());
	}

	/**
	 * The stream this deployment FETCHES: what an instantiation here would fold. NOTHING
	 * on a deployment started with nothing configured that holds no fold yet (ADR-0093),
	 * which fetches no stream at all.
	 */
	private fetchedStream(): string | undefined {
		const source = this.fetchedSource;
		return source ? streamDigestOf(source, resolveStreamConfig(this.options.stream)) : undefined;
	}

	/** One generation's answer for `folding`, the reasons in the order an operator would act on them. */
	private async foldingIn(generation: GenerationRecord, fetched: string | undefined): Promise<GenerationFolding> {
		if (this.folds.some((fold) => sameGeneration(fold.record, generation))) {
			return {generation, folding: 'held'};
		}
		const frozen = (reason: FrozenReason, message: string): GenerationFolding => ({
			generation,
			folding: 'frozen',
			frozen: {reason, message},
		});
		// THE CODE ITSELF FIRST: without bytes nothing anywhere can make it fold again,
		// which outranks anything about this particular host.
		const bundle = await this.registry.bundleOf(generation);
		if (!bundle || bundle.length === 0) {
			return frozen(
				'no-bundle',
				`no bundle is stored for it, so its code is gone: it answers reads from its own state and nothing can ` +
					`make it fold again`,
			);
		}
		if (!this.options.instantiateGeneration) {
			return frozen(
				'no-instantiator',
				`its bundle is stored, and this host was given no \`instantiateGeneration\`, so it cannot run it here`,
			);
		}
		const attempt = this.lastAttempt.get(keyOf(generation));
		if (attempt) {
			return frozen(attempt.reason, attempt.message);
		}
		// A deployment that fetches NOTHING yet (ADR-0093) takes the source of the first
		// generation it folds, so no stream is ruled out here until one is fetched.
		if (fetched !== undefined && generation.stream !== fetched) {
			return frozen(
				'stream-not-fetched',
				`its stream ${generation.stream} is not one this deployment fetches (it fetches ${fetched}), so nothing ` +
					`here would fold it: a move onto it is a freeze`,
			);
		}
		return {generation, folding: 'instantiable'};
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
			const opening = this.folds[0];
			namedLogger.info(
				`the registry names no canonical generation, so this container answers NONE rather than falling back to ` +
					(opening
						? `the fold it opened with ({stream: ${opening.record.stream}, processor: ${opening.record.processor}})`
						: `anything: it holds no fold, having been opened with nothing configured (ADR-0093)`) +
					`. A read is refused rather than served from a generation the pointer does not name (ADR-0058).`,
			);
			return undefined;
		}
		return {stream: canonical.stream, processor: canonical.processor};
	}

	/**
	 * THE LIVE WIRE CONTEXTS: one STREAM WRITER per stream a registered generation
	 * held here folds.
	 *
	 * A stream is ONE address on the wire, and what answers at that address is the
	 * deployment's writer of that stream (ADR-0087) -- not a fold, because no fold
	 * appends. So this list no longer depends on WHICH fold is present, only on
	 * whether any registered generation still folds the stream, which is the whole
	 * of what this change buys: a deployment holding nothing but a successor
	 * re-folding stored history goes on fetching and appending.
	 *
	 * A fold is live while the generation it was registered as is still registered.
	 * That is the whole lifetime: it BEGINS when the successor is created (`add`,
	 * which registers before it builds anything) and ENDS when that generation is
	 * DELETED. The STREAM is no longer part of that lifetime -- it outlives every
	 * fold over it and is deleted only when asked.
	 *
	 * What it deliberately does NOT consult is the canonical pointer. A superseded
	 * generation is RETAINED under the caps, so "the successor became canonical" is
	 * not by itself a reason to stop fetching its stream; whether it should be is a
	 * POLICY that sets what the registry holds, and this routing follows the registry
	 * either way.
	 *
	 * What is GONE from here is `reconcileWriters`, which ran before every answer to
	 * move the wire to whichever generation the records now elected. There is nothing
	 * to move: the wire never belonged to a generation.
	 */
	async liveIngestions(): Promise<readonly LogIngestion[]> {
		const registered = await this.registry.list();
		// WHICH fold answers reads, read here for the reason it always was: the batch
		// this list is being answered for is about to be FOLDED, and only the canonical
		// fold publishes what it applied (ADR-0083). The pointer is durable and shared,
		// so it is read where the records are.
		this.noteCanonical(await this.registry.canonical());
		const live: LogIngestion[] = [];
		for (const [digest, writer] of this.writers) {
			const stillFolded = this.folds.some(
				(fold) => fold.streamDigest === digest && registered.some((record) => sameGeneration(record, fold.record)),
			);
			if (stillFolded) live.push(writer);
		}
		return live;
	}

	/** The promotion policy this indexer runs under, resolved, so a host can see WHICH value is in force. */
	get promotion(): UsedPromotionConfig {
		return this.promotionConfig;
	}

	/**
	 * Build a fold BESIDE the ones already held, and make sure its stream is being
	 * fetched.
	 *
	 * The receiving twin of `Indexer.add`, and the same order for the same reason:
	 * STATE FIRST, then the fold over it (ADR-0043), then the REGISTRY -- which is
	 * written before anything writes the stream, because a stream subtree no
	 * registered generation claims is what the sweep collects.
	 *
	 * A cap REFUSES here and no GENERATION is left behind: the record is not
	 * written and no engine is built, so nothing names or reads whatever the
	 * state factory happened to open.
	 *
	 * What a refusal MAY leave is storage the factory itself created, and that is the
	 * host's business rather than this container's: a factory that claims its store
	 * (`openForWriting`, ADR-0077) migrates, and the cap is enforced one step later
	 * because the record needs the processor's identity, which needs the
	 * processor, which needs the state (ADR-0043). The CLI's SQL factory therefore
	 * leaves an empty namespace behind, reused verbatim if the bound is raised. This
	 * order cannot be swapped: a pre-check on the COUNT alone would refuse re-opening
	 * a generation this container already holds, which is the case `create`
	 * deliberately RESOLVES.
	 *
	 * ## THERE IS NOTHING LEFT TO DETERMINE ABOUT THE FOLD (ADR-0087)
	 *
	 * Every fold gets a `GenerationRebuild` over the stored stream and none of them
	 * gets a receiver or an appender. What the arriving fold's STREAM gets, if this
	 * is the first fold on it, is a WRITER -- the deployment's, positioned from the
	 * stream's own coverage claim. So the question that used to be decided here
	 * ("does this fold follow, or does it hold the pen") has no answer to give,
	 * which is what makes a restarted deployment holding only a successor fetch
	 * exactly as a fresh one does.
	 */
	async add<S>(spec: ReceivedGenerationSpec<ABI, ProcessResultType, S>): Promise<HeldFold<ABI, ProcessResultType, S>> {
		// THE CODE FIRST, before any state is opened: a fold with no bundle is one this
		// runtime could never resume, and refusing it here leaves nothing behind at all.
		const bundle = requireBundle(spec.bundle);
		const source = spec.source ?? this.fetchedSource ?? refuseFoldWithNoSource();
		const provided = spec.stream ?? this.options.stream;
		// The RESOLVED config, exactly as the writer and the rebuild resolve it, so the
		// digest this container files a generation under and the digest its stream is
		// stored under cannot be two different streams.
		const streamConfig = resolveStreamConfig(provided);
		const context: GenerationContext = {stream: streamDigestOf(source, streamConfig)};
		const replay = this.options.replay;
		if (!replay) {
			refuseFoldWithNoStream(context.stream);
		}

		// STATE FIRST, then the fold over it (ADR-0043). The identity is the ARRIVAL's
		// (ADR-0086), read ONCE here -- after the factories, which is what lets an arrival
		// with no bytes derive one from the object it just built -- and handed DOWN to the
		// rebuild, so the record and the engine advancing it cannot name one generation
		// two ways. Absent is REFUSED: there is nothing left that may name a fold on its
		// behalf.
		const state = await spec.createState(context);
		const processor = await spec.createProcessor(state, context);

		const wanted: GenerationId = {
			stream: context.stream,
			processor: requireProcessorIdentity(spec.processorIdentity),
		};
		// READ ONCE, BEFORE anything is registered or dropped. The SLOTS decide whether
		// this fold is a successor at all and what it displaces; the records decide which
		// held folds are still registered.
		const registeredBefore = await this.registry.list();
		const slotsBefore = await this.registry.slots();
		const canonicalBefore = this.noteCanonical(slotsBefore.canonical);
		// WHAT THE SUCCESSOR SLOT HELD GOES FIRST, so the room this registration needs is
		// already free when the CAP is decided. It is deliberately not cap-PRESSURE
		// eviction: a replaced successor is dead the moment a newer one takes its place,
		// whether the registry holds two generations or none to spare, and a rule that
		// fired only near the bound would make a deterministic lifecycle a heuristic.
		//
		// What it does NOT take any more is the STREAM: dropping a generation leaves the
		// stream exactly where it is (ADR-0087), so a second save in a tab can no longer
		// delete the history the first one fetched.
		await this.replaceTheSuccessor(wanted, registeredBefore, slotsBefore);
		// INTO THE `successor` SLOT, which holds AT MOST ONE. The registry decides what
		// that means for this identity: the first generation of an empty registry takes
		// `canonical` instead, and a generation some slot ALREADY names stays where it is
		// -- so a restart on the canonical processor stays canonical, and one on the
		// generation a revert returned to is not re-armed by the act of starting up.
		//
		// ...and WITH ITS BUNDLE, in the same commit as the record (ADR-0092). This is the
		// ONE place this container registers a generation, so it is the one place its code
		// is stored, however the bytes reached the host.
		const record = await this.registry.create(wanted, {slot: 'successor', bundle});
		noteSuccessor(canonicalBefore, record);
		this.records.set(keyOf(record), record);
		// WHETHER THIS FOLD IS THE ONE THE POINTER NAMES, derived rather than re-read:
		// `create` leaves the pointer where it was, and takes it only when there was
		// none. It is recorded because a later move BACK to it must be readable as a
		// revert -- including the opening fold of a host that comes up already canonical.
		const canonicalOnAdd = !canonicalBefore || sameGeneration(canonicalBefore, record);

		const fold = this.foldOf<S>(record, state, processor, source, streamConfig, replay);
		this.hold(fold as HeldFold<ABI, ProcessResultType, unknown>, source, provided);
		// WHICH fold answers reads, re-derived from what was just read and written rather
		// than inferred later: it is the fold added here when the pointer named it or took
		// it, and otherwise whichever held fold the pointer already named.
		this.noteCanonical(canonicalOnAdd ? record : canonicalBefore);
		await this.applyPolicyTo(fold as HeldFold<ABI, ProcessResultType, unknown>);
		return fold;
	}

	/**
	 * ONE FOLD, as this container holds one: the record, the state and processor the
	 * factories built, and the bounded rebuild that advances it.
	 *
	 * Shared by `add` and by the resume of a stored generation (`instantiate`), so that
	 * a fold registered here and a fold instantiated from bytes are ONE shape advanced by
	 * ONE code path.
	 */
	private foldOf<S>(
		record: GenerationRecord,
		state: S,
		processor: EventProcessor<ABI, ProcessResultType>,
		source: IndexingSource<ABI>,
		streamConfig: UsedStreamConfig,
		replay: ReplaySource<ABI>,
	): HeldFold<ABI, ProcessResultType, S> {
		return {
			record,
			streamDigest: record.stream,
			streamConfig,
			state,
			processor,
			rebuild: new GenerationRebuild<ABI, ProcessResultType>(processor, source, {
				stream: record.stream,
				streamConfig,
				replay,
				...(this.options.maxEmissionsPerChunk === undefined ? {} : {maxEmissions: this.options.maxEmissionsPerChunk}),
				// THE NAME THIS FOLD IS ALREADY REGISTERED UNDER, taken from the record rather
				// than re-derived: `create` RESOLVES a generation already there rather than
				// duplicating it, so the record is the authority on what this fold is called.
				processorIdentity: record.processor,
			}),
		};
	}

	/**
	 * START DRIVING a fold: hold it, make sure its stream has a writer, and relay what
	 * it reports.
	 */
	private hold(
		fold: HeldFold<ABI, ProcessResultType, unknown>,
		source: IndexingSource<ABI>,
		provided: ProvidedStreamConfig | undefined,
	): void {
		this.folds.push(fold);
		// A deployment started with NOTHING configured takes what it fetches from its FIRST
		// fold, once, and keeps it (ADR-0093): see `fetchedSource`.
		if (!this.options.source && !this.adopted) {
			this.adopted = source;
			namedLogger.info(
				`this deployment was started with nothing configured, and its first fold ({stream: ${fold.record.stream}, ` +
					`processor: ${fold.record.processor}}) names what it fetches from now on (ADR-0093)`,
			);
		}
		// ...and the STREAM's own writer, built once per stream and AFTER the record
		// exists, for the reason the registry states: a stream subtree no registered
		// generation claims is what the sweep collects, so nothing may write a stream
		// ahead of its registration.
		this.writerFor(fold.streamDigest, source, provided);
		// THE SIGNAL's relay, attached BEFORE anything folds and to EVERY fold rather
		// than to the canonical one: the pointer moves, and a relay attached only to the
		// fold that happens to be canonical now would have to be re-attached at every
		// promotion. The filter is in `publishFoldReport`, at the moment a report arrives.
		this.relayFoldReports(fold, fold.processor);
	}

	/**
	 * BUILD A FOLD FOR A GENERATION ALREADY REGISTERED, from the bundle stored for it
	 * (ADR-0092) -- without holding it yet.
	 *
	 * The host's `instantiateGeneration` turns the bytes into the same two factories
	 * `add` is handed, and they are run in ADR-0043's order. Nothing is REGISTERED: the
	 * generation already is, with these very bytes on its row, and no slot changes here.
	 * The fold is returned rather than held so the caller can hold it only once the
	 * pointer move it is for has actually happened.
	 *
	 * EVERY way the stored CODE can be broken is one `GenerationInstantiationError`,
	 * naming why: no bytes stored, the host refused them, they hash to a different
	 * identity than the generation is registered under, or the fold's factories threw.
	 *
	 * A generation on ANOTHER STREAM is not broken code, and is not refused: it comes
	 * back with no fold and the reason it stays frozen. Its factories are never run,
	 * since nothing here would fold what they build.
	 */
	private async resumable(
		id: GenerationId,
		instantiateGeneration: NonNullable<ReceivingIndexerOptions<ABI, ProcessResultType, State>['instantiateGeneration']>,
	): Promise<ResumedFold<ABI, ProcessResultType> | undefined> {
		// An identity nothing registered is the REGISTRY's refusal to make, by name, at
		// the move itself (`UnknownGenerationError`): there are no bytes to look for.
		const record = (await this.registry.list()).find((candidate) => sameGeneration(candidate, id));
		return record ? this.instantiate(record, instantiateGeneration) : undefined;
	}

	private async instantiate(
		record: GenerationRecord,
		instantiateGeneration: NonNullable<ReceivingIndexerOptions<ABI, ProcessResultType, State>['instantiateGeneration']>,
	): Promise<ResumedFold<ABI, ProcessResultType>> {
		// WHAT THE ATTEMPT CAME TO is remembered for `folding`, so a generation whose code
		// could not be built is REPORTED as frozen rather than merely logged (ADR-0092).
		const key = keyOf(record);
		try {
			const resumed = await this.buildFromBundle(record, instantiateGeneration);
			if (resumed.fold) {
				this.lastAttempt.delete(key);
			} else {
				this.lastAttempt.set(key, {reason: 'stream-not-fetched', message: resumed.frozen});
			}
			return resumed;
		} catch (err) {
			if (err instanceof GenerationInstantiationError) {
				this.lastAttempt.set(key, {reason: 'instantiation-failed', message: err.why});
			}
			throw err;
		}
	}

	private async buildFromBundle(
		record: GenerationRecord,
		instantiateGeneration: NonNullable<ReceivingIndexerOptions<ABI, ProcessResultType, State>['instantiateGeneration']>,
	): Promise<ResumedFold<ABI, ProcessResultType>> {
		const id: GenerationId = {stream: record.stream, processor: record.processor};
		const replay = this.options.replay;
		if (!replay) refuseFoldWithNoStream(record.stream);
		const bundle = await this.registry.bundleOf(id);
		if (!bundle || bundle.length === 0) {
			throw new GenerationInstantiationError(id, `no bundle is stored for it`);
		}
		let spec: Omit<ReceivedGenerationSpec<ABI, ProcessResultType, State>, 'bundle'>;
		try {
			spec = await instantiateGeneration(id, bundle);
		} catch (err) {
			throw new GenerationInstantiationError(
				id,
				`the host could not turn the stored bytes into a fold (${err instanceof Error ? err.message : String(err)})`,
				{cause: err},
			);
		}
		if (spec.processorIdentity !== record.processor) {
			throw new GenerationInstantiationError(
				id,
				`the stored bytes name the fold ${JSON.stringify(spec.processorIdentity)}, not the generation they are stored ` +
					`under`,
			);
		}
		// The host's source for it where the instantiation named one -- a deployment started
		// with NOTHING configured has no other way to learn what a stored bundle indexes
		// (ADR-0093) -- and otherwise the one this deployment fetches.
		const source = spec.source ?? this.fetchedSource;
		if (!source) {
			throw new GenerationInstantiationError(
				id,
				`nothing names what it indexes: this container was opened with no source (ADR-0093) and the host's ` +
					`instantiation named none either`,
			);
		}
		const provided = spec.stream ?? this.options.stream;
		const streamConfig = resolveStreamConfig(provided);
		const context: GenerationContext = {stream: streamDigestOf(source, streamConfig)};
		// ...and whatever the instantiation named, a deployment folds only the stream it
		// FETCHES, once it fetches one: a generation whose own contracts name another stream
		// is a filter change's, frozen here exactly as a configured deployment freezes it.
		const fetched = this.fetchedStream();
		const fetchesAnother = spec.source !== undefined && fetched !== undefined && fetched !== record.stream;
		if (context.stream !== record.stream || fetchesAnother) {
			// A FILTER CHANGE's generation, not broken code: its stream is not the one this
			// deployment fetches, so the move goes ahead and it answers reads frozen, as a
			// revert across a filter change always did (ADR-0057).
			return {
				fold: undefined,
				frozen:
					`its stream ${record.stream} is not one this deployment fetches (it fetches ${fetched ?? context.stream}), so its ` +
					`code was loaded and nothing folds it: a revert across a filter change is a freeze`,
			};
		}
		let state: State;
		let processor: EventProcessor<ABI, ProcessResultType>;
		try {
			state = await spec.createState(context);
			processor = await spec.createProcessor(state, context);
		} catch (err) {
			throw new GenerationInstantiationError(
				id,
				`its fold could not be built (${err instanceof Error ? err.message : String(err)})`,
				{cause: err},
			);
		}
		const fold = this.foldOf(record, state, processor, source, streamConfig, replay) as HeldFold<
			ABI,
			ProcessResultType,
			unknown
		>;
		this.instantiatedHere.add(fold);
		return {fold, source, provided};
	}

	/**
	 * THE WRITER OF ONE STREAM, built once and kept: the DEPLOYMENT's, never a
	 * generation's (ADR-0087).
	 *
	 * Built with the first fold on a stream and never rebuilt, because nothing about
	 * it depends on which folds are present -- it reads the STREAM's own coverage
	 * claim for its position, and it appends through the deployment's appender. That
	 * is the whole of why the elected writer is gone: there is no observation point
	 * at which a duty has to change hands, because the duty never moved.
	 *
	 * A container with no way to store a stream gets NO writer, which is refused at
	 * `open` rather than left to be discovered: a deployment that folds and never
	 * fetches reports healthy for ever.
	 */
	private writerFor(
		stream: string,
		source: IndexingSource<ABI>,
		provided: ProvidedStreamConfig | undefined,
	): StreamWriter<ABI> {
		const held = this.writers.get(stream);
		if (held) return held;
		const appendEmissions = this.options.appendEmissions;
		const cursor = this.options.streamCursor;
		if (!appendEmissions) refuseContainerThatCannotFetch('appendEmissions');
		if (!cursor) refuseContainerThatCannotFetch('streamCursor');
		const writer = new StreamWriter<ABI>(source, {
			...(provided ? {stream: provided} : {}),
			cursor,
			appendEmissions,
			...(this.options.recordReorg ? {recordReorg: this.options.recordReorg} : {}),
			// WHAT WAS APPENDED, OFFERED to every fold on this stream -- after the append,
			// so nothing about which folds are present can change what was stored.
			deliver: (delta) => this.offerToFolds(delta),
		});
		this.writers.set(stream, writer);
		return writer;
	}

	/**
	 * OFFER the delta the writer just appended to every fold on that stream.
	 *
	 * The live half of the ONE advance a fold has. A fold LEVEL with the stream takes
	 * it and folds it there and then; one that is behind declines, and its bounded
	 * rebuild reads the same rows back off disk. Both go through
	 * `GenerationRebuild`, so there is one implementation of "replay what the stream
	 * says happened".
	 *
	 * **This is not the rejected hand-over.** The append already happened,
	 * positioned from the stream, before any of this: what a fold does or does not
	 * take changes nothing about what was written, which is exactly the property the
	 * hand-over could not have at any observation point.
	 *
	 * A fold that THROWS is contained and said out loud rather than failing the
	 * append that reached it: the stream is stored, which is the expensive half, and
	 * the fold is behind by one delta and is carried by its rebuild. Failing here
	 * would tell a sender to re-send a batch that was in fact stored.
	 */
	private async offerToFolds(delta: StreamDelta<ABI>): Promise<void> {
		for (const fold of [...this.folds]) {
			if (fold.streamDigest !== delta.stream) continue;
			try {
				// STILL HELD by the time its turn comes: a pointer move serialised on this fold
				// (`settlePromotion`) may have stopped driving it while this delta waited, and a
				// fold nothing drives any more must not take one more block.
				await this.advance(fold, async () => {
					if (this.folds.includes(fold)) await fold.rebuild.follow(delta);
				});
			} catch (err) {
				namedLogger.error(
					`the fold {stream: ${fold.record.stream}, processor: ${fold.record.processor}} could not take the ` +
						`delta just appended to its stream. The STREAM is stored, which is what the fetch bought; this fold ` +
						`is behind by one batch and its rebuild carries it.`,
					err,
				);
			}
		}
	}

	/**
	 * RUN ONE ADVANCE OF ONE FOLD, after whatever was already advancing it.
	 *
	 * See `advancing`: a fold moves two ways -- the live delta and the scheduled
	 * rebuild chunk -- and on a host that schedules rebuilds while it serves ingests
	 * the two can arrive at once. Both read the durable checkpoint and apply from it,
	 * so overlapping them would have both decide from the same position and the
	 * storage seam would refuse the second at its duplicate-height guard.
	 *
	 * The chain is advanced whether the call succeeded or failed, so one failure does
	 * not wedge the fold for ever.
	 */
	private advance<T>(fold: HeldFold<ABI, ProcessResultType, unknown>, work: () => Promise<T>): Promise<T> {
		const after = (this.advancing.get(fold) ?? Promise.resolve()).then(work, work);
		this.advancing.set(
			fold,
			after.catch(() => undefined),
		);
		return after;
	}

	// ------------------------------------------------------------------------------------------------------------------
	// THE REBUILD, and the promotion that ends it
	// ------------------------------------------------------------------------------------------------------------------

	/**
	 * ADVANCE EVERY FOLD BY ONE BOUNDED CHUNK, then settle the pointer.
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
	 * per fold.
	 *
	 * It advances EVERY fold and no longer only the followers, because there are no
	 * others: under ADR-0087 no generation fetches, so every one of them catches up
	 * by re-folding the stream the deployment stored. A fold that is already level
	 * has taken each delta live as it was appended (`offerToFolds`), so its chunk
	 * here finds nothing new and costs one read.
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
			// A generation that has been DELETED is not advanced: its state is gone, so
			// folding into it would be writing into nothing -- the same rule
			// `liveIngestions` applies to a stream's writer.
			if (!registered.some((record) => sameGeneration(record, fold.record))) continue;
			// SERIALISED with whatever else is advancing this fold: a delta offered by the
			// stream's writer applies from the same durable checkpoint this does.
			reports.push(await this.advance(fold, () => fold.rebuild.more(options)));
		}
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
	 *
	 * ## ...and a target it holds no fold for is INSTANTIATED, so it FOLDS (ADR-0092)
	 *
	 * Answering reads is not enough: a generation the pointer names has to advance. So
	 * where the host supplied `instantiateGeneration`, the target is built from the
	 * bundle stored on its row before the pointer moves, and a target that cannot be
	 * built refuses the move (`GenerationInstantiationError`) rather than leaving a
	 * canonical generation nothing folds. A revert also stops folding the generation it
	 * moved away from (`movePointer`).
	 *
	 * A target on a stream this container cannot name (a revert across a filter
	 * change) is NOT refused: its code is not broken, its stream is simply not one
	 * this deployment fetches. The pointer moves, nothing folds it, and that is logged
	 * as an error, which is the freeze a filter change always was.
	 */
	async promote(id: GenerationId): Promise<GenerationRecord> {
		return this.movePointer(id);
	}

	/**
	 * What the policy does about a fold that has just been ADDED, whether it arrived
	 * at `open` or beside a live one.
	 *
	 * ## ONE condition, stated positively: arm what `successor` names
	 *
	 * Read off the durable slot rather than off how the fold ARRIVED (ADR-0084). The
	 * question stops being "did this turn up at `open` or through a reconfigure",
	 * which nothing durable records and which a restart answers wrongly, and becomes
	 * "what is this generation FOR", which is a row. `add` always leaves the arriving
	 * fold in exactly ONE slot -- the registry assigns `successor`, or leaves it in the
	 * slot that already named it, or gives it `canonical` on an empty registry -- so
	 * there are exactly two things this excludes, and they are NOT the same weight:
	 *
	 * - **What `predecessor` names, and this clause is load-bearing.** After a revert
	 *   the pointer sits on an older generation while a newer one is still registered,
	 *   so arming every non-canonical fold at open would re-promote exactly what an
	 *   operator deliberately reverted away from -- undoing a revert by restarting
	 *   (ADR-0046). It is MEASURED rather than argued: drop this clause and a restart
	 *   after a revert under `immediate` moves the pointer straight back
	 *   (`packages/cli/test/aRestartFinishesTheUpgrade.test.ts`). The registry keeps
	 *   such a generation where it is (`create`, rule 2), so it never enters
	 *   `successor` and is armed under no policy value.
	 * - **What `canonical` names, which is INTENT plus defence in depth.** This is the
	 *   hazard `immediate` posed at `open` -- promoting whatever the host happened to
	 *   be built with -- and it is worth saying that the pointer would not actually
	 *   move: `moveCanonicalTo` writes nothing when the target is the generation the
	 *   pointer already names, so the hazard is already neutral one layer down.
	 *   Removing this clause therefore breaks no test, and it stays anyway, because
	 *   the rule is a statement about what a generation IS: the fold the pointer
	 *   already names is not a successor to anything, and a policy asking to promote
	 *   it would be saying something false about it in every log line it produced.
	 *
	 * What is NOT here any more is a clause about the MOMENT of arrival. The MAPPING
	 * from policy to action stays `generation/promotion.ts`'s, shared with the
	 * chain-facing container.
	 */
	private async applyPolicyTo(fold: HeldFold<ABI, ProcessResultType, unknown>): Promise<void> {
		// ONE read of the slots, and the pointer noted from it: `canonical` is one of the
		// three answers this is asking for, so asking for it separately would pair two
		// reads across another process's write.
		const slots = await this.registry.slots();
		this.noteCanonical(slots.canonical);
		if (slotHolding(slots, fold.record) !== 'successor') return;
		switch (promotionOnAdd(this.promotionConfig.policy)) {
			case 'promote':
				await this.movePointer(fold.record);
				return;
			case 'arm':
				// ARMING IS NOT A THING THIS CONTAINER REMEMBERS any more: the slot already
				// says it, so there is nothing to record and the settle simply reads it. It is
				// evaluated at once as well as per chunk, because a fold added when it is
				// already level -- one that caught up in a previous process and is being held
				// again after a restart -- is ready NOW.
				await this.settlePromotion();
				return;
			case 'wait':
				return;
		}
	}

	/**
	 * THE TRIGGER: promote what `successor` names once it has reached the CANONICAL
	 * generation's cursor.
	 *
	 * The rule is `readyForPromotion`'s, shared with the chain-facing container so
	 * that there is one answer to "when does the pointer move on its own". What this
	 * runtime supplies is the VIEW, and it is now the same view the read tier has: a
	 * cursor here is not a field an engine publishes, it is the `lastToBlock` a
	 * generation has PERSISTED in its own table namespace -- read live on every
	 * settle, never snapshotted, because a snapshot would let a successor be promoted
	 * while the incumbent had moved on.
	 *
	 * ## Neither side has to be a fold THIS CONTAINER HOLDS, and that is the fix
	 *
	 * The entries are the two the SLOTS name, and they are read by IDENTITY. This
	 * used to search the held folds for one matching the canonical generation and
	 * return when there was none -- which is the ORDINARY restart: a redeployed host
	 * holds exactly one fold, the new one, and a fold for the incumbent is unbuildable
	 * by construction, because the old processor's code is not in the build. So the
	 * trigger could not be EVALUATED on the very shape the upgrade story is about, and
	 * the pointer never moved (`work/notes/observations/the-promotion-trigger-cannot-be-evaluated-with-no-held-incumbent.md`).
	 * It is now the same rule the rest of this runtime follows (module JSDoc, rule 1;
	 * `promote`'s docstring): a generation ANSWERS with no engine, so it can be
	 * MEASURED with no engine.
	 *
	 * The POLICY still decides WHEN. This is the `arm` half of it and runs under
	 * nothing else: `immediate` moved the pointer at `add`, and `manual` means the
	 * pointer moves only when somebody asks -- a successor sitting armed in a slot must
	 * not creep forward because the slot exists.
	 */
	private async settlePromotion(): Promise<void> {
		if (promotionOnAdd(this.promotionConfig.policy) !== 'arm') return;
		const slots = await this.registry.slots();
		this.noteCanonical(slots.canonical);
		const current = slots.canonical;
		const successor = slots.successor;
		if (!current || !successor) return;

		// THE INCUMBENT MAY BE MOVING (ADR-0092): where this process folds the canonical
		// generation -- the one it opened with, or one instantiated at `open` so that an
		// upgrade window is not a window of stale answers -- a delta can land on it between
		// its cursor being read and the pointer leaving it. So the comparison AND the move
		// run on that fold's own advance chain: nothing folds into the incumbent from the
		// read to the move, the successor is promoted only at or past where the incumbent
		// finally stood, and a reader's answers never step backwards across the promotion.
		// With no held incumbent (nothing here folds it) the cursor cannot move under this
		// process, and the read is as it was.
		const incumbent = this.folds.find((fold) => sameGeneration(fold.record, current));
		if (incumbent) {
			await this.advance(incumbent, () => this.promoteIfLevel(current, successor));
		} else {
			await this.promoteIfLevel(current, successor);
		}
	}

	/** The comparison half of the trigger, both cursors read live, and the move if it holds. */
	private async promoteIfLevel(current: GenerationRecord, successor: GenerationRecord): Promise<void> {
		const cursors = new Map<GenerationRecord, number | undefined>([
			[current, await this.cursorOf(current)],
			[successor, await this.cursorOf(successor)],
		]);
		const ready = readyForPromotion([current, successor], current, {
			// BEING A CANDIDATE IS A ROW: the slot says what a generation is FOR, so there
			// is nothing in memory to consult and nothing that a restart empties.
			isCandidate: (record) => record === successor,
			cursorOf: (record) => cursors.get(record),
		});
		if (ready) {
			await this.movePointer(ready);
		}
	}

	/**
	 * HOW FAR ONE GENERATION HAS GOT, read from where it is durable and with NO
	 * ENGINE.
	 *
	 * The persisted cursor and never an in-memory copy, for the reason
	 * `StreamBuilder` reads its own on every call: several isolates may serve one
	 * database, and a cursor held in a process is that process's private opinion of a
	 * value the database owns.
	 *
	 * It goes through the INJECTED seam (`GenerationRegistryPort.readStateCursor`)
	 * rather than through a held fold's `processor.load(...)`, and the difference is
	 * the whole of part two of ADR-0084's third symptom. Three things follow, and
	 * each one was a defect:
	 *
	 *  - a generation this container holds NO FOLD for can be measured, which is the
	 *    restart shape and the case the upgrade story depends on;
	 *  - nothing here retains, re-imports or reconstructs the processor that wrote the
	 *    cursor -- the number is a ROW addressed by an identity the registry holds
	 *    (ADR-0053), and retaining CODE is a separate question this does not answer;
	 *  - a fold with its OWN source has its cursor read with the pair it ACTUALLY
	 *    folded under, because the address IS that pair. The read it replaced passed
	 *    the CONTAINER's source with the FOLD's stream config, which is a pair no fold
	 *    necessarily ran under (it was latent rather than observable, because neither
	 *    implementation of `load` chooses a cursor by `source`).
	 *
	 * A read that FAILS is reported as `undefined` and said out loud, exactly as the
	 * status reporter treats an unreadable store: `undefined` means NOT READABLE and
	 * must never become a zero, or a generation that has folded nothing would read as
	 * level at block 0 with one that has. The safe direction falls out of that --
	 * `hasReachedCursor` is false wherever either side is unknown, so an unreadable
	 * cursor holds the pointer where it is.
	 */
	private async cursorOf(record: GenerationRecord): Promise<number | undefined> {
		try {
			return await this.registry.readStateCursor({stream: record.stream, processor: record.processor});
		} catch (err) {
			namedLogger.error(
				`the cursor of the generation {stream: ${record.stream}, processor: ${record.processor}} could not be read, ` +
					`so it counts as NOT READABLE rather than as a position: the pointer does not move on its own until it can ` +
					`be read`,
				err,
			);
			return undefined;
		}
	}

	/**
	 * THE MOVE: one small write, and the generation left behind is RETAINED.
	 *
	 * Retaining is what makes moving the pointer BACK a revert rather than a
	 * re-index, which is why drop-on-promotion is OFF by default. Where it IS on, it
	 * now really does drop the superseded generation on the ordinary processor
	 * upgrade: the clause that used to DECLINE that drop -- never drop the WRITER of a
	 * stream another held generation follows (ADR-0046), which would leave the
	 * follower folding a stream nothing appends to -- has no subject left on this
	 * runtime, because no generation writes a stream (ADR-0087). What the deployment
	 * keeps instead is the STREAM, which is the expensive half: a drop takes the
	 * registry row and the state namespace and never the bytes the fetches bought.
	 *
	 * It takes an IDENTITY and nothing else. It used to take the held fold beside it,
	 * purely so that the move could DISARM it in memory; the `successor` slot is what
	 * arming is now, and the registry empties that slot in the same commit as the
	 * move, so there is nothing left for a caller to hand over -- which is right,
	 * since there is no fold at all for a generation this process was not built with
	 * (the ordinary post-redeploy revert, see `promote`).
	 */
	private async movePointer(id: GenerationId): Promise<GenerationRecord> {
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
		/**
		 * THE TARGET HAS TO FOLD FROM THIS MOMENT, so a generation this container holds
		 * no fold for is INSTANTIATED from its stored bundle first (ADR-0092). BEFORE the
		 * write, so an instantiation that fails refuses the move and leaves the deployment
		 * exactly as it was (`GenerationInstantiationError`) rather than serving a state
		 * nothing advances. Not on a no-op move: the pointer is not going anywhere.
		 */
		const moving = !supersededRecord || !sameGeneration(supersededRecord, id);
		const resumed =
			moving && this.options.instantiateGeneration && !this.folds.some((held) => sameGeneration(held.record, id))
				? await this.resumable(id, this.options.instantiateGeneration)
				: undefined;
		const record = await this.registry.moveCanonicalTo(id);
		if (resumed?.fold) {
			this.hold(resumed.fold, resumed.source, resumed.provided);
			namedLogger.info(
				`the generation {stream: ${record.stream}, processor: ${record.processor}} was INSTANTIATED from the bundle ` +
					`stored for it (ADR-0092): this process was not built with its code, and it folds again from where its ` +
					`state stood.`,
			);
		}
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
		// NOTHING IS DISARMED HERE. The target is canonical now, so it is no longer
		// waiting to become so -- and the registry took it out of the `successor` slot in
		// the same commit as the move, which is the only place that fact was ever kept.
		// A REVERT past it later therefore cannot re-promote it on the next chunk.
		if (!supersededRecord || sameGeneration(supersededRecord, record)) {
			return record;
		}
		namedLogger.info(
			`the canonical pointer moved ${wasPromotion ? '' : 'BACK '}to {stream: ${record.stream}, processor: ` +
				`${record.processor}}. The generation {stream: ${supersededRecord.stream}, processor: ` +
				`${supersededRecord.processor}} is what \`predecessor\` names from here on: it keeps its own state and is ` +
				`what the pointer moves BACK to.`,
		);
		const superseded = this.folds.find((held) => sameGeneration(held.record, supersededRecord));
		if (!this.canonicalFold) {
			// SAID OUT LOUD, because it is a deployment serving reads that will not advance:
			// either its stream is not one this deployment fetches (a revert across a filter
			// change), or this host was given no way to turn stored bytes into a fold. The
			// generation moved away from keeps folding, so the stream it reads stays fetched.
			const why =
				resumed && !resumed.fold
					? resumed.frozen
					: `this container was given no \`instantiateGeneration\`, so the bundle stored for it cannot be run here`;
			namedLogger.error(
				`the canonical pointer now names {stream: ${record.stream}, processor: ${record.processor}}, and NOTHING in ` +
					`this process folds it: it answers reads from its own state and does not advance. ${why} (ADR-0092).`,
			);
		} else if (superseded && !wasPromotion) {
			// THE GENERATION MOVED AWAY FROM BY A REVERT STOPS BEING FOLDED. It stays
			// registered, keeps its state and is what `predecessor` names, so a move forward
			// again is still one write -- and instantiates it again from its stored bundle.
			// Folding on would leave this process running the engine an operator REJECTED
			// beside the one it now serves. Only when the new canonical generation IS folded
			// here, so the stream always keeps a fold and its writer stays live.
			this.stopDriving(supersededRecord);
			namedLogger.info(
				`the generation {stream: ${supersededRecord.stream}, processor: ${supersededRecord.processor}} was moved ` +
					`away from by a move that is not a promotion, so this process no longer folds it. It is kept, with its ` +
					`state and its stored bundle, and a move back onto it instantiates it again.`,
			);
			return record;
		}
		// A MOVE THAT IS NOT A PROMOTION DROPS NOTHING, which is the chain-facing
		// container's rule (`arrangeDrop`) and ADR-0046's: drop-on-promotion discards a
		// generation a promotion SUPERSEDED, and a revert supersedes nothing -- it moves
		// away from a generation that is exactly what a second move forward would want
		// back.
		if (this.promotionConfig.dropOnPromotion && superseded && wasPromotion) {
			await this.dropSuperseded(superseded, record);
		} else if (superseded && this.canonicalFold && this.instantiatedHere.has(superseded)) {
			// A FOLD THIS PROCESS BUILT FROM STORED BYTES IS HELD WHILE THE POINTER NAMES IT,
			// and a promotion is the pointer leaving it: the incumbent an upgrading restart
			// kept folding through the catch-up stops being folded here (ADR-0092). It is
			// RETAINED -- registered, with its state and its bundle, and named by
			// `predecessor` -- so a revert is still one write, and instantiates it again.
			this.stopDriving(supersededRecord);
			namedLogger.info(
				`the generation {stream: ${supersededRecord.stream}, processor: ${supersededRecord.processor}} was ` +
					`instantiated here from its stored bundle only because it answered reads, so this process no longer ` +
					`folds it now that the pointer has left it. It is kept, with its state and its bundle, and a move back ` +
					`onto it instantiates it again.`,
			);
		}
		return record;
	}

	/**
	 * Drop a superseded generation: its registry row and its state namespace, and
	 * NOT its stream.
	 *
	 * It used to DECLINE where the generation being dropped was the elected writer
	 * of a stream another held fold followed, because dropping it would have left
	 * that fold folding a stream nothing appended to AND reaped the stream out from
	 * under it. Neither is possible any more (ADR-0087): no generation writes a
	 * stream, so there is no duty to strand, and a delete does not reap, so there
	 * are no bytes to lose. The decline is gone rather than kept as a clause nothing
	 * can reach.
	 */
	private async dropSuperseded(
		superseded: HeldFold<ABI, ProcessResultType, unknown>,
		successor: GenerationRecord,
	): Promise<void> {
		// Out of the held list FIRST, so nothing drives a fold whose state is being
		// dropped underneath it.
		this.folds.splice(this.folds.indexOf(superseded), 1);
		// ...and nothing relays what it did: this container no longer drives it, and a
		// dropped fold that went on reporting would be a channel into a publisher nothing
		// can reach it through any more.
		superseded.processor.setFoldReporter?.(undefined);
		try {
			// NO REAP: a promotion nobody asked to delete a stream for does not delete one
			// (ADR-0087). The stream stays, recorded by the registry, and is what the next
			// generation over it re-folds instead of going back to a node for history it
			// may refuse outright.
			await this.registry.deleteGeneration(superseded.record);
			namedLogger.info(
				`dropped the superseded generation {stream: ${superseded.record.stream}, processor: ` +
					`${superseded.record.processor}} on the promotion of {stream: ${successor.stream}, processor: ` +
					`${successor.processor}}. Its state namespace is gone and the stream ${superseded.streamDigest} is ` +
					`KEPT: a stream outlives every fold over it and is deleted only when asked.`,
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
	 * registration does to rows it never touched. That is `unheldIsCollectable: false`,
	 * stated at this call site rather than defaulted, and it is the ONE axis on which
	 * the shared rule differs between the runtimes: the chain-facing twin answers TRUE,
	 * because there nothing else will ever collect such a row and it can never run again
	 * (ADR-0090, points 3 and 4). Here it can: an operator RUNS `reclaim`, and a
	 * registration that collected for them would delete with nobody present -- the
	 * decision ADR-0084 declined to make -- taking whichever generation they were
	 * keeping with it.
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
	 * WHICH RECORDS THAT COVERS is `displacedBySuccessor`'s, shared with the
	 * chain-facing twin so the safety clause has ONE home; what is HERE is what
	 * stopping a fold means on this runtime.
	 *
	 * ## WHAT IT NO LONGER TAKES: the stream (ADR-0087)
	 *
	 * This path used to reap the stream of whatever it dropped, wherever that was
	 * the last generation on it -- so saving twice in a tab deleted the history the
	 * first save had fetched. That is the AUTOMATIC reap ADR-0087 removes, and with
	 * it goes the clause that used to RETAIN a replaced generation because dropping
	 * it would have stranded a fold on the stream it wrote: no generation writes a
	 * stream any more, so there is no duty to strand, and the bytes stay whatever
	 * happens to the rows.
	 */
	private async replaceTheSuccessor(
		arriving: GenerationId,
		registered: readonly GenerationRecord[],
		slots: SlottedGenerations,
	): Promise<void> {
		const displaced = displacedBySuccessor(arriving, registered, slots, {
			heldHere: (record) => this.folds.some((fold) => sameGeneration(fold.record, record)),
			unheldIsCollectable: false,
		});

		for (const record of displaced) {
			await this.dropReplaced(record, arriving);
		}
	}

	/**
	 * Drop ONE replaced successor: its registry row, its state namespace, and every
	 * trace of it in this container.
	 *
	 * Deleting a generation is already a `DROP` of its table namespace, injected by
	 * whoever named the tables (ADR-0053) and performed by the registry, so nothing new
	 * is invented here: what is new is deciding WHEN, without being asked.
	 *
	 * **The STREAM is NOT reaped with it** (ADR-0087). It used to be, wherever this was
	 * the last generation folding it, which made a second save in a tab delete the
	 * history the first save had fetched -- the one place this codebase deleted an
	 * expensive thing to reclaim a cheap one. What a registration displaces is a FOLD.
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
		try {
			// NO REAP, which is the whole of ADR-0087's second half at this call site.
			await this.registry.deleteGeneration(record);
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
				`it would be work for a result nobody will ever ask for. Its state namespace is gone and the stream ` +
				`${record.stream} is KEPT: a stream outlives every fold over it and is deleted only when asked ` +
				`(ADR-0087). The canonical generation and the revert target are untouched.`,
		);
		return true;
	}

	/**
	 * STOP DRIVING a generation whose record has gone: out of the held folds, out of
	 * the memo, and off the reporter.
	 *
	 * One function rather than the same three lines wherever a generation is deleted,
	 * because the last is the one that is easy to forget and the worst to omit: a
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
	 * It DECLINES per generation rather than refusing the whole call, where the
	 * substrate would not delete one: the others still go, and the next reclaim tries
	 * again. NEWEST FIRST, which is the order the registry lists garbage in.
	 *
	 * ## IT IS THE ONE PATH THAT STILL REAPS A STREAM (ADR-0087)
	 *
	 * Deletion is a VERB. Every AUTOMATIC reap is gone -- a registration that displaces
	 * a successor and a promotion that drops what it superseded both leave the stream
	 * exactly where it is -- and what is left is this, which an operator ran, and
	 * `deleteStream`, which an operator named. So a generation reclaimed here takes its
	 * stream with it exactly when no registered generation is left folding it, which is
	 * what an operator reclaiming disk asked for and is why the report NAMES what came
	 * back.
	 *
	 * The clause that used to RETAIN the elected writer of a stream another held fold
	 * followed is gone with the election: no generation writes a stream, so there is
	 * no duty to strand.
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

		for (const record of garbage) {
			let deletion: GenerationDeletion;
			try {
				// REAPING, and this is the only call in this container that asks for it: an
				// operator ran the verb, so the stream of a generation that was the last one
				// folding it goes with it (ADR-0087).
				deletion = await this.registry.deleteGeneration(record, {reapStream: true});
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

	/**
	 * RESOLVE a generation this indexer has REGISTERED, and refuse one it has not.
	 *
	 * It used to resolve OR CREATE, which made it a second registration route beside
	 * `add` -- one that carried no bundle, so it could register a generation on a Node
	 * deployment with no code stored for it (ADR-0092), which is precisely the class of
	 * frozen generation retention exists to make unexpressible. On this container a
	 * generation is registered by `add` and by nothing else, because `add` is what holds
	 * the bytes; this answers for what `add` (or an earlier process) already registered.
	 */
	async resolveGeneration(id: GenerationId): Promise<GenerationRecord> {
		const key = keyOf(id);
		const known = this.records.get(key);
		if (known) {
			return known;
		}
		const record = (await this.registry.list()).find((candidate) => sameGeneration(candidate, id));
		if (!record) {
			throw new UnknownGenerationError({stream: id.stream, processor: id.processor});
		}
		this.records.set(key, record);
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
