import 'fake-indexeddb/auto';
import {
	connectToIndexerHost,
	createIndexerState,
	hostIndexerInThisSharedWorker,
	serveIndexerHost,
	type HostedIndexerSpec,
	type HostQueryHandler,
	type IndexerHost,
	type IndexerPort,
	type MessageEndpoint,
} from '@etherfold/browser';
import {generationDigestOf, type Abi, type IndexingSource} from '@etherfold/core';
import {EntityEventProcessor, type EntityProcessor} from '@etherfold/processor-entities';
import {IndexedDBStateStore, type IndexedDBStateStoreOptions} from '@etherfold/state-store-indexeddb';
import {openForReading, openForWriting, type EntityDeclaration, type StateStoreBackend} from '@etherfold/state-store';
import type {QueryExecutorFactory, QuerySubject} from '../src/conformance/index.js';
import {graphqlQueryHandler, workerExecutor} from '../src/worker/index.js';

/**
 * THE WORKER HOSTS the query conformance suite is asked of: `@etherfold/browser`'s
 * own host (`serveIndexerHost`, which IS what `hostIndexerInThisWorker` runs, and
 * `hostIndexerInThisSharedWorker` behind a faked shared scope), over real
 * `MessagePort`s, with `graphqlQueryHandler` injected, and `workerExecutor` over
 * the tab's port.
 *
 * The suite writes blocks through the store itself, so the host must never fold:
 * its chain answers `eth_chainId` (the container opens, claims the store through
 * the app's `createState` and answers reads) and nothing else ever, so the
 * driver waits for ever and writes nothing. The suite's writes go through the
 * same store object the host claimed, which is how a fold's writes reach it.
 */

const abi = [{type: 'event', name: 'Ping', anonymous: false, inputs: []}] as const satisfies Abi;
type PingABI = typeof abi;

const SOURCE: IndexingSource<PingABI> = {
	chainId: '1',
	contracts: [{abi, address: '0x00000000000000000000000000000000000000aa', startBlock: 1}],
};

/** A chain that says which it is and then never answers again, so the fold never moves. */
const silentChain = {
	async request(args: {method: string}): Promise<unknown> {
		if (args.method === 'eth_chainId') return '0x1';
		return new Promise(() => undefined);
	},
} as never;

/** What names the fold, so a reader can name the generation before the leader has said anything. */
const PROCESSOR_IDENTITY = 'graphql-worker-conformance';

let databases = 0;

type HostKind = 'dedicated-worker' | 'shared-worker';

/** A subject's tab port, and how to kill its host, kept beside the subject for the transport cases. */
const hosts = new WeakMap<QuerySubject, {port: IndexerPort; terminate(): void}>();

export type WorkerExecutorOptions = IndexedDBStateStoreOptions & {
	readonly rowsExaminedBound?: number;
	/**
	 * The handler the host is built with; defaults to
	 * `graphqlQueryHandler({accessor: {rowsExaminedBound}})`, and `false` builds a
	 * host whose entry passed none.
	 */
	readonly query?: HostQueryHandler | false;
	/**
	 * How the host's app opens the fresh IndexedDB store before it is handed to
	 * `createState` (and to the suite, which writes through the same handle): by
	 * default it is used as it is. The WRITER is the store the subject writes
	 * and a host claims; a READER is the shared store a host under the tab
	 * election opens for reading (`readerHostExecutor`).
	 */
	readonly open?: (store: IndexedDBStateStore, role: 'writer' | 'reader') => Promise<StateStoreBackend>;
};

function specOver(
	declarations: readonly EntityDeclaration[],
	store: StateStoreBackend,
	query: HostQueryHandler | undefined,
	extra: Partial<HostedIndexerSpec<PingABI, unknown>> = {},
): HostedIndexerSpec<PingABI, unknown> {
	const processor: EntityProcessor<PingABI> = {entities: [...declarations], async onPing() {}};
	return {
		createState: async (_context, {signal}) => openForWriting(store, {signal}),
		createProcessor: (state) => new EntityEventProcessor<PingABI>(state, processor),
		provider: silentChain,
		source: SOURCE,
		processorIdentity: PROCESSOR_IDENTITY,
		...(query ? {query} : {}),
		...extra,
	};
}

