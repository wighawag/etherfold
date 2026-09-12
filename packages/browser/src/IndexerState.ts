import type {
	Abi,
	EventProcessor,
	GenerationContext,
	GenerationId,
	GenerationRecord,
	GenerationRegistry,
	HeldGeneration,
	Indexer,
	IndexerGeneration,
	IndexingSource,
	LastSync,
	ExistingStream,
	NotInstalledReason,
	PromotionConfig,
	UsedPromotionConfig,
	ProvidedStreamConfig,
	ProvidedIndexerConfig,
	StreamSeedInstallOutcome,
	StreamSeedLocation,
	TxInclusionQuery,
	TxInclusionVerdict,
} from '@etherfold/core';
import {
	checkTxInclusion as checkTxInclusionAgainst,
	installStreamSeed,
	isRetryable,
	openIndexer,
	openMemoryGenerationRegistry,
	resolveStreamConfig,
	sameGeneration,
} from '@etherfold/core';
import {pruneBudget, type StateStore, type WritableStateStore} from '@etherfold/state-store';
import {demoteToReader, isStoreWriterChanged, type Demotion, type DemotionReason} from './demotion.js';
import {derivedProgress, hostGenerationOf, hostGenerationsOf, type HostBacking} from './host/cases.js';
import {executionScopeName, type HostAccess} from './host/endpoint.js';
import type {HostGeneration, HostProgress, HostReconfigure, SyncPhase} from './host/envelope.js';
import {portErrorOf, type PortError} from './host/errors.js';
import {hostOnThisThread, type MainThreadHosting} from './host/mainThread.js';
import {cursorsOf, pacingAfterCycle, phaseAfterCycle} from './host/pacing.js';
import {BROWSER_GENERATION_CAPS} from './storage/generation/OnIndexedDB.js';
import {createRootStore, createStore} from './utils/stores.js';
import {ReactHooks, useStores} from 'use-stores';
import type {EIP1193ProviderWithoutEvents} from 'eip-1193';
import {formatLastSync} from './utils/format.js';
import {logs} from 'named-logs';
import {wait} from './utils/time.js';
const namedLogger = logs('@etherfold/browser');

export type ExtendedLastSync<ABI extends Abi> = LastSync<ABI> & {
	numBlocksProcessedSoFar: number;
	/**
	 * How far the fold has got across the span THIS indexer covers, 0 to 100.
	 *
	 * Derived by `derivedProgress`, the same function the port publishes from, so
	 * this hook and a tab holding a port cannot disagree about how far the fold
	 * has got. Where the port leaves the figure ABSENT -- before the first fetch a
	 * container publishes a cursor of `0` of `0`, so it has learnt no tip -- this
	 * field is typed non-optional and reads `0`: "nothing known yet", never a full
	 * bar and never `NaN`.
	 */
	syncPercentage: number;
	/**
	 * How far the fold has got across the WHOLE CHAIN, 0 to 100.
	 *
	 * Rarely what an application wants, and deliberately not carried across the
	 * port for that reason: a deployment whose contract starts at block 20,000,000
	 * reads 99.9% from its first fetch. `syncPercentage` is the one with a
	 * denominator an app means. `0` before a tip has been learnt.
	 */
	totalPercentage: number;
};

export type ErrorCode = string;

/**
 * How many versions ONE scheduled prune may delete, where the application names
 * no budget of its own.
 *
 * A prune costs time proportional to what it DROPS, which is the whole reason
 * ADR-0022 makes it a call the host schedules rather than something `applyBlock`
 * does on its way past -- so a host that schedules one still has to decide how
 * much of the backlog a single cycle pays for. This is that decision for a
 * BROWSER TAB, and the axis it is chosen on is responsiveness rather than any
 * cap a platform imposes (a Worker has one, and `d1PruneBudget` computes it; a
 * tab does not).
 *
 * The number: the IndexedDB prototype's FULL-SCAN prune took 6.3 s at 62,553
 * versions (`work/notes/findings/sqlite-in-the-browser.md`), so ~0.3 ms per
 * version is a safe over-estimate for the shipped store, which walks an index
 * instead. A thousand versions is therefore a fraction of a second of database
 * work against an auto-index loop that rests at four seconds, and it drains the
 * whole measured workload's unbounded footprint (29,393 versions) in about
 * thirty cycles rather than in one long stall. A steady-state cycle deletes a
 * handful and never reaches it.
 *
 * It bounds ONE PASS and never the total: an incomplete pass leaves the rest for
 * the next cycle, which is what keeps a large backlog off any single one.
 */
export const DEFAULT_PRUNE_BUDGET = 1000;

/**
 * A GENERATION THAT IS NOT ANSWERING READS, and how far its fold has got.
 *
 * The FACT and the DISTANCE, and nothing beyond them. Whether a second
 * generation existing means the answers on screen should be rendered, dimmed or
 * hidden is not something this library can know: only the developer knows
 * whether their reconfigure made the old answers WRONG or merely INCOMPLETE, so
 * a library that decided would be deciding wrong half the time (story 5 of
 * `a-reconfigure-is-not-an-outage`). It reports; the app decides.
 */
export type GenerationProgress = {
	/** WHICH generation. The same record `promote` takes, so a report is actionable. */
	readonly record: GenerationRecord;
	/**
	 * Whether it FOLLOWS a stream another generation writes rather than fetching
	 * its own -- which is what the common reconfigure (a processor change) makes,
	 * and what makes it free.
	 */
	readonly follows: boolean;
	/**
	 * How far its fold has got, or `undefined` before it has loaded.
	 *
	 * Absent rather than `0`, because "it has folded nothing yet" and "it is level
	 * at block 0" are different claims and an app that dims on progress must be
	 * able to tell them apart.
	 */
	readonly lastToBlock?: number;
	/**
	 * How far BEHIND the generation that is answering reads, in blocks: `0` means
	 * level (or ahead, which `manual` allows).
	 *
	 * `undefined` when either cursor is unknown. A percentage is deliberately not
	 * reported: which span to divide by is a presentation decision (the whole
	 * chain, the catch-up, the last reconfigure), and this `lastToBlock` together
	 * with `SyncingState.lastSync` carries the numbers for any of them.
	 */
	readonly blocksBehind?: number;
};

/**
 * WHICH WAY a refused seed and this client disagree, where the reason carries a
 * direction at all (ADR-0064).
 *
 * It is the refusal REASON, narrowed: the two members are exactly the two
 * reasons that name a direction, restated here so an application can switch on
 * one field instead of knowing which members of the refusal vocabulary happen to
 * be directional. It is DERIVED from `reason` and is never a second fact.
 *
 * What nothing in this library does with it is INFER. An app may render "a newer
 * version of this app may be available" off `seed-covers-more`; the library may
 * not, because a deliberately NARROWER client is indistinguishable from a stale
 * one and only the application knows which it is (ADR-0064).
 */
export type StreamSeedDirection = Extract<NotInstalledReason, 'seed-covers-more' | 'seed-covers-less'>;

/**
 * WHAT HAPPENED TO THE STREAM SEED, as a small discriminated state an app can
 * render.
 *
 * The visibility half of `a-browser-app-starts-from-a-published-artifact`: an
 * app that cannot say WHY it has no seed shows an empty screen instead of an
 * explanation, which is the outcome that spec exists to avoid (ADR-0064). So the
 * outcome the loader returns reaches the surface an application already
 * subscribes to, and not only the boot path's return value.
 *
 * It REPORTS and it does not decide, exactly as `nonCanonicalGenerations` does:
 * whether "installing", "seeded" or "refused" should dim, hide or replace what is
 * on screen is the application's call.
 *
 * ## What it deliberately does NOT carry
 *
 * **No byte-level progress.** In the recommended single-document shape the whole
 * install is about 1 s on a mid-range phone and ~300 ms on desktop, which a
 * spinner covers; the variable part is the DOWNLOAD, not the install, so a
 * progress signal belongs on the fetch as an optional loader callback if it is
 * ever wanted (`work/notes/findings/what-a-published-stream-seed-costs-to-install.md`).
 * `installing` and the terminal states are the whole surface, which is also why
 * this field publishes at most twice per boot.
 *
 * **No inference.** See `StreamSeedDirection`.
 */
export type StreamSeedState =
	/**
	 * The install is running. Published before the fetch, and replaced by a
	 * terminal state on every path the loader RETURNS from -- which is every
	 * ordinary one, since a refusal is data.
	 *
	 * The exception, stated here because this is what an app author reads: if the
	 * loader THROWS (a malformed `expectedContentHash`, a keeper failing mid-install,
	 * a batch declined by another writer) there is no outcome to report, so this
	 * value STANDS and `init` rejects instead. Neither of the alternatives is
	 * truthful -- clearing the field says no seed was asked for, and a synthetic
	 * terminal state needs a reason the loader's vocabulary does not have -- so the
	 * honest signal is the rejection, and an app must treat `init` rejecting as the
	 * end of the boot rather than waiting on this field. The status phase does NOT
	 * stick: it returns to `Idle`, so a spinner keyed on `InstallingStreamSeed`
	 * (which is what the guide shows) clears.
	 */
	| {readonly status: 'installing'}
	| {
			/** A stream was installed, and the app now holds history it never fetched. */
			readonly status: 'seeded';
			/** How far the installed stream REACHES: the seed's coverage end, above its last event. */
			readonly at: number;
			/** How far back it reaches: what the keeper recorded as the stream's `startBlock`. */
			readonly reachesBackTo: number;
			/** WHICH location served it, so an app can say where its history came from. */
			readonly from: string;
			readonly events: number;
			/** How many saves it took, which is how many SEGMENTS the keeper now holds. */
			readonly segments: number;
	  }
	| {
			/**
			 * No seed was installed, and the app STARTS ANYWAY.
			 *
			 * A refusal is a NORMAL condition and never gates the boot (ADR-0064): state
			 * still comes up from a published snapshot and indexes forward from the tip,
			 * and what is lost is the stream underneath, so the generation is a leaf and a
			 * later processor-only change waits for a republished snapshot instead of
			 * being free. That is why this is its own field and not `error`: an app
			 * treating `error` as a fault would render a crash for an ordinary outcome,
			 * and `acknowledgeError()` does not fit an outcome nothing can acknowledge
			 * away.
			 */
			readonly status: 'refused';
			/** WHY, verbatim from the loader, so an app can explain it. */
			readonly reason: NotInstalledReason;
			/** Present only where the reason names one. See `StreamSeedDirection`. */
			readonly direction?: StreamSeedDirection;
	  };

/**
 * The loader's outcome as this surface publishes it, plus the direction where
 * the reason carries one.
 *
 * A translation and not a re-decision: every field is the loader's own, and the
 * `direction` is `reason` narrowed. It is a free function because it decides
 * nothing about any particular indexer.
 */
function streamSeedStateOf(outcome: StreamSeedInstallOutcome): StreamSeedState {
	if (outcome.status === 'installed') {
		return {
			status: 'seeded',
			at: outcome.at,
			reachesBackTo: outcome.reachesBackTo,
			from: outcome.from,
			events: outcome.events,
			segments: outcome.segments,
		};
	}
	const direction = directionOf(outcome.reason);
	return {status: 'refused', reason: outcome.reason, ...(direction ? {direction} : {})};
}

/** The two refusal reasons that name a direction, and no others. */
function directionOf(reason: NotInstalledReason): StreamSeedDirection | undefined {
	return reason === 'seed-covers-more' || reason === 'seed-covers-less' ? reason : undefined;
}

