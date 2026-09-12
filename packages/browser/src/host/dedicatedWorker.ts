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
 * `sharedWorker.ts` is the opt-in sibling, and nothing about it changed what an
 * app gets when it says nothing.
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
 * ## `close()` terminates only a host that is KNOWN TO BE QUIET
 *
 * This used to terminate unconditionally, and the reasoning was that a dedicated
 * worker belongs to the tab that made it, so killing it is free and killing
 * before a restart is what stops a second writer.
 *
 * The second half was never load-bearing -- ADR-0075's writer token is what stops
 * a second writer, and it stops one that survived a failed kill too -- and the
 * first half is measurably false. Ending a worker that has a `readwrite` and a
 * `readonly` transaction in flight can leave its IndexedDB database PERMANENTLY
 * unable to run any transaction on WebKit, recovered by no reload and no new tab,
 * with `deleteDatabase` blocked
 * (`work/notes/findings/webkit-does-not-abort-a-terminated-workers-indexeddb-transaction.md`).
 * A host killed for being unresponsive is, by construction, a host that was busy.
 *
 * So a kill now needs a reason to believe the host is idle, and the port
 * establishes that by asking it to stop before letting go. When it cannot -- a
 * host that answers nothing is exactly the case -- the worker is ABANDONED rather
 * than killed. That leaks a thread, and the leak is bounded by a fact worth
 * stating: a dedicated worker cannot outlive the document that created it, so the
 * cost is one idle worker until the page goes away, against a local database the
 * user cannot get back.
 */
export function dedicatedWorkerHost(create: () => Worker): HostAccess {
	const access = (worker: Worker): HostAccess => ({
		host: 'dedicated-worker',
		// A `Worker` IS a message endpoint; the cast is the DOM's overloaded
		// `addEventListener` meeting a one-signature structural type, not a
		// difference in behaviour.
		endpoint: worker as unknown as MessageEndpoint,
		// Only a host that answered `stopIndexing` is killed; see the note above.
		close: ({quiesced}) => {
			if (quiesced) worker.terminate();
		},
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
	if ('onconnect' in scope) {
		// A SHARED worker's scope, which has no `postMessage` of its own, so the
		// refusal below would be true and would not say the useful thing. The two
		// helpers are one line apart in an app's entry point and a mix-up is silent:
		// a shared scope's `connect` event never fires in a dedicated worker either,
		// so what an app observes is a host that never answers.
		throw new Error(
			`hostIndexerInThisWorker() was called in ${executionScopeName()}, which is a SHARED worker: it is handed a ` +
				`port per client through a \`connect\` event and has no \`postMessage\` of its own. Call ` +
				`hostIndexerInThisSharedWorker() there -- it takes the same spec, and what runs inside the host is the same ` +
				`code in both shapes.`,
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
