import type {Abi} from 'abitype';
import type {EIP1193ProviderWithoutEvents} from 'eip-1193';
import {logs} from 'named-logs';

import {IndexerGeneration, type LoadingState, type PauseState, type ReconfigureOutcome} from './indexer.js';
import {
	displacedBySuccessor,
	sameGeneration,
	fetcherOf,
	slotHolding,
	type GenerationId,
	type GenerationRecord,
	type GenerationRegistry,
	type SlottedGenerations,
} from './generation/registry.js';
import {
	hasReachedCursor,
	promotionOnAdd,
	readyForPromotion,
	resolvePromotionConfig,
	type PromotionConfig,
	type UsedPromotionConfig,
} from './generation/promotion.js';
import {generationDigestOf} from './generation/identity.js';
import {streamDigestOf} from './stream/identity.js';
import {readOnlyStream} from './stream/readOnly.js';
import {resolveStreamConfig} from './internal/engine/utils.js';
import {requireProcessorIdentity} from './internal/processorIdentity.js';
import {StateMovedPublisher, type StateMovedDetach, type StateMovedHandler} from './stateMoved.js';
import type {
	EventProcessor,
	FoldReport,
	IndexingSource,
	LastSync,
	LogEvent,
	ProvidedIndexerConfig,
	ProvidedStreamConfig,
} from './types.js';

const namedLogger = logs('@etherfold/core');

/* ---------------------------------------------------------------------------
 * THE GENERATION CONTAINER: the indexer that HOLDS generations, one of which is
 * canonical and answers every read.
 *
 * `IndexerGeneration` is one stream plus one processor
 * plus one state, which under this model is a GENERATION and not the container.
 * This is the container, and the name follows `CONTEXT.md`, which has defined
 * *indexer* as the named unit holding generations, carrying the caps and holding
 * ONE canonical pointer since ADR-0036.
 *
 * ## What it adds, and what it deliberately does not
 *
 * It adds four things:
 *
 * 1. **Generations are BUILT from factories, not handed over already built.** A
 *    container that holds N generations cannot be given one already-constructed
 *    processor over one already-constructed store, because each generation folds
 *    into its OWN state. So a generation arrives as a `GenerationSpec`: a state
 *    factory and a processor factory, called once each, in that order.
 * 2. **Reads resolve through the CANONICAL POINTER, indirectly.** `state` is a
 *    handle that answers from whichever generation is canonical NOW, so holding
 *    a reference across a promotion is never a way to read a retired generation
 *    (story 6).
 * 3. **A pointer move is APPLIED AT A NOTIFICATION.** See `promote` for why that
 *    single rule is the whole read unit of work, and why no scope API, no
 *    transaction handle and no timer is needed to get it.
 * 4. **EVERY generation it holds ADVANCES, and HOW each one advances is
 *    DETERMINED rather than configured.** A generation that shares its stream
 *    with one already held is a FOLLOWER: it fetches nothing, writes nothing,
 *    re-folds the stored stream from the start and then follows it. A generation
 *    on its own stream is an ordinary indexer at a different address. There is no
 *    knob, and `add` is where the rule lives.
 *
 * It also PUBLISHES a discard (`publishDiscard`), which is not a fifth thing but
 * the second one applied to the case `onStateUpdated` never covered: a fold that
 * was thrown away is neither adopted nor produced, so without this a subscriber
 * holding the state it lost is told by nothing.
 *
 * 5. **A generation PAUSES by capping and draining**, and the container is where
 *    one is named: `pause` / `resume` take the generation, because pausing is a
 *    fact about one generation and not about the indexer. It adds no mechanism of
 *    its own -- the cap lives on the engine and the drain is the existing
 *    `getFromBlock` -- and `HeldGeneration.pauseState` is what a consumer watches
 *    for the DRAINING period to end.
 * 6. **It APPLIES the promotion policy**, which is WHEN the pointer moves on its
 *    own and what happens to the generation left behind. The three values and
 *    their one default live in `generation/promotion.ts`; what lives here is the
 *    application of them -- see `applyPolicyTo` (at creation), `settlePromotion`
 *    (the trigger, once per advance) and `dropSuperseded`.
 *
 * It still does not turn a RECONFIGURE VERB into a new generation:
 * `updateIndexer` and `updateProcessor` do to the canonical generation exactly
 * what they did before. Building a successor is `add`, which is what a caller
 * that wants a reconfigure without an outage calls.
 *
 * ## A GENERATION IS HELD BY A DURABLE NAMED SLOT (ADR-0084)
 *
 * The registry holds three assignments and `canonical` is merely the first:
 * `successor` is the generation being built beside the incumbent and holds AT
 * MOST ONE, and `predecessor` is what a revert moves back to on the runtime that
 * assigns one, which is not this one (see below). `add` registers
 * into `successor`, so a second registration REPLACES the first pending one --
 * and because the slot is a ROW, a RELOADED TAB replaces what it finds there
 * having registered nothing and remembered nothing, which is the property no
 * in-memory rule could have. What that replaced is DROPPED: the registry row, the
 * state store (`dropState`) and the stream where no registered generation is left
 * folding it.
 *
 * **This is the twin where it matters most**, and it is the same rule as the
 * receiving container's rather than a second dialect of it. A page reload is a
 * fresh process with an empty memory, the caps here are the tightest in the
 * system (`BROWSER_GENERATION_CAPS`, two of each), and a developer reloads a tab
 * constantly -- so an in-memory rule protected the long-lived server process,
 * which accumulates slowly, and missed the tab, which accumulates every few
 * minutes. WHAT a registration displaces is `displacedBySuccessor`, shared with
 * the receiving twin so the safety clause has one home; HOW it is dropped is
 * repeated here, because a fold on this side is an ENGINE and stopping one is
 * this container's own business.
 *
 * **NO `predecessor` IS ASSIGNED HERE (ADR-0089)**, and it is the one axis on
 * which this twin differs from the receiving one. A revert needs the code of the
 * fold it returns to, and a tab cannot have it: a production bundle ships ONE
 * processor, so the superseded generation's code is not un-promoted but ABSENT
 * FROM THE BUILD, and in development the way back is the editor. The move
 * therefore never DRAFTS the assignment (`movePointerTo`), and the generation the
 * pointer came off is UNSLOTTED -- collectable by the ordinary rule, deleted by
 * nothing here. Going back in a browser is what it always was: supply the old
 * code, which derives the same identity and RESOLVES to the same record
 * (ADR-0086), re-folding the stream already on disk (ADR-0087).
 *
 * **AND A PROMOTION FINISHES THE JOB HERE (ADR-0090)**, which is the other axis
 * this twin differs on and the one that makes the numbers work. `dropOnPromotion`
 * DEFAULTS TO TRUE on this container (see the constructor): the generation a
 * promotion superseded can never answer a read or fetch again on a runtime that
 * ships one processor, so it goes -- row and state, never its stream (ADR-0087) --
 * and the FETCH DUTY moves to the promoted generation in the same act
 * (`dropSuperseded`). An embedder may still turn the drop off and keep a way back
 * inside one session.
 *
 * **What the browser's numbers mean after that**, stated because it is arithmetic
 * rather than taste, and MEASURED rather than reasoned: at `maxGenerations: 2` the
 * tab holds `canonical` + `successor` (the reconfigure loop, which is what this
 * makes unbounded) and never `canonical` + `predecessor`. Every promotion frees the
 * second seat, on BOTH kinds of save: a CROSS-STREAM save leaves the superseded
 * generation alone on its old stream, and a SAME-STREAM save loop -- the developer
 * editing a handler, the common case -- hands that stream to the promoted fold
 * before dropping the writer. That second case is what used to WALL: the drop was
 * declined (`wouldStrandAFollower`, ADR-0044), the save met the cap and was REFUSED
 * (`GenerationCapReachedError`), and no page reload could clear it. The caps are
 * deliberately unchanged by any of this (ADR-0084's consequences): what frees the
 * seat is a promotion finishing, never an eviction at the bound.
 *
 * The DIRECTION of a move is still read from a slot, and that is `successor`'s job
 * rather than `predecessor`'s: a PROMOTION is a move onto what `successor` names,
 * and every other move drops nothing. It is the reason a boolean (`everCanonical`)
 * used to stand on each held entry, answering "has the pointer EVER named this
 * generation, as far as THIS container has seen" -- which after a reload was
 * `false` for everything, so a restarted tab read every move as a revert. The slot
 * answers it durably and better.
 * ------------------------------------------------------------------------- */

/** What both of a generation's factories are told about the generation being built. */
export type GenerationContext = {
	/**
	 * The stream this generation folds, as `streamDigestOf` renders it.
	 *
	 * Handed to both factories because it is the half of a generation's identity
	 * that IS known before the fold exists -- it is a function of the source and
	 * the stream config alone -- so a runtime that addresses storage per stream
	 * can do so without waiting for a processor.
	 */
	readonly stream: string;
};

/**
 * HOW ONE GENERATION IS BUILT: its state, then the fold over it.
 *
 * The order is forced by the identity and is worth stating, because it is what
 * makes the whole shape work without a circular dependency. A generation is
 * `{stream, processor version hash}`. The stream half is known up front. The
 * FOLD half is only known once the processor exists, and the processor needs its
 * state -- so the state cannot be keyed on the finished identity, and a design
 * that tried would deadlock on the first reload (find the record to learn the
 * store to build the processor to compute the record's key).
 *
 * The way out is that the factories are supplied PER GENERATION rather than once
 * for the container: the caller's own closure is what distinguishes this
 * generation's state from the next one's, and the container registers the
 * identity AFTER building, from whatever the ARRIVAL supplied (ADR-0086). Nothing
 * has to be declared twice, and nothing can be declared wrongly.
 */
export type GenerationSpec<ABI extends Abi, ProcessResultType = void, State = unknown> = {
	/**
	 * Build the state THIS generation folds into. Called ONCE, before the
	 * processor.
	 *
	 * The container never touches the value: it is a separate step (rather than
	 * folded into `createProcessor`) so that "each generation has its own state" has
	 * somewhere to be expressed. On the entity path it is a `StateStore`; the
	 * container names no storage seam and cannot, since `@etherfold/core` does not
	 * depend on one.
	 *
	 * ## It is a CONVENTION, and the caller has to keep it
	 *
	 * This used to claim the separate step made per-generation state STRUCTURAL.
	 * It does not, and it cannot: `State` is opaque here, so the container cannot
	 * tell two stores apart, and two distinct store objects can address one
	 * underlying database anyway -- which is the way this actually goes wrong, and
	 * is invisible from here by construction.
	 *
	 * So it is on the caller, and this is the rule: **key the state on
	 * `context.stream`.** Two generations under one storage location are ONE store
	 * by that backend's own definition, and their cursors collide as well as their
	 * rows, because the sync cursor lives under a fixed key. The whole point of a
	 * successor -- the canonical generation keeps answering complete old answers
	 * while the new fold catches up -- does not survive that.
	 *
	 * The factory is handed the `GenerationContext` for exactly this reason: it is
	 * the identity to derive a database name, a table prefix or a directory from.
	 */
	createState: (context: GenerationContext) => State | Promise<State>;
	/**
	 * Build the processor that folds it. The FACTORY, not its result.
	 *
	 * What NAMES this generation is `processorIdentity` below, so two generations
	 * over one stream are two records exactly when their folds differ -- which is
	 * the common reconfigure (a processor change re-fetches nothing) made
	 * identity.
	 */
	createProcessor: (
		state: State,
		context: GenerationContext,
	) => EventProcessor<ABI, ProcessResultType> | Promise<EventProcessor<ABI, ProcessResultType>>;
	/**
	 * THE IDENTITY THIS FOLD WAS HANDED, which its ARRIVAL derived: the fold half of
	 * the generation this spec registers.
	 *
	 * ADR-0086: an author cannot STATE a processor's identity, so it comes from what
	 * the processor IS. A host that read a self-contained BUNDLE off disk names its
	 * generation by the SHA-256 of those octets, and an edited handler is a
	 * different generation whether or not anybody remembered to say so. The
	 * container never looks INSIDE the value -- it is COMPARED and RENDERED and
	 * nothing here parses it -- so it does not care which arrival derived it.
	 *
	 * REQUIRED, and REFUSED when it is missing: there is no declared identity left
	 * to fall back on, so a generation with no name is not registrable. It is typed
	 * optional for ONE reason, which is the read ORDER `add` promises: state, then
	 * processor, THEN identity. That is what makes a MODULE arrival expressible --
	 * a fold with no bytes cannot be named before the object exists, so
	 * `@etherfold/browser` hands this spec over and fills the field in from inside
	 * `createProcessor`. By the time the factory has returned it must be there.
	 *
	 * It is PER GENERATION and deliberately not on `IndexerOptions.config`, which is
	 * one value shared by every generation this container builds: two generations
	 * given one identity would be ONE record, one state namespace and one fold of a
	 * stream two specs asked to fold separately.
	 */
	processorIdentity?: string;
	/**
	 * The state handle to answer with BEFORE this generation has folded anything.
	 *
	 * Optional, and only interesting where the state is a READ HANDLE rather than
	 * a value: on the entity path `process()` hands back the same
	 * `EntityStateView` every time, and it exists the moment the processor does,
	 * so a reader must be able to hold it before the first event arrives. Without
	 * it the container answers with the last state this generation published, and
	 * with nothing at all until it publishes one.
	 */
	stateOf?: (processor: EventProcessor<ABI, ProcessResultType>) => ProcessResultType;
	/**
	 * The FETCH FILTER this generation folds, when it is not the container's own.
	 *
	 * A stream IS its fetch filter, so this is the only way to say "a different
	 * stream" -- and saying it is what makes the container's advance rule
	 * DETERMINED rather than configured: a generation naming no source of its own
	 * shares the container's stream and therefore FOLLOWS it, while one naming a
	 * different filter must fetch, because the logs it needs were never requested
	 * under the old one. There is deliberately no flag anywhere that says which.
	 *
	 * The stream CONFIG is deliberately NOT settable per generation, and that is a
	 * limit rather than an oversight: `setStreamConfig` is a single mutable value
	 * on the ONE keeper a container holds ("one keeper serves one indexer"), so two
	 * generations under different configs would clobber each other's address. A
	 * config change is still a new stream; reaching it needs a keeper per
	 * generation, which is nobody's landable yet.
	 */
	source?: IndexingSource<ABI>;
};

