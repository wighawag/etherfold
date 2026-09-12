import type {
	Abi,
	Indexer,
	IndexingSource,
	LastSync,
	PromotionConfig,
	ProvidedIndexerConfig,
	EventProcessor,
	GenerationContext,
	TxInclusionQuery,
	TxInclusionVerdict,
	UsedPromotionConfig,
} from '@etherfold/core';
import {
	checkTxInclusion as checkTxInclusionAgainst,
	isRetryable,
	openIndexer,
	openMemoryGenerationRegistry,
	sameGeneration,
} from '@etherfold/core';
import {type StateStore, type WritableStateStore} from '@etherfold/state-store';
import type {EIP1193ProviderWithoutEvents} from 'eip-1193';
import {logs} from 'named-logs';
import type {BrowserGenerationSpec, EntityEventProcessorLike} from '../IndexerState.js';
import {BROWSER_GENERATION_CAPS} from '../storage/generation/OnIndexedDB.js';
import {derivedProgress, hostGenerationsOf, hostGenerationOf, serveHostCases, type HostBacking} from './cases.js';
import {executionScopeName, type HostAccess} from './endpoint.js';
import {cursorsOf, pacingAfterCycle} from './pacing.js';
import type {HostGeneration, HostProgress, HostReconfigure, SyncPhase} from './envelope.js';
import {portErrorOf, type PortError} from './errors.js';

const namedLogger = logs('@etherfold/browser');

/**
 * THE WORKER HOSTS' DRIVER: it owns a **container**, DRIVES it, and answers a
 * **port** through the shared case body.
 *
 * It knows NOTHING about workers. It is handed a `HostAccess` -- a wire plus the
 * name of the shape that produced it -- and everything a TAB observes is served
 * by `cases.ts`, which every shape reaches (ADR-0082: "three hosting shapes ...
 * differ ONLY in how a port is obtained"). `dedicatedWorker.ts` and
 * `sharedWorker.ts` hold the only CODE in this package that names a worker
 * constructor, and all that code does is produce one of those accesses.
 *
 * ## What it is NOT
 *
 * It is not the MAIN-THREAD host. That one is `createIndexerState`, adapted
 * (ADR-0082, `mainThread.ts`): a tab that hosts its own indexer already has a
 * container, an auto-index loop, a scheduled prune, a stream-seed install,
 * demotion and three reactive stores, and it serves the port from THOSE rather
 * than opening a second container beside them. What the two share is
 * `HostBacking` and everything behind it, which is the whole of what crosses.
 */

/**
 * WHAT AN APP HANDS ITS HOST, wherever the host runs.
 *
 * It is the generation spec `createIndexerState` already takes, PLUS what that
 * function takes at `init` (a provider, a source, a config). The two are one
 * argument here because a host is constructed by an app's own entry point and
 * starts folding immediately: there is no separate moment at which a tab hands a
 * provider over, and there could not be -- a provider is an object with methods,
 * so it cannot cross a port and has to be built where the fold runs.
 */
export type HostedIndexerSpec<ABI extends Abi, ProcessResultType, ProcessorConfig = undefined> = BrowserGenerationSpec<
	ABI,
	ProcessResultType,
	ProcessorConfig
> & {
	/** The chain, built HERE: an EIP-1193 provider is code and cannot cross a port. */
	provider: EIP1193ProviderWithoutEvents;
	source: IndexingSource<ABI>;
	config?: ProvidedIndexerConfig<ABI>;
	/** Passed through and never defaulted here, exactly as `createIndexerState` passes it through. */
	promotion?: PromotionConfig;
	/** The processor's own configuration, where it takes one. */
	processorConfig?: ProcessorConfig;
	/**
	 * How long the driver rests once the fold is AT THE TIP, in seconds. Defaults
	 * to four, which is `createIndexerState`'s auto-index interval.
	 */
	tipIntervalInSeconds?: number;
};

