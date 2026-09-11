import {assertClonable} from './clone.js';
import {listen, type HostAccess} from './endpoint.js';
import {
	INDEXER_PORT_PROTOCOL,
	isPortPush,
	isPortResponse,
	type HostProgress,
	type HostingShape,
	type PortCaseName,
	type PortRequest,
	type PortRequestPayload,
	type PortResponseValue,
} from './envelope.js';
import {errorFromPort} from './errors.js';
import type {PortStateReads} from './reads.js';

/**
 * THE PORT: the typed boundary a tab holds onto a host that is not its own
 * thread.
 *
 * Every verb here is a CASE on the envelope, except `onProgress`, which is the
 * one thing that travels the other way: a PUSH the host sends unprompted
 * (ADR-0082). What is not here is as much the point as what is: a tab holds no
 * store, no container and no processor, so there is nothing on this type that
 * could mutate the state the host is folding into. The writer/reader split
 * (ADR-0077, ADR-0079) reaches across the boundary as a fact of the TYPE rather
 * than as a rule anybody has to remember -- the host opened the store for
 * WRITING, and what a tab can name is this.
 *
 * What a tab reads WITH is `reads` below: the store's four reads, proxied, with
 * nothing beside them that could write. A tab may also open the same store for
 * READING itself (`openForReading`), which the same-origin IndexedDB default
 * makes possible -- the port is what makes the surface work for a store a tab
 * cannot open, and what keeps an app from having to know which of the two it is
 * in.
 */
export type IndexerPort = {
	/** WHICH hosting shape this port leads to, as the access that built it named it. */
	readonly host: HostingShape;
	/**
	 * How far the host's fold has got.
	 *
	 * Answering at all is proof the host is ALIVE, which is why nothing here says
	 * so separately. A host that has stopped reports why in `failure` instead of
	 * leaving a tab to infer it from a number that stopped moving.
	 */
	progress(): Promise<HostProgress>;
	/**
	 * BE TOLD where the fold has got to, whenever it MOVES. Returns the detach.
	 *
	 * This is the channel ADR-0082 decides on: status is PUSHED, and an app builds
	 * whatever reactive wrapper its framework wants over this signal --
	 * `createProgressReadable(port)` is the one this package ships for the common
	 * case. Nothing here polls, and nothing on a timer moves it: the host posts
	 * when a batch has been APPLIED or the phase changed, and posts nothing when
	 * the report would repeat the last one.
	 *
	 * ```ts
	 * const stop = indexer.onProgress(({phase, blocksBehindTip}) => {
	 *   banner.textContent = phase === 'at-tip' ? 'live' : `syncing, ${blocksBehindTip} blocks behind`;
	 * });
	 * ```
	 *
	 * The listener is called with WHERE THE FOLD IS NOW as soon as the host
	 * answers, so a tab that attached half way through a fold renders the truth
	 * without waiting for the next batch to land.
	 *
	 * A SUBSCRIPTION and not a slot: several listeners may hold it at once, and
	 * each releases its own -- unlike the container's `onLastSyncUpdated` and its
	 * neighbours, which are single assignable callbacks on an object only the host
	 * can reach. When the LAST one lets go, the host is told to stop posting, so an
	 * unsubscribed tab stops receiving pushes rather than merely ignoring them.
	 */
	onProgress(listener: (progress: HostProgress) => void): () => void;
	/**
	 * THE STORE'S FOUR READS, served by the host from the store its canonical
	 * generation folds into.
	 *
	 * Untyped here, by entity NAME, exactly as `EntityStateView` is on this thread:
	 * what an app should hold is the TYPED surface generated from its own
	 * declarations over these, which is `createPortReadSurface(port, entities)`.
	 *
	 * There is nothing beside them that could mutate, and that is a fact of this
	 * type rather than a rule to remember: the host opened the store for WRITING
	 * and what crosses is four reads (ADR-0077, ADR-0082).
	 */
	readonly reads: PortStateReads;
	/**
	 * Stop holding the host.
	 *
	 * Every call still in flight REJECTS: a hung promise is the worst available
	 * outcome, because a stalled app and a slow app look identical from outside
	 * (ADR-0082). What `close` does to the host itself is the hosting shape's
	 * business -- a dedicated worker belongs to the tab that made it and is
	 * terminated; a SharedWorker serving other tabs is not.
	 */
	close(): void;
};

/**
 * HOLD A HOST that is not this thread.
 *
 * ```ts
 * const indexer = connectToIndexerHost(
 *   dedicatedWorkerHost(new Worker(new URL('./indexer.worker.ts', import.meta.url), {type: 'module'})),
 * );
 * const {lastToBlock, latestBlock} = await indexer.progress();
 * ```
 *
 * It knows nothing about workers. The argument is the ONE thing a hosting shape
 * differs in, which is why choosing a shape is a different call rather than a
 * flag threaded through this one.
 */
