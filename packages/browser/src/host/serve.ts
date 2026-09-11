import type {
	Abi,
	Indexer,
	IndexingSource,
	LastSync,
	PromotionConfig,
	ProvidedIndexerConfig,
	EventProcessor,
	GenerationContext,
} from '@etherfold/core';
import {isRetryable, openIndexer, openMemoryGenerationRegistry} from '@etherfold/core';
import {
	declaredRow,
	mustGet,
	type Listing,
	type NormalizedEntity,
	type StateStore,
	type WritableStateStore,
} from '@etherfold/state-store';
import type {EIP1193ProviderWithoutEvents} from 'eip-1193';
import {logs} from 'named-logs';
import type {BrowserGenerationSpec, EntityEventProcessorLike} from '../IndexerState.js';
import {BROWSER_GENERATION_CAPS} from '../storage/generation/OnIndexedDB.js';
import {wait} from '../utils/time.js';
import {assertClonable} from './clone.js';
import {executionScopeName, listen, type HostAccess} from './endpoint.js';
import {
	INDEXER_PORT_PROTOCOL,
	isPortRequest,
	type HostProgress,
	type PortCases,
	type PortPush,
	type PortRequest,
	type PortResponse,
	type PortRow,
	type SyncPhase,
} from './envelope.js';
import {portErrorOf, type PortError} from './errors.js';

const namedLogger = logs('@etherfold/browser');

/**
 * THE HOST: it owns a **container**, DRIVES it, and answers a **port**.
 *
 * This module is the whole of what runs inside a host, and it knows NOTHING
 * about workers. It is handed a `HostAccess` -- a wire plus the name of the shape
 * that produced it -- and everything else is the same code in every shape, which
 * is the decision ADR-0082 exists to protect ("three hosting shapes ... differ
 * ONLY in how a port is obtained"). `dedicatedWorker.ts` holds the only CODE in
 * this package that names `Worker`, and all that code does is produce one of
 * those accesses.
 *
 * ## What it is NOT
 *
 * It is not `createIndexerState`, and it does not reach for it. That function is
 * the MAIN-THREAD host and is large: it holds the store bookkeeping, the
 * scheduled prune, the stream-seed install, generation progress, demotion and
 * three reactive stores an app subscribes to. Bringing all of that across in one
 * go would decide six later tasks by accident. So this takes what a CONTAINER
 * needs -- the two generation factories, a provider, a source, a config -- and
 * drives it, and the surfaces arrive one task at a time. The last task in this
 * spec makes `createIndexerState` this shape rather than a second path beside it,
 * which is why the spec it takes is `BrowserGenerationSpec`, the shape that
 * function already takes, rather than a new one.
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
 */
