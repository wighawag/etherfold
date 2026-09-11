import {assertClonable} from './clone.js';
import {listen, type HostAccess} from './endpoint.js';
import {
	INDEXER_PORT_PROTOCOL,
	isPortResponse,
	type HostProgress,
	type HostingShape,
	type PortCaseName,
	type PortRequest,
	type PortRequestPayload,
	type PortResponseValue,
} from './envelope.js';
import {errorFromPort} from './errors.js';

/**
 * THE PORT: the typed boundary a tab holds onto a host that is not its own
 * thread.
 *
 * Every verb here is a CASE on the envelope, and there is deliberately exactly
 * one so far. What is not here is as much the point as what is: a tab holds no
 * store, no container and no processor, so there is nothing on this type that
 * could mutate the state the host is folding into. The writer/reader split
 * (ADR-0077, ADR-0079) reaches across the boundary as a fact of the TYPE rather
 * than as a rule anybody has to remember -- the host opened the store for
 * WRITING, and what a tab can name is this.
 *
 * A tab that wants to READ the rows the host wrote opens the same store for
 * READING (`openForReading`), which is what the same-origin IndexedDB default
 * makes possible today; proxying those four reads over this port, so that the
 * surface works for a store a tab cannot open, is
 * `a-tab-reads-the-store-across-the-port`'s case to add.
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

	const stopListening = listen(access.endpoint, (data) => {
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
		close() {
			if (closed) return;
			closed = true;
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