/** What the entry point that obtained the port gets back. */
export type IndexerHost = {
	/** How far the fold has got, as the port reports it. The same value the `progress` case answers. */
	progress(): HostProgress;
	/**
	 * START THE DRIVER. The same call the `startIndexing` case serves, so an entry
	 * point that wants to decide for itself has the verb its tab has.
	 *
	 * Starting a driver that is already running changes nothing and answers where
	 * the fold is. One arriving while a STOP is being honoured waits for that stop
	 * to land and then starts afresh, so the two cannot race into a host that was
	 * asked to index and is not.
	 */
	startIndexing(): Promise<HostProgress>;
	/**
	 * STOP THE DRIVER, resolving once the cycle in flight has LANDED: no chain
	 * request is made after this resolves, and the cursor is where a completed cycle
	 * would have left it.
	 */
	stopIndexing(): Promise<HostProgress>;
	/**
	 * Stop driving and stop answering.
	 *
	 * It does NOT close the endpoint: what owns the wire is whatever obtained it,
	 * and a worker that closed its own scope here would take the port down under a
	 * tab that is still holding it.
	 */
	dispose(): void;
};

/**
 * OPEN A CONTAINER, DRIVE IT, AND ANSWER THE PORT.
 *
 * Returns as soon as it is listening; opening the container and folding are
 * under way by then and their failures are REPORTED through `progress` rather
 * than thrown at a caller that has already been handed its host. That is the
 * same choice the demotion path makes and for the same reason: a tab whose host
 * failed to open must be able to ask why, and an exception raised inside a worker
 * entry point reaches nobody.
 *
 * IT STARTS INDEXING, because a host exists in order to fold and a worker entry
 * point that had to say so twice would be a line every app writes identically.
 * A tab turns it off and on again over the port (`stopIndexing` / `startIndexing`),
 * and stopping the DRIVER never closes the CONTAINER: a stopped host still
 * answers reads from the store its canonical generation folds into.
 *
 * ## It is NOT the way to build a main-thread indexer
 *
 * It is reached from a WORKER entry point (`hostIndexerInThisWorker`,
 * `hostIndexerInThisSharedWorker`, both of which refuse to run in a document),
 * and it is exported so a deployment can write a hosting shape this package does
 * not ship. Calling it on the UI thread with a wire of your own would open a
 * SECOND container beside `createIndexerState`, over the same store, and the
 * first thing anybody would see is a writer being refused (ADR-0075): there is
 * ONE main-thread path and it is that function, adapted (ADR-0082).
 */
