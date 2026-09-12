import type {Abi} from '@etherfold/core';
import {logs} from 'named-logs';
import {isPortPush, isPortRequest, isPortResponse} from './envelope.js';
import {executionScopeName, listen, type HostAccess, type MessageEndpoint} from './endpoint.js';
import {serveIndexerHost, type HostedIndexerSpec, type IndexerHost} from './serve.js';

const namedLogger = logs('@etherfold/browser');

/**
 * THE SHAREDWORKER HOSTING SHAPE, which like its sibling is a way of OBTAINING A
 * PORT and nothing else.
 *
 * Both ends live in this one file for the reason `dedicatedWorker.ts` gives for
 * its own: it is the answer to "can a reviewer point at the seam?". Everything a
 * host does -- the container, the store, the driving loop, the envelope and every
 * case on it -- is in `serve.ts`, is written against `MessageEndpoint`, and is
 * BYTE-IDENTICAL between the two shapes. This file and its sibling hold the only
 * code in this package that names a worker constructor.
 *
 * ## The one structural difference, and what it costs
 *
 * A dedicated worker owns ONE wire: the tab constructed it, and its global scope
 * IS the other end. A SharedWorker is handed a wire PER CLIENT, through a
 * `connect` event, because several tabs reach one instance. So this file has one
 * thing in it the dedicated file does not: `oneEndpointOverEveryClient`, which
 * presents those wires to the host as the single endpoint every shape gives it.
 * The host is not told how many tabs are attached and has no verb that would let
 * it care.
 *
 * ## Dedicated remains the DEFAULT (ADR-0082), and this is opt-in
 *
 * Shared wins a narrow prize -- one store connection, and no election needed at
 * all -- and pays for it: a SharedWorker has no devtools panel (it needs
 * `chrome://inspect`), it cannot be terminated by a client, and every tab's reads
 * FUNNEL through the one instance instead of parallelising across a worker per
 * tab. Which is why it is offered rather than assumed, and why nothing here
 * changes what an app gets when it says nothing.
 *
 * ## A SharedWorker is identified by its SCRIPT URL plus its NAME
 *
 * So two different apps on one origin get different hosts with nothing to
 * configure, and two tabs of ONE app get the same host with nothing to configure
 * either -- which is the same scoping the writer guard arrives at from the
 * storage side (ADR-0075: a claim is scoped to a `databaseName`). It is a
 * PROPERTY rather than a mechanism: nothing in this file implements it, and
 * `browser/sharedWorkerServesSeveralTabs.spec.ts` observes it on all three
 * engines.
 */

/**
 * A HOST IN A SHAREDWORKER, as the tab reaches it.
 *
 * ```ts
 * const indexer = connectToIndexerHost(
 *   sharedWorkerHost(
 *     () => new SharedWorker(new URL('./indexer.worker.ts', import.meta.url), {type: 'module', name: 'my-app-indexer'}),
 *   ),
 * );
 * ```
 *
 * ONE ARGUMENT is the whole difference from `dedicatedWorkerHost`: the app writes
 * the line that constructs the worker (the URL has to be a literal its bundler
 * can see, so that the entry -- and the processor it imports -- is BUILT and
 * type-checked with the rest of the app), and the code it writes against the port
 * afterwards does not know which of the two it got.
 *
 * NAME the worker. It is half of its identity, so leaving it unnamed means every
 * SharedWorker an origin loads from this script URL is the same one -- which is
 * what you want for two tabs of one app and not what you want for two apps that
 * happen to share a bundle.
 *
 * ## `close()` does NOT take the host down, and cannot
 *
 * There is no `terminate()` on a `SharedWorker` and there should not be: the
 * instance belongs to every tab attached to it, so one tab letting go closes ITS
 * OWN port and leaves the fold running for the others. The browser ends the
 * worker when its LAST client is gone, which is what makes "the last tab closes"
 * an ordinary resume rather than a lifecycle to manage (ADR-0027: the cursor is
 * written in the same transaction as the block it describes, so the next tab
 * reads it and carries on).
 *
 * That also makes the restart path differ in one respect worth knowing: a
 * dedicated worker is TERMINATED before its successor is opened, so a host merely
 * suspected of being dead cannot become a second writer. Here there is nothing to
 * terminate and nothing to guard against -- a SharedWorker is a singleton by
 * construction, so `reopen` reaches the instance that is already running where one
 * is, and starts a fresh one only where the browser has already ended it.
 */
