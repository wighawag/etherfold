import type {Abi} from 'abitype';
import type {EIP1193ProviderWithoutEvents} from 'eip-1193';
import {logs} from 'named-logs';

import {IndexerGeneration, type LoadingState, type PauseState, type ReconfigureOutcome} from './indexer.js';
import {
	sameGeneration,
	type GenerationId,
	type GenerationRecord,
	type GenerationRegistry,
} from './generation/registry.js';
import {
	hasReachedCursor,
	promotionOnAdd,
	readyForPromotion,
	resolvePromotionConfig,
	type PromotionConfig,
	type UsedPromotionConfig,
} from './generation/promotion.js';
import {streamDigestOf} from './stream/identity.js';
import {readOnlyStream} from './stream/readOnly.js';
import {resolveStreamConfig} from './internal/engine/utils.js';
import type {
	EventProcessor,
	IndexingSource,
	LastSync,
	LogEvent,
	ProcessorDriftReport,
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
 * identity AFTER building, from the processor's own `getVersionHash()`. Nothing
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
	 * Its `getVersionHash()` is what NAMES this generation, so two generations
	 * over one stream are two records exactly when their folds differ -- which is
	 * the common reconfigure (a processor change re-fetches nothing) made
	 * identity.
	 */
	createProcessor: (
		state: State,
		context: GenerationContext,
	) => EventProcessor<ABI, ProcessResultType> | Promise<EventProcessor<ABI, ProcessResultType>>;
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
	/**
	 * Whether the canonical pointer has EVER named this generation.
	 *
	 * It is what tells a PROMOTION from a REVERT, and nothing else can: a move to a
	 * generation that has answered reads before is going BACK to it (story 4),
	 * whichever way the clock reads. Deliberately not `createdAt`, which ties --
	 * two generations registered in the same millisecond compare equal, and the
	 * registry breaks that tie on the identity, which is a fine order for a listing
	 * and no basis at all for deciding whether to DELETE one.
	 */
	everCanonical: boolean;
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
	public onProcessorDrift: ((report: ProcessorDriftReport) => void) | undefined;
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
		this.promotionConfig = resolvePromotionConfig(options.promotion);
		this.createGeneration =
			options.createGeneration ??
			((provider, processor, source, config) =>
				new IndexerGeneration<ABI, ProcessResultType>(provider, processor, source, config));
		this.streamDigest = this.digestOf(this.source, this.config);
	}

	/** Build and register the generations, then resolve the canonical pointer onto one of them. */
	async open(specs: readonly AnyGenerationSpec<ABI, ProcessResultType>[]): Promise<void> {
		for (const spec of specs) {
			await this.add(spec);
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
	 * ## Which generation WRITES a stream: the first one held on it
	 *
	 * Registration order and not the canonical pointer, so the writer is stable:
	 * moving the pointer is one small record write and must not silently hand the
	 * append duty to a different engine mid-flight. The normal case makes the two
	 * the same thing anyway, since the first generation registered is the one the
	 * registry makes canonical.
	 *
	 * The registry is written BEFORE the engine exists, which is the order its own
	 * documentation asks for: a stream subtree no registered generation claims is
	 * what the sweep collects, so nothing may write a stream ahead of its
	 * registration.
	 */
	async add(spec: AnyGenerationSpec<ABI, ProcessResultType>): Promise<HeldGeneration<ABI, ProcessResultType>> {
		const source = spec.source ?? this.source;
		const context: GenerationContext = {
			stream: spec.source ? this.digestOf(spec.source, this.config) : this.streamDigest,
		};
		const state = await spec.createState(context);
		const processor = await spec.createProcessor(state, context);
		const record = await this.registry.create({stream: context.stream, processor: processor.getVersionHash()});

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
		// Asked of the durable REGISTRY rather than of this process's `held` array,
		// which is whatever order the caller passed its specs in and does not survive a
		// restart. The question is "is any OTHER generation already registered on this
		// stream", which is the container's form of the one-writer rule: it never
		// REASSIGNS the duty, so the first generation registered on a stream keeps it.
		//
		// Deliberately NOT `writerOf(...)`, and the reason has two halves.
		//
		// It USED to be unsafe: `writerOf` is a function of the whole record SET at a
		// moment, while `follows` is frozen per generation at ADD time -- `readOnlyStream`
		// is baked into the engine's config, so it cannot be recomputed later the way
		// `reconcileWriters` recomputes it on the receiving side. Evaluating a
		// set-function per element at different moments let two generations added in one
		// millisecond each see `writerOf` name THEMSELVES, and one stream got two
		// writers (ADR-0071, measured).
		//
		// ADR-0072 removed that: `createdAt` is strictly increasing within a registry, so
		// a record being added always sorts LAST and `writerOf` can never name it while
		// others exist. The two questions now give the same answer here, always. This
		// one is kept anyway because it is the one that does not DEPEND on that: "is
		// anyone else already registered on this stream" is correct whatever the
		// ordering, where the `writerOf` form is correct only while the ordering holds.
		// Having just paid for that distinction once, the robust form is worth its two
		// lines.
		const alreadyOnThisStream = (await this.registry.list()).filter(
			(other) => other.stream === record.stream && !sameGeneration(other, record),
		);
		const follows = alreadyOnThisStream.length > 0;
		const config: ProvidedIndexerConfig<ABI> =
			follows && this.config.keepStream
				? {...this.config, keepStream: readOnlyStream<ABI>(this.config.keepStream)}
				: this.config;

		const generation = this.createGeneration(this.provider, processor, source, config);
		const entry: HeldEntry<ABI, ProcessResultType> = {
			record,
			generation,
			processor,
			spec,
			follows,
			candidate: false,
			everCanonical: false,
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
		generation.onProcessorDrift = (report) => {
			if (entry === this.current) {
				this.onProcessorDrift?.(report);
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

		await this.applyPolicyTo(entry);
		return this.heldOf(entry);
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
		options?: {force?: boolean},
	): Promise<ReconfigureOutcome> {
		const entry = this.requireCurrent();
		const publishedBefore = entry.publications;
		const outcome = await entry.generation.updateProcessor(newProcessor, options);
		if (outcome.stateDiscarded) {
			// Recorded BEFORE the discard is published, and unconditionally: the state to
			// publish is the NEW fold's read handle, which is a handle onto a different
			// store whenever the declarations changed.
			entry.processor = newProcessor;
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
		const record = await this.registry.moveCanonicalTo(entry.record);
		// It is canonical: it is no longer waiting to become so, and a REVERT past it
		// later must not re-promote it on the next cycle.
		entry.candidate = false;
		if (superseded !== entry) {
			// BEFORE the notification, so a consumer drops what it derived from the
			// retired generation's cursor before it is told to re-read.
			try {
				this.onPromoted?.(entry.record, superseded?.record);
			} catch (err) {
				namedLogger.error(`onPromoted listener threw`, err);
			}
		}
		// Read BEFORE the move applies, because that is what makes it readable at all:
		// a generation the pointer has named before is one this is going BACK to.
		const wasRevert = entry.everCanonical;
		this.applyAtNotification(entry);
		if (superseded !== entry && entry.lastSync) {
			// The cursor of the generation that answers NOW. Without it a consumer would
			// go on reporting how far the RETIRED generation had got -- and would answer
			// `checkTxInclusion` from a window nothing is maintaining any more.
			this.onLastSyncUpdated?.(entry.lastSync);
		}
		if (superseded && superseded !== entry) {
			await this.arrangeDrop(superseded, entry, wasRevert);
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
	 * A BACKWARDS move drops nothing. Moving the pointer to an older generation is
	 * a REVERT, not a promotion, and dropping what it moved away from would delete
	 * the very thing the developer might revert forwards to again.
	 */
	protected async arrangeDrop(
		superseded: HeldEntry<ABI, ProcessResultType>,
		successor: HeldEntry<ABI, ProcessResultType>,
		wasRevert: boolean,
	): Promise<void> {
		if (!this.promotionConfig.dropOnPromotion || wasRevert) {
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
	 * Drop a superseded generation: its state store, its record, and its stream if
	 * it was the last one folding it.
	 *
	 * **It never drops the WRITER of a stream another held generation follows.**
	 * Which generation writes a stream is the first one held on it and not the
	 * canonical one (ADR-0044), precisely so a promotion does not hand the append
	 * duty to a different engine mid-flight -- so dropping the writer would leave
	 * its followers folding a stream nothing appends to, and the app would simply
	 * stop advancing. That is worse than keeping the bytes, so the drop is DECLINED
	 * and said out loud. The case it costs is the common reconfigure (a processor
	 * change, on the stream that is already there); the case it serves is the
	 * expensive one (a filter change), where the retired generation owns a whole
	 * stream of its own that goes with it.
	 */
	protected async dropSuperseded(
		superseded: HeldEntry<ABI, ProcessResultType>,
		successor: HeldEntry<ABI, ProcessResultType>,
	): Promise<void> {
		if (!this.held.includes(superseded)) {
			return;
		}
		const strands = this.held.some(
			(entry) => entry !== superseded && entry.follows && entry.record.stream === superseded.record.stream,
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
		// Out of the held list FIRST, so nothing drives an engine whose state store is
		// being dropped underneath it.
		this.held.splice(this.held.indexOf(superseded), 1);
		try {
			const deletion = await this.registry.deleteGeneration(superseded.record);
			namedLogger.info(
				`dropped the superseded generation {stream: ${superseded.record.stream}, processor: ` +
					`${superseded.record.processor}} on the promotion of {stream: ${successor.record.stream}, processor: ` +
					`${successor.record.processor}}` +
					`${deletion.reaped ? `, reaping the stream ${deletion.reaped} with it` : ''}.`,
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

	/** What the container hands OUT for a generation it holds. */
	protected heldOf(entry: HeldEntry<ABI, ProcessResultType>): HeldGeneration<ABI, ProcessResultType> {
		return {
			record: entry.record,
			generation: entry.generation,
			processor: entry.processor,
			follows: entry.follows,
			// GETTERS, so a caller holding this object sees the drain complete and the
			// cursor move rather than the values they had when the object was built
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
		entry.everCanonical = true;
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
		entry.everCanonical = true;
		this.notifyState();
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