export function serveIndexerHost<ABI extends Abi, ProcessResultType, ProcessorConfig = undefined>(
	spec: HostedIndexerSpec<ABI, ProcessResultType, ProcessorConfig>,
	access: HostAccess,
): IndexerHost {
	const scope = executionScopeName();
	const tipInterval = spec.tipIntervalInSeconds ?? 4;

	let container: Indexer<ABI, ProcessResultType> | undefined;
	let lastSync: LastSync<ABI> | undefined;
	let indexing = false;
	let failure: PortError | undefined;
	let stopped = false;
	/**
	 * Nothing has been asked of the chain yet. It is the same starting claim
	 * `createIndexerState` publishes as `waitingForProvider: true`, and it is
	 * cleared at the same moment: when the container is open.
	 */
	let phase: SyncPhase = 'waiting';
	/**
	 * HOW MANY SUBSCRIPTIONS this endpoint holds, so that nothing is posted to a
	 * tab that did not ask and a second listener does not silence the first.
	 *
	 * A COUNT rather than a flag: a tab's port asks once for its first listener and
	 * releases once for its last, but a host answers whoever is on its endpoint and
	 * must not be made incoherent by one that asks twice.
	 */
	let subscriptions = 0;
	/** The last value POSTED, so an unchanged one is not posted again. See `publish`. */
	let published: HostProgress | undefined;

	/**
	 * WHICH STORE EACH GENERATION FOLDS INTO, so a read is answered by the
	 * generation that is ANSWERING READS.
	 *
	 * Recorded here for the same reason `createIndexerState` records it: a
	 * generation's state is the caller's own object, built by the caller's own
	 * factory, and this is the one place that CALLED that factory. A host holds one
	 * generation today and will hold several once the control surface lands, so
	 * resolving the CANONICAL one per read is what stops a tab being answered from
	 * a generation the pointer has moved off -- which is the staleness the
	 * container's own indirect handle exists to prevent.
	 */
	const statesByGeneration = new Map<string, WritableStateStore>();
	const generationKey = (id: {stream: string; processor: string}) => `${id.stream}/${id.processor}`;

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

	/**
	 * POST THE PROGRESS, if anybody asked for it and if it MOVED.
	 *
	 * Two rules, and both are the push cadence ADR-0082 asks for. It is tied to
	 * APPLIED WORK because every caller of this is a place the container reported
	 * an advance or the driver changed phase, and never a timer. And an UNCHANGED
	 * value is not a change: a host resting at the tip advances every few seconds
	 * and applies nothing, so posting there would turn the signal into the polling
	 * it replaced, with the cost merely moved to the other end of the wire.
	 */
	function publish(): void {
		if (stopped || subscriptions === 0) return;
		const current = progress();
		if (published && sameProgress(published, current)) return;
		published = current;
		const push: PortPush<'progress'> = {
			protocol: INDEXER_PORT_PROTOCOL,
			kind: 'push',
			push: 'progress',
			value: current,
		};
		try {
			assertClonable(current, `the 'progress' push`);
			access.endpoint.postMessage(push);
		} catch (error) {
			// Nobody is waiting on a push, so there is no call to reject: it is logged
			// rather than swallowed, so a host that cannot talk is visible in a console.
			namedLogger.error(`the indexer host could not post its 'progress' push`, error);
		}
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
	 * ONE READ, projected to the DECLARED columns before it crosses.
	 *
	 * Projected HERE, by the same `declaredRow` the same-thread surface uses, which
	 * is what makes "the rows are identical" one implementation rather than two
	 * that agree by inspection: the version columns never leave the host, and an
	 * unlisted declared field crosses as `null` exactly as the store wrote it.
	 *
	 * An entity the store was not built with is refused by `mustGet`, which every
	 * backend already raises through, so the refusal a tab gets is the refusal a
	 * same-thread caller gets (`UnknownEntityError`, named so it survives the
	 * crossing as something an app can act on).
	 */
	async function served<T>(
		entityName: string,
		read: (store: StateStore, entity: NormalizedEntity) => Promise<T>,
	): Promise<T> {
		const store = await storeForReads();
		return read(store, mustGet(store.declarations, entityName));
	}

	const projected = (entity: NormalizedEntity, raw: PortRow | undefined): PortRow | undefined =>
		raw === undefined ? undefined : declaredRow(entity, raw);

	const listed = (entity: NormalizedEntity, found: Listing<PortRow>): Listing<PortRow> => ({
		rows: found.rows.map((raw) => declaredRow(entity, raw)),
		truncated: found.truncated,
	});

	/**
	 * THE CASES, and the switch a later task extends.
	 *
	 * Async because most of what is on it is: the store's four reads and every
	 * control call return promises.
	 */
	async function serveCase(request: PortRequest): Promise<unknown> {
		switch (request.case) {
			case 'progress':
				return progress();
			case 'subscribeToProgress': {
				subscriptions++;
				const current = progress();
				// Recorded as published, so the first PUSH a new subscriber gets is a
				// CHANGE rather than a repeat of the answer it is about to be handed.
				published = current;
				return current;
			}
			case 'unsubscribeFromProgress':
				subscriptions = Math.max(0, subscriptions - 1);
				// What was last posted is forgotten with the last subscriber: the next one
				// is told where the fold is by its own subscribe, and comparing against a
				// value nobody on this endpoint ever received would suppress a real change.
				if (subscriptions === 0) published = undefined;
				return undefined;
			case 'declarations':
				return [...(await storeForReads()).declarations.values()];
			case 'getCurrent': {
				const asked = request.payload as PortCases['getCurrent']['request'];
				return served(asked.entity, async (store, entity) =>
					projected(entity, await store.getCurrent(entity.name, asked.id)),
				);
			}
			case 'getAsOf': {
				const asked = request.payload as PortCases['getAsOf']['request'];
				return served(asked.entity, async (store, entity) =>
					projected(entity, await store.getAsOf(entity.name, asked.id, asked.at)),
				);
			}
			case 'listCurrent': {
				const asked = request.payload as PortCases['listCurrent']['request'];
				return served(asked.entity, async (store, entity) =>
					listed(entity, await store.listCurrent(entity.name, asked.prefix, asked.limit)),
				);
			}
			case 'listAsOf': {
				const asked = request.payload as PortCases['listAsOf']['request'];
				return served(asked.entity, async (store, entity) =>
					listed(entity, await store.listAsOf(entity.name, asked.prefix, asked.at, asked.limit)),
				);
			}
			default:
				throw new Error(
					`this indexer host does not know the case '${String((request as {case: string}).case)}'. A tab and its ` +
						`host come out of one build, so this means they did not.`,
				);
		}
	}

	function respond(response: PortResponse): void {
		try {
			access.endpoint.postMessage(response);
		} catch (error) {
			// Nothing is left to answer WITH: the answer itself is what could not be
			// posted. It is logged rather than swallowed so a host that cannot talk is
			// visible in a console, and the tab's call is left to the port's own
			// lifetime handling.
			namedLogger.error(`the indexer host could not post its '${response.case}' response`, error);
		}
	}

	async function answer(request: PortRequest): Promise<void> {
		const envelope = {protocol: INDEXER_PORT_PROTOCOL, kind: 'response', id: request.id, case: request.case} as const;
		let value: unknown;
		try {
			value = await serveCase(request);
			// REFUSED HERE, where the value was written, rather than thrown out of
			// `postMessage` where nothing knows which field it was. The refusal is
			// still an ANSWER to the tab's call: a caller that asked a question gets a
			// rejection naming the field, not a promise that never settles.
			assertClonable(value, `the '${request.case}' response`);
		} catch (error) {
			respond({...envelope, ok: false, error: portErrorOf(error)});
			return;
		}
		respond({...envelope, ok: true, value} as PortResponse);
	}

	const stopListening = listen(access.endpoint, (data) => {
		// Not ours: a shared scope carries whatever anybody posts to it, and a
		// message from somebody else is not an unknown case.
		if (!isPortRequest(data)) return;
		if (stopped) return;
		void answer(data);
	});

	/**
	 * Retry what waiting can fix, and stop on what it cannot.
	 *
	 * The same distinction `createIndexerState`'s loop draws (`isRetryable`): a
	 * rate limit is transient, while a store refusing the write it is being
	 * offered is a refusal a store does not change its mind about, and retrying
	 * that one re-fetches a chain for ever in order to be refused identically.
	 */
	async function withRetries<T>(step: () => Promise<T>): Promise<T | undefined> {
		while (!stopped) {
			try {
				return await step();
			} catch (error) {
				if (!isRetryable(error)) throw error;
				namedLogger.error(`the indexer host hit a transient failure; retrying in a second`, error);
				await wait(1);
			}
		}
		return undefined;
	}

	/** THE DRIVER: load once, then advance until something stops it. */
	async function drive(): Promise<void> {
		indexing = true;
		publish();
		try {
			const opened = await openIndexer<ABI, ProcessResultType>({
				registry: spec.registry ?? (await openMemoryGenerationRegistry(BROWSER_GENERATION_CAPS)),
				provider: spec.provider,
				source: spec.source,
				config: spec.config ?? {},
				...(spec.promotion ? {promotion: spec.promotion} : {}),
				generations: [
					generationSpecOf(spec, (id, state) => {
						// The FIRST one wins, exactly as the container resolves a generation it
						// already holds rather than adding a second engine over it.
						const key = generationKey(id);
						if (!statesByGeneration.has(key)) statesByGeneration.set(key, state);
					}),
				],
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
			if (stopped) return;

			const loaded = await withRetries(() => opened.load());
			if (loaded) lastSync = loaded;
			// Loaded, and BEHIND BY AN UNKNOWN AMOUNT: no advance has answered yet, so
			// the cursor's own numbers may still be the `0` of `0` a container publishes
			// before it has fetched. Only an advance can say `at-tip`.
			enter('catching-up');

			while (!stopped) {
				const advanced = await withRetries(() => opened.indexMore());
				if (!advanced) return;
				lastSync = advanced;
				// ONE rule for "at the tip", and it is literally the same expression the
				// driver rests on rather than a threshold beside it: a phase saying
				// `at-tip` while this loop went on fetching would be two answers to one
				// question, and an app would be told "live" over an incomplete fold.
				const atTip = advanced.lastToBlock >= advanced.latestBlock;
				enter(atTip ? 'at-tip' : 'catching-up');
				if (atTip) {
					// At the tip: rest, exactly as the main-thread loop does. An advance
					// straight away would be a `eth_blockNumber` per turn of the event loop
					// against a provider a browser user is rate-limited on.
					await wait(tipInterval);
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
			// A subscriber is TOLD the driver stopped, on both ways out. Silence is the
			// one thing a stalled host and a slow one look identical in (ADR-0082).
			publish();
		}
	}

	void drive();

	return {
		progress,
		dispose() {
			stopped = true;
			indexing = false;
			subscriptions = 0;
			published = undefined;
			refuseFirstState?.(new Error(`this indexer host was disposed, so it holds no store to read from.`));
			stopListening();
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
 * THE FIGURES AN APP RENDERS, derived where the cursor is.
 *
 * The three `createIndexerState` computes for the main-thread case (`ExtendedLastSync`),
 * carried across for the hosted one so that an app moving between the two binds
 * the same names to the same meanings, and computed in ONE place so the two
 * cannot drift.
 *
 * ## The guard, and what it is guarding against
 *
 * Every figure here is a distance to a TIP, and a container that has loaded and
 * not yet fetched publishes `0` for both cursors: it has learnt no tip. So they
 * are absent together below `latestBlock > 0` rather than computed from a number
 * that does not mean what it looks like -- the alternative is an app told it is
 * `0` blocks behind, and a full progress bar, before a single log was asked for.
 *
 * ## What was deliberately left behind
 *
 * `ExtendedLastSync.totalPercentage` (`lastToBlock / latestBlock`) does not
 * cross. It measures the fold against the whole CHAIN rather than against the
 * span it indexes, so a deployment whose contract starts at block 20,000,000
 * reads 99.9% from its first fetch, which is not a thing to put on a progress
 * bar. `syncPercentage` is the one with a denominator an app means.
 */
function derivedProgress<ABI extends Abi>(
	lastSync: LastSync<ABI>,
	foldStartsAt: number,
): Pick<HostProgress, 'blocksBehindTip' | 'numBlocksProcessedSoFar' | 'syncPercentage'> {
	const {lastToBlock, latestBlock} = lastSync;
	if (latestBlock <= 0) return {};
	const numBlocksProcessedSoFar = Math.max(0, lastToBlock - foldStartsAt);
	const totalToProcess = Math.max(0, latestBlock - foldStartsAt);
	return {
		blocksBehindTip: Math.max(0, latestBlock - lastToBlock),
		numBlocksProcessedSoFar,
		// A fold with no span to cross is DONE rather than a division by zero, which
		// is what the main-thread version performs there.
		syncPercentage:
			totalToProcess === 0
				? 100
				: Math.min(100, Math.floor((numBlocksProcessedSoFar * 1000000) / totalToProcess) / 10000),
	};
}

/**
 * WHETHER TWO REPORTS SAY THE SAME THING, which is how a push that carries no
 * news is suppressed.
 *
 * Field by field rather than by serialising both, because the equality is the
 * one this decides on: `failure` is compared on what a tab acts on (its name and
 * its message) and never on the host's stack, which is a string the same failure
 * can spell differently and which nothing renders.
 */
function sameProgress(a: HostProgress, b: HostProgress): boolean {
	return (
		a.host === b.host &&
		a.scope === b.scope &&
		a.indexing === b.indexing &&
		a.phase === b.phase &&
		a.lastToBlock === b.lastToBlock &&
		a.latestBlock === b.latestBlock &&
		a.blocksBehindTip === b.blocksBehindTip &&
		a.numBlocksProcessedSoFar === b.numBlocksProcessedSoFar &&
		a.syncPercentage === b.syncPercentage &&
		a.failure?.name === b.failure?.name &&
		a.failure?.message === b.failure?.message
	);
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