export function sharedWorkerHost(create: () => SharedWorker): HostAccess {
	if (typeof SharedWorker === 'undefined') {
		throw new Error(
			`this runtime has no SharedWorker, so the shared hosting shape is not available in ${executionScopeName()}. ` +
				`Use \`dedicatedWorkerHost(() => new Worker(new URL('./indexer.worker.ts', import.meta.url), ` +
				`{type: 'module'}))\`, which is the DEFAULT shape and works everywhere. Nothing here falls back on its own: ` +
				`the shape decides how many writers an app has, so it is the app's choice to make ` +
				`(\`typeof SharedWorker === 'undefined'\` is the whole of the check).`,
		);
	}
	const access = (worker: SharedWorker): HostAccess => {
		// A script that will not load is the one failure this shape has and the
		// dedicated one does not: a runtime with `SharedWorker` but no MODULE shared
		// worker constructs happily and then never runs. The port concludes a death
		// from the silence that follows (`IndexerPortOptions.watch`) and tells the
		// app; this says WHY in a console, where the alternative is an app author
		// watching a restart loop with nothing to read.
		worker.addEventListener('error', (event) => {
			namedLogger.error(
				`the SharedWorker hosting the indexer failed to load or threw before it could answer. A runtime that has ` +
					`\`SharedWorker\` but does not support MODULE shared workers fails exactly here; the dedicated shape ` +
					`works everywhere.`,
				event,
			);
		});
		return {
			host: 'shared-worker',
			// A `MessagePort` IS a message endpoint, `start()` included -- which is
			// what `listen` calls, so a message posted before the tab attached its
			// listener is not lost.
			endpoint: worker.port as unknown as MessageEndpoint,
			close: () => worker.port.close(),
			reopen: () => access(create()),
		};
	};
	return access(create());
}

/**
 * RUN THE INDEXER HERE, in the shared worker this is called from, for every tab
 * that connects to it. The whole of what an app's entry point does.
 *
 * ```ts
 * // indexer.worker.ts -- the same file, whichever shape an app chose
 * import {createBrowserStateStore, hostIndexerInThisSharedWorker} from '@etherfold/browser';
 * import {EntityEventProcessor} from '@etherfold/processor-entities';
 * import {openForWriting} from '@etherfold/state-store';
 * import {processor, source, provider} from './my-app.js';
 *
 * hostIndexerInThisSharedWorker({
 *   createState: async () => openForWriting(await createBrowserStateStore(processor.entities)),
 *   createProcessor: (store) => new EntityEventProcessor(store, processor),
 *   provider,
 *   source,
 * });
 * ```
 *
 * The SPEC is the dedicated helper's spec, unchanged, and that is the point: the
 * processor crosses as an IMPORT and never as a message, the provider is built
 * here for the same reason, and the store is opened for WRITING here, which is
 * what makes this host the writer and every tab a reader. Only the helper's name
 * differs, and all it does differently is where it gets its wires.
 */