export type SyncingState<ABI extends Abi> = {
	waitingForProvider: boolean;
	autoIndexing: boolean;
	loading: boolean;
	processingFetchedLogs: boolean;
	fetchingLogs: boolean;
	catchingUp: boolean;
	numRequests?: number;
	lastSync?: ExtendedLastSync<ABI>;
	error?: {message: string; id: ErrorCode; code?: number};
	/**
	 * EVERY generation this indexer holds that is NOT answering reads, with how far
	 * each has caught up (story 5).
	 *
	 * Empty while there is only one generation, which is the ordinary state of an
	 * app that has not reconfigured. A generation LEAVES this list the moment the
	 * canonical pointer names it -- it is then the thing being read, not a
	 * successor to it -- and the generation the pointer moved OFF enters it, because
	 * it is retained (that is what makes moving the pointer BACK a revert) and
	 * because "a generation you could revert to exists" is the same fact reported
	 * the same way.
	 */
	nonCanonicalGenerations: readonly GenerationProgress[];
	/**
	 * WHAT HAPPENED TO THE STREAM SEED this hook was asked to install, or ABSENT
	 * where none was asked for.
	 *
	 * Additive, and its own field rather than a second meaning for an existing one:
	 * an app that never seeds sees `undefined` here for ever and nothing else about
	 * this store changes. See `StreamSeedState`.
	 *
	 * It reports the install THIS hook ran at `init`, into the stream the indexer
	 * was initialised on. A reconfigure that moves the indexer to a DIFFERENT
	 * stream does not re-run an install and does not clear this, so on that path it
	 * goes on describing the stream the app booted on -- which is the honest reading
	 * of a boot-time fact, and the reason it is not cleared alongside `lastSync`:
	 * the common reconfigure (a processor change) keeps the very stream this
	 * describes, and clearing there would drop a true report.
	 */
	streamSeed?: StreamSeedState;
	/**
	 * THIS TAB IS NO LONGER A WRITER, and WHY -- or ABSENT while it still is.
	 *
	 * The visible half of the demotion (`demoteToReader`): a writer whose mutation
	 * was refused, or that was told it lost the write duty, stops fetching and folding
	 * and goes on ANSWERING READS. Without this field an app following the documented
	 * `createState` example would get a tab that silently stopped indexing for ever,
	 * which is the quiet failure the writer guard exists to end.
	 *
	 * It is its own field and NOT `error`, on exactly the ground `streamSeed` is: an
	 * app that renders `error` as a fault would render a crash for a state change,
	 * and `acknowledgeError()` does not fit an outcome nothing can acknowledge away.
	 * The data on screen is still correct -- it is the store's, and the store is being
	 * written by whoever holds it now -- so the honest rendering is "this tab is
	 * reading" rather than a broken app.
	 *
	 * It is reported for the INDEXER and not per generation, because the claim it
	 * reports is a fact about one unit of STORAGE (ADR-0075) and the shipped pattern
	 * hands one store to every generation (ADR-0077): a demotion that applied to one
	 * generation of a shared store and not to its neighbours would be a claim no
	 * backend makes.
	 *
	 * It CLEARS on `dispose()`, because a later `init` builds new generations over
	 * whatever the factories hand back -- which is where becoming a writer again
	 * happens, since a store that has lost is never re-claimed (ADR-0077).
	 */
	demotion?: Demotion;
};

export type StatusState = {
	/**
	 * WHICH PHASE the indexer is in, which is where applications already switch to
	 * choose what to render.
	 *
	 * `InstallingStreamSeed` is the boot phase a published **stream seed** is
	 * written to the keeper in. It is here, beside the phases an app already
	 * handles, so that the boot becomes visible without every app learning a new
	 * field; WHAT the install then did is `SyncingState.streamSeed`, because a phase
	 * says what is happening and not what happened. The phase LEAVES this value the
	 * moment the install reaches a terminal outcome, back to `Idle` until the load
	 * moves it on -- an indexer that has finished installing and not yet been asked
	 * to load really is idle.
	 */
	state:
		| 'Idle'
		| 'InstallingStreamSeed'
		| 'Loading'
		| 'FetchingEventStream'
		| 'ProcessingEventStream'
		| 'CatchingUp'
		| 'IndexingLatest';
};

/**
 * What the hook needs from a deployment's processor.
 *
 * Structural rather than an import of `EntityEventProcessor`, so that
 * `@etherfold/browser` does not have to depend on one entity runtime in order to
 * type the path. `EntityEventProcessor` (`@etherfold/processor-entities`)
 * satisfies it; so would anything else that runs an entity processor against a
 * store.
 *
 * `state` is a READ HANDLE and not a state object: there is no initial state to
 * CREATE, because the state is already in the store and is read back through the
 * handle. The handle exists the moment the processor does, has stable identity,
 * and is what `load` and `process` hand back.
 *
 * There used to be a second shape here -- a `ProcessorKind` tag discriminating
 * this from the free-form `EventProcessorWithInitialState` a `KeepState` keeper
 * persisted whole. That path is gone (ADR-0037), so the tag discriminates
 * nothing and the call shape is the processor itself.
 */
export type EntityEventProcessorLike<ABI extends Abi, ProcessResultType, ProcessorConfig> = EventProcessor<
	ABI,
	ProcessResultType
> & {
	readonly state: ProcessResultType;
	configure(config: ProcessorConfig): void;
};

/**
 * THE SHAPE of this hook: the factories that BUILD a generation, rather than one
 * already-built processor over one already-built store.
 *
 * An indexer holds any number of **generations** -- a stream plus a fold over it
 * -- and one of them is canonical and answers every read. So it cannot be handed
 * a constructed processor and a constructed store: each generation folds into
 * its OWN state, and the container has to be able to build the next one.
 *
 * ```ts
 * const indexer = createIndexerState({
 *   createState: async () => openForWriting(await createBrowserStateStore(myProcessor.entities)),
 *   createProcessor: (store) => fromEntityProcessor(myProcessor)(store),
 * });
 * ```
 *
 * The order is `createState` then `createProcessor`, and it is the order a
 * generation's IDENTITY forces: the stream half is known from the source and the
 * stream config, and the FOLD half is the processor's own version hash, so the
 * processor has to exist before the generation can be named -- which means the
 * state cannot be keyed on the finished name. The factories are per generation
 * instead, so the caller's own closure is what distinguishes this generation's
 * store from the next one's.
 *
 * There used to be a second accepted shape -- `createIndexerState(fromEntityProcessor(p)(store))`,
 * one already-built processor over one already-built store, which meant exactly
 * one generation. It is DELETED: an indexer that holds generations cannot be
 * handed one, so keeping it would have been a second call shape that could never
 * reach what the first one is for.
 */
export type BrowserGenerationSpec<ABI extends Abi, ProcessResultType, ProcessorConfig = undefined> = {
	/**
	 * Where THIS generation's state lives, CLAIMED. Called once, before its
	 * processor.
	 *
	 * It hands back a `WritableStateStore`, which is what `openForWriting` returns
	 * and the only way to obtain one: folding is writing, so the factory that builds
	 * a generation's store is where the claim is taken (ADR-0077). A reader never
	 * comes through here, which is the whole point of the narrowing -- a tab that only
	 * renders holds the store as a `StateStore` and cannot mutate it.
	 *
	 * The claim is per STORE INSTANCE and `openForWriting` is idempotent over one, so
	 * the shipped `createState: () => store` shape (one instance for every generation)
	 * takes ONE claim and every generation writes through it.
	 */
	createState: (context: GenerationContext) => WritableStateStore | Promise<WritableStateStore>;
	/** The fold, over that state. The FACTORY, not its result: its version hash NAMES the generation. */
	createProcessor: (
		state: WritableStateStore,
		context: GenerationContext,
	) =>
		| EntityEventProcessorLike<ABI, ProcessResultType, ProcessorConfig>
		| Promise<EntityEventProcessorLike<ABI, ProcessResultType, ProcessorConfig>>;
	/**
	 * Which generations this indexer holds and which one is canonical.
	 *
	 * Defaults to a MEMORY registry under `BROWSER_GENERATION_CAPS`, because this
	 * hook knows no indexer NAME and a durable registry is addressed under one --
	 * inventing a name here would fork the discriminator the stream address
	 * already carries. A tab that holds one generation re-registers it on every
	 * boot and loses nothing by that; an app that keeps a superseded generation to
	 * move the pointer BACK to wants a durable one and passes
	 * `openGenerationRegistryOnIndexedDB(name, {dropState})`.
	 */
	registry?: GenerationRegistry;
};

/**
 * WHERE A PUBLISHED STREAM SEED COMES FROM, as the hook takes it.
 *
 * ## Convenience, not a trust boundary and not a safety mechanism
 *
 * The loader is callable directly (`installStreamSeed`, `@etherfold/core`) and
 * an application may drive the install itself; this option saves it sequencing
 * the call, and gives this hook's surface something to publish. It is NOT a
 * safety mechanism: the install carries its own RESOLVED stream config and sets
 * it on the keeper before it addresses anything (ADR-0067), so it is correct
 * whether it runs before or after a generation exists.
 *
 * ## The trust contract travels with the locations (ADR-0066)
 *
 * The CALLER names the locations and owns that choice: the loader fetches where
 * it is pointed and nowhere else, so there is no origin check to make. Keep BOTH
 * the list and any `expectedContentHash` in the BUILD -- a pin read from the same
 * place as the artifact proves nothing -- and read `installStreamSeed`'s own
 * JSDoc before shipping one, including what it does NOT defend against
 * (OMISSION, which is impossible within the premise rather than deferred).
 */
export type BrowserStreamSeedOptions = {
	/**
	 * The ORDERED list, freshest first, walked until one is usable. A relative,
	 * hostless path is a first-class location and is what a BUILD-EMBEDDED artifact
	 * is listed as, ordinarily LAST so the app still starts when the remote is gone.
	 */
	locations: StreamSeedLocation | readonly StreamSeedLocation[];
	/**
	 * An OPTIONAL content hash, verbatim as the producer printed it
	 * (`sha256:<hex>`). Only an IMMUTABLE, release-tied artifact can have one
	 * pinned: a build cannot know the hash of a ROLLING artifact, and rolling is how
	 * this is ordinarily deployed.
	 */
	expectedContentHash?: string;
	/**
	 * The block the client will ask this stream FROM, which a seed must reach back
	 * to or be refused. Defaults to the source's own earliest `startBlock`, which is
	 * exactly what a fresh generation's `load()` asks for.
	 */
	reachBackTo?: number;
	/** How many events one save carries, at most. Defaults to the loader's own 1,000. */
	maxEventsPerBatch?: number;
	/** Injectable for tests and for a host with its own retry/timeout policy. */
	fetch?: typeof globalThis.fetch;
};

type InitFunction<ABI extends Abi, ProcessorConfig = undefined> = ProcessorConfig extends undefined
	? (indexerSetup: {
			provider: EIP1193ProviderWithoutEvents;
			source: IndexingSource<ABI>;
			config?: ProvidedIndexerConfig<ABI>;
		}) => Promise<void>
	: (
			indexerSetup: {
				provider: EIP1193ProviderWithoutEvents;
				source: IndexingSource<ABI>;
				config?: ProvidedIndexerConfig<ABI>;
			},
			processorConfig: ProcessorConfig,
		) => Promise<void>;

