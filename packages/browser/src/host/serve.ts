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
import type {WritableStateStore} from '@etherfold/state-store';
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
	type PortRequest,
	type PortResponse,
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

	function progress(): HostProgress {
		return {
			host: access.host,
			scope,
			indexing,
			...(lastSync ? {lastToBlock: lastSync.lastToBlock, latestBlock: lastSync.latestBlock} : {}),
			...(failure ? {failure} : {}),
		};
	}

	/**
	 * ONE CASE, and the switch a later task extends.
	 *
	 * Async because most of what joins it is: the store proxy's four reads and
	 * every control call return promises. This one does not await anything and
	 * says so by having nothing to await.
	 */
	async function serveCase(request: PortRequest): Promise<unknown> {
		switch (request.case) {
			case 'progress':
				return progress();
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
		try {
			const opened = await openIndexer<ABI, ProcessResultType>({
				registry: spec.registry ?? (await openMemoryGenerationRegistry(BROWSER_GENERATION_CAPS)),
				provider: spec.provider,
				source: spec.source,
				config: spec.config ?? {},
				...(spec.promotion ? {promotion: spec.promotion} : {}),
				generations: [generationSpecOf(spec)],
			});
			container = opened;
			opened.onLastSyncUpdated = (updated) => {
				lastSync = updated;
			};
			if (stopped) return;

			const loaded = await withRetries(() => opened.load());
			if (loaded) lastSync = loaded;

			while (!stopped) {
				const advanced = await withRetries(() => opened.indexMore());
				if (!advanced) return;
				lastSync = advanced;
				if (advanced.lastToBlock >= advanced.latestBlock) {
					// At the tip: rest, exactly as the main-thread loop does. An advance
					// straight away would be a `eth_blockNumber` per turn of the event loop
					// against a provider a browser user is rate-limited on.
					await wait(tipInterval);
				}
			}
		} catch (error) {
			failure = portErrorOf(error);
			namedLogger.error(`the indexer host STOPPED: nothing waiting can fix what it was refused`, error);
		} finally {
			indexing = false;
		}
	}

	void drive();

	return {
		progress,
		dispose() {
			stopped = true;
			indexing = false;
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
) {
	return {
		createState: (context: GenerationContext) => spec.createState(context),
		createProcessor: async (state: unknown, context: GenerationContext) => {
			const built = await spec.createProcessor(state as WritableStateStore, context);
			if (built.configure && spec.processorConfig) {
				built.configure(spec.processorConfig);
			}
			return built;
		},
		stateOf: (built: EventProcessor<ABI, ProcessResultType>) =>
			(built as EntityEventProcessorLike<ABI, ProcessResultType, ProcessorConfig>).state,
	};
}