export function hostIndexerInThisSharedWorker<ABI extends Abi, ProcessResultType, ProcessorConfig = undefined>(
	spec: HostedIndexerSpec<ABI, ProcessResultType, ProcessorConfig>,
): IndexerHost {
	const scope = thisSharedWorker();
	const clients = oneEndpointOverEveryClient();
	// Attached BEFORE the host is served, and synchronously: a `connect` event is
	// dispatched after this entry point's script has run, so the first tab's port
	// arrives at a listener that is already there.
	scope.addEventListener('connect', (event) => {
		for (const port of event.ports) clients.attach(port as unknown as MessageEndpoint);
	});
	return serveIndexerHost(spec, {host: 'shared-worker', endpoint: clients.endpoint});
}

/** A shared worker's own scope, as the one event this shape needs from it. */
type SharedWorkerScope = {
	addEventListener(type: 'connect', listener: (event: {ports: readonly MessageEndpoint[]}) => void): void;
};

/**
 * This shared worker's own scope, REFUSING to be anything else.
 *
 * The refusal is what makes the `host: 'shared-worker'` a tab is told a
 * consequence rather than a claim, exactly as the dedicated helper's is. The
 * MIX-UP is the case worth naming: the two helpers are one line apart in an app's
 * entry point, and calling the wrong one is SILENT -- a dedicated worker's
 * `postMessage` does not exist in a shared scope and a shared scope's `connect`
 * never fires in a dedicated one, so what an app would observe is a host that
 * never answers and a port that concludes it died.
 */
function thisSharedWorker(): SharedWorkerScope {
	const scope = globalThis as {window?: unknown; document?: unknown; addEventListener?: unknown};
	if (scope.window !== undefined || scope.document !== undefined) {
		throw new Error(
			`hostIndexerInThisSharedWorker() must be called from INSIDE a SharedWorker, and it was called in ` +
				`${executionScopeName()}. A shared worker entry point is loaded with \`new SharedWorker(new ` +
				`URL('./indexer.worker.ts', import.meta.url), {type: 'module', name: 'my-app-indexer'})\`; importing it from ` +
				`the tab runs the indexer on the UI thread, which is what hosting it in a worker is for.`,
		);
	}
	// The `connect` handler slot, which is what a `SharedWorkerGlobalScope` has and
	// no other scope does (observed on all three engines: a dedicated worker scope
	// and a window both answer `false` here).
	if (!('onconnect' in scope) || typeof scope.addEventListener !== 'function') {
		throw new Error(
			`hostIndexerInThisSharedWorker() found no \`connect\` interface in ${executionScopeName()}: a SharedWorker is ` +
				`handed a port per client through a \`connect\` event, and this scope has none. In a DEDICATED worker, call ` +
				`hostIndexerInThisWorker() instead.`,
		);
	}
	return globalThis as unknown as SharedWorkerScope;
}

/** The wires of every attached client, as the ONE endpoint a host is given. */
type EveryClient = {
	/** What `serveIndexerHost` is handed: a wire like any other. */
	readonly endpoint: MessageEndpoint;
	/** One more client, as a `connect` event delivered it. */
	attach(client: MessageEndpoint): void;
};