/**
 * THE BROWSER INDEXING HOOK, AND THE MAIN-THREAD **indexer host** (ADR-0082).
 *
 * ```ts
 * // the state (and its cursor) live in a store the app chose, and a GENERATION
 * // builds its own: the hook is handed the factories, not their results
 * const indexer = createIndexerState({
 *   createState: async () => openForWriting(await createBrowserStateStore(myProcessor.entities)),
 *   createProcessor: (store) => fromEntityProcessor(myProcessor)(store),
 * });
 * ```
 *
 * ## It is a HOST, and `mainThreadHost()` is the port to it
 *
 * A **host** owns a **container** and drives it; three **hosting shapes** exist
 * in a browser and they differ ONLY in how a port is obtained. This function is
 * the MAIN-THREAD one -- it owns the container, opens the store for WRITING and
 * runs the loop -- so an app that wants the port surface rather than the
 * reactive triple joins a wire to it and never constructs a second indexer:
 *
 * ```ts
 * const port = connectToIndexerHost(indexer.mainThreadHost(), {watch: false});
 * ```
 *
 * What that buys is that the code an app writes AGAINST the port is identical
 * across the three shapes, so moving the fold into a worker later is a change to
 * one line of wiring. What it COSTS here is the whole reason a dedicated worker
 * is the default: the fold runs on the UI thread, so a tab that hosts its own
 * indexer janks while it renders.
 *
 * There is deliberately no second main-thread constructor beside this one
 * (ADR-0082). `serveIndexerHost` is the WORKER hosts' driver, reached through
 * `hostIndexerInThisWorker` / `hostIndexerInThisSharedWorker` from inside a
 * worker entry point; what runs on this thread is this function.
 *
 * ## Where the state is persisted, and by whom
 *
 * NOT here, and not by a keeper this hook holds. The processor persists through
 * the store it CLAIMED, which writes the sync cursor in the SAME transaction as the
 * block it describes (ADR-0027) -- which is why the cursor lives behind the
 * storage seam at all. The invariant that buys is that a processor's state and
 * its cursor never diverge: a reader never comes back to state that has advanced
 * past its recorded position, or the reverse, however the tab died.
 *
 * This used to be one of two persistence models, the other being a `KeepState`
 * keeper that wrote `{state, lastSync}` as one blob because a blob has no
 * transaction to join. That path is deleted (ADR-0037), and with it the `kind`
 * tag that told the two apart and the `keepState` option that fed one of them.
 *
 * ## And what a RELOAD does
 *
 * The state comes back from the STORE, so how far it survives is a property of
 * the backend the application chose: versioned rows in IndexedDB (the default,
 * ADR-0024) resume from the cursor, and `@etherfold/state-store-patch` is
 * memory-only by design (ADR-0023) and starts over. That is not a defect of the
 * light store; it reports `durability: 'memory-only'` in its capabilities, which
 * the read handle exposes, so an app can learn it at startup instead of from an
 * empty tab.
 */