/**
 * A spec whose STATE type the container does not care about, which is all of
 * them: the value goes from one of the caller's factories to the other and the
 * container never looks inside it.
 */
export type AnyGenerationSpec<ABI extends Abi, ProcessResultType = void> = GenerationSpec<
	ABI,
	ProcessResultType,
	// deliberately `any`: this is the existential the container holds, and `unknown`
	// here would force every caller to cast its own store back out again
	/* eslint-disable-next-line */ any
>;

/**
 * A generation BUILT AND REGISTERED, with no engine and nothing held yet.
 *
 * What phase one of `open` produces and phase two consumes. It exists because
 * `follows` is a question about the whole fold set (ADR-0088), so the set has to
 * be complete before the first engine is constructed -- and a generation cannot
 * be NAMED any earlier than this, since a fold arriving as a module derives its
 * identity inside `createProcessor` (ADR-0086).
 */
type RegisteredGeneration<ABI extends Abi, ProcessResultType> = {
	spec: AnyGenerationSpec<ABI, ProcessResultType>;
	/** This generation's own fetch filter, which is the container's unless the spec named one. */
	source: IndexingSource<ABI>;
	processor: EventProcessor<ABI, ProcessResultType>;
	record: GenerationRecord;
};

/** What the container keeps per generation. Internal: `HeldGeneration` is what it hands out. */
type HeldEntry<ABI extends Abi, ProcessResultType> = {
	record: GenerationRecord;
	generation: IndexerGeneration<ABI, ProcessResultType>;
	processor: EventProcessor<ABI, ProcessResultType>;
	spec: AnyGenerationSpec<ABI, ProcessResultType>;
	/** Whether this generation FOLLOWS a stream another generation writes. See `add`. */
	follows: boolean;
	/**
	 * The cursor this generation last reported, or nothing before it has loaded.
	 *
	 * Kept per generation and not for the canonical one alone, because the
	 * promotion TRIGGER is a comparison BETWEEN two of them (`lastToBlock`), and
	 * because a promotion has to be able to PUBLISH the cursor of the generation
	 * that now answers -- a consumer left holding the retired generation's would
	 * reason about a window that is no longer being maintained. Recorded from what
	 * each generation publishes and from what each advance returns, so it needs no
	 * new surface on the engine.
	 */
	lastSync?: LastSync<ABI>;
	/**
	 * Whether this generation is a candidate for AUTOMATIC promotion.
	 *
	 * ARMED by `add` under `on-catch-up` -- creating a generation beside the live
	 * one is what asks for the move -- and cleared the moment the pointer reaches
	 * it. It is deliberately not "every non-canonical generation is a candidate":
	 * that rule would re-promote the successor on the next cycle after a REVERT,
	 * since a reverted-from generation is caught up by construction, and story 4's
	 * whole point is that the way back holds. IN MEMORY, like the pause cap and for
	 * the same reason (ADR-0045): the registry holds what a generation IS, and being
	 * a candidate is what a container is DOING with one.
	 */
	candidate: boolean;
	/* --------------------------------------------------------------------------
	 * WHAT USED TO BE HERE, and what reads it now (ADR-0084)
	 *
	 * `everCanonical`, "whether the canonical pointer has EVER named this
	 * generation", which is how a PROMOTION was told from a REVERT. It is DELETED
	 * rather than left beside the slot agreeing with it most of the time: what it
	 * actually held was a record of the moves ONE PROCESS had seen, so after a page
	 * reload it was `false` for every generation and a genuine promotion read as a
	 * revert. `movePointerTo` reads the `successor` SLOT instead -- a durable row any
	 * process can read, which is the same answer the receiving twin reads.
	 * ------------------------------------------------------------------------ */
	published?: ProcessResultType;
	/** Distinguishes "published nothing yet" from "published `undefined`", which a `void` fold does. */
	hasPublished: boolean;
	/**
	 * How many times this generation has published a state.
	 *
	 * Read ONLY as a comparison across a reconfigure, to answer "did the fold
	 * produce a state while that call was running?". A discard does not always
	 * leave nothing: when the STREAM survives (a processor swap leaves the cached
	 * events untouched, since the stream verdict is about the source and the config
	 * and not the processor), the `load` inside the verb replays it and publishes
	 * the REBUILT state before the verb returns. Dropping the handle after that
	 * would throw away the very thing the rebuild produced.
	 */
	publications: number;
};

/** One generation this container holds: its record, its engine, its fold. */
export type HeldGeneration<ABI extends Abi, ProcessResultType = void> = {
	readonly record: GenerationRecord;
	/** The engine that fetches and folds for this generation. */
	readonly generation: IndexerGeneration<ABI, ProcessResultType>;
	/** The processor this generation folds with. */
	readonly processor: EventProcessor<ABI, ProcessResultType>;
	/**
	 * Whether this generation FOLLOWS a stream another held generation writes,
	 * rather than fetching its own.
	 *
	 * REPORTED and never set: it is a consequence of sharing a stream, and a caller
	 * that could choose it would be choosing to break the one-writer rule. Exposed
	 * so a driver or a test can see what was determined instead of inferring it
	 * from a fetch count.
	 */
	readonly follows: boolean;
	/**
	 * HOW FAR THIS GENERATION'S FOLD HAS GOT, or nothing before it has loaded.
	 *
	 * Reported for EVERY held generation and not for the canonical one alone,
	 * because "a generation exists beside the live one and it is N blocks behind"
	 * is a question only this object can answer: the canonical generation's cursor
	 * is published through `onLastSyncUpdated`, and a non-canonical one publishes
	 * to nobody (story 5). The container already keeps it -- the promotion trigger
	 * is a comparison between two of these -- so this exposes what is there rather
	 * than recording it twice.
	 *
	 * Read afresh from the entry on every access, like `pauseState` and for the
	 * same reason: a cursor moves between two reads, and a snapshot taken when this
	 * object was built would report a distance that stopped closing.
	 *
	 * `undefined` means this generation has not loaded, which is NOT the same claim
	 * as being level at block 0.
	 */
	readonly lastSync: LastSync<ABI> | undefined;
	/**
	 * WHERE A PAUSE HAS GOT TO: `running`, `draining`, or `drained`.
	 *
	 * Read afresh from the engine on every access, because a drain completes
	 * between two reads and a snapshot taken when this object was built would say
	 * `draining` forever. It is what a consumer watches to know that a pause -- which
	 * is NOT instant, since it takes up to `finality` blocks of continued light
	 * polling -- has actually completed.
	 */
	readonly pauseState: PauseState;
};

/**
 * The registry names a canonical generation this container was not given
 * factories for.
 *
 * REFUSED rather than worked around, and the two obvious ways around it are both
 * worse. Silently promoting the generation that WAS built would move the
 * canonical pointer without anybody asking, which is the one thing a container
 * that holds a revertible history must never do on its own. Running the built
 * generation while the pointer names another would answer reads from a
 * generation the registry says is not canonical -- silently, and exactly the
 * staleness the indirect handle exists to prevent.
 *
 * It is reachable today only across a restart against a DURABLE registry whose
 * pointer was moved by an earlier session. Resuming several generations is the
 * promotion policy's and the shared-stream follower's business; until they land,
 * a caller either supplies the specs for the canonical generation or moves the
 * pointer back before opening.
 */
export class CanonicalGenerationNotHeldError extends Error {
	readonly name = 'CanonicalGenerationNotHeldError';

	constructor(
		readonly canonical: GenerationId,
		readonly held: readonly GenerationId[],
	) {
		super(
			`the canonical generation {stream: ${canonical.stream}, processor: ${canonical.processor}} is not one this ` +
				`indexer was built to hold, so nothing here can answer a read. Held: ` +
				`${held.map((id) => `{stream: ${id.stream}, processor: ${id.processor}}`).join(', ') || '(none)'}. ` +
				`Supply the spec that builds the canonical generation, or move the canonical pointer to one of the held ` +
				`generations before opening -- this is never fixed by promoting one of them here, because which ` +
				`generation answers reads is not a decision an open may take on its own.`,
		);
	}
}

/**
 * PAUSING A FOLLOWER, which is not a thing a cap can express.
 *
 * A pause CAPS the block a generation fetches up to, and a **follower** fetches
 * nothing at all: it advances exactly as far as the STREAM it folds and holds no
 * `toBlock` of its own. So the cap would sit there governing a verb that never
 * runs, and `pauseState` would report a drain that is not happening -- a pause
 * that lies, which is worse than a refusal, because the whole point of draining
 * is knowing that nothing a reorg can invalidate is still being answered.
 *
 * What stops a follower is stopping its STREAM, which is the writer's business
 * (ADR-0044: a follower's whole claim is that its state is a function of the
 * stream, so the writer's pause is felt by everything following it), or deleting
 * it. Pausing a follower ON ITS OWN TERMS needs the follow path to keep replaying
 * its window while it drains, and that is the follower's landable rather than a
 * cap.
 */
export class CannotPauseFollowerError extends Error {
	readonly name = 'CannotPauseFollowerError';

	constructor(readonly id: GenerationId) {
		super(
			`the generation {stream: ${id.stream}, processor: ${id.processor}} FOLLOWS a stream another generation ` +
				`writes, so it fetches nothing and there is no \`toBlock\` of its own to cap. Pausing it would report a ` +
				`drain that never runs. A follower advances exactly as far as its stream: stop the stream's WRITER, or ` +
				`delete this generation.`,
		);
	}
}

/** A generation the container does not hold, named to a container operation. */
export class UnheldGenerationError extends Error {
	readonly name = 'UnheldGenerationError';

	constructor(readonly id: GenerationId) {
		super(
			`this indexer holds no generation {stream: ${id.stream}, processor: ${id.processor}}. A registered ` +
				`generation this container did not build has no engine and no state here, so pointing reads at it would ` +
				`answer them from nothing.`,
		);
	}
}

/** What `openIndexer` needs: where the generations are recorded, what they index, and how to build them. */
export type IndexerOptions<ABI extends Abi, ProcessResultType = void> = {
	/** Which generations this indexer holds, which one is canonical, and the caps that refuse. */
	registry: GenerationRegistry;
	provider: EIP1193ProviderWithoutEvents;
	source: IndexingSource<ABI>;
	config?: ProvidedIndexerConfig<ABI>;
	/**
	 * The generations to build and register, in order.
	 *
	 * The FIRST one registered becomes canonical when nothing is canonical yet,
	 * which is the registry's rule and not a policy of this container's.
	 */
	generations: readonly AnyGenerationSpec<ABI, ProcessResultType>[];
	/**
	 * WHEN the canonical pointer moves on its own, and what happens to the
	 * generation left behind.
	 *
	 * Defaults to `on-catch-up` with nothing dropped, and that default is the same
	 * in every runtime: see `generation/promotion.ts` for why there is deliberately
	 * no per-runtime and no per-environment selection.
	 */
	promotion?: PromotionConfig;
	/**
	 * How a generation's ENGINE is constructed. Defaults to
	 * `new IndexerGeneration(...)`.
	 *
	 * The same seam `createIndexerState`'s `createIndexer` option is, kept at this
	 * level too so a container can be driven by a subclass, a shared instance or a
	 * spy without the generation shape leaking into a test's assertions.
	 */
	createGeneration?: (
		provider: EIP1193ProviderWithoutEvents,
		processor: EventProcessor<ABI, ProcessResultType>,
		source: IndexingSource<ABI>,
		config: ProvidedIndexerConfig<ABI>,
		/**
		 * The identity this generation was REGISTERED under, RESOLVED: whatever the
		 * spec's arrival supplied, or the processor's own declared hash where it
		 * supplied nothing. Handed over so the engine cannot name its fold anything
		 * other than what the registry already recorded.
		 */
		processorIdentity: string,
	) => IndexerGeneration<ABI, ProcessResultType>;
};

