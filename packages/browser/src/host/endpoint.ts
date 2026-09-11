import type {HostingShape} from './envelope.js';

/**
 * THE UNTYPED DUPLEX A PORT IS BUILT OVER: two `postMessage` ends and a
 * listener.
 *
 * Deliberately structural and deliberately tiny, because this is the ONE thing a
 * **hosting shape** differs in (`CONTEXT.md`, *indexer host*). A `Worker`, a
 * `MessagePort` (which is what a SharedWorker hands each tab), a dedicated
 * worker's own global scope and a `MessageChannel` end in a test all satisfy it
 * already; nothing in this package has to adapt any of them.
 *
 * It is NOT the **port**: the port is the TYPED boundary a tab holds
 * (`connectToIndexerHost`), and this is the wire it speaks over.
 */
export type MessageEndpoint = {
	postMessage(message: unknown): void;
	addEventListener(type: 'message', listener: (event: {data: unknown}) => void): void;
	removeEventListener(type: 'message', listener: (event: {data: unknown}) => void): void;
	/**
	 * `MessagePort` only, and only where the listener was attached with
	 * `addEventListener`: messages are queued until it is called. A `Worker` and a
	 * worker's own scope do not have it, which is why it is optional and why
	 * `listen` calls it defensively rather than each hosting shape remembering to.
	 */
	start?: () => void;
};

/**
 * HOW A PORT IS OBTAINED, which is the whole of what a **hosting shape** is.
 *
 * Everything else -- the container, the store, the driving loop, the envelope and
 * every case on it -- is written once against `MessageEndpoint` and knows nothing
 * about workers. So a reviewer checking "is the host host-agnostic?" checks
 * exactly one thing: that the only code naming `Worker` is the code that produces
 * one of these.
 */
export type HostAccess = {
	/** WHICH shape this is. Reported to the tab, and never branched on inside the host. */
	readonly host: HostingShape;
	/** The wire. */
	readonly endpoint: MessageEndpoint;
	/**
	 * Let the host go, where the holder of this access is what keeps it alive: a
	 * tab that constructed a dedicated worker terminates it. Absent where there is
	 * nothing to release (the host's own end of its own scope).
	 */
	readonly close?: () => void;
};

/** Attach a message listener, starting the endpoint where that is needed. Returns the detach. */
export function listen(endpoint: MessageEndpoint, onMessage: (data: unknown) => void): () => void {
	const listener = (event: {data: unknown}) => onMessage(event.data);
	endpoint.addEventListener('message', listener);
	endpoint.start?.();
	return () => endpoint.removeEventListener('message', listener);
}

/**
 * WHAT `globalThis` IS where this call runs: `'Window'` in a tab,
 * `'DedicatedWorkerGlobalScope'` in a worker.
 *
 * A MEASUREMENT and not a label, which is what makes it worth reporting: a test
 * asserting that the UI thread is not doing the fold can assert on WHERE the
 * answering code ran, instead of on how long something took. Nothing in this
 * package BRANCHES on it -- a host that behaved differently depending on its scope
 * would be the three implementations ADR-0082 exists to prevent.
 */
export function executionScopeName(): string {
	return globalThis.constructor?.name ?? typeof globalThis;
}