export function connectToIndexerHost(access: HostAccess): IndexerPort {
	type Pending = {resolve: (value: never) => void; reject: (error: unknown) => void};
	const pending = new Map<number, Pending>();
	let nextId = 1;
	let closed = false;

	/**
	 * WHO IS LISTENING, and the LAST THING THE HOST SAID.
	 *
	 * The value is held for one reason: a listener added while a subscription is
	 * already open has missed the answer that opened it, and would otherwise render
	 * nothing until the fold next moved (which, at the tip, is never). It is the
	 * host's own last word verbatim and is replaced wholesale, never merged into --
	 * a tab that MAINTAINED a progress object would be the duplicated state ADR-0082
	 * refuses.
	 */
	const listeners = new Set<(progress: HostProgress) => void>();
	let latest: HostProgress | undefined;

	function announce(progress: HostProgress): void {
		latest = progress;
		for (const listener of listeners) listener(progress);
	}

	const stopListening = listen(access.endpoint, (data) => {
		if (isPortPush(data)) {
			// Narrowed by NAME, which is what makes a second push a `case` here rather
			// than a cast.
			if (data.push === 'progress') announce(data.value);
			return;
		}
		if (!isPortResponse(data)) return;
		const waiting = pending.get(data.id);
		// An answer to a call nobody is waiting for: a response that arrived after
		// its caller gave up. Dropped rather than raised -- there is no caller to
		// raise it to.
		if (!waiting) return;
		pending.delete(data.id);
		if (data.ok) {
			(waiting.resolve as (value: unknown) => void)(data.value);
		} else {
			waiting.reject(errorFromPort(data.error));
		}
	});

	function request<Case extends PortCaseName>(
		name: Case,
		payload: PortRequestPayload<Case>,
	): Promise<PortResponseValue<Case>> {
		if (closed) {
			return Promise.reject(
				new Error(`this indexer port is closed, so the '${name}' call was not sent. Connect to the host again.`),
			);
		}
		const id = nextId++;
		const message: PortRequest<Case> = {
			protocol: INDEXER_PORT_PROTOCOL,
			kind: 'request',
			id,
			case: name,
			payload,
		};
		// REFUSED HERE, naming the field, rather than thrown out of `postMessage`
		// naming an object. It is the caller's own call that rejects, synchronously
		// in the promise it is already awaiting.
		assertClonable(payload, `the '${name}' request`);
		return new Promise<PortResponseValue<Case>>((resolve, reject) => {
			pending.set(id, {resolve: resolve as (value: never) => void, reject});
			try {
				access.endpoint.postMessage(message);
			} catch (error) {
				pending.delete(id);
				reject(error);
			}
		});
	}

	return {
		host: access.host,
		progress: () => request('progress', undefined),
		onProgress(listener) {
			const first = listeners.size === 0;
			listeners.add(listener);
			if (first) {
				// The answer IS the current progress, so there is no window in which a
				// freshly attached tab holds nothing and no race with a first push.
				request('subscribeToProgress', undefined).then(announce, () => {
					// A port closed before the host answered. The caller's own `close` is
					// what rejected it, and there is no call here to report it to.
				});
			} else if (latest) {
				// Already subscribed, so this listener missed the answer that opened it.
				// Asynchronously, so a listener never fires before the call that added it
				// returned its detach.
				const known = latest;
				queueMicrotask(() => {
					if (listeners.has(listener)) listener(known);
				});
			}
			return () => {
				if (!listeners.delete(listener)) return;
				if (listeners.size > 0 || closed) return;
				latest = undefined;
				// The HOST stops posting, rather than this end stopping listening: a tab
				// that went on receiving what it unsubscribed from would still be paying
				// for it. Nothing awaits this -- there is no answer worth having.
				void request('unsubscribeFromProgress', undefined).catch(() => undefined);
			};
		},
		reads: {
			declarations: () => request('declarations', undefined),
			getCurrent: (entity, id) => request('getCurrent', {entity, id}),
			getAsOf: (entity, id, at) => request('getAsOf', {entity, id, at}),
			listCurrent: (entity, prefix, limit) => request('listCurrent', {entity, prefix, limit}),
			listAsOf: (entity, prefix, at, limit) => request('listAsOf', {entity, prefix, at, limit}),
		},
		close() {
			if (closed) return;
			closed = true;
			listeners.clear();
			latest = undefined;
			stopListening();
			const closing = new Error(`the indexer port was closed while this call was in flight.`);
			for (const [id, waiting] of pending) {
				pending.delete(id);
				waiting.reject(closing);
			}
			access.close?.();
		},
	};
}