/** Build a host of the kind asked for, over a real `MessageChannel`, and a tab's port to it. */
function hostAndPort(
	kind: HostKind,
	spec: HostedIndexerSpec<PingABI, unknown>,
): {host: IndexerHost; port: IndexerPort; terminate(): void} {
	const channel = new MessageChannel();
	const hostEnd = channel.port1 as unknown as MessageEndpoint;
	let host: IndexerHost;
	if (kind === 'dedicated-worker') {
		// `hostIndexerInThisWorker` is this call over the worker's global scope.
		host = serveIndexerHost(spec, {host: 'dedicated-worker', endpoint: hostEnd});
	} else {
		const scope = sharedWorkerScope();
		try {
			host = hostIndexerInThisSharedWorker(spec);
			scope.connect(hostEnd);
		} finally {
			scope.restore();
		}
	}
	const port = connectToIndexerHost(
		{host: kind, endpoint: channel.port2 as unknown as MessageEndpoint, close: () => channel.port2.close()},
		// A dead host is concluded from silence: watched briskly, and never restarted.
		{watch: {everyInSeconds: 0.1}, restart: false},
	);
	return {
		host,
		port,
		terminate() {
			// What a terminated worker does: stops answering, and nobody tells the port.
			host.dispose();
			channel.port1.close();
		},
	};
}