export function serveIndexerHost<ABI extends Abi, ProcessResultType, ProcessorConfig = undefined>(
	spec: HostedIndexerSpec<ABI, ProcessResultType, ProcessorConfig>,
	access: HostAccess,
): IndexerHost {
	const scope = executionScopeName();
	const tipInterval = spec.tipIntervalInSeconds ?? 4;
	/** The shared case body, attached below once the backing it serves exists. */
	let served: {publish(): void; stop(): void} | undefined;
	const publish = () => served?.publish();

	let container: Indexer<ABI, ProcessResultType> | undefined;
	let lastSync: LastSync<ABI> | undefined;
	let indexing = false;
	let failure: PortError | undefined;
	/** This host is FINISHED: disposed, and answering nothing ever again. */
	let disposed = false;
	/**
	 * A STOP WAS ASKED FOR, which is a different thing from being disposed: the
	 * container stays open, the store stays readable and the driver can be started
	 * again.
	 *
	 * Read by the driver loop AND by the retry wait, so a stop asked for while a
	 * transient failure is being slept off is honoured then rather than a second
	 * later.
	 */
	let stopRequested = false;
	/** The driver loop, while one is running. `stopIndexing` awaits it, which is what makes a stop honest. */
	let driving: Promise<void> | undefined;
	/** Cut short whatever the driver is RESTING on, so a stop does not wait out a tip interval. */
	let wakeFromRest: (() => void) | undefined;
	/** The container, opened ONCE and held open across a stop. See `openContainer`. */
	let opening: Promise<Indexer<ABI, ProcessResultType>> | undefined;
	/** The reconfigures, run one after another in arrival order. See `reconfigure`. */
	let reconfiguring: Promise<unknown> = Promise.resolve();
	/**
	 * Nothing has been asked of the chain yet. It is the same starting claim
	 * `createIndexerState` publishes as `waitingForProvider: true`, and it is
	 * cleared at the same moment: when the container is open.
	 */
	let phase: SyncPhase = 'waiting';

	/**
	 * WHICH STORE EACH GENERATION FOLDS INTO, so a read is answered by the
	 * generation that is ANSWERING READS.
	 *
	 * Recorded here for the same reason `createIndexerState` records it: a
	 * generation's state is the caller's own object, built by the caller's own
	 * factory, and this is the one place that CALLED that factory. A host holds
	 * several of them as soon as a tab RECONFIGURES, so resolving the CANONICAL one
	 * per read is what stops a tab being answered from a generation the pointer has
	 * moved off -- which is the staleness the container's own indirect handle exists
	 * to prevent.
	 */
	const statesByGeneration = new Map<string, WritableStateStore>();
	const generationKey = (id: {stream: string; processor: string}) => `${id.stream}/${id.processor}`;
	/**
	 * The FIRST state built for a generation wins, exactly as the container resolves
	 * a generation it already holds rather than adding a second engine over it.
	 *
	 * Shared by the boot generation and by every one a RECONFIGURE adds, so a read
	 * answered from a promoted generation is answered from the store that
	 * generation's own factory built.
	 */
	const recordState = (id: {stream: string; processor: string}, state: WritableStateStore) => {
		const key = generationKey(id);
		if (!statesByGeneration.has(key)) statesByGeneration.set(key, state);
	};

	/**
	 * A READ MAY ARRIVE BEFORE THE FIRST STORE EXISTS, and waits rather than being
	 * refused.
	 *
	 * The host returns as soon as it is LISTENING, and opening the container is
	 * under way by then, so a tab that connects and reads immediately would
	 * otherwise race the open. Waiting is the honest answer to "read me the rows":
	 * the store is moments away. What must never happen is waiting FOREVER, so a
	 * host that stops before it ever built one rejects this with the failure that
	 * stopped it -- a hung promise is the worst available outcome (ADR-0082).
	 */
	let announceFirstState: (() => void) | undefined;
	let refuseFirstState: ((error: unknown) => void) | undefined;
	const firstState = new Promise<void>((resolve, reject) => {
		announceFirstState = resolve;
		refuseFirstState = reject;
	});
	// Nobody may ever read, and a promise that rejects with no handler is a warning
	// in every runtime this ships to.
	firstState.catch(() => undefined);

	/**
	 * REST, unless something asks the driver to stop first.
	 *
	 * The two places a driver waits -- the tip interval and the pause between
	 * retries -- are the two places a stop would otherwise take seconds to be
	 * honoured, for no reason: nothing is in flight during either, so there is
	 * nothing to let land.
	 */
	function rest(seconds: number): Promise<void> {
		return new Promise<void>((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				wakeFromRest = undefined;
				resolve();
			};
			const timer = setTimeout(finish, seconds * 1000);
			wakeFromRest = finish;
		});
	}

	function progress(): HostProgress {
		return {
			host: access.host,
			scope,
			indexing,
			phase,
			...(lastSync ? {lastToBlock: lastSync.lastToBlock, latestBlock: lastSync.latestBlock} : {}),
			...(lastSync ? derivedProgress(lastSync, foldStartsAt()) : {}),
			...(failure ? {failure} : {}),
		};
	}

	/**
	 * WHICH BLOCK THIS FOLD STARTS AT, which is the origin every derived figure is
	 * measured from.
	 *
	 * Read from the container per report rather than captured, for the reason the
	 * read store is: a reconfigure moves it, and a percentage measured from the
	 * block the PREVIOUS source started at is wrong in a way nothing on screen
	 * would reveal. It is only ever asked for once a cursor exists, and a cursor is
	 * the canonical generation's own, so there is a current generation to ask.
	 */
	function foldStartsAt(): number {
		return container?.defaultFromBlock ?? 0;
	}

	/** Move the phase and say so. A move to the phase it is already in posts nothing. */
	function enter(next: SyncPhase): void {
		phase = next;
		publish();
	}

	/**
	 * THE STORE A READ IS ANSWERED FROM: the one the CANONICAL generation folds
	 * into.
	 *
	 * Resolved per read rather than captured once, because the pointer moves: a
	 * promotion makes another generation the one that answers, and a read served
	 * from the retired one would be answering from a fold nobody is advancing. The
	 * `StateStore` narrowing is what the port hands the read path -- the host holds
	 * the writable handle and nothing here can reach the mutating half.
	 */
	async function storeForReads(): Promise<StateStore> {
		await firstState;
		const canonical = container?.canonical.record;
		const state = canonical && statesByGeneration.get(generationKey(canonical));
		if (!state) {
			throw new Error(
				`this host holds no state for the generation that answers reads, so there is nothing to read from. A ` +
					`generation's store is built by the factory this host was given, and the canonical generation's was not.`,
			);
		}
		return state;
	}

	/**
	 * Retry what waiting can fix, and stop on what it cannot.
	 *
	 * The same distinction `createIndexerState`'s loop draws (`isRetryable`): a
	 * rate limit is transient, while a store refusing the write it is being
	 * offered is a refusal a store does not change its mind about, and retrying
	 * that one re-fetches a chain for ever in order to be refused identically.
	 */
	async function withRetries<T>(step: () => Promise<T>): Promise<T | undefined> {
		while (!disposed && !stopRequested) {
			try {
				return await step();
			} catch (error) {
				if (!isRetryable(error)) throw error;
				namedLogger.error(`the indexer host hit a transient failure; retrying in a second`, error);
				await rest(1);
			}
		}
		return undefined;
	}

	/**
	 * OPEN THE CONTAINER, ONCE, whether or not a driver is running.
	 *
	 * Opening is not indexing, and the two are separated for the reason a STOPPED
	 * host still answers: what a tab reads from is the store the canonical
	 * generation folds into, and a host that closed its container when a settings
	 * screen switched indexing off would take the app's data down with the fold.
	 * So the container opens once and stays open until the host is DISPOSED, and
	 * start/stop move the DRIVER over it.
	 *
	 * Memoised on the promise rather than on the value, so a `startIndexing` racing
	 * the opening one cannot open a second container over the same store.
	 */
	function openContainer(): Promise<Indexer<ABI, ProcessResultType>> {
		opening ??= (async () => {
			const opened = await openIndexer<ABI, ProcessResultType>({
				registry: spec.registry ?? (await openMemoryGenerationRegistry(BROWSER_GENERATION_CAPS)),
				provider: spec.provider,
				source: spec.source,
				config: spec.config ?? {},
				...(spec.promotion ? {promotion: spec.promotion} : {}),
				generations: [generationSpecOf(spec, recordState)],
			});
			container = opened;
			// The container is open, so the generation it was given has been built and
			// its state is recorded: a read that was waiting can be answered.
			announceFirstState?.();
			// The chain answered, so this host is no longer WAITING on a provider -- the
			// same moment `createIndexerState` clears `waitingForProvider`.
			enter('loading');
			opened.onLastSyncUpdated = (updated) => {
				// THE PUSH CADENCE, and the whole of it: the container publishes a cursor
				// per APPLIED BATCH, so a batch that landed is a push and nothing else is.
				lastSync = updated;
				publish();
			};
			opened.onPromoted = () => {
				// THE POINTER MOVED, so the cursor this host was reporting belongs to a
				// generation that no longer answers anything. Dropped rather than kept, for
				// the reason `createIndexerState` drops it: a figure derived from the retired
				// fold would describe a fold nobody is reading from. The container publishes
				// the new canonical generation's own cursor immediately after this, where it
				// has one -- and where it has none (an `immediate` promotion is canonical
				// before it has caught up) reporting nothing is the honest answer.
				lastSync = undefined;
				publish();
			};
			return opened;
		})();
		return opening;
	}

	/** THE DRIVER: load, then advance until something stops it. */
	async function drive(): Promise<void> {
		try {
			const opened = await openContainer();
			if (disposed || stopRequested) return;

			const loaded = await withRetries(() => opened.load());
			if (loaded) lastSync = loaded;
			// Loaded, and BEHIND BY AN UNKNOWN AMOUNT: no advance has answered yet, so
			// the cursor's own numbers may still be the `0` of `0` a container publishes
			// before it has fetched. Only an advance can say `at-tip`.
			enter('catching-up');

			while (!disposed && !stopRequested) {
				const before = cursorsOf(opened);
				const advanced = await withRetries(() => opened.indexMore());
				if (!advanced) return;
				lastSync = advanced;
				// The phase and the rest are ONE decision, taken in `pacing.ts` so that this
				// driver and the main-thread one cannot answer it differently. What is left
				// here is the part that is genuinely this driver's: a rest it can be WOKEN
				// from, which is how a reconfigure starts its successor at once instead of
				// paying out the remainder of an interval.
				const {phase, rest: shouldRest} = pacingAfterCycle(opened, before);
				enter(phase);
				if (shouldRest) {
					// An advance straight away would be an `eth_blockNumber` per turn of the
					// event loop against a provider a browser user is rate-limited on.
					await rest(tipInterval);
				}
			}
		} catch (error) {
			failure = portErrorOf(error);
			phase = 'refused';
			// A read waiting for a store that will now never exist is answered with what
			// stopped the host, rather than left hanging.
			refuseFirstState?.(error);
			namedLogger.error(`the indexer host STOPPED: nothing waiting can fix what it was refused`, error);
		} finally {
			indexing = false;
			driving = undefined;
			// A subscriber is TOLD the driver stopped, on every way out. Silence is the
			// one thing a stalled host and a slow one look identical in (ADR-0082).
			publish();
		}
	}

	/**
	 * START THE DRIVER, and say where the fold is.
	 *
	 * A host that is already indexing is LEFT INDEXING and answers: this names a
	 * state a caller wants the host to be in, not an edge it fires, so asking twice
	 * is asking for what is already true. A DISPOSED host is refused, because there
	 * is nothing left to start -- it has stopped listening and released its
	 * container's callbacks.
	 */
	async function startIndexing(): Promise<HostProgress> {
		if (disposed) {
			throw new Error(
				`this indexer host was disposed, so there is nothing left to start. Build a host again to index again.`,
			);
		}
		if (stopRequested && driving) {
			// A STOP IS BEING HONOURED, so this waits for it to land and then starts
			// afresh. Without the wait the two would race: the stopping loop would
			// unwind after this call had decided there was already one running, and a
			// host that was asked to index would sit there not indexing.
			await driving;
		}
		if (driving) return progress();
		stopRequested = false;
		// A NEW ATTEMPT CLEARS THE OLD REFUSAL. `failure` describes the drive that
		// STOPPED, so carrying it into the next one hands a tab `phase: 'at-tip'` with a
		// stale failure attached, and an app renders an error over a fold that is running.
		// The phase moves on when the driver does; this has to move with it, because the
		// two are read together and only one of them was being reset.
		failure = undefined;
		indexing = true;
		publish();
		driving = drive();
		return progress();
	}

	/**
	 * STOP THE DRIVER, once the cycle in flight has LANDED.
	 *
	 * It AWAITS the loop rather than signalling it, and that await is the whole of
	 * the promise this call makes: when it answers, no chain request is in flight
	 * and none will be made. A cycle is never cut in half, so the cursor is where a
	 * completed cycle would have left it -- which is what lets a stopped indexer
	 * resume without re-indexing and without skipping (ADR-0027 writes the cursor in
	 * the same transaction as the block it describes, so there is no window where
	 * the two disagree).
	 *
	 * Stopping a host that is not indexing is an ANSWER, not a refusal, on the same
	 * ground as starting a started one.
	 */
	async function stopIndexing(): Promise<HostProgress> {
		stopRequested = true;
		// Nothing is in flight while the driver rests, so a stop asked for during a tip
		// interval is honoured now rather than at the end of it.
		wakeFromRest?.();
		const running = driving;
		if (running) await running;
		indexing = false;
		publish();
		return progress();
	}

	/**
	 * RECONFIGURE: fold the new source in a generation BESIDE the live one.
	 *
	 * The generation machinery does the whole of it and this is the ASK reaching it
	 * from a tab: `Indexer.add` builds the generation on the source it is given,
	 * registers it, and applies the promotion policy -- so the canonical generation
	 * goes on answering every read until the new fold is ready, and a source that
	 * hashes to a generation already held RESOLVES to it instead of putting a second
	 * engine over one state.
	 *
	 * SERIALISED against other reconfigures for the reason `createIndexerState`
	 * serialises its own: two of them in flight would each decide against a
	 * generation set the other is changing, and the cap that refuses the second one
	 * is counted over that set. It is NOT serialised against the driver, which is
	 * the container's own business: a generation added mid-cycle is picked up by the
	 * next one, because `indexMore` iterates a copy.
	 */
	async function reconfigure(source: IndexingSource<ABI>): Promise<HostReconfigure> {
		const run = reconfiguring.then(
			() => reconfigureNow(source),
			() => reconfigureNow(source),
		);
		// The queue survives a refusal: one caller's cap refusal must not poison the
		// next caller's turn.
		reconfiguring = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async function reconfigureNow(source: IndexingSource<ABI>): Promise<HostReconfigure> {
		// A reconfigure needs the container, and a tab may ask for one while the host is
		// still opening. Awaiting it is the same answer a read gets: the container is
		// moments away, and a host that never opens one rejects with what stopped it
		// rather than leaving the call hanging.
		const opened = await openContainer();
		const before = opened.generations.map((generation) => generation.record);
		const held = await opened.add({source, ...generationSpecOf(spec, recordState)});
		// WAKE A RESTING DRIVER. The generation just added has a whole history to fetch,
		// and the driver is resting precisely BECAUSE everything was level a moment ago.
		// Without this it would sit out the remainder of the tip interval before giving
		// the successor its first advance, which on the default four seconds is a rest
		// the app pays for work it has just asked for. The driver re-reads the generation
		// set on its next turn (`indexMore` iterates a copy), so there is nothing to
		// serialise against here.
		wakeFromRest?.();
		// A promotion may already have happened (`immediate`), and the generation list a
		// tab renders has moved either way.
		publish();
		return {
			generation: hostGenerationOf(held, opened),
			added: !before.some((record) => sameGeneration(record, held.record)),
		};
	}

	/**
	 * EVERY GENERATION, as the port reports them: the container's own records and
	 * cursors, with the canonical one marked.
	 *
	 * Read afresh per call rather than accumulated, exactly as
	 * `createIndexerState` derives `nonCanonicalGenerations`: the container already
	 * keeps every generation's cursor (its promotion trigger is a comparison between
	 * two of them), and a copy here would be a second thing to keep true across a
	 * promotion, a revert and a drop.
	 */
	function generations(): readonly HostGeneration[] {
		return container ? hostGenerationsOf(container) : [];
	}

	/**
	 * DOES THE STATE THIS HOST IS FOLDING INTO ALREADY ACCOUNT FOR THESE
	 * TRANSACTIONS?
	 *
	 * The same two arguments `createIndexerState` answers this from, read HERE so
	 * that a tab never has to keep a second copy of either: the cursor this host is
	 * currently reporting, and the finality depth its container actually runs with
	 * (`resolveStreamConfig` fills that one in, so it is not derivable from the
	 * config an app passed). The rule itself is `@etherfold/core`'s and is neither
	 * re-implemented nor adjusted on the way across.
	 *
	 * ## It does not WAIT for the container, and that is the answer rather than a
	 * shortcut
	 *
	 * A read waits for the first store, because "read me the rows" has no honest
	 * answer until there is a store. This question DOES have one: a host that has
	 * not synced anything says `unknown`/`not-synced`, which is a verdict an app
	 * renders (keep the optimistic update; nothing here can tell you otherwise).
	 * Waiting would turn the cheapest true answer into a call that hangs for as long
	 * as a provider takes to respond, and the caller is a UI thread laying out a
	 * pending queue.
	 *
	 * The same reasoning is what makes this honest across a PROMOTION: the cursor is
	 * dropped when the pointer moves (`onPromoted`), so what is answered from is
	 * the window the generation that ANSWERS READS maintains, or nothing at all --
	 * never a window nobody is maintaining any more.
	 */
	function checkTxInclusion(queries: readonly TxInclusionQuery[]): Record<string, TxInclusionVerdict> {
		return checkTxInclusionAgainst(lastSync, queries, container ? container.finalityDepth : 0);
	}

	/**
	 * THE POLICY IN FORCE, from the container that APPLIES it.
	 *
	 * Nothing is defaulted here and nothing may be: there is one default everywhere
	 * and it lives with the type it belongs to, so a value invented at this boundary
	 * would be a second copy of the answer to "which policy is this app running
	 * under" (`CONTEXT.md`, *canonical pointer*). `spec.promotion` is passed through
	 * to the container un-defaulted for the same reason.
	 */
	async function promotion(): Promise<UsedPromotionConfig> {
		return (await openContainer()).promotion;
	}

	/**
	 * WHAT THIS HOST ANSWERS, as every shape's host answers it.
	 *
	 * The nine questions and nothing else: the envelope, the dispatch, the
	 * projections and the push cadence are `cases.ts`'s and are the same code the
	 * main-thread host runs (ADR-0082).
	 */
	const backing: HostBacking = {
		progress,
		startIndexing,
		stopIndexing,
		// The ABI is NARROWED here and nowhere else. The envelope is not generic -- the
		// same reason the rows it carries are not -- and a tab and its host come out of
		// ONE build (see the envelope's note on why there is no protocol version), so
		// the source a tab sends is a source this host's own ABI types were compiled
		// against.
		reconfigure: (source) => reconfigure(source as IndexingSource<ABI>),
		generations,
		promotion,
		checkTxInclusion,
		storeForReads,
	};
	served = serveHostCases(access, backing);

	// Nothing awaits the first start: a host exists in order to fold, and its
	// failures are REPORTED through `progress` rather than thrown at an entry point
	// that has already been handed its host.
	void startIndexing();

	return {
		progress,
		startIndexing,
		stopIndexing,
		dispose() {
			disposed = true;
			stopRequested = true;
			wakeFromRest?.();
			indexing = false;
			refuseFirstState?.(new Error(`this indexer host was disposed, so it holds no store to read from.`));
			served?.stop();
			if (container) {
				container.onLastSyncUpdated = undefined;
				container.onStateUpdated = undefined;
				container.onLoad = undefined;
				container.onPromoted = undefined;
			}
		},
	};
}

