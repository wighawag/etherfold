import type {Abi} from '@etherfold/core';
import type {HostAccess, MessageEndpoint} from './endpoint.js';
import {executionScopeName} from './endpoint.js';
import {serveIndexerHost, type HostedIndexerSpec, type IndexerHost} from './serve.js';

/**
 * THE DEDICATED-WORKER HOSTING SHAPE, which is a way of OBTAINING A PORT and
 * nothing else.
 *
 * Both ends of the shape live in this one file on purpose: it is the answer to
 * "can a reviewer point at the seam?". Everything a host does -- the container,
 * the store, the driving loop, the envelope and every case on it -- is in
 * `serve.ts` and never mentions a worker; this is the only module in the package
 * that does, and all it does is hand over a wire. A SharedWorker is a sibling of
 * this file, not a branch inside any other one.
 *
 * ## Dedicated is the DEFAULT (ADR-0082)
 *
 * It works everywhere, it debugs properly (a SharedWorker needs `chrome://inspect`
 * and has no devtools panel), and one worker per tab is not waste: each serves
 * its own tab's reads, so reads PARALLELISE instead of funnelling through one.
 */

/**
 * A HOST IN A DEDICATED WORKER, as the tab reaches it.
 *
 * The app writes the line that constructs the `Worker`, and that is deliberate:
 * the URL has to be a literal its bundler can see, so that the worker entry --
 * and the processor that entry imports -- is BUILT, type-checked and
 * de-duplicated with the rest of the app. `new Worker(new
 * URL('./indexer.worker.ts', import.meta.url), {type: 'module'})` is the form
 * every current bundler understands, and a URL this package built for the caller
 * would be a string no bundler traces.
 *
 * ```ts
 * const indexer = connectToIndexerHost(
 *   dedicatedWorkerHost(() => new Worker(new URL('./indexer.worker.ts', import.meta.url), {type: 'module'})),
 * );
 * ```
 *
 * ## It takes a FACTORY, and not a worker
 *
 * Browsers evict workers, so a port has to be able to start another one
 * (ADR-0082) -- and obtaining a port is the whole of what a hosting shape is, so
 * obtaining one AGAIN belongs here rather than anywhere else. Handed an instance,
 * this could report a death and reject the calls and then do nothing, with no
 * signal anywhere that the restart half was missing; handed the five words that
 * BUILD one, every port can restart. The line an app writes is the same line,
 * with an arrow in front of it.
 *
 * `close()` TERMINATES the worker, because a dedicated worker belongs to the tab
 * that constructed it and nothing else can be holding it. That is also what makes
 * the restart safe: the port kills before it opens a successor, so a host merely
 * SUSPECTED of being dead costs a restart rather than a second writer.
 */
export function dedicatedWorkerHost(create: () => Worker): HostAccess {
	const access = (worker: Worker): HostAccess => ({
		host: 'dedicated-worker',
		// A `Worker` IS a message endpoint; the cast is the DOM's overloaded
		// `addEventListener` meeting a one-signature structural type, not a
		// difference in behaviour.
		endpoint: worker as unknown as MessageEndpoint,
		close: () => worker.terminate(),
		reopen: () => access(create()),
	});
	return access(create());
}

/**
 * RUN THE INDEXER HERE, in the dedicated worker this is called from. The whole
 * of what an app's worker entry point does.
 *
 * ```ts
 * // indexer.worker.ts -- the one file an app writes for this
 * import {createBrowserStateStore, hostIndexerInThisWorker} from '@etherfold/browser';
 * import {EntityEventProcessor} from '@etherfold/processor-entities';
 * import {openForWriting} from '@etherfold/state-store';
 * import {processor, source, provider} from './my-app.js';
 *
 * hostIndexerInThisWorker({
 *   createState: async () => openForWriting(await createBrowserStateStore(processor.entities)),
 *   createProcessor: (store) => new EntityEventProcessor(store, processor),
 *   provider,
 *   source,
 * });
 * ```
 *
 * The processor crosses as an IMPORT and never as a message, because it is code
 * and closures (ADR-0082). So is the provider, for the same reason: what the tab
 * holds is a port, and what builds the chain connection is this file.
 *
 * The store is opened for WRITING here, which is what makes the host the writer
 * and every tab a reader.
 */
export function hostIndexerInThisWorker<ABI extends Abi, ProcessResultType, ProcessorConfig = undefined>(
	spec: HostedIndexerSpec<ABI, ProcessResultType, ProcessorConfig>,
): IndexerHost {
	return serveIndexerHost(spec, thisDedicatedWorker());
}

/**
 * This worker's own scope as an endpoint, REFUSING to be a window.
 *
 * The refusal is what makes the `host: 'dedicated-worker'` a tab is told a
 * consequence rather than a claim: the only way to reach this code is to be
 * running somewhere that is not a document. A misdirected import -- an entry
 * point pulled into the app bundle by a stray `import './indexer.worker.js'` --
 * would otherwise start a SECOND container on the UI thread, folding into the
 * same store as the real one, and the first thing anybody would see is a writer
 * being refused.
 */
function thisDedicatedWorker(): HostAccess {
	const scope = globalThis as {window?: unknown; document?: unknown; postMessage?: unknown; addEventListener?: unknown};
	if (scope.window !== undefined || scope.document !== undefined) {
		throw new Error(
			`hostIndexerInThisWorker() must be called from INSIDE a worker, and it was called in ${executionScopeName()}. ` +
				`A worker entry point is loaded with \`new Worker(new URL('./indexer.worker.ts', import.meta.url), ` +
				`{type: 'module'})\`; importing it from the tab runs the indexer on the UI thread, which is what hosting ` +
				`it in a worker is for.`,
		);
	}
	if (typeof scope.postMessage !== 'function' || typeof scope.addEventListener !== 'function') {
		throw new Error(
			`hostIndexerInThisWorker() found no worker messaging in ${executionScopeName()}: this context has no ` +
				`\`postMessage\`/\`addEventListener\` to answer a tab through.`,
		);
	}
	return {host: 'dedicated-worker', endpoint: globalThis as unknown as MessageEndpoint};
}
