import {executionScopeName, type HostAccess, type MessageEndpoint} from './endpoint.js';
import {serveHostCases, type HostBacking, type ServedCases} from './cases.js';

/**
 * THE MAIN-THREAD HOSTING SHAPE, which like its two siblings is a way of
 * OBTAINING A PORT and nothing else.
 *
 * ## The host here is `createIndexerState`, and there is not a second one
 *
 * The two worker shapes obtain a port by CONSTRUCTING a host: an app writes
 * `new Worker(...)`, the entry point inside it calls `hostIndexerInThisWorker`,
 * and `serve.ts` opens a container and drives it. On this thread there is
 * already a host -- `createIndexerState` owns a container, drives it, holds the
 * writer's store and publishes three reactive stores an app subscribes to -- so
 * this file constructs NOTHING. It is handed that host's `HostBacking` and joins
 * a wire to it (ADR-0082: "`createIndexerState` IS the main-thread host,
 * adapted, not a second way of doing the same thing").
 *
 * That is why there is no `mainThreadHost(spec)` beside `dedicatedWorkerHost`
 * and `sharedWorkerHost`, and why the shape is reached as
 * `createIndexerState(...).mainThreadHost()` instead: a top-level factory taking
 * a spec would be a SECOND way to build a main-thread indexer, with no rule for
 * choosing between them, which is the one thing ADR-0082 closes.
 *
 * ## The wire is a REAL `MessageChannel`
 *
 * Not a pair of direct calls. A hosting shape is how a port is obtained, and the
 * port's contract includes what may cross it: a value that would throw on its
 * way to a worker must throw on its way here too, or the shape an app develops
 * against would be more permissive than the shape it ships. So the same
 * structured-clone boundary is in force, the same `assertClonable` refusals
 * fire, and the same envelope crosses -- the only thing missing is a second
 * execution context, which is precisely what this shape does not claim to have.
 *
 * ## What it costs, and it is the whole reason this is not the default
 *
 * THE FOLD IS ON THE UI THREAD. Indexing is a fold over every log a contract
 * ever emitted (31,332 events across 1,042 blocks on the measured workload, at
 * 45.6 ms per block of store writes on Chromium), so a tab that hosts its own
 * indexer janks while it renders. A dedicated worker is the default for exactly
 * that reason; this shape is for tests, for a small backfill, and for an app
 * whose bundler cannot emit a worker.
 */

/** One wire to the host on this thread, and what its holder may do with it. */
export type MainThreadHosting = {
	/** What a tab passes to `connectToIndexerHost`. */
	readonly access: HostAccess;
	/** Post the progress on this wire, if its tab subscribed and the report MOVED. */
	publish(): void;
	/** Stop answering on this wire and close it. Called by the access's own `close`. */
	stop(): void;
};

/**
 * JOIN A WIRE TO THE HOST RUNNING ON THIS THREAD.
 *
 * `onStopped` is how the host learns a wire is gone, so it stops publishing to
 * one nobody is holding.
 */
export function hostOnThisThread(
	backing: HostBacking,
	onStopped?: (wire: MainThreadHosting) => void,
): MainThreadHosting {
	if (typeof MessageChannel === 'undefined') {
		throw new Error(
			`this runtime has no MessageChannel, so a port to the indexer on this thread cannot be obtained in ` +
				`${executionScopeName()}. The main-thread hosting shape speaks the same structured-clone boundary a worker ` +
				`does, deliberately: a value that could not cross to a worker must not cross here either.`,
		);
	}
	const channel = new MessageChannel();
	let served: ServedCases | undefined;
	let stopped = false;

	const wire: MainThreadHosting = {
		access: {
			host: 'main-thread',
			// The TAB's end. A `MessagePort` IS a message endpoint, `start()` included --
			// which `listen` calls, so a message posted before the tab attached its
			// listener is not lost.
			endpoint: channel.port2 as unknown as MessageEndpoint,
			close: () => wire.stop(),
			// NO `reopen`, and it is not an omission. A restart exists because a browser
			// can evict a worker while its tab lives on; a host on the UI thread cannot
			// die independently of the tab holding the port, because they are the same
			// context. So a port to this shape reports `restarting: false` rather than
			// pretending it could have done something, and `watch: false` is the honest
			// setting for it (`IndexerPortOptions`).
		},
		publish: () => served?.publish(),
		stop() {
			if (stopped) return;
			stopped = true;
			served?.stop();
			channel.port1.close();
			channel.port2.close();
			onStopped?.(wire);
		},
	};

	// The HOST's end is the other one. Both halves of this shape are in this file,
	// as they are in `dedicatedWorker.ts` and `sharedWorker.ts`, and the difference
	// is that here they are two ends of one channel rather than two contexts.
	served = serveHostCases({host: 'main-thread', endpoint: channel.port1 as unknown as MessageEndpoint}, backing);
	return wire;
}