/** How far a held generation's fold has got, or nothing before it has loaded. */
function cursorOf<ABI extends Abi, ProcessResultType>(entry: HeldEntry<ABI, ProcessResultType>): number | undefined {
	return entry.lastSync?.lastToBlock;
}

/** Whether a value can be reached THROUGH, which is what an indirect handle needs. */
function isIndirectable(value: unknown): value is object {
	return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/**
 * A handle with STABLE IDENTITY that reads through to whatever `resolve()`
 * currently answers.
 *
 * This is the whole of story 6's mechanism. The entity path hands a consumer a
 * read HANDLE rather than a state object -- the same `EntityStateView` every
 * time, bound to one store -- so a consumer that kept one across a promotion
 * would go on reading the retired generation's rows forever, with nothing to
 * indicate it. Reached through a resolver instead, the reference a consumer
 * holds is a reference to WHICHEVER GENERATION IS CANONICAL, and the pointer
 * move is the only thing that has to be correct.
 *
 * Every trap resolves afresh; the target is only ever the object the proxy
 * invariants are checked against. Methods are bound to the resolved target so a
 * destructured read (`const {getCurrent} = state`) cannot end up running against
 * the proxy. What it deliberately does NOT do is copy: there is no snapshot to
 * go stale.
 */
function indirectHandle<T extends object>(target: T, resolve: () => T): T {
	return new Proxy(target, {
		get(_target, property) {
			const current = resolve();
			const value = Reflect.get(current, property, current);
			return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(current) : value;
		},
		set(_target, property, value) {
			return Reflect.set(resolve(), property, value);
		},
		has(_target, property) {
			return Reflect.has(resolve(), property);
		},
		getPrototypeOf() {
			return Reflect.getPrototypeOf(resolve());
		},
	});
}

/**
 * The container, opened over its registry.
 *
 * Asynchronous because building a generation is: the state factory opens a
 * store, and the registry is a substrate that has to be read. See `Indexer`.
 */
export async function openIndexer<ABI extends Abi, ProcessResultType = void>(
	options: IndexerOptions<ABI, ProcessResultType>,
): Promise<Indexer<ABI, ProcessResultType>> {
	const indexer = new Indexer<ABI, ProcessResultType>(options);
	await indexer.open(options.generations);
	return indexer;
}

/**
 * AN INDEXER: several generations, one canonical pointer, one answer set.
 *
 * Built through `openIndexer`. See the module JSDoc above for what it adds over
 * a single `IndexerGeneration` and what it deliberately leaves to later work.
 */
export class Indexer<ABI extends Abi, ProcessResultType = void> {
	// ------------------------------------------------------------------------------------------------------------------
	// THE CALLBACKS, which are the GENERATION's callbacks forwarded from whichever generation is canonical
	// ------------------------------------------------------------------------------------------------------------------
	public onLoad: ((state: LoadingState) => Promise<void>) | undefined;
	/**
	 * The NOTIFICATION. It publishes the INDIRECT handle rather than the value the
	 * canonical generation produced, so a subscriber that keeps what it is handed
	 * keeps something that follows the pointer.
	 */
	public onStateUpdated: ((state: ProcessResultType) => void) | undefined;
	public onLastSyncUpdated: ((lastSync: LastSync<ABI>) => void) | undefined;
	/**
	 * THE POINTER MOVED. Fired for every move, whether the policy took it or a
	 * caller asked for it.
	 *
	 * It fires BEFORE the state notification that applies the move on the read
	 * path, so a consumer that keeps anything DERIVED from the canonical generation
	 * -- a cursor, a progress figure, a `checkTxInclusion` window -- can drop it
	 * before the notification tells everybody to re-read. A consumer told the other
	 * way round would answer one notification's worth of questions about the new
	 * generation from the retired one's cursor.
	 */
	public onPromoted: ((promoted: GenerationRecord, superseded: GenerationRecord | undefined) => void) | undefined;

	/**
	 * THE SIGNAL, and the token it carries: what this container tells the sides
	 * that are READING (ADR-0083).
	 *
	 * Held rather than reimplemented, because the receiving container publishes the
	 * SAME signal and one notification model is the claim being made. Everything
	 * about subscribing, containing a throwing handler and rotating the token is
	 * `StateMovedPublisher`'s; what is here is the half only a container knows --
	 * WHICH generation applied the block and whether it is the one that answers
	 * reads.
	 */
	protected readonly stateMoved = new StateMovedPublisher();

	protected readonly registry: GenerationRegistry;
	protected provider: EIP1193ProviderWithoutEvents;
	protected source: IndexingSource<ABI>;
	protected config: ProvidedIndexerConfig<ABI>;
	protected readonly createGeneration: NonNullable<IndexerOptions<ABI, ProcessResultType>['createGeneration']>;
	/** The promotion policy this indexer runs under, with nothing left to decide. */
	protected readonly promotionConfig: UsedPromotionConfig;

	/**
	 * Whether `open` has finished, so `add` knows a SUCCESSOR from the BOOT SET.
	 *
	 * The generations an indexer is opened with are the set it holds; which of them
	 * is canonical is the registry's durable answer, and the policy has no business
	 * second-guessing it at open -- under `immediate` it would otherwise promote the
	 * last spec in the list, and under `on-catch-up` it would undo a revert recorded
	 * in a previous session. A generation ADDED to a running indexer is a successor,
	 * and that is what the policy is about.
	 */
	protected opened = false;

	/**
	 * The drops the `immediate` policy DEFERRED, and the cursor each one waits for.
	 *
	 * `immediate` promotes a generation that has caught up to nothing, so dropping
	 * the previous one at that moment would discard a complete state for an empty
	 * one with no fallback. The two are resolved by ORDER rather than by an
	 * interlock: retention simply continues until the successor reaches the cursor
	 * the previous generation had AT THE PROMOTION.
	 */
	protected readonly deferredDrops: {
		superseded: HeldEntry<ABI, ProcessResultType>;
		successor: HeldEntry<ABI, ProcessResultType>;
		at: number;
	}[] = [];

	/** The stream every generation built from here folds. Recomputed by a reconfigure. */
	protected streamDigest: string;

	protected readonly held: HeldEntry<ABI, ProcessResultType>[] = [];

	/**
	 * WHICH generation reads resolve to, and it moves ONLY inside `notifyState`.
	 *
	 * It is not the same thing as the registry's canonical pointer, and the
	 * difference IS the read unit of work: the registry records the decision the
	 * moment it is taken, and this follows it at the next notification, so no read
	 * ever observes the pointer moving under it without being told.
	 */
	protected current: HeldEntry<ABI, ProcessResultType> | undefined;

	/** The indirect handle, created once so its identity is stable. */
	protected handle: {value: ProcessResultType} | undefined;

	constructor(options: IndexerOptions<ABI, ProcessResultType>) {
		this.registry = options.registry;
		this.provider = options.provider;
		this.source = options.source;
		this.config = options.config ?? {};
		// THE DROP DEFAULTS TO ON HERE, and this is the ONE call site that says so
		// (ADR-0090, point 1). This runtime ships ONE processor, so the generation a
		// promotion superseded is not un-promoted but ABSENT FROM THE BUILD: it can never
		// answer a read and never fetch, and retaining it spends the tightest caps in the
		// system on a seat nothing can use. The POLICY beside it still has no per-runtime
		// default and must never grow one -- that axis is development-versus-production,
		// which nothing here can detect -- and an embedder that wants the old behaviour
		// still says `{dropOnPromotion: false}` and gets it.
		this.promotionConfig = resolvePromotionConfig(options.promotion, {dropOnPromotion: true});
		this.createGeneration =
			options.createGeneration ??
			((provider, processor, source, config, processorIdentity) =>
				new IndexerGeneration<ABI, ProcessResultType>(provider, processor, source, config, {processorIdentity}));
		this.streamDigest = this.digestOf(this.source, this.config);
	}

	/**
	 * Build and register the generations, then resolve the canonical pointer onto
	 * one of them.
	 *
	 * ## TWO PHASES, because which generation FETCHES is a fact about the whole set
	 *
	 * Every spec is REGISTERED first, and only then is an ENGINE built for any of
	 * them. The split is ADR-0088's and it is not a tidy-up: `follows` is derived
	 * from the oldest generation this container HOLDS on the stream, and `add`
	 * freezes that answer into the engine's config at construction (`readOnlyStream`),
	 * so a derivation taken while the set is still half-built answers a different
	 * question for each spec and gives a different result per spec ORDER. Measured,
	 * with the same two folds listed edited-first: TWO generations decide they fetch,
	 * the same range is asked of the node twice, and one block's log is stored twice
	 * (`docs/spikes/the-reloaded-tab-stall-is-measured-on-the-configuration-a-tab-actually-has/`).
	 *
	 * The identity cannot be read any earlier than phase one, which is why the phase
	 * boundary is HERE and not before the factories: a fold arriving as a MODULE has
	 * no bytes to hash, so `GenerationSpec.processorIdentity` is filled in from
	 * inside `createProcessor` and a generation genuinely cannot be named before it
	 * is built (ADR-0086).
	 */
	async open(specs: readonly AnyGenerationSpec<ABI, ProcessResultType>[]): Promise<void> {
		const registered: RegisteredGeneration<ABI, ProcessResultType>[] = [];
		for (const spec of specs) {
			registered.push(await this.registerGeneration(spec));
		}
		// EVERY FOLD THIS CONTAINER WILL HOLD, known before the first engine exists.
		// The records carry their own `createdAt`, so ranking them is the registry's
		// order and not the order the caller listed its specs in.
		const willHold = registered.map((generation) => generation.record);
		for (const generation of registered) {
			await this.holdGeneration(generation, willHold);
		}
		await this.resolveCanonical();
		// LAST: from here on, a generation handed to `add` is a SUCCESSOR beside a live
		// one, which is the only thing the promotion policy has an opinion about.
		this.opened = true;
	}

	// ------------------------------------------------------------------------------------------------------------------
	// THE GENERATIONS
	// ------------------------------------------------------------------------------------------------------------------

	/**
	 * Build a generation and register it BESIDE the ones already held.
	 *
	 * It does not become canonical (unless nothing is, which is the registry's
	 * rule for the first one), and it DOES advance -- but how it advances is
	 * decided here and is not a choice anybody gets to make.
	 *
	 * ## The rule: a SHARED stream makes a FOLLOWER, and nothing else does
	 *
	 * A generation whose stream digest matches one already held is handed a
	 * READ-ONLY VIEW of the keeper (`readOnlyStream`) and advances with
	 * `followMore`: it fetches NOTHING, writes NOTHING, re-folds the stored stream
	 * from the start and then follows it as the indexing generation appends. A
	 * generation on a stream nobody here holds keeps the keeper itself and advances
	 * with `indexMore`, which is an ordinary indexer at a different address.
	 *
	 * There is no flag, because a flag would be wrong in both positions. "Follow a
	 * stream nobody writes" never advances; "fetch a stream somebody else writes"
	 * is a second writer, and it also makes this generation's state a function of
	 * its own fetch rather than of the stream, which is what would break the exact
	 * revert (`IndexerGeneration.followMore`). ADR-0044 records the rule and the
	 * options weighed against it.
	 *
	 * ## Which generation FETCHES a stream: the oldest one this container HOLDS
	 *
	 * Registration order among the folds PRESENT, and not the canonical pointer, so
	 * the fetching is stable: moving the pointer is one small record write and must
	 * not silently hand the append duty to a different engine mid-flight. The normal
	 * case makes the two the same thing anyway, since the first generation registered
	 * is the one the registry makes canonical. See `holdGeneration` for the
	 * derivation and for why the candidates are the held folds (ADR-0088).
	 *
	 * There is exactly ONE moment at which that answer changes under a held fold, and
	 * it is not a pointer move on its own: a promotion that DROPS the writer hands the
	 * stream to the generation the derivation names next, which is safe only because
	 * that generation has provably reached the writer's cursor (`dropSuperseded`,
	 * ADR-0090). Everywhere else the duty is exactly as stable as this paragraph says.
	 *
	 * The registry is written BEFORE the engine exists, which is the order its own
	 * documentation asks for: a stream subtree no registered generation claims is
	 * what the sweep collects, so nothing may write a stream ahead of its
	 * registration.
	 */
	async add(spec: AnyGenerationSpec<ABI, ProcessResultType>): Promise<HeldGeneration<ABI, ProcessResultType>> {
		const registered = await this.registerGeneration(spec);
		// THE FOLD SET IS ALREADY COMPLETE HERE, which is what makes one call enough:
		// this container is open, so everything else it holds it is already holding, and
		// this generation is the only addition to the set (ADR-0088). `open` is the case
		// that has to gather its set first, because it builds several at once.
		return this.holdGeneration(registered, [...this.held.map((entry) => entry.record), registered.record]);
	}

	/**
	 * PHASE ONE: build this generation and put its RECORD in the registry, with no
	 * engine and nothing held.
	 *
	 * Split out of `add` so `open` can register every spec before deciding anything
	 * about any of them: what a record ANSWERS -- whether this fold fetches its
	 * stream or follows it -- is a question about the whole set, and a record is the
	 * cheapest complete statement of a set member (it carries the `createdAt` the
	 * ranking uses). Nothing here reads `this.held`, and nothing here may: at this
	 * point it is half-built by construction.
	 */
	protected async registerGeneration(
		spec: AnyGenerationSpec<ABI, ProcessResultType>,
	): Promise<RegisteredGeneration<ABI, ProcessResultType>> {
		const source = spec.source ?? this.source;
		const context: GenerationContext = {
			stream: spec.source ? this.digestOf(spec.source, this.config) : this.streamDigest,
		};
		const state = await spec.createState(context);
		const processor = await spec.createProcessor(state, context);

		// THE ARRIVAL'S, read ONCE here -- after the factories, which is what lets an
		// arrival with no bytes derive one from the object it just built -- and passed
		// DOWN to the engine, so the registry record and the fold advancing it cannot name
		// this generation two different things. Absent is REFUSED and never back-filled
		// (ADR-0086): nothing here may name a fold, and the alternative is a generation
		// called `undefined`.
		const processorIdentity = requireProcessorIdentity(spec.processorIdentity);
		const wanted: GenerationId = {stream: context.stream, processor: processorIdentity};
		// READ ONCE, BEFORE anything is registered or dropped. The SLOTS decide whether
		// this generation is a successor at all and what it displaces; the records decide
		// which of those are still registered and which generation writes each stream.
		const registeredBefore = await this.registry.list();
		const slotsBefore = await this.registry.slots();
		// WHAT THE SUCCESSOR SLOT HELD GOES FIRST, so the room this registration needs is
		// already free when the CAP is decided. It is deliberately not cap-PRESSURE
		// eviction: a replaced successor is dead the moment a newer one takes its place,
		// whether the registry holds two generations or none to spare, and a rule that
		// fired only near the bound would make a deterministic lifecycle a heuristic.
		await this.replaceTheSuccessor(wanted, registeredBefore, slotsBefore, context.stream);
		// INTO THE `successor` SLOT, which holds AT MOST ONE. The registry decides what
		// that means for this identity: the first generation of an empty registry takes
		// `canonical` instead, and a generation some slot ALREADY names stays where it is
		// -- so a reload on the canonical processor stays canonical, and one on the
		// generation a revert returned to is not re-armed by the act of starting up.
		const record = await this.registry.create(wanted, {slot: 'successor'});
		return {spec, source, processor, record};
	}

	/**
	 * PHASE TWO: build the ENGINE for a registered generation and hold it, knowing
	 * every fold this container will hold.
	 *
	 * `willHold` is that set, as records. It is the caller's to supply because only
	 * the caller knows when it is complete: `add` adds one to what is already held,
	 * `open` gathers all of its specs first.
	 */
	protected async holdGeneration(
		{spec, source, processor, record}: RegisteredGeneration<ABI, ProcessResultType>,
		willHold: readonly GenerationRecord[],
	): Promise<HeldGeneration<ABI, ProcessResultType>> {
		const existing = this.held.find((entry) => sameGeneration(entry.record, record));
		if (existing) {
			// The same generation, named twice. The registry RESOLVES rather than
			// duplicating, and so does this: a second engine over one generation's
			// state would be two writers to it.
			namedLogger.info(
				`the generation {stream: ${record.stream}, processor: ${record.processor}} is already held, so the spec ` +
					`resolved to it rather than adding a second engine over the same state.`,
			);
			// The POLICY still applies, because the caller still ASKED for this
			// generation beside the live one: naming a generation that already exists is
			// how a caller re-arms one it created in an earlier session, and under
			// `immediate` it is how one is promoted again after a revert.
			await this.applyPolicyTo(existing);
			return this.heldOf(existing);
		}

		// DETERMINED, and determined HERE: everything downstream reads this rather
		// than re-deciding it, so there is one place the rule lives.
		//
		// Asked of the folds this container HOLDS -- `willHold`, which the caller has
		// already completed -- and not of every record the durable REGISTRY carries
		// (ADR-0088). And asked as `fetcherOf`, ADR-0044's own rule, so "which generation
		// fetches this stream" has ONE home and `follows` is simply "and it is not me";
		// what narrowed is the SET it is asked about and nothing else. The duty is never
		// REASSIGNED, so within one process the oldest fold present keeps it -- and that
		// set does not change under a promotion, which is the stability ADR-0044 chose
		// registration order for.
		//
		// **THE REGISTERED SET WAS WRONG, and it was wrong in the direction that is
		// silent.** The comment here used to argue FOR it: `this.held` "is whatever order
		// the caller passed its specs in and does not survive a restart". The second half
		// is true and is the point -- the registered set is exactly the set that can name
		// a generation this process holds no fold for. Measured: a tab reloading after a
		// PROMOTION holds the one fold its bundle carries, the superseded generation
		// survives -- as `predecessor` when that was measured, and unslotted since
		// ADR-0089, which changes nothing here because nothing collects it either way --
		// and it is older, so the tab's only fold followed a stream nothing writes. It opened
		// healthy, answered reads and reported `at-tip` for ever, two blocks behind a
		// chain it asked nothing about after the load-time `eth_chainId` handshake.
		//
		// The FIRST half is answered by WHERE this now runs rather than by argument. A
		// derivation over a half-built `held` array really is order-dependent, and
		// measurably so -- two fetchers on one stream, one range asked twice, one log
		// stored twice -- which is why this is phase TWO of a two-phase `open` and why
		// `willHold` is a parameter: the answer is taken once the fold set is COMPLETE,
		// which was not true of the array the old comment was written about. The records
		// carry `createdAt`, so ranking them is still the registry's order.
		//
		// **ADR-0087 does not reach this line, and the reason is what the word means
		// here.** On the RECEIVING side the thing that fetches a stream is the
		// DEPLOYMENT, so electing a generation to hold the pen was a third role that did
		// not belong to a generation at all, and it is gone. HERE the thing that fetches
		// IS a generation -- `IndexerGeneration` opens `load()` with `eth_chainId` and a
		// batch is a side effect of it advancing -- so "which generation fetched this
		// stream" and "which generation writes it" are ONE fact, which is exactly
		// ADR-0044's follower rule and is untouched. What ADR-0087 changes on this
		// runtime is nothing; splitting the browser engine's fetch from its fold is a
		// separate change nothing has asked for.
		//
		// ADR-0071 REJECTED this form and that rejection has EXPIRED, twice over.
		//
		// It rejected it because `createdAt` was a millisecond clock with a hash
		// tie-break, so two generations added in the same millisecond could each see
		// `fetcherOf` name THEMSELVES and one stream got two writers (measured, 20/20).
		// ADR-0072 removed the tie: `createdAt` is strictly increasing within a
		// registry, so records sort in REGISTRATION order and every reader of
		// `fetcherOf` gets the same answer. That is exactly the precondition ADR-0071
		// named as the open work, and it has landed.
		//
		// What it fell back to -- "is any OTHER generation already registered on this
		// stream" -- was then kept on the claim that the two forms "now give the same
		// answer here, always", because a record being added always sorts LAST. That
		// claim is FALSE, and exactly one case breaks it: a record that ALREADY EXISTS.
		// `create` RESOLVES rather than duplicating, so a generation re-registered keeps
		// its original `createdAt` and sorts FIRST -- and re-registering what is already
		// there is precisely what a page RELOAD is. A tab re-opening on canonical A with
		// a leftover successor B found B "already on this stream" and built its own
		// CANONICAL generation as a FOLLOWER of a stream nothing writes: it stopped
		// fetching while its state and its reported status both went on looking healthy.
		// The set question is equivalent only for a record that is NEW. `fetcherOf` is
		// right for both, so it is what is asked.
		//
		// This is still the INITIAL derivation and nothing recomputes it: `follows`
		// freezes `readOnlyStream` into the engine's config at construction. That is what
		// makes the COMPLETENESS of `willHold` load-bearing rather than tidy -- a
		// half-built set cannot be corrected later -- and it is why the answer may only be
		// taken once. It matters beyond that only if the fetcher CHANGES while a fold is
		// held, and within one process the held set does not change under a promotion.
		// (The receiving side used to recompute it per cycle through `reconcileWriters`;
		// that whole hand-over is deleted, because there the deployment fetches and no
		// generation ever holds the pen -- ADR-0087, which this does NOT extend to this
		// runtime: here the thing that fetches genuinely IS a generation.)
		const fetcher = fetcherOf(willHold, record.stream);
		const follows = !!fetcher && !sameGeneration(fetcher, record);
		const config: ProvidedIndexerConfig<ABI> =
			follows && this.config.keepStream
				? {...this.config, keepStream: readOnlyStream<ABI>(this.config.keepStream)}
				: this.config;

		// `record.processor` rather than the identity the spec was read for, and they are
		// the same value: `create` RESOLVES a generation already registered rather than
		// duplicating it, so the record is the authority on what this fold is called.
		const generation = this.createGeneration(this.provider, processor, source, config, record.processor);
		const entry: HeldEntry<ABI, ProcessResultType> = {
			record,
			generation,
			processor,
			spec,
			follows,
			candidate: false,
			hasPublished: false,
			publications: 0,
		};
		this.held.push(entry);

		generation.onLoad = async (loadingState) => {
			if (entry === this.current) {
				await this.onLoad?.(loadingState);
			}
		};
		generation.onLastSyncUpdated = (lastSync) => {
			// EVERY generation's cursor is recorded, not the canonical one's alone: the
			// promotion trigger is a comparison between two of them.
			entry.lastSync = lastSync;
			if (entry === this.current) {
				this.onLastSyncUpdated?.(lastSync);
			}
		};
		generation.onStateUpdated = (published) => {
			entry.published = published;
			entry.hasPublished = true;
			entry.publications++;
			if (entry === this.current) {
				this.notifyState();
			}
		};
		// The SIGNAL's upward half, attached to EVERY generation and filtered at the
		// publication, exactly like the cursor callback above: which generation is
		// canonical moves, and a relay attached only to the canonical one would have to
		// be re-attached at every promotion.
		this.relayFoldReports(entry, processor);

		await this.applyPolicyTo(entry);
		return this.heldOf(entry);
	}

	/**
	 * BE TOLD THE STATE MOVED, block by block. Returns the detach.
	 *
	 * One notification per block the CANONICAL fold applies, naming that block, the
	 * generation that answered, the entity names that block touched and a coherence
	 * token to compare -- and one per REORG, naming the fork point that fold
	 * reverted to, with a token that has ROTATED (`StateMoved`). It is a SIGNAL and
	 * not a delivery of data: it says what moved so a reader re-reads through the
	 * surface it already has -- `state` here, a port in a tab, a feed or a query
	 * surface across a network.
	 *
	 * ```ts
	 * const detach = indexer.onStateMoved((moved) => {
	 *   if (moved.coherence !== held) {held = moved.coherence; return invalidateEverything();}
	 *   if (moved.kind === 'applied') for (const entity of moved.entities) invalidate(entity);
	 * });
	 * ```
	 *
	 * Best-effort, with nothing held per subscriber: see `StateMovedPublisher`. A
	 * reader that MISSES a retraction is repaired by the next notification it does
	 * receive, because that one carries the rotated token and the first line above
	 * invalidates everything.
	 */
	onStateMoved(handler: StateMovedHandler): StateMovedDetach {
		return this.stateMoved.subscribe(handler);
	}

	/**
	 * THE COHERENCE TOKEN IN FORCE RIGHT NOW, read without waiting for a notification.
	 *
	 * The same read as `ReceivingIndexer.coherenceNow`, present here so the two
	 * containers keep differing in exactly ONE place (which fold is canonical) rather
	 * than in two. A transport that must tell a client AT CONNECT whether what it
	 * holds may be stale asks this; the browser transports do not, because a reader
	 * that attaches part way through READS the store it shares (ADR-0083).
	 *
	 * OPAQUE and COMPARED, never parsed, exactly as on a notification. It rotates
	 * nothing and publishes nothing.
	 */
	coherenceNow(): string {
		return this.stateMoved.token;
	}

	/** Every generation this container holds, in the order it built them. */
	get generations(): readonly HeldGeneration<ABI, ProcessResultType>[] {
		return this.held.map((entry) => this.heldOf(entry));
	}

	/** The generation that answers reads right now. */
	get canonical(): HeldGeneration<ABI, ProcessResultType> {
		return this.heldOf(this.requireCurrent());
	}

	/**
	 * The promotion policy this indexer runs under, resolved.
	 *
	 * REPORTED so a caller (or a test) can see WHICH value is in force rather than
	 * re-deriving the default: the whole point of having one default everywhere is
	 * lost if each runtime keeps its own copy of what it is.
	 */
	get promotion(): UsedPromotionConfig {
		return this.promotionConfig;
	}

	/**
	 * THE READ HANDLE, and it is INDIRECT.
	 *
	 * A consumer may keep it: it answers from whichever generation is canonical
	 * when the read is made, so a promotion cannot leave a held reference reading
	 * a retired generation's state (story 6). It is the same object every time,
	 * because a handle that changed identity on every publication would defeat
	 * exactly the callers who keep one.
	 *
	 * Where the state is a VALUE rather than a handle (a plain object a processor
	 * hands back, or nothing at all) there is no indirection to give: the value is
	 * returned as it is, resolved per call, and the notification is what tells a
	 * caller to read again.
	 */
	get state(): ProcessResultType {
		if (this.handle) {
			return this.handle.value;
		}
		const current = this.resolveState();
		if (!isIndirectable(current)) {
			return current;
		}
		this.handle = {value: indirectHandle(current, () => this.resolveState() as object) as ProcessResultType};
		return this.handle.value;
	}

	/**
	 * MOVE THE CANONICAL POINTER, and apply the move AT A NOTIFICATION.
	 *
	 * ## The read unit of work is the interval between notifications
	 *
	 * The pointer is recorded in the registry first (that is the durable decision:
	 * forwards it is promotion, backwards it is revert), and the READ PATH follows
	 * it inside `notifyState` and nowhere else. So the only moment a reader can
	 * observe a different generation is a moment it was told about, and every read
	 * between two notifications answers from ONE generation.
	 *
	 * That boundary already existed -- `createIndexerState` publishes through
	 * subscribable stores and the core's state callback, and an app already treats
	 * a notification as "the world moved, re-read" -- which is why there is no
	 * scope API here, no transaction handle and no timer. Inventing one would add
	 * a second thing to get right for a guarantee the existing one already gives.
	 *
	 * **The residual, stated rather than discovered:** a caller reading OUTSIDE
	 * any subscription (a one-off read in an event handler) gets per-CALL
	 * resolution, so two such reads either side of a promotion can straddle it.
	 * That is tolerable and bounded: each read is answered by a generation that
	 * was canonical when it was made, and neither read is stale.
	 *
	 * ## And the COHERENCE TOKEN rotates with it
	 *
	 * A reader that is not in this heap holds a cache rather than a handle, and
	 * nothing about the pointer reaches it -- so every notification after this one
	 * carries a token it has never seen, which is its instruction to invalidate
	 * EVERYTHING and re-read. See `movePointerTo` for where that sits and why.
	 */
	async promote(id: GenerationId): Promise<GenerationRecord> {
		return this.movePointerTo(this.require(id));
	}

	/**
	 * PAUSE ONE GENERATION: it stops indexing without being deleted, by CAPPING
	 * and DRAINING.
	 *
	 * The mechanism is entirely the engine's (`IndexerGeneration.pause`), and there
	 * is deliberately none of it here: this names WHICH generation and refuses the
	 * two ids that have no answer. A paused generation goes on being driven by
	 * `indexMore` -- that is what the drain IS -- and goes on answering reads if it
	 * is the canonical one; what it stops doing is moving forward.
	 *
	 * IN MEMORY, and not recorded in the registry: the registry holds what a
	 * generation IS, and a pause is what one is DOING. So a reload comes back
	 * running, which costs one drain to re-pause and never costs correctness.
	 *
	 * SYNCHRONOUS, unlike `promote`, precisely because nothing durable is written.
	 */
	pause(id: GenerationId): void {
		const entry = this.require(id);
		if (entry.follows) {
			throw new CannotPauseFollowerError({stream: id.stream, processor: id.processor});
		}
		entry.generation.pause();
	}

	/** RESUME one generation: remove the cap. The next round asks the head again. */
	resume(id: GenerationId): void {
		this.require(id).generation.resume();
	}

	// ------------------------------------------------------------------------------------------------------------------
	// THE VERBS, on the canonical generation
	// ------------------------------------------------------------------------------------------------------------------
	// Delegation and nothing else, deliberately: a reconfigure that BUILDS a new
	// generation beside the live one is the promotion policy's
	// (`the-promotion-policy-moves-the-canonical-pointer`), and this batch removes
	// nothing and changes no behaviour of what a caller already had.

	get defaultFromBlock(): number {
		return this.requireCurrent().generation.defaultFromBlock;
	}

	get finalityDepth(): number {
		return this.requireCurrent().generation.finalityDepth;
	}

	get expectedFromBlock(): number {
		return this.requireCurrent().generation.expectedFromBlock;
	}

	/**
	 * Load EVERY generation, and answer with the canonical one's cursor.
	 *
	 * All of them, because a generation that has not loaded has no state and no
	 * cursor, so it could not advance afterwards -- and for a FOLLOWER the load IS
	 * the re-fold of the stored stream from the start. In HELD ORDER, which puts a
	 * stream's writer before anything following it, so a follower's first re-fold
	 * sees whatever the writer's load recovered. `load` is idempotent per
	 * generation (`_load.once()`), so naming the canonical one twice costs nothing.
	 */
	async load(): Promise<LastSync<ABI>> {
		const current = this.requireCurrent();
		for (const entry of this.held) {
			entry.lastSync = await entry.generation.load();
		}
		const answer = await current.generation.load();
		// A load is an advance -- for a FOLLOWER it is the whole re-fold of the stored
		// stream -- so a successor can arrive at the trigger here and not only in
		// `indexMore`.
		await this.settlePromotion();
		return answer;
	}

	/**
	 * Advance EVERY generation one step, each by the verb its stream decides, and
	 * answer with the canonical one's cursor.
	 *
	 * The order is the order they were built, which is what makes a follower's step
	 * meaningful: a stream's writer is always ahead of it in that list, so by the
	 * time a follower reads the stream this cycle's batch is already in it. A
	 * follower that ran first would simply see nothing new and catch up on the next
	 * tick, so the order is a latency decision rather than a correctness one -- but
	 * a driver that loops to the tip would otherwise leave every follower one cycle
	 * short at the end.
	 *
	 * The canonical generation is resolved BEFORE the loop, so a promotion applied
	 * mid-cycle cannot make this return a cursor from a generation that was not the
	 * one being driven.
	 */
	async indexMore(): Promise<LastSync<ABI>> {
		const current = this.requireCurrent();
		let answer: LastSync<ABI> | undefined;
		for (const entry of [...this.held]) {
			const lastSync = entry.follows ? await entry.generation.followMore() : await entry.generation.indexMore();
			entry.lastSync = lastSync;
			if (entry === current) {
				answer = lastSync;
			}
		}
		// The TRIGGER, evaluated once per cycle and after every generation has moved,
		// so a successor is measured against the cursor the canonical generation has
		// NOW rather than the one it had at the top of the loop.
		await this.settlePromotion();
		// The canonical generation is always one this container holds -- that is what
		// `resolveCanonical` refuses to open without -- so the loop always answered.
		return answer as LastSync<ABI>;
	}

	feed(eventStream: LogEvent<ABI>[], lastSyncFetched: LastSync<ABI>): Promise<LastSync<ABI>> {
		return this.requireCurrent().generation.feed(eventStream, lastSyncFetched);
	}

	replay(eventStream: LogEvent<ABI>[], lastSyncStored: LastSync<ABI>): Promise<LastSync<ABI>> {
		return this.requireCurrent().generation.replay(eventStream, lastSyncStored);
	}

	/** Stop EVERY generation, because every generation is what advances. */
	disableProcessing(): void {
		for (const entry of this.held) {
			entry.generation.disableProcessing();
		}
	}

	reenableProcessing(): void {
		for (const entry of this.held) {
			entry.generation.reenableProcessing();
		}
	}

	async reset(): Promise<ReconfigureOutcome> {
		const entry = this.requireCurrent();
		const publishedBefore = entry.publications;
		const outcome = await entry.generation.reset();
		this.publishDiscard(entry, outcome, publishedBefore);
		return outcome;
	}

	async updateIndexer(update: {
		provider?: EIP1193ProviderWithoutEvents;
		source?: IndexingSource<ABI>;
		streamConfig?: ProvidedStreamConfig;
	}): Promise<ReconfigureOutcome> {
		const entry = this.requireCurrent();
		const publishedBefore = entry.publications;
		const outcome = await entry.generation.updateIndexer(update);
		// The source or the stream config may have moved, so the stream a
		// generation built from here folds has too. Recomputed rather than cached
		// once: a generation added after a reconfigure belongs to the stream running
		// NOW, and a stale digest would file it under the stream it replaced.
		this.provider = update.provider ?? this.provider;
		this.source = update.source ?? this.source;
		this.config = update.streamConfig ? {...this.config, stream: update.streamConfig} : this.config;
		this.streamDigest = this.digestOf(this.source, this.config);
		// Last, so a listener woken by the discard reads a container that has already
		// finished moving.
		this.publishDiscard(entry, outcome, publishedBefore);
		return outcome;
	}

	/**
	 * Swap the canonical generation's processor IN PLACE, exactly as before.
	 *
	 * Under the generation model a processor change is a NEW GENERATION over the
	 * same stream, built beside the live one and promoted when it is ready. That is
	 * the promotion policy's landable (`the-promotion-policy-moves-the-canonical-pointer`),
	 * and reaching for it here would be the outage-shaped in-place discard wearing
	 * a container. So this batch keeps today's behaviour and today's cost, and only
	 * keeps the container HONEST about it: the held entry now names the processor
	 * that is actually folding, so the read handle cannot answer from the fold that
	 * was replaced. The registry record still names the fold this generation was
	 * REGISTERED with, which is the drift the policy task closes by creating a
	 * generation instead of mutating one.
	 */
	async updateProcessor(
		newProcessor: EventProcessor<ABI, ProcessResultType>,
		options: {force?: boolean; processorIdentity: string},
	): Promise<ReconfigureOutcome> {
		const entry = this.requireCurrent();
		const publishedBefore = entry.publications;
		// BEFORE the verb, because the verb REBUILDS: a swap is followed by a `load`
		// that replays the cached stream through the NEW fold, and a relay attached
		// afterwards would go quiet for exactly those blocks. Attaching to a processor
		// the swap then declines costs nothing -- a processor this container does not
		// hold folds nothing and therefore reports nothing -- and it is detached below.
		this.relayFoldReports(entry, newProcessor);
		const outcome = await entry.generation.updateProcessor(newProcessor, options);
		if (outcome.stateDiscarded) {
			// Recorded BEFORE the discard is published, and unconditionally: the state to
			// publish is the NEW fold's read handle, which is a handle onto a different
			// store whenever the declarations changed.
			this.stopRelayingFoldReports(entry.processor, newProcessor);
			entry.processor = newProcessor;
		} else {
			// The swap was declined (same identity, not forced), so this generation goes on
			// folding with the processor it already had and the newcomer is not this
			// container's.
			this.stopRelayingFoldReports(newProcessor, entry.processor);
		}
		this.publishDiscard(entry, outcome, publishedBefore);
		return outcome;
	}

	// ------------------------------------------------------------------------------------------------------------------
	// INTERNALS
	// ------------------------------------------------------------------------------------------------------------------

	protected digestOf(source: IndexingSource<ABI>, config: ProvidedIndexerConfig<ABI>): string {
		return streamDigestOf(source, resolveStreamConfig(config.stream));
	}

	// ------------------------------------------------------------------------------------------------------------------
	// THE PROMOTION POLICY, applied
	// ------------------------------------------------------------------------------------------------------------------
	// The values, the default and the trigger arithmetic are in
	// `generation/promotion.ts`. What is here is WHERE each of them is applied:
	// at creation (`applyPolicyTo`), once per advance (`settlePromotion`), and at
	// the move itself (`movePointerTo` / `arrangeDrop`).

	/**
	 * What the policy does about a generation that has just been ADDED beside the
	 * live one.
	 *
	 * Nothing at all during `open`: see `opened`. And nothing for the canonical
	 * generation itself, which is not a successor to anything.
	 */
	protected async applyPolicyTo(entry: HeldEntry<ABI, ProcessResultType>): Promise<void> {
		if (!this.opened || entry === this.current) {
			return;
		}
		// The MAPPING is `generation/promotion.ts`'s, shared with the receiving
		// container: two copies of it are two sources of truth about what `immediate`
		// means, and they drift. What is here is what each verb DOES on this runtime.
		switch (promotionOnAdd(this.promotionConfig.policy)) {
			case 'promote':
				// Canonical BEFORE it has caught up, which is the opt-in: a developer
				// iterating on a fold would rather see an incomplete answer from the new one
				// than a complete answer from the one they replaced (story 13).
				await this.movePointerTo(entry);
				return;
			case 'arm':
				entry.candidate = true;
				// Evaluated at once as well as per cycle: a generation added when it has
				// already caught up (one named a second time, or one whose fold is level
				// because it was built from the same stream) is ready NOW.
				await this.settlePromotion();
				return;
			case 'wait':
				// The pointer moves only when asked, so an operator can inspect first.
				return;
		}
	}

	/**
	 * THE TRIGGER, and the deferred drops that hang off it.
	 *
	 * A candidate is promoted the moment its cursor reaches the cursor the
	 * CANONICAL generation has -- the one it must not fall behind, since promoting
	 * a successor that is behind the incumbent is the state going backwards that
	 * story 14 is about. One move per cycle: a second candidate is still a
	 * candidate on the next one, and promoting twice inside one advance would
	 * publish a generation nobody ever read from.
	 */
	protected async settlePromotion(): Promise<void> {
		const current = this.current;
		if (current) {
			// The RULE is `generation/promotion.ts`'s; what is here is this container's
			// view of it -- which entries exist, which are armed, and where each cursor
			// is kept. The receiving container answers the same two questions from a
			// persisted cursor instead, over the same rule.
			const ready = readyForPromotion(this.held, current, {
				isCandidate: (entry) => entry.candidate,
				cursorOf,
			});
			if (ready) {
				await this.movePointerTo(ready);
			}
		}
		for (const deferred of [...this.deferredDrops]) {
			if (!hasReachedCursor(cursorOf(deferred.successor), deferred.at)) {
				continue;
			}
			this.deferredDrops.splice(this.deferredDrops.indexOf(deferred), 1);
			await this.dropSuperseded(deferred.superseded, deferred.successor);
		}
	}

	/**
	 * Move the pointer to a generation this container holds: the registry first,
	 * the read path at the notification, then what happens to the one left behind.
	 */
	protected async movePointerTo(entry: HeldEntry<ABI, ProcessResultType>): Promise<GenerationRecord> {
		const superseded = this.current;
		/**
		 * WHICH KIND OF MOVE THIS IS, read from the SLOTS before it applies rather than
		 * from what this process happens to have seen.
		 *
		 * A PROMOTION is a move onto what `successor` names: that generation was built
		 * beside the incumbent precisely to take over, so a promotion demonstrated
		 * something and drop-on-promotion may discard what it superseded. EVERY OTHER
		 * MOVE DROPS NOTHING -- naming any other registered generation is a move back, and
		 * that is the safe direction: the only consequence is that a generation is kept.
		 * It is read from `successor` alone here, and it has to be: no move on this
		 * runtime assigns a `predecessor` for the other side of the question to read
		 * (ADR-0089), so a going-back move is exactly a move this rule does not call a
		 * promotion.
		 *
		 * This is what `everCanonical` used to approximate in memory, and it is strictly
		 * better: that flag was `false` for everything after a reload, so a reloaded tab
		 * read every move as a revert. The same read, in the same words, as the receiving
		 * twin's `movePointer`.
		 */
		const slotsBefore = await this.registry.slots();
		const wasPromotion = !!slotsBefore.successor && sameGeneration(slotsBefore.successor, entry.record);
		/**
		 * NO `predecessor` IS ASSIGNED HERE, and this is the ONE line of ADR-0089.
		 *
		 * `predecessor` is what a revert moves BACK to, and a revert needs the code of
		 * the fold it returns to. THIS runtime cannot have it: in a production bundle the
		 * superseded generation's processor is not un-promoted, it is ABSENT FROM THE
		 * BUILD, and in development the way back is the editor. So the slot would name a
		 * generation a tab is structurally unable to instantiate, and the seat it holds
		 * is a seat under `BROWSER_GENERATION_CAPS`.
		 *
		 * The generation the pointer moved off is therefore UNSLOTTED. What then happens
		 * to it is `arrangeDrop`'s: on this runtime the promotion DISCARDS it by default
		 * and takes its stream with it (ADR-0090), because it could never be run here
		 * again -- and where an embedder turned that off, it is collectable by the
		 * ordinary rule and deleted by nothing else here (ADR-0087's removal of the
		 * automatic reap stands).
		 *
		 * The receiving twin passes nothing and keeps the assignment: there an operator
		 * reverts without redeploying and the code arrives by a route a tab does not have.
		 */
		const record = await this.registry.moveCanonicalTo(entry.record, {assignPredecessor: false});
		// It is canonical: it is no longer waiting to become so, and a REVERT past it
		// later must not re-promote it on the next cycle.
		entry.candidate = false;
		if (superseded !== entry) {
			// THE TOKEN ROTATES, because a DIFFERENT FOLD answers from here on and that
			// is indistinguishable, to a cache, from "everything you hold may be wrong"
			// (ADR-0083). The SAME mechanism a retraction uses and deliberately not a
			// second event kind: a reader does not care that a promotion is a different
			// thing, and two kinds would be two code paths in every app ever written.
			// Nothing is PUBLISHED here -- there is no block to name, the pointer moved
			// and no fold applied anything -- so what a reader receives is the next
			// notification, carrying a token it has never seen.
			//
			// FIRST, before the pointer-moved callback below and before the state
			// notification that applies the move, because both of them are a reader being
			// told to re-read: a rotation that happened after either would let one
			// notification's worth of questions about the new generation be answered under
			// the retired one's token. AFTER the registry write, so a move that did not
			// happen does not invalidate every reader's cache.
			//
			// EVERY move of the pointer and not the forward ones alone: a REVERT changes
			// which fold answers exactly as a promotion does, which is the only thing a
			// reader can see of either.
			this.stateMoved.rotate(
				`a pointer move: reads are answered by the generation {stream: ${entry.record.stream}, processor: ` +
					`${entry.record.processor}} from here on`,
			);
			// BEFORE the notification, so a consumer drops what it derived from the
			// retired generation's cursor before it is told to re-read.
			try {
				this.onPromoted?.(entry.record, superseded?.record);
			} catch (err) {
				namedLogger.error(`onPromoted listener threw`, err);
			}
		}
		this.applyAtNotification(entry);
		if (superseded !== entry && entry.lastSync) {
			// The cursor of the generation that answers NOW. Without it a consumer would
			// go on reporting how far the RETIRED generation had got -- and would answer
			// `checkTxInclusion` from a window nothing is maintaining any more.
			this.onLastSyncUpdated?.(entry.lastSync);
		}
		if (superseded && superseded !== entry) {
			await this.arrangeDrop(superseded, entry, wasPromotion);
		}
		return record;
	}

	/**
	 * DROP-ON-PROMOTION, and the one case it is resolved by ORDER rather than by an
	 * interlock.
	 *
	 * Under `on-catch-up` and `manual` a promotion means the successor DEMONSTRATED
	 * something, so the generation left behind can go at that moment. Under
	 * `immediate` it demonstrated nothing -- it is canonical having caught up to
	 * NOTHING -- so dropping the previous one would discard a complete state for an
	 * empty one, with no fallback when the new fold throws on its first event.
	 * There is no interlock and no refusal: retention simply CONTINUES until the
	 * successor reaches the cursor the previous generation had at the promotion,
	 * and the drop happens then.
	 *
	 * A MOVE THAT IS NOT A PROMOTION DROPS NOTHING. A promotion is a move onto what
	 * the `successor` slot names; a move onto any other registered generation is a
	 * going-back move and is treated as one. Dropping what such a move left behind
	 * would delete the very thing the developer might move forwards to again.
	 */
	protected async arrangeDrop(
		superseded: HeldEntry<ABI, ProcessResultType>,
		successor: HeldEntry<ABI, ProcessResultType>,
		wasPromotion: boolean,
	): Promise<void> {
		if (!this.promotionConfig.dropOnPromotion || !wasPromotion) {
			return;
		}
		if (this.promotionConfig.policy === 'immediate') {
			const at = cursorOf(superseded) ?? 0;
			this.deferredDrops.push({superseded, successor, at});
			namedLogger.info(
				`the generation {stream: ${superseded.record.stream}, processor: ${superseded.record.processor}} is ` +
					`RETAINED: an \`immediate\` promotion demonstrates nothing, so it is kept until the new canonical ` +
					`generation reaches block ${at}, the cursor it had at the promotion.`,
			);
			return;
		}
		await this.dropSuperseded(superseded, successor);
	}

	/**
	 * Drop a superseded generation: its registry row and its state store, and NOT its
	 * stream, which outlives every fold over it and is deleted only where a caller ASKS
	 * (ADR-0087). The stream is what the chain fetches bought and the state is derived
	 * from it, so what the drop takes is the recomputable half.
	 *
	 * ## THE STREAM CHANGES HANDS IN THE SAME ACT (ADR-0090, point 2)
	 *
	 * The common save is a handler edit, so both generations sit on ONE stream and the
	 * successor was constructed as a FOLLOWER of the incumbent -- which made this drop
	 * unreachable, because dropping a stream's writer would leave its follower folding
	 * a stream nothing appends to (ADR-0044). That follower relationship is an artifact
	 * of CONSTRUCTION ORDER and not a fact about the two generations: the same
	 * successor, in a tab reloaded one second later, is built alone and IS the fetcher
	 * (ADR-0088). So rather than weaken the guard, the promotion does what the reload
	 * already does -- the promoted generation STOPS FOLLOWING and takes the stream
	 * (`takeOverStream`), in the same act as the drop.
	 *
	 * **Why THIS moment and no other.** The hand-over is safe exactly because the
	 * promoted generation is provably AT the writer's position: under `on-catch-up`
	 * the promotion IS the event "the successor reached the incumbent's cursor", and
	 * under `immediate` the deferral above has already waited for that same condition
	 * before this runs. There is no gap for an append to be lost in. This is
	 * deliberately NOT a fetcher that can change at any time under a held fold: the
	 * initial derivation is taken ONCE and its completeness is load-bearing
	 * (`holdGeneration`), and ADR-0090 rejects continuous recomputation explicitly.
	 *
	 * ## THE DECLINE IS NARROWED, NOT DELETED
	 *
	 * What the hand-over removes is the CASE the guard was declining, and the guard
	 * stays for every case it does not cover. The question is asked as ADR-0088's --
	 * who fetches a stream among the folds this container HOLDS -- so it is one rule at
	 * both sites rather than two dialects:
	 *
	 * - the superseded generation does not fetch this stream, so dropping it strands
	 *   nobody and no hand-over is needed;
	 * - it fetches, and NOTHING this container holds is left on that stream, so again
	 *   there is nothing to strand and nothing to hand over (the cross-stream save);
	 * - it fetches, and the fold the derivation names NEXT is the promoted generation:
	 *   the hand-over makes reality match that derivation, and the drop proceeds;
	 * - it fetches, and somebody ELSE is next. The promoted generation has not been
	 *   following that stream and is at no position on it, so there is nothing to hand
	 *   over, and the next fetcher is a fold frozen as a follower at construction.
	 *   Dropping the writer would leave a fold on a stream nothing appends to, so the
	 *   drop is DECLINED and said out loud, exactly as it always was.
	 */
	protected async dropSuperseded(
		superseded: HeldEntry<ABI, ProcessResultType>,
		successor: HeldEntry<ABI, ProcessResultType>,
	): Promise<void> {
		if (!this.held.includes(superseded)) {
			return;
		}
		const stream = superseded.record.stream;
		let handOver: HeldEntry<ABI, ProcessResultType> | undefined;
		if (this.fetcherAmongHeld(stream) === superseded) {
			// WHO THE DERIVATION NAMES NEXT, which is the only generation the duty may go
			// to: the oldest fold this container holds on that stream once this one goes.
			const next = this.fetcherAmongHeld(stream, superseded);
			if (next && next !== successor) {
				namedLogger.info(
					`drop-on-promotion DECLINED for {stream: ${superseded.record.stream}, processor: ` +
						`${superseded.record.processor}}: it FETCHES a stream this container still folds, and the generation ` +
						`that would fetch it next ({processor: ${next.record.processor}}) is not the one the promotion ` +
						`demonstrated anything about -- so there is nothing that has provably reached this writer's cursor to ` +
						`hand the stream to, and dropping it would leave that fold folding a stream nothing appends to ` +
						`(ADR-0044). It is retained; delete it explicitly once nothing follows its stream.`,
				);
				return;
			}
			handOver = next;
		}
		// Out of the held list FIRST, so nothing drives an engine whose state store is
		// being dropped underneath it.
		this.held.splice(this.held.indexOf(superseded), 1);
		// ...and the pen changes hands with NO await in between, so no cycle can observe
		// this stream with two writers on it or with none.
		if (handOver) {
			this.handOverTheStream(handOver, superseded);
		}
		try {
			// NO REAP: a promotion nobody asked to delete a stream for does not delete one
			// (ADR-0087). The stream stays, and is what the next generation over it re-folds
			// instead of going back to a node for history it may refuse outright.
			await this.registry.deleteGeneration(superseded.record);
			namedLogger.info(
				`dropped the superseded generation {stream: ${superseded.record.stream}, processor: ` +
					`${superseded.record.processor}} on the promotion of {stream: ${successor.record.stream}, processor: ` +
					`${successor.record.processor}}. Its state store is gone and the stream ` +
					`${superseded.record.stream} is KEPT: a stream outlives every fold over it and is deleted only when asked.`,
			);
		} catch (err) {
			// The state may or may not have gone; what must not happen is this container
			// going on driving a generation it has decided to drop, so it stays out of the
			// held list and the registry keeps whatever it kept.
			namedLogger.error(
				`failed to drop the superseded generation {stream: ${superseded.record.stream}, processor: ` +
					`${superseded.record.processor}}`,
				err,
			);
		}
	}

	/**
	 * WHICH FOLD THIS CONTAINER HOLDS FETCHES THIS STREAM, as an entry.
	 *
	 * `fetcherOf` over the records of the folds PRESENT, which is ADR-0088's rule and
	 * the same question `holdGeneration` asks when it derives `follows` and
	 * `wouldStrandAFollower` asks when it declines a drop. One question, one set, one
	 * home: what differs between the three sites is only WHEN it is asked.
	 *
	 * `excluding` is how the drop asks it about the moment AFTER: who fetches this
	 * stream once that generation is gone. It is a HYPOTHETICAL and nothing is
	 * removed by asking.
	 */
	protected fetcherAmongHeld(
		stream: string,
		excluding?: HeldEntry<ABI, ProcessResultType>,
	): HeldEntry<ABI, ProcessResultType> | undefined {
		const present = this.held.filter((entry) => entry !== excluding);
		const fetcher = fetcherOf(
			present.map((entry) => entry.record),
			stream,
		);
		return fetcher && present.find((entry) => sameGeneration(entry.record, fetcher));
	}

	/**
	 * HAND THE STREAM OVER to the generation a promotion just moved the pointer to
	 * (ADR-0090, point 2).
	 *
	 * Two halves and they must not come apart: the ENTRY stops following, which is
	 * what makes the container advance it with `indexMore` rather than `followMore`,
	 * and the ENGINE is handed the keeper itself in place of the read-only view it was
	 * constructed with, which is what makes its appends land. Marked without the
	 * second half the generation would fetch and write nowhere; given the second half
	 * without the first it would never fetch at all.
	 *
	 * A container with NO keeper has no stream for anyone to hold, so there is only
	 * the first half to do: `follows` still decides which verb advances this fold.
	 *
	 * The CALLER is `dropSuperseded` and only it, because what makes this safe is the
	 * pair of facts only a promotion has: the generation losing the stream is going in
	 * the same act, and this one is provably at its cursor.
	 */
	protected handOverTheStream(
		taking: HeldEntry<ABI, ProcessResultType>,
		from: HeldEntry<ABI, ProcessResultType>,
	): void {
		taking.follows = false;
		if (this.config.keepStream) {
			taking.generation.takeOverStream(this.config.keepStream);
		}
		namedLogger.info(
			`the stream ${taking.record.stream} CHANGES HANDS: {processor: ${taking.record.processor}} stops following it ` +
				`and FETCHES it from here on, because the promotion that superseded {processor: ${from.record.processor}} ` +
				`proved it had reached that generation's cursor. Exactly one generation fetches this stream at every ` +
				`moment, including this one (ADR-0044, ADR-0090).`,
		);
	}

	// ------------------------------------------------------------------------------------------------------------------
	// THE OTHER HALF OF THE LIFECYCLE: the SUCCESSOR SLOT holds ONE, so a newer one REPLACES it
	// ------------------------------------------------------------------------------------------------------------------

	/**
	 * MAKE ROOM IN THE `successor` SLOT, because the registration about to happen is
	 * what takes it.
	 *
	 * The container knew ONE kind of supersession and it is a PROMOTION: the incumbent
	 * is RETAINED, and on the receiving runtime it is retained BY a slot, since the
	 * pointer must be able to move back to it (`dropSuperseded`, above). Here it is
	 * retained by nothing at all -- no move assigns a `predecessor` on this runtime
	 * (ADR-0089) -- so what protects it from this path is only the strand rule below,
	 * where it applies. This is the other half, and it is the half a browser tab lives
	 * in. A successor that is still catching up and that a
	 * NEWER one has just replaced is dead work in every case and a WALL in this one:
	 * it keeps its registry row, keeps its state store and keeps being advanced by
	 * every cycle, so a developer saving twice reaches `maxGenerations` -- two here --
	 * almost at once, and the only remedy was deleting a generation by hand.
	 *
	 * ## The PREDICATE is the whole safety argument, and it is now a ROW
	 *
	 * "Not canonical right now" is NOT the test, and the reason is the receiving twin's
	 * -- one rule, one home: a predecessor kept for a revert is not canonical right now
	 * either, and dropping it would silently destroy the way back. Nor is it "has never
	 * been canonical", which is the question the rows cannot
	 * answer and which `everCanonical` approximated IN MEMORY, from what one tab had
	 * seen since the page loaded -- so a RELOAD answered "nothing" and dropped
	 * nothing, which is exactly the shape that reloads most. The test is now the SLOT,
	 * and `displacedBySuccessor` is where it is written down, ONCE, for both
	 * containers.
	 *
	 * ## "THE SAME ROLE" MEANS THE SLOT, REGARDLESS OF STREAM
	 *
	 * There is ONE `successor` slot, so the cross-stream question is answered
	 * structurally rather than by fiat: a newer successor replaces the pending one
	 * wherever either sits, because there is only one place for a pending successor to
	 * be. That is also what frees a STREAM slot -- `maxStreams` counts the distinct
	 * streams among registered generations, and a tab that reconfigures its SOURCE
	 * meets that bound first.
	 *
	 * ## AND A GENERATION NO FOLD HERE EXISTS FOR GOES TOO, which is this runtime's
	 * answer and not the shared rule's (ADR-0090, point 3)
	 *
	 * `unheldIsCollectable` is TRUE here and FALSE on the receiving twin, and that one
	 * word is where the two runtimes differ. A row this container holds no fold for can
	 * never answer a read and can never fetch on THIS runtime: after a page reload the
	 * previous processor's code is not in the bundle that loaded, which is the same fact
	 * ADR-0089 removed the `predecessor` assignment for. Nothing else here will ever
	 * collect it either -- `reclaim` belongs to the container that HAS an operator
	 * (ADR-0084) -- so it survived every session and the developer's next save met
	 * `maxGenerations` with a wall no reload could clear.
	 *
	 * It is collected AT A REGISTRATION and at no other moment: nothing here fires on a
	 * timer and nothing sweeps at `open`, so the deletion is a consequence of an act the
	 * developer just performed rather than the authorless one ADR-0084 refused. A tab
	 * that reloads and sits there collects nothing, because the fold it arrives with is
	 * the one `canonical` names and the shared rule displaces nothing for it.
	 *
	 * What happens at a PROMOTION is `arrangeDrop`'s and `dropSuperseded`'s (ADR-0090,
	 * points 1 and 2): there the superseded generation goes and its stream CHANGES
	 * HANDS, because the promoted fold has provably reached its cursor. Nothing of that
	 * belongs here -- a registration demonstrates nothing -- so this path still drops
	 * only what it may drop safely, and the caps are untouched by either.
	 */
	protected async replaceTheSuccessor(
		arriving: GenerationId,
		registered: readonly GenerationRecord[],
		slots: SlottedGenerations,
		arrivingStream: string,
	): Promise<void> {
		const displaced = displacedBySuccessor(arriving, registered, slots, {
			heldHere: (record) => this.heldHere(record),
			unheldIsCollectable: true,
		});

		const surviving = [...registered];
		for (const record of displaced) {
			if (this.wouldStrandAFollower(record, surviving, arrivingStream)) {
				namedLogger.info(
					`the replaced successor {stream: ${record.stream}, processor: ${record.processor}} is RETAINED for now: ` +
						`it WRITES the stream ${record.stream}, which another generation here follows, and dropping it would ` +
						`leave that one folding a stream nothing appends to (ADR-0044). No slot names it any more, so it goes ` +
						`when nothing follows its stream.`,
				);
				continue;
			}
			if (await this.dropReplaced(record, arriving, slotHolding(slots, record) === 'successor')) {
				surviving.splice(
					surviving.findIndex((held) => sameGeneration(held, record)),
					1,
				);
			}
		}
	}

	/** Whether this container holds a fold for that record, which is the question `follows` and a drop both ask. */
	protected heldHere(record: GenerationId): boolean {
		return this.held.some((entry) => sameGeneration(entry.record, record));
	}

	/**
	 * Whether dropping this generation would leave a stream being folded by something
	 * with nothing appending to it.
	 *
	 * `dropSuperseded`'s rule, applied one moment earlier and with one more follower in
	 * view. Which generation WRITES a stream is the oldest SURVIVING one registered on
	 * it (ADR-0044), so dropping a writer another held generation follows leaves that
	 * one folding a stream nothing appends to. The generation about to be ADDED counts
	 * as such a follower, because it is about to be one: a generation on a stream this
	 * container already holds FOLLOWS it, and dropping its writer here would leave it,
	 * too, on a stream nothing appends to. What the drop does NOT do is take the stored
	 * stream with it -- no drop reaps one any more (ADR-0087) -- so the hazard here is
	 * the missing appender and only that.
	 *
	 * **It takes RECORDS in and answers about FOLDS, and that pairing is the point.**
	 * It has to take records, because the caller hands it rows: the record it is asked
	 * about may be one this container holds no fold for at all, which is the reload
	 * case and the one ADR-0090's point 3 collects. What it answers with is the
	 * derivation over the folds this container HOLDS (below), so such a record is never
	 * named as a fetcher and strands nobody -- which is exactly what makes it
	 * collectable. The justification this paragraph used to give was the generation "the
	 * slot names" being unheld; that is stale twice over, because no slot names a
	 * superseded generation on this runtime at all (ADR-0089) and an unheld row is what
	 * the narrowing below FILTERS OUT rather than a reason to widen.
	 *
	 * ## WHO FETCHES IS ASKED OF THE FOLDS THIS CONTAINER HOLDS (ADR-0088)
	 *
	 * `fetcherOf` and ADR-0044's rule are unchanged; what narrowed is the SET it is
	 * asked about, and this is the SECOND of the two sites that ask it. The first is the
	 * `follows` derivation in `holdGeneration`, narrowed when ADR-0088 landed, and
	 * leaving this one over every REGISTERED record made the two answer differently
	 * about the same stream: after a reload the oldest record on it is the superseded
	 * generation NO FOLD EXISTS FOR, so the held fold correctly derived that IT fetches
	 * while this question still named the dead row as the fetcher -- and declined to
	 * drop it to protect a follower that does not exist.
	 *
	 * The IN-SESSION case is unchanged by the narrowing and must be: there the
	 * superseded generation IS held and IS the oldest fold present, so it is still named
	 * here and the drop is still DECLINED. What the narrowing removes is only the answer
	 * about a generation this process has no fold for, which is the same claim ADR-0088
	 * removed from the derivation: a generation absent from this process cannot be
	 * fetching for it.
	 *
	 * The FOLLOWER half of the question was always asked of the held set (below), so
	 * this makes one question about one set rather than half of each.
	 *
	 * ## AND IT IS NOT NARROWED BY THE HAND-OVER (ADR-0090)
	 *
	 * A PROMOTION may now hand a stream to the generation it promoted and drop the
	 * writer (`dropSuperseded`), because that generation has provably reached the
	 * writer's cursor. A REGISTRATION has no such thing: a fold arriving beside the live
	 * one is at no position at all, and nothing about it demonstrates anything. So this
	 * question keeps its full force, and its decline is the one that still stops a save
	 * deleting the generation that is fetching for it.
	 */
	protected wouldStrandAFollower(
		record: GenerationRecord,
		registered: readonly GenerationRecord[],
		arrivingStream: string,
	): boolean {
		const fetcher = fetcherOf(
			registered.filter((candidate) => this.heldHere(candidate)),
			record.stream,
		);
		if (!fetcher || !sameGeneration(fetcher, record)) return false;
		if (record.stream === arrivingStream) return true;
		return this.held.some(
			(entry) => !sameGeneration(entry.record, record) && entry.follows && entry.record.stream === record.stream,
		);
	}

	/**
	 * Drop ONE replaced successor: its registry row, its state store, and every trace
	 * of it in this container.
	 *
	 * Deleting a generation is already a drop of its state (`dropState`, injected by
	 * whoever named the storage), so nothing new is invented here: what is new is
	 * deciding WHEN, without being asked.
	 *
	 * **The STREAM is NOT reaped with it** (ADR-0087). It used to be, wherever this was
	 * the last generation folding it, which made a second save in a tab delete the
	 * history the first save had fetched -- the one place this codebase deleted an
	 * expensive thing to reclaim a cheap one. What a registration displaces is a FOLD.
	 *
	 * The REGISTRY GOES FIRST, which is the opposite order from `dropSuperseded` and
	 * deliberately so: there the drop is the last act of a promotion that has already
	 * happened, while here a registration is about to be decided on the result, so a
	 * failure must leave the container exactly as it was rather than holding a
	 * generation it has stopped driving.
	 *
	 * A FAILED DROP DOES NOT STOP THE REPLACEMENT, and the slot is what makes that
	 * safe: the arriving generation takes `successor` regardless, so what failed to go
	 * is left named by no slot -- which is the definition of collectable, and the next
	 * registration tries again. Refusing the registration instead would make a stuck
	 * deletion an outage for the tab that is trying to move forward, and a tab is what
	 * a user is looking at.
	 */
	protected async dropReplaced(
		record: GenerationRecord,
		arriving: GenerationId,
		/**
		 * Whether the `successor` slot NAMED it, which is the one thing the two cases this
		 * path now covers differ by -- and therefore what the line an operator reads has to
		 * say. The other case is a generation no slot names that no fold here exists for
		 * (ADR-0090, point 3), and reporting that one as a replaced successor would give it
		 * a cause it does not have.
		 */
		namedBySuccessor: boolean,
	): Promise<boolean> {
		try {
			// NO REAP, which is the whole of ADR-0087's second half at this call site.
			await this.registry.deleteGeneration(record);
		} catch (err) {
			namedLogger.error(
				`failed to drop the generation {stream: ${record.stream}, processor: ${record.processor}}; it is ` +
					`still registered, and the arriving generation takes the \`successor\` slot anyway -- so nothing names it ` +
					`and it can be collected later`,
				err,
			);
			return false;
		}
		this.stopDriving(record);
		namedLogger.info(
			(namedBySuccessor
				? `the generation {stream: ${record.stream}, processor: ${record.processor}} was what the \`successor\` ` +
					`slot held, and {stream: ${arriving.stream}, processor: ${arriving.processor}} REPLACES it there: the ` +
					`slot holds AT MOST ONE, so it has been DROPPED. It was safe because no slot named it once it was ` +
					`replaced -- it is not the canonical generation, so nothing reads from it and re-folding it would be ` +
					`work for a result nobody will ever ask for.`
				: `the generation {stream: ${record.stream}, processor: ${record.processor}} was named by NO slot and ` +
					`this container holds NO FOLD for it, so registering {stream: ${arriving.stream}, processor: ` +
					`${arriving.processor}} COLLECTED it. On this runtime it could never answer a read and never fetch ` +
					`again -- the code its fold needs is not in the build that is running -- and nothing else here would ` +
					`ever have collected it (ADR-0090). Supplying that code again derives the same identity and re-folds ` +
					`this stream.`) +
				` Its state store is gone and the stream ` +
				`${record.stream} is KEPT: a stream outlives every fold over it and is deleted only when asked. ` +
				`The canonical generation is untouched.`,
		);
		return true;
	}

	/**
	 * STOP DRIVING a generation whose record has gone: out of the held list, out of
	 * any deferred drop, and off the reporter.
	 *
	 * One function rather than the same lines wherever a generation is deleted,
	 * because the last is the one that is easy to forget and the worst to omit: a
	 * dropped fold that went on REPORTING would be a channel into a publisher nothing
	 * can reach it through any more.
	 *
	 * A generation this container holds no engine for is the ordinary case after a
	 * reload (a tab holds only the fold it was built with), and then there is simply
	 * nothing to stop driving.
	 */
	protected stopDriving(record: GenerationId): void {
		const entry = this.held.find((held) => sameGeneration(held.record, record));
		if (!entry) {
			return;
		}
		this.held.splice(this.held.indexOf(entry), 1);
		entry.candidate = false;
		for (const deferred of [...this.deferredDrops]) {
			if (deferred.superseded === entry || deferred.successor === entry) {
				this.deferredDrops.splice(this.deferredDrops.indexOf(deferred), 1);
			}
		}
		entry.processor.setFoldReporter?.(undefined);
	}

	/** What the container hands OUT for a generation it holds. */
	protected heldOf(entry: HeldEntry<ABI, ProcessResultType>): HeldGeneration<ABI, ProcessResultType> {
		return {
			record: entry.record,
			generation: entry.generation,
			processor: entry.processor,
			// GETTERS, so a caller holding this object sees the drain complete, the cursor
			// move and the STREAM CHANGE HANDS rather than the values they had when the
			// object was built. `follows` joined them when a promotion became able to move
			// the fetch duty (ADR-0090): a caller that kept this object across one would
			// otherwise be told the promoted generation is still following.
			get follows(): boolean {
				return entry.follows;
			},
			get lastSync(): LastSync<ABI> | undefined {
				return entry.lastSync;
			},
			get pauseState(): PauseState {
				return entry.generation.pauseState;
			},
		};
	}

	/** The held generation this id names, or the refusal that says nothing here can answer for it. */
	protected require(id: GenerationId): HeldEntry<ABI, ProcessResultType> {
		const entry = this.held.find((held) => sameGeneration(held.record, id));
		if (!entry) {
			throw new UnheldGenerationError({stream: id.stream, processor: id.processor});
		}
		return entry;
	}

	/**
	 * DROP WHAT THE DISCARD DESTROYED, AND SAY SO.
	 *
	 * The three reconfiguring verbs all end in one of two places -- the fold
	 * survived, or it is gone and being rebuilt -- and `onStateUpdated` fires when a
	 * state is ADOPTED or PRODUCED, so it fires for neither. A subscriber holding
	 * the state the fold just lost is therefore told by nothing, and on the
	 * reconfigure this exists for (a contract redeployed behind its proxy, which has
	 * emitted nothing yet) the next publication never comes at all: the old
	 * contract's numbers stay on screen for the rest of the session.
	 *
	 * So the container publishes the discard, which is a NOTIFICATION and not a new
	 * state: what goes out is the same indirect handle every publication carries,
	 * now resolving to the fold that has processed nothing. `createIndexerState` did
	 * this for its own `state` store until `the-old-indexer-shape-is-deleted`; it is
	 * here because the container is what knows a verb discarded, and because every
	 * other consumer of one (a server, a CLI, a test) was never told at all.
	 *
	 * **A DISCARD DOES NOT ALWAYS LEAVE NOTHING**, which is the whole reason for the
	 * `publishedBefore` guard. When the STREAM survives -- which a processor swap
	 * always leaves it, since the stream verdict is about the source and the config
	 * and not the processor -- the `load` inside the verb REPLAYS the cached events
	 * and publishes the rebuilt state before the verb returns. That publication is
	 * the truth; dropping the handle and re-announcing an empty fold on top of it
	 * would report a correct rebuild to every subscriber as an empty state, with the
	 * cursor already past the blocks, so nothing would arrive later to correct it.
	 */
	protected publishDiscard(
		entry: HeldEntry<ABI, ProcessResultType>,
		outcome: ReconfigureOutcome,
		publishedBefore: number,
	): void {
		if (!outcome.stateDiscarded || entry.publications !== publishedBefore) {
			return;
		}
		// What this generation last published no longer exists, so the handle must stop
		// answering with it: it falls back to the fold's own read handle, which is what
		// a processor that has processed nothing has.
		entry.hasPublished = false;
		entry.published = undefined;
		if (entry === this.current) {
			this.notifyState();
		}
	}

	/** Point the read path at the generation the registry already calls canonical. */
	protected async resolveCanonical(): Promise<void> {
		const canonical = await this.registry.canonical();
		if (!canonical) {
			// Nothing is registered at all, which only happens when this container was
			// opened with no generations. Reads have nothing to answer from and say so
			// at the point of asking rather than here.
			return;
		}
		const entry = this.held.find((held) => sameGeneration(held.record, canonical));
		if (!entry) {
			throw new CanonicalGenerationNotHeldError(
				{stream: canonical.stream, processor: canonical.processor},
				this.held.map((held) => ({stream: held.record.stream, processor: held.record.processor})),
			);
		}
		this.current = entry;
	}

	protected requireCurrent(): HeldEntry<ABI, ProcessResultType> {
		if (!this.current) {
			throw new Error(
				`this indexer holds no canonical generation, so there is nothing to index with and nothing to read from. ` +
					`Open it with at least one generation spec.`,
			);
		}
		return this.current;
	}

	/** What the canonical generation answers with: what it last published, or its handle. */
	protected resolveState(): ProcessResultType {
		const entry = this.requireCurrent();
		if (entry.hasPublished) {
			return entry.published as ProcessResultType;
		}
		return entry.spec.stateOf?.(entry.processor) as ProcessResultType;
	}

	/**
	 * The one place the read path's pointer moves, and it moves WITH a
	 * notification.
	 */
	protected applyAtNotification(entry: HeldEntry<ABI, ProcessResultType>): void {
		this.current = entry;
		this.notifyState();
	}

	/**
	 * RELAY: hand this generation's fold the reporter it names what it did to.
	 *
	 * The entity set is produced where the mutations are, and the fork point where
	 * the `removed` markers are read and `revertTo` is called -- both one package
	 * down -- and this container assembles the signal from them plus what only a
	 * container holds (ADR-0083). A fold that implements nothing here reports
	 * nothing and therefore publishes nothing, which is the honest coarse answer
	 * rather than a fabricated one: core cannot know which blocks such a fold
	 * applied, what they touched, or what it took back.
	 */
	protected relayFoldReports(
		entry: HeldEntry<ABI, ProcessResultType>,
		processor: EventProcessor<ABI, ProcessResultType>,
	): void {
		processor.setFoldReporter?.((report) => this.publishFoldReport(entry, report));
	}

	/** Detach a fold this container no longer drives, unless it is the one it kept. */
	protected stopRelayingFoldReports(
		processor: EventProcessor<ABI, ProcessResultType>,
		keeping: EventProcessor<ABI, ProcessResultType>,
	): void {
		if (processor === keeping) {
			return;
		}
		processor.setFoldReporter?.(undefined);
	}

	/**
	 * ASSEMBLE and PUBLISH one thing the fold did, and ONLY for the CANONICAL fold.
	 *
	 * A non-canonical generation re-folds a whole stored stream to catch up, so
	 * publishing per block there would fire thousands of notifications naming past
	 * blocks while nothing a reader can see has moved. The filter is the one the
	 * per-generation callbacks in `add` already apply -- `entry === this.current` --
	 * rather than a second rule that can disagree with it.
	 *
	 * It fires AS THE BLOCK LANDS, which is inside the `process()` call that
	 * applied it and therefore BEFORE the `onStateUpdated` that follows the batch.
	 * That order is deliberate and it is safe in the direction that matters: the
	 * block is already durable when the fold reports it (a block and its cursor are
	 * ONE atomic unit behind the storage seam, ADR-0027), so a reader that re-reads
	 * the instant it is told sees that block's effects. The alternative -- holding
	 * the reports back until the batch's state notification -- would buffer, which
	 * is the one thing the producer must not do, and would collapse a batch's
	 * blocks into one moment for no reader's benefit.
	 *
	 * A RETRACTION goes out the same way and through the same filter, which is the
	 * half worth stating: the filter covers the TOKEN as well as the notification,
	 * so a follower re-folding a stored stream's reorg rotates nothing. Rotating
	 * there would have every reader of the canonical fold throw its cache away
	 * because a second generation caught up.
	 */
	protected publishFoldReport(entry: HeldEntry<ABI, ProcessResultType>, report: FoldReport): void {
		if (entry !== this.current) {
			return;
		}
		// Rendered as everything that REPORTS which generation answered already renders
		// it (`generationDigestOf`): ONE opaque value, compared and never parsed, so
		// what a generation is composed of stays changeable.
		const generation = generationDigestOf(entry.record);
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

	protected notifyState(): void {
		if (!this.onStateUpdated) {
			return;
		}
		try {
			this.onStateUpdated(this.state);
		} catch (err) {
			namedLogger.error(`onStateUpdated listener threw`, err);
		}
	}
}