export function createIndexerState<ABI extends Abi, ProcessResultType, ProcessorConfig = undefined>(
	spec: BrowserGenerationSpec<ABI, ProcessResultType, ProcessorConfig>,
	options?: {
		catchupThreshold?: number;
		trackNumRequests?: boolean;
		logRequests?: boolean;
		keepStream?: ExistingStream<ABI>;
		/**
		 * INSTALL A PUBLISHED STREAM SEED into `keepStream` at `init`, before the
		 * generation loads.
		 *
		 * The documented default way to seed a stream, and a convenience over calling
		 * `installStreamSeed` yourself: this hook sequences the call and publishes what
		 * it did on `syncing.streamSeed` and `status.state`. See
		 * `BrowserStreamSeedOptions` for the trust contract, which is the caller's.
		 *
		 * It needs a `keepStream`, because a seed is a stream and there is nothing to
		 * install into without one; asking for a seed with no keeper RAISES at `init`
		 * rather than being reported as a refusal, since it is a wiring mistake in the
		 * caller's own source and no location makes it right.
		 */
		seed?: BrowserStreamSeedOptions;
		/**
		 * WHEN the canonical pointer moves to a generation added beside the live one.
		 *
		 * PASSED THROUGH and never defaulted here. `on-catch-up` is the default in
		 * every runtime, and this hook deliberately does not select one of its own:
		 * the axis that would justify a browser-specific value is DEVELOPMENT versus
		 * PRODUCTION, and nothing in a browser build can detect which it is in, so a
		 * runtime default would be a guess with `immediate`'s consequences. A
		 * developer who wants their edit to answer straight away says
		 * `{promotion: {policy: 'immediate'}}`; a shipped app says nothing and gets
		 * the safe one.
		 */
		promotion?: PromotionConfig;
		/**
		 * How many versions ONE of this loop's scheduled prunes may delete. Defaults
		 * to `DEFAULT_PRUNE_BUDGET`.
		 *
		 * The budget is per PASS, and the loop comes back on its next cycle for
		 * whatever a pass could not finish, so this is a smoothness knob rather than a
		 * limit on what is reclaimed. Lower it for a tab doing animation work beside
		 * its indexing; raise it for one that has just been given a window after
		 * running unbounded and wants the backlog gone sooner.
		 *
		 * What it is NOT is a way to turn pruning off. A store prunes because its
		 * retention states a FLOOR, and a deployment that wants nothing dropped says
		 * so where retention is configured (`unbounded`, which is the default) rather
		 * than by starving the schedule -- a store bounded in what it answers and
		 * unbounded in what it holds is strictly worse than either honest position.
		 */
		pruneBudget?: number;
		// Optional factory used to construct the underlying IndexerGeneration. Receives the same
		// arguments (already request-tracked/logged provider, configured processor, source, config)
		// that would otherwise be passed to `new IndexerGeneration(...)`. Useful for injecting a
		// subclass, a shared instance, or a spy/fake in tests. Defaults to
		// `new IndexerGeneration(...)`.
		//
		// The processor arrives as the `EventProcessor` the core drives, which is all
		// `new IndexerGeneration(...)` takes. This is the container's
		// `createGeneration`: one of these is built per generation.
		createIndexer?: (
			provider: EIP1193ProviderWithoutEvents,
			processor: EventProcessor<ABI, ProcessResultType>,
			source: IndexingSource<ABI>,
			config: ProvidedIndexerConfig<ABI>,
		) => IndexerGeneration<ABI, ProcessResultType>;
	},
) {
	const {
		$state: $syncing,
		set: setSyncing,
		readable: readableSyncing,
	} = createStore<SyncingState<ABI>>({
		waitingForProvider: true,
		loading: false,
		autoIndexing: false,
		catchingUp: false,
		fetchingLogs: false,
		processingFetchedLogs: false,
		numRequests: options?.trackNumRequests ? 0 : undefined,
		nonCanonicalGenerations: [],
	});

	/**
	 * The budget every scheduled prune spends, validated HERE rather than on the
	 * first cycle that would have used it.
	 *
	 * It is the seam's own check (`pruneBudget`, `@etherfold/state-store`), so a
	 * nonsense budget is refused in the same words wherever it is written -- and it
	 * lands where the app configured it instead of becoming a logged failure once
	 * per cycle for ever. Zero in particular is refused rather than read as "do
	 * nothing": a caller that computed a budget wrongly would otherwise watch a
	 * prune run on schedule while the store grew.
	 */
	const scheduledPruneBudget = pruneBudget({maxVersions: options?.pruneBudget ?? DEFAULT_PRUNE_BUDGET});

	const {set: setStatus, readable: readableStatus} = createStore<StatusState>({state: 'Idle'});
	/**
	 * There is nothing to publish until `init` has built the generation.
	 *
	 * The state is a READ HANDLE onto a store, and neither exists before the
	 * factories have been called -- which is the whole point of taking factories.
	 * `init` publishes the container's INDIRECT handle the moment it does.
	 */
	const {set: setState, readable: readableState} = createRootStore<ProcessResultType>(undefined as ProcessResultType);

	/** The container this hook drives, once `init` has opened it. */
	let indexer: Indexer<ABI, ProcessResultType> | undefined;
	/**
	 * WHICH OF THE FIVE COARSE THINGS THE FOLD IS DOING, as a **port** reports it.
	 *
	 * Kept beside `status.state` rather than derived from it, because the two answer
	 * different questions and one of them would be WRONG if translated. `StatusState`
	 * carries this thread's finer vocabulary (`FetchingEventStream`,
	 * `ProcessingEventStream`) and reaches `IndexingLatest` through
	 * `catchupThreshold`, which is a presentation smoothing knob -- twenty blocks from
	 * the tip is "latest" for a UI that would otherwise flicker. `SyncPhase.at-tip` is
	 * the DRIVER's own condition -- every generation the container holds is level with
	 * its tip, as `host/pacing.ts` decides it for all three hosting shapes -- and
	 * nothing else, which is what every hosting shape means by it. Deriving one from
	 * the other would make a port say "live" over a fold that is still fetching.
	 */
	let hostPhase: SyncPhase = 'waiting';
	/** WHY the loop stopped, where it stopped on something waiting cannot fix. */
	let hostFailure: PortError | undefined;
	/** Every wire a `mainThreadHost()` handed out and has not been let go of. */
	const wires = new Set<MainThreadHosting>();
	/** The processor configuration `init` was given, so a generation added later is built with it. */
	let processorConfigUsed: ProcessorConfig | undefined;
	/** The auto-index cycle in flight, so a STOP can resolve once it has LANDED. */
	let cycling: Promise<void> | undefined;

	/**
	 * A READ ACROSS THE PORT MAY ARRIVE BEFORE THE FIRST STORE EXISTS, and waits
	 * rather than being refused.
	 *
	 * The same rule the worker hosts follow, for the same reason: waiting is the
	 * honest answer to "read me the rows" while the store is moments away, and what
	 * must never happen is waiting FOREVER -- so a `dispose()` before any `init`
	 * rejects it and a later `init` gives it a fresh one.
	 */
	let announceFirstState!: () => void;
	let refuseFirstState!: (error: unknown) => void;
	let firstState!: Promise<void>;
	function expectFirstState(): void {
		firstState = new Promise<void>((resolve, reject) => {
			announceFirstState = resolve;
			refuseFirstState = reject;
		});
		// Nobody may ever read, and a promise that rejects with no handler is a warning
		// in every runtime this ships to.
		firstState.catch(() => undefined);
	}
	expectFirstState();

	/** Tell every attached wire where the fold is, if it MOVED. See `ServedCases.publish`. */
	function publishToPort(): void {
		for (const wire of wires) wire.publish();
	}

	/** Move the port's phase and say so. A move to the phase it is already in posts nothing. */
	function enterHostPhase(next: SyncPhase): void {
		hostPhase = next;
		publishToPort();
	}
	// `ReturnType<typeof setTimeout>` rather than `number`: this module is browser
	// code, but its own test tooling puts node's typings in scope, and the handle is
	// only ever passed back to `clearTimeout`, which takes either.
	let indexingTimeout: ReturnType<typeof setTimeout> | undefined;
	let autoIndexingInterval: number = 4;

	/**
	 * WHETHER THIS TAB HAS STOPPED BEING A WRITER, and why. `undefined` while it is one.
	 *
	 * Held here as well as published on `syncing`, because it GATES every path that
	 * would write: a demoted tab that re-entered `setupIndexing` would load, fold and
	 * be refused all over again -- which is the loop the demotion exists to end. It
	 * is one-way for the life of this container: a writer never re-claims a store it
	 * lost (ADR-0077), so it is cleared only by `dispose`, after which a new `init`
	 * builds new generations over whatever the factories hand back.
	 */
	let demotion: Demotion | undefined;

	/**
	 * How many times the canonical pointer has moved.
	 *
	 * Read as a STAMP across an advance, to answer "did the pointer move while that
	 * call was running?". A cycle the pointer moved in returns the cursor of the
	 * generation that was canonical when it STARTED (`Indexer.indexMore` resolves
	 * the canonical generation before its loop), and publishing that afterwards
	 * would put the RETIRED generation's cursor back into `syncing` -- undoing the
	 * container's own re-publish, and leaving `checkTxInclusion` answering from a
	 * window nothing maintains.
	 */
	let promotions = 0;

	/**
	 * WHERE EACH GENERATION'S STATE LIVES, so the cycle can prune what this
	 * indexer holds.
	 *
	 * Keyed by the generation the store belongs to, because that is the thing that
	 * comes and goes: a generation dropped on promotion takes its state with it,
	 * and a hook holding every store it ever built would go on pruning a database
	 * that was deleted underneath it. The key is the generation's own identity
	 * (`{stream, processor}`), computed from exactly what the container registers.
	 *
	 * It is recorded rather than asked for, because there is nothing to ask: the
	 * container hands out a `HeldGeneration` carrying the record, the engine and
	 * the fold, and deliberately not the store -- a generation's state is the
	 * caller's own object, built by the caller's own factory. This hook CALLED that
	 * factory, so it is the one place that knows.
	 *
	 * Which is also the limit of what it can know: a store handed in ALREADY BUILT,
	 * which is what `updateProcessor` takes, was not built through a factory here.
	 * That is the same store in the ordinary case (a hot reload rebuilds the
	 * processor over the tab's existing database), and a swap onto a genuinely
	 * different store is prunable again after the next `init`.
	 */
	const statesByGeneration = new Map<string, WritableStateStore>();

	/** A generation's identity as a map key: the two halves the registry records. */
	function generationKey(id: {stream: string; processor: string}): string {
		return `${id.stream}/${id.processor}`;
	}

	// Serializes reconfiguration (updateIndexer/updateProcessor) so that overlapping calls
	// (e.g. a slow deploy's source change racing a processor change, in either order) run one fully
	// settled then the next, in arrival order, instead of interleaving their reset/reinit/load phases
	// on the same indexer instance.
	let reconfigureQueue: Promise<unknown> = Promise.resolve();
	function serializeReconfigure<T>(fn: () => Promise<T>): Promise<T> {
		// chain after the previous reconfigure regardless of whether it succeeded or failed
		const run = reconfigureQueue.then(fn, fn);
		// keep the chain alive even if this step rejects (so a failure does not poison the queue)
		reconfigureQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/**
	 * The two factories, as the container takes them: state first, then the fold
	 * over it.
	 *
	 * Shared by `init` and `addGeneration`, so a generation added beside the live
	 * one is built exactly as the first one was -- including the read HANDLE
	 * (`stateOf`), which is what lets the container answer from a generation that
	 * has folded nothing yet, and which is what a just-promoted generation IS.
	 */
	function generationSpecFor(
		createState: BrowserGenerationSpec<ABI, ProcessResultType, ProcessorConfig>['createState'],
		createProcessor: BrowserGenerationSpec<ABI, ProcessResultType, ProcessorConfig>['createProcessor'],
		processorConfig?: ProcessorConfig,
	) {
		return {
			createState: (context: GenerationContext) => createState(context),
			createProcessor: async (state: unknown, context: GenerationContext) => {
				const built = await createProcessor(state as WritableStateStore, context);
				if (built.configure && processorConfig) {
					built.configure(processorConfig);
				}
				// Recorded HERE and not in `createState`, because this is the first moment
				// both halves exist: a generation is `{stream, processor version hash}` and
				// the fold's half is only known once the processor is built, which is why
				// the factories run in this order at all.
				//
				// The FIRST one wins, because that is what the container does with the
				// generation itself: naming a generation it already holds RESOLVES to the one
				// it is folding rather than adding a second engine over it, and the state that
				// is being folded into is the one built alongside THAT processor. Overwriting
				// would point this at a store nothing writes to and quietly stop pruning the
				// one that is growing.
				const key = generationKey({stream: context.stream, processor: built.getVersionHash()});
				if (!statesByGeneration.has(key)) {
					statesByGeneration.set(key, state as WritableStateStore);
				}
				return built;
			},
			stateOf: (built: EventProcessor<ABI, ProcessResultType>) =>
				(built as EntityEventProcessorLike<ABI, ProcessResultType, ProcessorConfig>).state,
		};
	}

	/**
	 * THE POINTER MOVED, so what this hook derived from the retired generation goes
	 * with it.
	 *
	 * `syncing.lastSync` is not decoration: `checkTxInclusion` answers from it, and
	 * the retired generation's unconfirmed window would report a transaction as
	 * INCLUDED that the generation now answering has not reached -- which is the
	 * double-counted optimistic update the whole verdict exists to prevent. So it is
	 * dropped here, and the container re-publishes the new canonical generation's
	 * own cursor immediately after IF it has one. Where it has none (an `immediate`
	 * promotion, which is canonical before it has caught up), nothing replaces it
	 * and `checkTxInclusion` answers `unknown` / `not-synced` -- which is the honest
	 * answer rather than a missing one.
	 */
	function onPromoted(promoted: GenerationRecord) {
		promotions++;
		clearSyncingStateForReconfigure();
		// The promoted generation is passed IN rather than read back, because this
		// fires BEFORE the container applies the move on the read path (that is the
		// whole point of the callback: a consumer drops what it derived from the
		// retired generation before it is told to re-read). Asking `indexer.canonical`
		// here would still answer with the generation being superseded, and the one
		// just promoted would be reported as a successor to itself.
		reportGenerationProgress(promoted);
	}

	/**
	 * WHICH GENERATIONS ARE NOT ANSWERING READS, and how far each has caught up.
	 *
	 * Derived from the container on demand rather than accumulated here: it already
	 * keeps every generation's cursor (the promotion trigger is a comparison
	 * between two of them), and a second copy in this hook would be a second thing
	 * to keep true across promotion, revert and drop.
	 *
	 * `canonicalNow` exists for the one caller that knows better than the container
	 * does -- see `onPromoted`.
	 */
	function reportGenerationProgress(canonicalNow?: GenerationRecord) {
		if (!indexer) {
			setSyncing({nonCanonicalGenerations: []});
			return;
		}
		const generations = indexer.generations;
		// `canonical` is a generation and never nothing: `init` opens the container with
		// a spec, and a container that could not resolve a canonical generation refuses
		// to open at all rather than holding none.
		const canonical = canonicalNow ?? indexer.canonical.record;
		const isCanonical = (record: GenerationRecord) => sameGeneration(record, canonical);
		const canonicalCursor = generations.find((generation) => isCanonical(generation.record))?.lastSync?.lastToBlock;
		setSyncing({
			nonCanonicalGenerations: generations
				.filter((generation) => !isCanonical(generation.record))
				.map((generation) => {
					const lastToBlock = generation.lastSync?.lastToBlock;
					return {
						record: generation.record,
						follows: generation.follows,
						lastToBlock,
						// floored at zero: a generation AHEAD of the canonical one (which `manual`
						// allows) is not behind by a negative number, it is not behind. The two
						// cursors are both reported for an app that needs the exact relation.
						blocksBehind:
							lastToBlock === undefined || canonicalCursor === undefined
								? undefined
								: Math.max(0, canonicalCursor - lastToBlock),
					};
				}),
		});
	}

	/**
	 * INSTALL THE PUBLISHED SEED, and PUBLISH what it did.
	 *
	 * Run from `init` and BEFORE the generation is built, so the fold that follows
	 * finds the stream already there rather than fetching a history a public node
	 * would refuse to serve. Ordering is not what makes it correct, though: the
	 * install takes the RESOLVED stream config as an argument and sets it on the
	 * keeper itself (ADR-0067), so an application driving `installStreamSeed`
	 * directly gets the same answer before `init` or after it.
	 *
	 * TWO publications and never more: `installing`, then the terminal outcome. A
	 * refusal is DATA and does not stop anything -- `init` carries on, the generation
	 * is built, state comes up from whatever the application's `createState`
	 * bootstrapped and indexes forward, and the refusal is reported ALONGSIDE that
	 * boot rather than gating it (ADR-0064).
	 *
	 * What DOES propagate is a THROW, which the loader reserves for what is not an
	 * ordinary condition: a malformed pin, a keeper that failed mid-install, or a
	 * batch declined by a subtree something else wrote into. `init` rejects, and
	 * this field is left saying `installing`, which is what actually happened: there
	 * is no terminal outcome to report.
	 */
	async function installSeed(
		seed: BrowserStreamSeedOptions,
		source: IndexingSource<ABI>,
		config: ProvidedIndexerConfig<ABI>,
	) {
		const keepStream = config.keepStream;
		if (!keepStream) {
			throw new Error(
				`a stream seed was given with no \`keepStream\`: a seed IS a stream, so there is nothing to install it ` +
					`into. Pass a keeper (\`keepStreamOnIndexedDB(name)\`), or drop the seed and run the snapshot-only mode.`,
			);
		}
		setSyncing({streamSeed: {status: 'installing'}});
		setStatus({state: 'InstallingStreamSeed'});
		try {
			const outcome = await installStreamSeed(keepStream, seed.locations, {
				source,
				// RESOLVED here, because the install addresses the subtree with it and the
				// digest half of that address must be the one the indexer itself will run
				// under -- never the config as a user spelled it.
				streamConfig: resolveStreamConfig(config.stream),
				...(seed.reachBackTo === undefined ? {} : {reachBackTo: seed.reachBackTo}),
				...(seed.maxEventsPerBatch === undefined ? {} : {maxEventsPerBatch: seed.maxEventsPerBatch}),
				...(seed.expectedContentHash === undefined ? {} : {expectedContentHash: seed.expectedContentHash}),
				...(seed.fetch === undefined ? {} : {fetch: seed.fetch}),
			});
			setSyncing({streamSeed: streamSeedStateOf(outcome)});
			// The install is over either way, and nothing is loading yet. `setupIndexing`
			// moves this on to `Loading` at the next call; leaving `InstallingStreamSeed`
			// standing would be the one thing that is certainly untrue.
			setStatus({state: 'Idle'});
		} catch (err) {
			setStatus({state: 'Idle'});
			throw err;
		}
	}

	async function init(
		indexerSetup: {
			provider: EIP1193ProviderWithoutEvents;
			source: IndexingSource<ABI>;
			config?: ProvidedIndexerConfig<ABI>;
		},
		processorConfig?: ProcessorConfig,
	) {
		if (indexer) {
			throw new Error(`already initialised`);
		}
		processorConfigUsed = processorConfig;
		const config = {...{}, keepStream: options?.keepStream, ...(indexerSetup.config || {})};
		const source = indexerSetup.source;

		// BEFORE the generation is built, and therefore before it loads: a fold that
		// starts first would find an empty subtree, index into it, and the install would
		// then be refused as `subtree-not-empty` -- loudly and as data, but too late.
		if (options?.seed) {
			await installSeed(options.seed, source, config);
		}

		let provider: EIP1193ProviderWithoutEvents = indexerSetup.provider;

		if (options?.trackNumRequests && !options.logRequests) {
			// only trackNumRequest
			provider = new Proxy(indexerSetup.provider, {
				get(target, p, receiver) {
					if (p === 'request') {
						return (args: {method: string; params?: readonly unknown[]}) => {
							if (options.trackNumRequests) {
								setSyncing({numRequests: ($syncing.numRequests || 0) + 1});
							}
							return target[p](args as any);
						};
					}
					return (target as any)[p];
				},
			});
		} else if (options?.logRequests) {
			provider = new Proxy(indexerSetup.provider, {
				get(target, p, receiver) {
					if (p === 'request') {
						return async (args: {method: string; params?: readonly unknown[]}) => {
							if (options.trackNumRequests) {
								setSyncing({numRequests: ($syncing.numRequests || 0) + 1});
							}
							if (options.logRequests) {
								console.log(JSON.stringify(args));
							}
							let response;
							try {
								response = await target[p](args as any);
								console.log(`  =>`, JSON.stringify(response));
							} catch (err) {
								console.error(`  error:`, err);
								throw err;
							}
							return response;
						};
					}
					return (target as any)[p];
				},
			});
		}

		// Build the generation here, because a generation's state and its fold are
		// this hook's to construct, not the caller's to have constructed. The registry
		// is what holds WHICH generations exist and which one is canonical.
		indexer = await openIndexer<ABI, ProcessResultType>({
			registry: spec.registry ?? (await openMemoryGenerationRegistry(BROWSER_GENERATION_CAPS)),
			provider,
			source,
			config,
			...(options?.promotion ? {promotion: options.promotion} : {}),
			generations: [generationSpecFor(spec.createState, spec.createProcessor, processorConfig)],
			createGeneration: options?.createIndexer,
		});
		indexer.onPromoted = onPromoted;
		// Published straight away, and it is the INDIRECT handle: a subscriber that
		// keeps what it is handed keeps something that follows the canonical pointer.
		setState(indexer.state);
		setSyncing({waitingForProvider: false});
		// The container is open, so the generation it was given has been built and its
		// state recorded: a read across the port that was waiting can be answered. The
		// chain answered too, so this host is no longer WAITING on a provider -- the same
		// moment `waitingForProvider` is cleared, which is the rule every shape follows.
		announceFirstState();
		enterHostPhase('loading');
		// One generation and it is canonical, so this reports nothing -- but it reports
		// nothing from the CONTAINER, rather than leaving the initial value standing
		// for a container that may have been opened over a durable registry.
		reportGenerationProgress();
	}

	let lastLastToBlock: number;
	function setLastSync(lastSync: LastSync<ABI>) {
		if (!lastSync) {
			return;
		}
		if (!indexer) {
			throw new Error(`no indexer`);
		}
		const startingBlock = indexer.defaultFromBlock;
		const latestBlock = lastSync.latestBlock;
		const lastToBlock = lastSync.lastToBlock;
		lastLastToBlock = lastToBlock;

		// ONE derivation, shared with the port (`derivedProgress`), rather than a second
		// copy of the arithmetic beside it. The copy that used to live here divided by a
		// tip the container had not learnt yet: before the first fetch the cursor is `0`
		// of `0`, so `lastToBlock / latestBlock` was `NaN` and the span was NEGATIVE
		// (`latestBlock - startingBlock`, with `startingBlock` the source's start block).
		// An app binding a progress bar rendered that.
		//
		// Where the port reports a figure as ABSENT below a learnt tip, these fields are
		// typed non-optional, so they read `0` -- "nothing known yet". `0` rather than
		// `100` is the load-bearing half: with no tip, an empty span is indistinguishable
		// from a finished one, and telling an app it is DONE before a single log is asked
		// for is the worse of the two lies.
		const derived = derivedProgress(lastSync, startingBlock);

		const lastSyncObject = formatLastSync(lastSync);
		lastSyncObject.numBlocksProcessedSoFar = derived.numBlocksProcessedSoFar ?? 0;
		lastSyncObject.syncPercentage = derived.syncPercentage ?? 0;
		lastSyncObject.totalPercentage =
			latestBlock > 0 ? Math.min(100, Math.floor((lastToBlock * 1000000) / latestBlock) / 10000) : 0;

		setSyncing({lastSync: lastSyncObject});
		// THE PUSH CADENCE, and the whole of it: the cursor moved, so a tab holding a
		// port is told. Tied to APPLIED WORK and never to a timer.
		publishToPort();
	}

	// Clears the browser-layer syncing state that gates `setupIndexing` (its early-return on
	// `$syncing.lastSync`) so that after a reconfiguration (updateIndexer/updateProcessor) the next
	// indexMore/auto-index re-runs setupIndexing cleanly against the new source/config and recomputes
	// progress against the (possibly new) defaultFromBlock.
	function clearSyncingStateForReconfigure() {
		setSyncing({lastSync: undefined});
		// NOTE: we intentionally do NOT touch `status` here.
		// - If indexing resumes (auto-index tick or a manual indexMore), the next setupIndexing() ->
		//   load() emits `Loading` (and onward) via onLoad, so the status corrects itself.
		// - If nothing is called after the reconfigure, the indexer really is idle now (lastSync is
		//   undefined), so arguably `Idle` would be the most correct resting status. We avoid forcing
		//   either `Loading` (a lie if no reload follows, e.g. a no-reset updateIndexer) or `Idle` (a
		//   flicker if a reload does follow) and let the actual next operation set the truthful status.
	}

	async function setupIndexing(): Promise<LastSync<ABI>> {
		if ($syncing.lastSync) {
			return $syncing.lastSync;
		}
		if (!indexer) {
			throw new Error(`no indexer`);
		}
		indexer.onLoad = async (loadingState) => {
			if (loadingState === 'Loading') {
				setStatus({state: 'Loading'});
				enterHostPhase('loading');
			} else if (loadingState === 'FetchingEventStream') {
				setSyncing({fetchingLogs: true});
				setStatus({state: 'FetchingEventStream'});
			} else if (loadingState === 'ProcessingEventStream') {
				setSyncing({fetchingLogs: false, processingFetchedLogs: true});
				setStatus({state: 'ProcessingEventStream'});
			} else if (loadingState === 'Loaded') {
				setSyncing({processingFetchedLogs: false});
				setSyncing({catchingUp: true});
				setStatus({state: 'CatchingUp'});
				// Loaded, and BEHIND BY AN UNKNOWN AMOUNT: no advance has answered yet, so
				// the cursor's own numbers may still be the `0` of `0` a container publishes
				// before it has fetched. Only an advance can say `at-tip`.
				enterHostPhase('catching-up');
			}
			await wait(0.001); // allow propagation if the whole proces is synchronous
		};
		indexer.onLastSyncUpdated = (lastSync) => {
			// should we also wait ?
			setLastSync(lastSync);
			setCatchup(lastSync);
		};
		indexer.onStateUpdated = (state) => {
			setState(state);
		};

		setSyncing({loading: true});
		try {
			const lastSync = await indexer.load();
			setSyncing({loading: false});
			// A load is an advance for every generation -- for a follower it is the whole
			// re-fold of the stored stream -- so it is where a successor first has a cursor.
			reportGenerationProgress();
			return lastSync;
		} catch (err) {
			// A REFUSED WRITER is not a failed load: the load did everything it could and
			// another writer holds the store. It is reported as a demotion by whoever
			// called this, so publishing `error` here too would render a fault for a state
			// change -- and `loading` still has to come down either way.
			setSyncing({
				loading: false,
				...(isStoreWriterChanged(err) ? {} : {error: {message: 'Failed to load', id: 'FAILED_TO_LOAD'}}),
			});
			throw err;
		}
	}

	/**
	 * ONE advance, published unless the pointer moved during it.
	 *
	 * The skip is not an optimisation: the value this returns belongs to whichever
	 * generation was canonical when the cycle started, and after a promotion that is
	 * the RETIRED one. The container publishes the new canonical generation's own
	 * cursor at the move (or publishes none, when it has none yet), and that is what
	 * `syncing` must be left holding.
	 */
	async function advanceOnce(): Promise<LastSync<ABI>> {
		if (!indexer) {
			throw new Error(`no indexer`);
		}
		const stamp = promotions;
		const lastSync = await indexer.indexMore();
		if (promotions === stamp) {
			setLastSync(lastSync);
			setCatchup(lastSync);
		}
		// ONE rule for "at the tip", and it is the rule the DRIVER rests on rather than
		// `catchupThreshold` beside it: a port saying `at-tip` while a loop went on
		// fetching would be two answers to one question, and an app would be told "live"
		// over an incomplete fold. It lives in `host/pacing.ts` so that this host and the
		// worker host cannot answer it differently -- and it is asked of every generation
		// the container holds, so a successor still rebuilding says `catching-up` even
		// while the generation answering reads is level.
		enterHostPhase(phaseAfterCycle(indexer));
		// Unconditionally, unlike the cursor above: this is read from the container as
		// it stands NOW, so a pointer that moved during the cycle is already accounted
		// for rather than something to skip.
		reportGenerationProgress();
		// LAST, and outside every apply: the blocks are already stored and the cursor
		// is already published, so what the delete delays is this cycle's return and
		// never a block's own transaction (ADR-0022).
		await pruneScheduled();
		return lastSync;
	}

	/**
	 * RECLAIM WHAT THE RETENTION NO LONGER COVERS: one bounded pass per cycle, over
	 * the state of every generation this indexer holds.
	 *
	 * The half of retention that a browser deployment was missing. A window bounds
	 * what a READ may ask about from the moment it is configured; this is what
	 * bounds the BYTES, and ADR-0022 makes it an explicit call a HOST schedules --
	 * so without a caller a tab got the refusals of a bounded store and the
	 * footprint of an unbounded one, on a device under a quota, for as long as it
	 * stayed open.
	 *
	 * ## Why it is called UNCONDITIONALLY
	 *
	 * It is a no-op wherever there is no floor, which ADR-0022 states precisely so
	 * that a host may schedule one without asking what it is holding. And the
	 * question could not be answered here anyway: the trigger is a FLOOR and not a
	 * window -- `retentionFloor` returns one for `revert-only` too, wherever a
	 * finality depth was stated -- while the capability report carries no depth. A
	 * host that branched on `retention.kind === 'window'` would leave a
	 * `revert-only` deployment, which is the setting a browser app wanting reorg
	 * safety and no history is told to prefer, refusing every historical read while
	 * retaining every version for ever.
	 *
	 * ## Why it is not the store's own business
	 *
	 * Because it costs time proportional to what it drops, and WHICH cycle pays is
	 * a scheduling decision a store cannot make for a tab, a backfilling CLI and a
	 * long-running server at once. Here it is the cycle, after the advance: a
	 * bounded pass, and whatever it could not finish is the next cycle's. A tab
	 * that ran unbounded for a month before a window was configured therefore
	 * reclaims its backlog over cycles instead of stalling on one delete, and the
	 * report says which of the two just happened (`complete`).
	 *
	 * A failed prune does not fail the cycle. Indexing is what the tab is for, and
	 * a delete that could not run is a store that stayed larger than it asked to be
	 * -- worth saying out loud, and not worth stopping for.
	 */
	async function pruneScheduled(): Promise<void> {
		if (!indexer) {
			return;
		}
		// A SET, because two generations may legitimately fold into one store (a
		// caller's `createState` that hands back the object it captured, which is what
		// a hot reload wants), and pruning it twice in one cycle would spend the
		// budget twice for nothing.
		const states = new Set<WritableStateStore>();
		for (const held of indexer.generations) {
			const state = statesByGeneration.get(generationKey(held.record));
			if (state) {
				states.add(state);
			}
		}
		for (const state of states) {
			try {
				const report = await state.prune({maxVersions: scheduledPruneBudget});
				if (!report.complete) {
					// The one thing the report decides here is whether this is worth saying:
					// a pass that spent its whole budget and left more below the floor is a
					// store still converging, which looks identical from outside to a store
					// that is not being pruned at all. It is not an error and nothing waits on
					// it: the next cycle continues from where this one stopped.
					namedLogger.info(
						`pruned ${report.versionsDeleted} versions at or below block ${report.floor}, and the budget of ` +
							`${scheduledPruneBudget} stopped the pass before the store reached its floor. The next cycle ` +
							`continues.`,
					);
				}
			} catch (err) {
				if (isStoreWriterChanged(err)) {
					// NOT a failed prune: the store is saying this writer no longer holds it, and
					// a delete against a floor computed from a tip somebody else is moving is
					// exactly what it must not do. Raised rather than logged, so the one refusal
					// handler demotes -- swallowing it here would leave a tab that had learnt it
					// lost and carried on indexing until its next write said so again.
					throw err;
				}
				namedLogger.error(`failed to prune the state of a generation this indexer holds`, err);
			}
		}
	}

	/**
	 * STOP BEING A WRITER, and publish that.
	 *
	 * The mechanism is `demoteToReader` (`./demotion.ts`) and none of it is here:
	 * this names WHAT this hook's writer is made of -- the loop to stop, the cursor
	 * to drop, the stores to narrow -- and publishes the result where an app already
	 * subscribes. The refusal handler and the caller-driven `demoteToReader()` verb
	 * both come through here, so there is one code path and one published outcome
	 * whichever way this tab learnt that it lost.
	 *
	 * Demoting twice is the first demotion: the second reason would overwrite a true
	 * report with a later one (a lease released AFTER a write was refused is the
	 * ordinary order), and nothing is left to stop.
	 */
	function demote(reason: DemotionReason): Demotion {
		if (demotion) {
			return demotion;
		}
		demotion = demoteToReader(
			{
				stopFolding() {
					stopAutoIndexing();
					// unconditionally, exactly as `dispose` does: a tick may have armed one
					// between the stop and here.
					if (indexingTimeout) {
						clearTimeout(indexingTimeout);
						indexingTimeout = undefined;
					}
					// EVERY generation, which is what this verb already means on the container:
					// the claim that was taken is the STORAGE's, and the shipped pattern folds
					// every generation into one store.
					indexer?.disableProcessing();
				},
				forgetCursor() {
					// `checkTxInclusion` answers from this window and `setupIndexing` gates on
					// it; both would be reasoning about a store this tab no longer moves.
					setSyncing({lastSync: undefined});
				},
				stores: () => statesByGeneration.values(),
			},
			reason,
		);
		// The transient flags go with it: nothing is loading, fetching or catching up any
		// more, and leaving one standing would leave a spinner on screen for ever.
		setSyncing({
			demotion,
			loading: false,
			fetchingLogs: false,
			processingFetchedLogs: false,
			catchingUp: false,
		});
		// `Idle` for the reason a refused stream seed leaves it there: the PHASE says
		// what is happening, and nothing is. WHAT happened is `syncing.demotion`.
		setStatus({state: 'Idle'});
		return demotion;
	}

	/**
	 * Run one step of the indexing loop AS A WRITER, and demote instead of throwing
	 * where the store refused this one.
	 *
	 * Every driver goes through here, because the refusal can surface from any step
	 * that writes -- `load()` re-folds, an empty cycle still writes the cursor -- and
	 * a driver that recognised it in one place and retried it in another would spin
	 * against a store that will never accept it again. `undefined` means DEMOTED and
	 * means nothing else: every other failure is thrown, exactly as before.
	 */
	async function whileWriting<T>(step: () => Promise<T>): Promise<T | undefined> {
		if (demotion) {
			return undefined;
		}
		try {
			return await step();
		} catch (err) {
			if (!isStoreWriterChanged(err)) {
				throw err;
			}
			demote('write-refused');
			return undefined;
		}
	}

	async function indexMore(): Promise<LastSync<ABI> | undefined> {
		return whileWriting(async () => {
			await setupIndexing();
			return advanceOnce();
		});
	}

	async function indexMoreAndCatchupIfNeeded(): Promise<LastSync<ABI> | undefined> {
		const lastSync = await whileWriting(async () => {
			await setupIndexing();
			if (!indexer) {
				throw new Error(`no indexer`);
			}
			return advanceOnce();
		});

		if (!lastSync) {
			return undefined;
		}

		// THE CANONICAL CURSOR, deliberately, and NOT the container-wide rule in
		// `host/pacing.ts`. The two ask different questions and only look alike: pacing
		// asks "is there work to do" (over every generation, so a successor rebuilding
		// is work), while this asks "is the state a caller READS current" -- which is
		// the canonical generation and nothing else. Widening it would make a caller
		// awaiting this wait out a successor's entire rebuild for a state it can
		// already read.
		if (lastSync.lastToBlock !== lastSync.latestBlock) {
			return indexToLatest();
		}

		return lastSync;
	}

	function setCatchup(lastSync: LastSync<ABI>) {
		if (lastSync.latestBlock - lastSync.lastToBlock > (options?.catchupThreshold || 20)) {
			if (!$syncing.catchingUp) {
				setSyncing({catchingUp: true});
				setStatus({state: 'CatchingUp'});
			}
		} else {
			if ($syncing.catchingUp) {
				setSyncing({catchingUp: false});
				setStatus({state: 'IndexingLatest'});
			}
		}
	}

	/**
	 * Index to the tip, retrying a TRANSIENT failure on a timer -- and stopping on
	 * everything else.
	 *
	 * The distinction is the whole reason `whileWriting` exists here: this loop
	 * swallows failures and comes back a second later, which is right for a rate
	 * limit and catastrophic for a refusal that will be repeated for ever.
	 *
	 * There are two kinds of "else" and they leave by different doors. A DEMOTED run
	 * answers `undefined` and returns; `syncing.demotion` says why. A NON-RETRYABLE
	 * refusal (`isRetryable`, read structurally off the error) is re-thrown to the
	 * caller, because it is neither transient nor a lost race: the store is telling
	 * this writer that the write itself is wrong -- a height the tip has passed, a
	 * block already recorded -- and a store does not move on its own, so the same
	 * offer is refused identically for ever. Swallowing it here is what turned a
	 * permanent refusal into a silent infinite re-fetch.
	 */
	async function indexToLatest(): Promise<LastSync<ABI> | undefined> {
		let lastSync: LastSync<ABI> | undefined;

		try {
			lastSync = await whileWriting(async () => {
				const loaded = await setupIndexing();
				setLastSync(loaded);
				setCatchup(loaded);
				if (!indexer) {
					throw new Error(`no indexer`);
				}
				return advanceOnce();
			});
		} catch (err) {
			if (!isRetryable(err)) {
				throw err;
			}
			return new Promise((resolve) => {
				setTimeout(async () => {
					const result = await indexToLatest();
					resolve(result);
				}, 1000);
			});
		}

		if (!lastSync) {
			// demoted, here or before this call: there is no cursor to answer with and
			// nothing to wait for.
			return undefined;
		}

		// Canonical-scoped for the reason given in `indexMoreAndCatchupIfNeeded`: this
		// verb's promise is "the state you read is current", so it is finished when the
		// generation answering reads is level. Each `advanceOnce` still advances EVERY
		// generation, so a successor catches up alongside; it is simply not what this
		// loop waits for.
		while (lastSync.lastToBlock !== lastSync.latestBlock) {
			try {
				const advanced = await whileWriting(() => advanceOnce());
				if (!advanced) {
					return undefined;
				}
				lastSync = advanced;
			} catch (err) {
				if (!isRetryable(err)) {
					throw err;
				}
				await new Promise((resolve) => {
					setTimeout(resolve, 1000);
				});
			}
		}

		return lastSync;
	}

	async function startAutoIndexing(intervalInSeconds = 4): Promise<boolean> {
		autoIndexingInterval = intervalInSeconds;
		// A demoted tab does not start indexing again on being asked to: it becomes a
		// writer again by CLAIMING again (a new store, a new `init`), and a loop started
		// here would fetch a chain in order to be refused by every write it made.
		if (!(await whileWriting(() => setupIndexing()))) {
			return false;
		}
		if (!$syncing.autoIndexing) {
			// A NEW ATTEMPT CLEARS THE OLD REFUSAL, exactly as the worker host's
			// `startIndexing` does (`host/serve.ts`): `hostFailure` describes the loop that
			// STOPPED, and it was only ever cleared on dispose, so a restarted loop reported
			// a moving phase with a stale failure still attached to it.
			hostFailure = undefined;
			_auto_index();
			return true;
		} else {
			return false;
		}
	}

	/**
	 * BRING THE NEXT CYCLE FORWARD, for a loop that is resting between cycles.
	 *
	 * Only ever shortens a wait: it does nothing when the loop is not running, and
	 * nothing when a cycle is already in flight (that cycle re-arms on its own when
	 * it lands, and it will see whatever was just added). So it cannot make two
	 * cycles overlap.
	 */
	function kickAutoIndexing(): void {
		if (!$syncing.autoIndexing) return;
		if (indexingTimeout === undefined) return;
		clearTimeout(indexingTimeout);
		indexingTimeout = setTimeout(_auto_index, 1);
	}

	function stopAutoIndexing(): boolean {
		if ($syncing.autoIndexing) {
			if (indexingTimeout) {
				clearTimeout(indexingTimeout);
			}
			setSyncing({
				autoIndexing: false,
			});
			publishToPort();
			return true;
		} else {
			return false;
		}
	}

	/**
	 * Throw the computed state away and rebuild it from the start block.
	 *
	 * A one-line delegation, because the CONTAINER publishes the discard
	 * (`Indexer.publishDiscard`, `@etherfold/core`): `reset` IS a discard, and the
	 * copy this hook holds goes at the same moment the fold's does, through the
	 * ordinary state notification. This hook used to fill that silence itself, back
	 * when it could be handed one already-built processor and there was no container
	 * underneath to know.
	 */
	function reset() {
		if (!indexer) {
			throw new Error(`no indexer`);
		}
		return indexer.reset();
	}

	// Tear down the indexer-state so it can be safely dropped (e.g. SPA navigation / component
	// unmount). It:
	//  1. stops the auto-index loop and clears any armed timer (otherwise the self-re-arming
	//     `setTimeout(_auto_index, ...)` keeps firing forever, holding the closure alive);
	//  2. detaches the indexer callbacks (onLoad/onLastSyncUpdated/onStateUpdated) which close over
	//     the stores, so the stores become unreachable;
	//  3. drops the indexer reference and resets the browser-layer syncing/status state.
	// It is idempotent (safe to call more than once). After dispose(), `init(...)` may be called
	// again to re-initialise — note this opens a NEW container and calls the generation factories
	// again, so how much is a fresh start is the caller's: a `createState` that hands back a store
	// it captured (which is what a hot reload wants) reuses that store and whatever it holds.
	function dispose() {
		// 1. stop auto-indexing and unconditionally clear the timer (a tick may have armed it).
		stopAutoIndexing();
		if (indexingTimeout) {
			clearTimeout(indexingTimeout);
			indexingTimeout = undefined;
		}

		// 2. detach callbacks that close over the stores.
		if (indexer) {
			indexer.onLoad = undefined;
			indexer.onLastSyncUpdated = undefined;
			indexer.onStateUpdated = undefined;
			indexer.onPromoted = undefined;
		}

		// 3. drop the indexer reference and reset browser-layer state so a later init() starts clean.
		indexer = undefined;
		// The port's view goes back to where it started, and a read that was waiting for
		// a store this container will now never build is REJECTED rather than left
		// hanging. A wire is NOT closed here: a port belongs to whoever obtained it, and
		// a later `init` builds a container this same wire goes on answering from.
		refuseFirstState(
			new Error(`this indexer was disposed, so it holds no store to read from. Call init(...) to build one again.`),
		);
		expectFirstState();
		hostFailure = undefined;
		processorConfigUsed = undefined;
		hostPhase = 'waiting';
		// A DEMOTION does not survive this, and that is the only way back: a later
		// `init` calls the factories again, and a writer becomes one again by CLAIMING
		// again (ADR-0077). A `createState` that hands back the store this one LOST is
		// refused again on its first write, and demotes again -- which is correct: a
		// backend never re-mints a claim it has committed (ADR-0075), so re-indexing
		// means a new store.
		demotion = undefined;
		// The stores go with it: a later `init` calls the factories again, and holding
		// the previous container's states here would keep pruning them (and keep them
		// reachable) long after nothing is indexing into them.
		statesByGeneration.clear();
		setSyncing({
			waitingForProvider: true,
			loading: false,
			autoIndexing: false,
			catchingUp: false,
			fetchingLogs: false,
			processingFetchedLogs: false,
			lastSync: undefined,
			error: undefined,
			demotion: undefined,
			nonCanonicalGenerations: [],
			// The install this hook reports is the one IT ran, at `init`. A later `init`
			// runs its own (or none), so carrying the previous one across a dispose would
			// report a stream a second container may never have been pointed at.
			streamSeed: undefined,
		});
		setStatus({state: 'Idle'});
		publishToPort();
	}

	/**
	 * Does the state in `$state` already account for these transactions?
	 *
	 * The reconciliation an app needs before it lays an optimistic update over
	 * indexed state: applied twice, a non-idempotent update (a counter, a balance,
	 * an append) is wrong. See `checkTxInclusion` in `@etherfold/core` for what the
	 * verdicts mean, why the caller's own receipt cannot answer this, and what it
	 * cannot tell you.
	 *
	 * Answered against the CURRENT cursor and the indexer's own configured finality
	 * depth, so a caller never has to keep a second copy of either. The pairing with
	 * `$state` is close but not transactional: the core writes the state through the
	 * processor BEFORE it publishes the cursor, and this hook then sets `syncing`
	 * before `state`, so within one synchronous update the cursor can be one
	 * statement ahead of the `state` store and never behind. That direction is the
	 * safe one -- an overlay dropped a moment early flickers, one dropped late is
	 * counted twice -- and a subscriber that reads both after the update sees them
	 * agree.
	 */
	function checkTxInclusion(queries: readonly TxInclusionQuery[]): Record<string, TxInclusionVerdict> {
		return checkTxInclusionAgainst($syncing.lastSync, queries, indexer ? indexer.finalityDepth : 0);
	}

	/**
	 * ONE TURN OF THE AUTO-INDEX LOOP, held so a STOP can wait for it to LAND.
	 *
	 * The promise is what makes `IndexerPort.stopIndexing` honest on this shape: a
	 * caller that has been answered knows no further chain request will be made and
	 * that the cursor is where a completed cycle would have left it. `stopAutoIndexing`
	 * keeps its own synchronous shape -- it clears a timer, which is what an app that
	 * drives the loop by hand asks for -- so this is beside it rather than inside it.
	 */
	function _auto_index(): void {
		cycling = _auto_index_cycle().finally(() => {
			cycling = undefined;
		});
	}

	async function _auto_index_cycle() {
		setSyncing({autoIndexing: true});
		publishToPort();
		try {
			const cursorsBefore = cursorsOf(indexer);
			const lastSync = await indexMoreAndCatchupIfNeeded();
			if (!lastSync) {
				// DEMOTED. The loop is not re-armed: this tab reads from here on, and
				// `demote` has already stopped it, dropped the cursor and said so. Re-arming
				// would fetch a chain every four seconds in order to be refused by every
				// write it made.
				return;
			}
			// STOPPED WHILE THIS CYCLE WAS IN FLIGHT, so it is not re-armed.
			//
			// `stopAutoIndexing` clears the timer that would have started the NEXT cycle,
			// which is the whole of a stop when the loop is resting -- but a stop that
			// arrives mid-cycle has no timer to clear, and re-arming here would restart the
			// loop a caller had just switched off. That was invisible while nothing waited
			// on a stop; `IndexerPort.stopIndexing` promises that no chain request is made
			// after it answers, and this is what makes the promise true on this shape.
			if (!$syncing.autoIndexing) {
				return;
			}
			// THE REST DECISION, taken in `host/pacing.ts` so that this loop and the worker
			// host's cannot disagree about it. What stays here is the part that is
			// genuinely this driver's: the rest is a re-armed TIMER rather than an awaited
			// promise, which is why `kickAutoIndexing` exists to bring it forward.
			if (pacingAfterCycle(indexer, cursorsBefore).rest) {
				// everything this container holds is level (or nothing moved): let's wait
				indexingTimeout = setTimeout(_auto_index, autoIndexingInterval * 1000);
			} else {
				// something is still short of its tip and the last cycle advanced it, so
				// let's sync quickly again
				indexingTimeout = setTimeout(_auto_index, 1);
			}
		} catch (err) {
			if (!isRetryable(err)) {
				// NOT RE-ARMED, and this is the one branch that must not be a retry.
				//
				// The error says waiting cannot help: the store refused this write because
				// the write is wrong about the store (a height its tip has passed, a block
				// already recorded), and a store does not move on its own. Re-arming here
				// re-fetches the whole range from the node every cycle in order to be
				// refused identically, for ever, with the cursor pinned where it was --
				// work that is invisible because each attempt merely fails again.
				//
				// It is deliberately NOT a demotion: that means "you lost a race, become a
				// reader", while this means "the caller is wrong, revert first or stop".
				// Both stop the loop, and an app must be able to tell them apart, so this
				// one leaves `syncing.demotion` alone and reports through `syncing.error`.
				namedLogger.error(
					`STOPPED auto-indexing: the store refused a write and waiting cannot change that, so the loop is not ` +
						`re-armed. Fix what is being offered (a reorged height must be REVERTED before its replacement is ` +
						`applied) and start indexing again.`,
					err,
				);
				setSyncing({
					autoIndexing: false,
					error: {message: (err as Error)?.message ?? String(err), id: 'WriteRefused'},
				});
				// A host that merely stopped reporting is indistinguishable from a slow one
				// (ADR-0082), so a tab holding a port is told WHY rather than left to infer it
				// from a number that stopped moving.
				hostFailure = portErrorOf(err);
				enterHostPhase('refused');
				return;
			}
			// Not re-armed either where a stop landed while the failing cycle was in
			// flight: a transient failure is worth retrying, and a caller that switched
			// indexing off is not asking for one.
			if (!$syncing.autoIndexing) {
				return;
			}
			namedLogger.error('ERROR, retry in 1 seconds', err);
			indexingTimeout = setTimeout(_auto_index, autoIndexingInterval * 1000);
			return;
		}
	}

	// -------------------------------------------------------------------------
	// THE MAIN-THREAD HOST (ADR-0082): the same nine questions every shape answers.
	// -------------------------------------------------------------------------

	/**
	 * WHERE THE FOLD HAS GOT TO, in the vocabulary the port carries.
	 *
	 * A TRANSLATION of what this hook already holds and never a second source of
	 * truth: the cursor is `syncing.lastSync`, the derived figures come from the same
	 * `derivedProgress` a worker host uses (so an app moving between shapes binds the
	 * same names to the same meanings), and `scope` is MEASURED rather than declared,
	 * which is what lets a test assert that the UI thread IS doing the fold here.
	 */
	function hostProgress(): HostProgress {
		const lastSync = $syncing.lastSync;
		return {
			host: 'main-thread',
			scope: executionScopeName(),
			// The DRIVER, which on this shape is the auto-index loop. An app driving
			// `indexMore()` by hand is not "indexing" in the sense a port means: nothing is
			// advancing the fold on its own.
			indexing: $syncing.autoIndexing,
			phase: hostPhase,
			...(lastSync ? {lastToBlock: lastSync.lastToBlock, latestBlock: lastSync.latestBlock} : {}),
			...(lastSync ? derivedProgress(lastSync, indexer?.defaultFromBlock ?? 0) : {}),
			...(hostFailure ? {failure: hostFailure} : {}),
		};
	}

	/**
	 * THE STORE A READ IS ANSWERED FROM: the one the CANONICAL generation folds
	 * into.
	 *
	 * Resolved per read rather than captured once, because the pointer moves: a
	 * promotion makes another generation the one that answers, and a read served from
	 * the retired one would be answering from a fold nobody is advancing. The
	 * `StateStore` narrowing is what the port is handed -- this hook holds the
	 * writable handle and nothing that crosses can reach the mutating half.
	 */
	async function storeForReads(): Promise<StateStore> {
		await firstState;
		const canonical = indexer?.canonical.record;
		const state = canonical && statesByGeneration.get(generationKey(canonical));
		if (!state) {
			throw new Error(
				`this host holds no state for the generation that answers reads, so there is nothing to read from. A ` +
					`generation's store is built by the factory this indexer was given, and the canonical generation's was not.`,
			);
		}
		return state;
	}

	/**
	 * WHAT THIS HOST ANSWERS, as every hosting shape answers it.
	 *
	 * The nine questions of `HostBacking` and nothing else. Everything a tab can
	 * OBSERVE -- the envelope, the case dispatch, the row projection, the refusals and
	 * the push cadence -- is `host/cases.ts`'s and is the same code the worker hosts
	 * run, which is what makes "one implementation, three hosting shapes" a fact about
	 * one module rather than three files that agree (ADR-0082).
	 */
	const hostBacking: HostBacking = {
		progress: hostProgress,
		async startIndexing(): Promise<HostProgress> {
			// The container is what a driver drives, and a tab may ask for one while `init`
			// is still opening it. Awaiting is the same answer a read gets: it is moments
			// away, and an indexer that never opens one rejects with what stopped it rather
			// than leaving the call hanging.
			await firstState;
			await startAutoIndexing(autoIndexingInterval);
			return hostProgress();
		},
		async stopIndexing(): Promise<HostProgress> {
			stopAutoIndexing();
			// AWAITED rather than signalled, which is the whole of the promise this call
			// makes: when it answers, no chain request is in flight and none will be made,
			// and the cursor is where a completed cycle would have left it.
			const running = cycling;
			if (running) await running;
			return hostProgress();
		},
		async reconfigure(source): Promise<HostReconfigure> {
			await firstState;
			// SERIALISED with this hook's own reconfiguring verbs, and not merely with other
			// port calls: building a generation beside the live one and swapping the
			// canonical one's processor are two ways of asking for the same thing, and
			// interleaving them would run one against the other's half-applied state.
			return serializeReconfigure(async () => {
				if (!indexer) {
					throw new Error(`no indexer setup, call init`);
				}
				const open = indexer;
				const before = open.generations.map((generation) => generation.record);
				const held = await open.add({
					// The ABI is NARROWED here and nowhere else, exactly as the worker hosts
					// narrow it: the envelope is not generic, and a tab and its host come out of
					// ONE build.
					source: source as IndexingSource<ABI>,
					...generationSpecFor(spec.createState, spec.createProcessor, processorConfigUsed),
				});
				// A promotion may already have happened (`immediate`), and the generation list
				// an app renders has moved either way.
				reportGenerationProgress();
				publishToPort();
				return {
					generation: hostGenerationOf(held, open),
					added: !before.some((record) => sameGeneration(record, held.record)),
				};
			});
		},
		generations(): readonly HostGeneration[] {
			return indexer ? hostGenerationsOf(indexer) : [];
		},
		async promotion(): Promise<UsedPromotionConfig> {
			await firstState;
			// Nothing is defaulted at this boundary: there is one default everywhere and it
			// lives with the type it belongs to (`CONTEXT.md`, *canonical pointer*).
			return indexer!.promotion;
		},
		checkTxInclusion,
		storeForReads,
	};

	return {
		syncing: {
			subscribe: readableSyncing.subscribe,
			get $state() {
				return readableSyncing.$state;
			},
		},
		state: {
			subscribe: readableState.subscribe,
			get $state() {
				return readableState.$state;
			},
		},
		status: {
			subscribe: readableStatus.subscribe,
			get $state() {
				return readableStatus.$state;
			},
		},
		checkTxInclusion,
		/**
		 * OBTAIN A PORT TO THE INDEXER RUNNING ON THIS THREAD: the MAIN-THREAD
		 * **hosting shape** (ADR-0082).
		 *
		 * ```ts
		 * const indexer = createIndexerState({createState, createProcessor});
		 * await indexer.init({provider, source});
		 * const port = connectToIndexerHost(indexer.mainThreadHost(), {watch: false});
		 * ```
		 *
		 * The third of the three shapes, and the only one that constructs nothing: the
		 * two worker shapes obtain a port by BUILDING a host (`dedicatedWorkerHost`,
		 * `sharedWorkerHost`, each handed the line that constructs a worker), while the
		 * host on this thread is THIS OBJECT and already exists. That asymmetry is the
		 * decision, not an accident: a top-level `mainThreadHost(spec)` would be a second
		 * way to build a main-thread indexer with no rule for choosing between them.
		 *
		 * What crosses is what crosses to a worker, because the wire is a real
		 * `MessageChannel`: the same envelope, the same structured-clone refusals, the
		 * same four reads projected by the same code. What an app writes AGAINST the port
		 * is therefore identical across the three shapes, which is what makes moving the
		 * fold off the UI thread later a change to one line of wiring.
		 *
		 * ## Three things worth knowing before reaching for it
		 *
		 * **The fold is on the UI thread.** That is the cost, and it is why the guide
		 * leads with a dedicated worker.
		 *
		 * **Pass `{watch: false}`.** A host on this thread cannot die independently of the
		 * tab holding the port, so the liveness probe has nothing to find; the access
		 * carries no `reopen` either, so a port that somehow concluded a death would
		 * honestly report `restarting: false`.
		 *
		 * **It may be called more than once**, and each call is its own wire with its own
		 * subscription -- the same thing a SharedWorker does for several tabs. Letting a
		 * port go (`close()`) releases only that wire; the indexer goes on folding,
		 * because it belongs to the app and not to the port. `dispose()` is what stops it.
		 */
		mainThreadHost(): HostAccess {
			const wire = hostOnThisThread(hostBacking, (released) => wires.delete(released));
			wires.add(wire);
			return wire.access;
		},
		init: init as InitFunction<ABI, ProcessorConfig>,
		/**
		 * RECONFIGURE WITHOUT AN OUTAGE: build a generation BESIDE the live one.
		 *
		 * This is what a reconfigure is under the generation model, and it is why one
		 * is not an outage: the new generation folds alongside the canonical one,
		 * which goes on answering every read until the promotion policy moves the
		 * pointer (stories 1 and 3). A generation on the SAME stream -- a processor
		 * change, which is the common case -- fetches not one log: it re-folds the
		 * stream that is already there and then follows it (ADR-0044).
		 *
		 * Distinct from `updateProcessor`, which reconfigures the canonical generation
		 * IN PLACE and therefore still costs the discard-and-rebuild it always did.
		 *
		 * When the pointer moves is the POLICY's (`promotion`), not this call's:
		 * `on-catch-up` (the default everywhere) moves it once the new generation
		 * reaches the cursor the canonical one had, `immediate` moves it here and now,
		 * and `manual` waits for `promote`.
		 */
		addGeneration(
			generation: {
				createState: BrowserGenerationSpec<ABI, ProcessResultType, ProcessorConfig>['createState'];
				createProcessor: BrowserGenerationSpec<ABI, ProcessResultType, ProcessorConfig>['createProcessor'];
			},
			processorConfig?: ProcessorConfig,
		): Promise<HeldGeneration<ABI, ProcessResultType>> {
			if (!indexer) {
				throw new Error(`no indexer setup, call init`);
			}
			// Serialized with the reconfiguring verbs: building a generation and swapping
			// the canonical one's processor are two ways of asking for the same thing, and
			// interleaving them would run one against the other's half-applied state.
			return serializeReconfigure(async () => {
				if (!indexer) {
					throw new Error(`no indexer setup, call init`);
				}
				const held = await indexer.add(
					generationSpecFor(generation.createState, generation.createProcessor, processorConfig),
				);
				// Reported from the moment it EXISTS, before it has folded anything: an app
				// that hides its answers during a rebuild must be able to do so from the
				// reconfigure, not from the first cursor the successor happens to publish.
				// (Under `immediate` the successor is canonical already, so this reports the
				// generation it superseded instead -- which is the same fact, the other way up.)
				reportGenerationProgress();
				// WAKE A RESTING LOOP. The generation just added has a whole history to fold,
				// and the loop is resting precisely BECAUSE everything was level a moment ago.
				// Without this it sits out the remainder of the interval before giving the
				// successor its first cycle -- a rest the app pays for work it has just asked
				// for. The worker host does the same thing through `wakeFromRest`
				// (`src/host/serve.ts`); here the rest IS the timer, so re-arming it now is
				// the whole of it.
				kickAutoIndexing();
				return held;
			});
		},
		/**
		 * MOVE THE CANONICAL POINTER by hand: forwards it promotes, backwards it
		 * REVERTS.
		 *
		 * Never gated by the promotion policy, under any of its values: the policy
		 * decides the move this library makes ON ITS OWN, and `manual` means "only when
		 * asked" rather than "never". The revert is exact and costs no re-index, because
		 * the generation it names was never touched.
		 */
		promote(id: GenerationId): Promise<GenerationRecord> {
			if (!indexer) {
				throw new Error(`no indexer setup, call init`);
			}
			return indexer.promote(id);
		},
		/**
		 * STOP BEING A WRITER: drop the cursor, stop fetching, go on answering reads.
		 *
		 * **It is not the inverse of `promote`.** That moves the canonical POINTER
		 * between generations of this indexer; this drops the WRITE DUTY over the
		 * storage they fold into, and every generation is a reader afterwards.
		 *
		 * The hook calls it for itself when the store refuses a write
		 * (`'write-refused'`), which is a lost race and not an application error. A
		 * caller calls it with `'lease-lost'` when this tab is told another one holds
		 * the write duty -- the one code path for both, which is what leader election
		 * needs of this package (`work/specs/proposed/one-tab-indexes-and-the-others-read.md`)
		 * and the whole of what it needs.
		 *
		 * It is ONE-WAY for this container: a store that lost is never re-claimed
		 * (ADR-0077), so indexing again means `dispose()` and a fresh `init` over a
		 * store built fresh -- which re-reads everything, as it must.
		 */
		demoteToReader(reason: DemotionReason = 'lease-lost'): Demotion {
			return demote(reason);
		},
		/** WHY this tab stopped writing, or `undefined` while it still is one. */
		get demotion(): Demotion | undefined {
			return demotion;
		},
		/** Every generation this indexer holds, in the order it built them. */
		get generations(): readonly HeldGeneration<ABI, ProcessResultType>[] {
			return indexer ? indexer.generations : [];
		},
		/** The generation that answers reads right now. */
		get canonical(): HeldGeneration<ABI, ProcessResultType> | undefined {
			return indexer ? indexer.canonical : undefined;
		},
		/**
		 * The promotion policy in force, resolved.
		 *
		 * Reported rather than re-derived, so "which value is this app running under"
		 * is answered by the container that applies it and not by a second copy of the
		 * default living here. `undefined` before `init`, because the container that
		 * holds it does not exist yet.
		 */
		get promotion(): UsedPromotionConfig | undefined {
			return indexer ? indexer.promotion : undefined;
		},
		indexToLatest,
		indexMore,
		indexMoreAndCatchupIfNeeded,
		startAutoIndexing,
		stopAutoIndexing,
		reset,
		dispose,
		/**
		 * Swap the processor in place.
		 *
		 * It takes the same shape the hook does, so a live-reload that rebuilds a
		 * processor does not have to unwrap it by hand. The core is handed the
		 * `EventProcessor` and decides whether the state survives by comparing VERSION
		 * HASHES -- which are author-declared, so an edited handler under an unchanged
		 * `version` is not a change the core can see, and the swap is SKIPPED rather
		 * than applied. Bump the processor's `version`, or pass `{force: true}`, to
		 * make an edit take effect.
		 *
		 * When the core does discard, `$state` is republished at that moment rather
		 * than left holding the old value until the next event overwrites it -- a wait
		 * that used to be unbounded, since a processor swapped in against a freshly
		 * redeployed contract has nothing to replay. The CONTAINER is what does that
		 * now (`Indexer.publishDiscard`, `@etherfold/core`), so it reaches every
		 * consumer of one and not this hook's subscribers alone.
		 */
		updateProcessor(
			newProcessor: EntityEventProcessorLike<ABI, ProcessResultType, ProcessorConfig>,
			options?: {force?: boolean},
		) {
			if (!indexer) {
				throw new Error(`no indexer setup, call init`);
			}
			// Serialize against any other in-flight reconfigure so overlapping update* calls do not
			// interleave their reset/reinit/load phases.
			return serializeReconfigure(async () => {
				if (!indexer) {
					throw new Error(`no indexer setup, call init`);
				}
				// Pause the auto-index loop so a timer tick cannot race the core reinit
				// (which would throw `Blocked` and trigger noisy retries). Resume after.
				const wasAutoIndexing = $syncing.autoIndexing;
				if (wasAutoIndexing) {
					stopAutoIndexing();
				}
				try {
					const outcome = await indexer.updateProcessor(newProcessor, options);
					// On success only (option b): clear stale syncing state so setupIndexing() re-runs.
					// Must run before resuming auto-indexing so the resumed loop does not early-return
					// on the stale lastSync.
					clearSyncingStateForReconfigure();
					// Forwarded, not swallowed: whether the state survived is the caller's
					// decision to act on too (a hot-reload handler choosing between carrying on
					// and telling the user its data is being rebuilt).
					return outcome;
				} catch (err) {
					setSyncing({error: {message: 'Failed to update processor', id: 'FAILED_TO_UPDATE_PROCESSOR'}});
					throw err;
				} finally {
					if (wasAutoIndexing) {
						await startAutoIndexing(autoIndexingInterval);
					}
				}
			});
		},
		updateIndexer(update: {
			provider?: EIP1193ProviderWithoutEvents;
			source?: IndexingSource<ABI>;
			streamConfig?: ProvidedStreamConfig;
		}) {
			if (!indexer) {
				throw new Error(`no indexer setup, call init`);
			}
			// Serialize against any other in-flight reconfigure so overlapping update* calls do not
			// interleave their reset/reinit/load phases.
			return serializeReconfigure(async () => {
				if (!indexer) {
					throw new Error(`no indexer setup, call init`);
				}
				// Pause the auto-index loop so a timer tick cannot race the core reinit
				// (which would throw `Blocked` and trigger noisy retries). Resume after.
				const wasAutoIndexing = $syncing.autoIndexing;
				if (wasAutoIndexing) {
					stopAutoIndexing();
				}
				try {
					// The container publishes the discard if there was one: a new source at the
					// same address is the redeploy case, and it is the one where the stale copy
					// was most dangerous -- the state on screen was computed from the events of
					// the implementation that is no longer deployed.
					const outcome = await indexer.updateIndexer(update);
					// On success only (option b): clear stale syncing state so setupIndexing() re-runs
					// cleanly for the new source/config instead of early-returning with old progress.
					// Must run before resuming auto-indexing.
					clearSyncingStateForReconfigure();
					return outcome;
				} catch (err) {
					setSyncing({error: {message: 'Failed to update indexer', id: 'FAILED_TO_UPDATE_INDEXER'}});
					throw err;
				} finally {
					if (wasAutoIndexing) {
						await startAutoIndexing(autoIndexingInterval);
					}
				}
			});
		},
		withHooks(react: ReactHooks) {
			const {useReadable} = useStores(react);
			return {
				...this,
				useState: () => useReadable(this.state, false),
				useSyncing: () => useReadable(this.syncing, false),
				useStatus: () => useReadable(this.status, false),
			};
		},
	};
}