async function until<T>(what: string, check: () => Promise<T | undefined | false>): Promise<T> {
	for (let attempt = 0; attempt < 500; attempt++) {
		const value = await check();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** The digest of the generation the host answers from: its canonical one, as its port reports it. */
async function canonicalDigest(port: IndexerPort): Promise<string> {
	const canonical = await until('the host to open its container', async () =>
		(await port.generations()).find((generation) => generation.canonical),
	);
	return generationDigestOf(canonical.record);
}

function freshStore(declarations: readonly EntityDeclaration[], options: IndexedDBStateStoreOptions) {
	const databaseName = `etherfold-graphql-worker-${++databases}-${Math.random().toString(36).slice(2, 10)}`;
	return {databaseName, store: new IndexedDBStateStore(declarations, {databaseName, ...options})};
}

/** The worker executor over a host of `kind` that holds the store and writes it. */
export function workerHostExecutor(
	kind: HostKind,
	{rowsExaminedBound, query, open, ...options}: WorkerExecutorOptions = {},
): QueryExecutorFactory {
	return async (declarations) => {
		const fresh = freshStore(declarations, options).store;
		const store = open ? await open(fresh, 'writer') : fresh;
		await store.migrate();
		const handler = query === false ? undefined : (query ?? graphqlQueryHandler({accessor: {rowsExaminedBound}}));
		const {port, terminate} = hostAndPort(kind, specOver(declarations, store, handler));
		const generation = await canonicalDigest(port);
		const subject: QuerySubject = {store, executor: workerExecutor(port), generation};
		hosts.set(subject, {port, terminate});
		return subject;
	};
}

/**
 * The worker executor over a READER under the tab election (ADR-0097): a leader
 * host holds the lock and the store, a second host finds the lock held and reads
 * the shared store it opened for reading, and the executor asks the READER.
 */
export function readerHostExecutor({
	rowsExaminedBound,
	open,
	...options
}: WorkerExecutorOptions = {}): QueryExecutorFactory {
	return async (declarations) => {
		const {store: fresh, databaseName} = freshStore(declarations, options);
		const store = open ? await open(fresh, 'writer') : fresh;
		await store.migrate();
		const election = {tabElection: {name: `graphql-election-${databases}-${Math.random().toString(36).slice(2)}`}};
		const openState = async () => {
			const opened = new IndexedDBStateStore(declarations, {databaseName, ...options});
			const shared = open ? await open(opened, 'reader') : opened;
			await shared.migrate();
			return {store: openForReading(shared), state: undefined};
		};
		const handler = graphqlQueryHandler({accessor: {rowsExaminedBound}});
		const leader = hostAndPort('dedicated-worker', specOver(declarations, store, handler, {...election, openState}));
		const generation = await canonicalDigest(leader.port);
		// A second store object the reader never writes through: the reader host must not claim.
		const reader = hostAndPort(
			'dedicated-worker',
			specOver(declarations, new IndexedDBStateStore(declarations, {databaseName, ...options}), handler, {
				...election,
				openState,
			}),
		);
		await until('the second host to read', async () => (await reader.port.progress()).election?.role === 'reader');
		await reader.port.reads.declarations();
		const subject: QuerySubject = {store, executor: workerExecutor(reader.port), generation};
		hosts.set(subject, reader);
		return subject;
	};
}

/**
 * The worker executor over the MAIN-THREAD host (`createIndexerState(...)
 * .mainThreadHost({query})`): the same port surface, on the thread the app runs.
 */
export function mainThreadHostExecutor({
	rowsExaminedBound,
	...options
}: WorkerExecutorOptions = {}): QueryExecutorFactory {
	return async (declarations) => {
		const {store} = freshStore(declarations, options);
		await store.migrate();
		const spec = specOver(declarations, store, undefined);
		const indexer = createIndexerState<PingABI, unknown>({
			createState: spec.createState,
			createProcessor: spec.createProcessor,
			processorIdentity: PROCESSOR_IDENTITY,
		});
		await indexer.init({provider: silentChain, source: SOURCE});
		const port = connectToIndexerHost(
			indexer.mainThreadHost({query: graphqlQueryHandler({accessor: {rowsExaminedBound}})}),
			{watch: false},
		);
		const generation = await canonicalDigest(port);
		const subject: QuerySubject = {store, executor: workerExecutor(port), generation};
		hosts.set(subject, {port, terminate: () => indexer.dispose()});
		return subject;
	};
}

/** Close the subject's tab port: every later query meets a closed port. */
export function closePort(subject: QuerySubject): void {
	hosts.get(subject)!.port.close();
}

/** Terminate the subject's host: every later query meets a host that is gone. */
export function terminateHost(subject: QuerySubject): void {
	hosts.get(subject)!.terminate();
}

/** The subject's tab port, for a test that asks it directly. */
export function portOf(subject: QuerySubject): IndexerPort {
	return hosts.get(subject)!.port;
}

/**
 * A SharedWorker's global scope, for as long as a host is being built in it: the
 * `connect` event is the one thing a shared scope has that this node global does
 * not. (The same fake `@etherfold/browser`'s own tests use.)
 */
function sharedWorkerScope(): {connect: (port: MessageEndpoint) => void; restore: () => void} {
	type Scope = {onconnect?: unknown; addEventListener?: unknown; removeEventListener?: unknown};
	const scope = globalThis as Scope;
	const before = {
		hadOnconnect: 'onconnect' in scope,
		addEventListener: scope.addEventListener,
		removeEventListener: scope.removeEventListener,
	};
	const listeners = new Set<(event: {ports: MessageEndpoint[]}) => void>();
	scope.onconnect = null;
	scope.addEventListener = (type: string, listener: (event: {ports: MessageEndpoint[]}) => void) => {
		if (type === 'connect') listeners.add(listener);
	};
	scope.removeEventListener = (_type: string, listener: (event: {ports: MessageEndpoint[]}) => void) => {
		listeners.delete(listener);
	};
	return {
		connect(port) {
			for (const listener of [...listeners]) listener({ports: [port]});
		},
		restore() {
			if (!before.hadOnconnect) delete scope.onconnect;
			if (before.addEventListener === undefined) delete scope.addEventListener;
			else scope.addEventListener = before.addEventListener;
			if (before.removeEventListener === undefined) delete scope.removeEventListener;
			else scope.removeEventListener = before.removeEventListener;
		},
	};
}