/**
 * EVERY ATTACHED CLIENT'S WIRE, PRESENTED AS ONE ENDPOINT.
 *
 * This is the whole of what the shared shape adds, and it exists so that the
 * thing ADR-0082 decided stays true: the host is written once, against one wire,
 * and knows nothing about hosting shapes. A SharedWorker's entry is handed a port
 * per client, so somebody has to make N wires look like the one every shape
 * provides. Doing it HERE keeps it inside "how a port is obtained"; doing it in
 * the host would have been a second implementation of the host, which is the
 * accident the ADR names.
 *
 * It does three things, and the first is not optional:
 *
 * **A RESPONSE GOES TO THE CLIENT THAT ASKED, AND NOWHERE ELSE.** A correlation
 * id is unique per PORT and not globally (see the envelope), which is exactly
 * right and becomes load-bearing the moment there are several ports: two tabs are
 * two documents, each counting from one, so their ids collide by construction.
 * Broadcasting the answers would therefore not merely be wasteful -- it would
 * RESOLVE tab A's `progress()` with the rows tab B asked for. So each request is
 * re-numbered into one id space on its way in, and the answer is re-numbered back
 * and posted to one client on its way out. Nothing else in the package sees
 * either number.
 *
 * **A PUSH GOES TO THE CLIENTS THAT SUBSCRIBED.** The host counts subscriptions
 * and posts nothing until at least one tab has asked; that count is the sum over
 * the attached clients, so the filter that says WHICH of them asked belongs here.
 * The two case names are the only protocol knowledge in this file, and the
 * alternative -- broadcasting and letting an unsubscribed tab ignore what arrives
 * -- would bill every tab for the one that is rendering a progress bar.
 *
 * **A MESSAGE THAT IS NOT OURS IS NOT FORWARDED.** A client's port carries
 * whatever that tab posts to it, which in this repository includes a test
 * fixture's own traffic; the host already ignores what is not its own, and this
 * ignores it one step earlier.
 *
 * ## What it does NOT do: notice that a tab went away
 *
 * Nothing tells a SharedWorker that a client is gone. There is no disconnect
 * event, `MessagePort`'s own `close` event is not on every engine this ships to,
 * and that is precisely why "closing one tab does not stop the fold" needs no
 * code: the host is never told, so it never acts. The cost is an entry per tab
 * that ever attached, and a post to a closed port, which the platform drops
 * silently -- bounded by the worker's own lifetime, since the browser ends it
 * when the last client goes. A client whose port THROWS on a post is dropped,
 * which is all the liveness that is actually observable here.
 */
function oneEndpointOverEveryClient(): EveryClient {
	type Client = {
		readonly endpoint: MessageEndpoint;
		/** Whether THIS tab asked for pushes. The host counts them; this says which. */
		subscribed: boolean;
	};
	const clients = new Set<Client>();
	/** WHO ASKED, under the id this endpoint gave the host, and what THEY called it. */
	const asked = new Map<number, {client: Client; id: number}>();
	const listeners = new Set<(event: {data: unknown}) => void>();
	let nextId = 1;

	function post(client: Client, message: unknown): void {
		try {
			client.endpoint.postMessage(message);
		} catch (error) {
			// A port that refuses a post is a tab that is gone, and it is the only
			// evidence of that this shape ever gets. Dropped rather than raised: the
			// host is answering somebody else and has no caller to report this to.
			clients.delete(client);
			namedLogger.info(`a tab attached to this indexer host could not be posted to, so it was let go`, error);
		}
	}

	return {
		endpoint: {
			postMessage(message) {
				if (isPortResponse(message)) {
					const waiting = asked.get(message.id);
					asked.delete(message.id);
					// An answer to a question nobody is waiting for: the client went away
					// while the host was computing it. Dropped, because there is nowhere to
					// put it.
					if (waiting) post(waiting.client, {...message, id: waiting.id});
					return;
				}
				if (isPortPush(message)) {
					for (const client of [...clients]) {
						if (client.subscribed) post(client, message);
					}
					return;
				}
				// Neither, which nothing in this package posts today. Broadcast rather
				// than dropped: a host that grew a message with no correlation and no
				// push name would otherwise reach nobody, silently.
				for (const client of [...clients]) post(client, message);
			},
			addEventListener(_type, listener) {
				listeners.add(listener);
			},
			removeEventListener(_type, listener) {
				listeners.delete(listener);
			},
		},
		attach(endpoint) {
			const client: Client = {endpoint, subscribed: false};
			clients.add(client);
			listen(endpoint, (data) => {
				if (!isPortRequest(data)) return;
				if (data.case === 'subscribeToProgress') client.subscribed = true;
				if (data.case === 'unsubscribeFromProgress') client.subscribed = false;
				const id = nextId++;
				asked.set(id, {client, id: data.id});
				const renumbered = {...data, id};
				for (const listener of [...listeners]) listener({data: renumbered});
			});
		},
	};
}