/**
 * The two factories as the CONTAINER takes them, with the read handle it answers
 * through.
 *
 * The same translation `createIndexerState` does, minus the bookkeeping that
 * belongs to the surfaces this host does not carry yet (which store each
 * generation folds into, for the scheduled prune). When the last task in this
 * spec makes that function this host, the two become one call.
 */
function generationSpecOf<ABI extends Abi, ProcessResultType, ProcessorConfig>(
	spec: HostedIndexerSpec<ABI, ProcessResultType, ProcessorConfig>,
	recordState: (id: {stream: string; processor: string}, state: WritableStateStore) => void,
) {
	return {
		createState: (context: GenerationContext) => spec.createState(context),
		createProcessor: async (state: unknown, context: GenerationContext) => {
			const built = await spec.createProcessor(state as WritableStateStore, context);
			if (built.configure && spec.processorConfig) {
				built.configure(spec.processorConfig);
			}
			// Recorded HERE and not in `createState`, because this is the first moment
			// both halves of a generation's identity exist: the stream is known up
			// front, the fold's version hash only once the processor is built.
			recordState({stream: context.stream, processor: built.getVersionHash()}, state as WritableStateStore);
			return built;
		},
		stateOf: (built: EventProcessor<ABI, ProcessResultType>) =>
			(built as EntityEventProcessorLike<ABI, ProcessResultType, ProcessorConfig>).state,
	};
}
