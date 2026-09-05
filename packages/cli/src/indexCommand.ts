import {resolveStreamConfig, StreamBuilder, type Abi, type EventProcessor, type IndexingSource} from '@etherfold/core';
import type {EnvRecord} from '@etherfold/fetcher-host';
import type {RunningServer, StartOptions} from '@etherfold/platform-nodejs';
import {stopOnSignals} from '@etherfold/platform-nodejs-fetcher';
import type {EntityProcessor, StateStore} from '@etherfold/processor-entities';
import {instantiateProcessor, loadProcessorModule} from '@etherfold/utils';
import {logs} from 'named-logs';
import type {RemoteSQL} from 'remote-sql';
import {resolveCommandConfig} from './config.js';
import {readCursorReport} from './cursorReport.js';
import {buildProcessor, openExplicitSource, streamConfigFor} from './folding.js';
import type {IndexConfig, Options} from './types.js';

const logger = logs('etherfold');

// ---------------------------------------------------------------------------------------------------
// `etherfold index`: THE FOLDING HALF, RECEIVING A PUSHED STREAM AND OWNING THE DATABASE
// ---------------------------------------------------------------------------------------------------
// The half a split deployment was missing. The chain-facing half has been
// runnable all along (`etherfold fetch`); what nothing assembled was a server
// that HOLDS a processor, so a pushed batch met a `501` and the split had a
// sender and no receiver.
//
// This is that receiver: it folds batches another process pushed to it, through
// the same `StreamBuilder` -> `EntityEventProcessor` -> `VersionedStateStore`
// chain `run` folds through, on ONE libSQL handle it also hands to the server.
// So `run` and `fetch` plus `index` are the same components with the transport
// as the only difference, which is what makes the split a DEPLOYMENT CHOICE
// rather than a second implementation.
//
// Four things define it, and each is a constraint rather than a feature:
//
//  1. **It makes NO chain call**, anywhere in this path. There is no provider
//     here, no `LogFetcher` and no fetcher host, which is why its source must be
//     given EXPLICITLY: the wire identity is derived from the source and the
//     stream config together, so a source resolved by asking a node which chain
//     it is on could not be the sender's. A processor module whose contracts are
//     keyed per chain is therefore refused by name (`requireExplicitSource`),
//     naming the two explicit forms, rather than quietly costing an
//     `eth_chainId`.
//  2. **It exposes the WRITE path and not the query API**, and that asymmetry is
//     the point: a split deployment is `index` plus `serve` against ONE
//     database, the writer and a stateless read tier, and that shape falls out
//     of the command set instead of needing to be explained. `/status` is
//     available because there is an HTTP surface, and it reports on the DATABASE
//     rather than on the process.
//  3. **It authenticates or it refuses everyone.** The shared secret is REQUIRED
//     (`src/config.ts`), so a receiver with none configured never binds a port:
//     the guard on `/{indexer}/ingest` fails closed, and a process that came up
//     regardless would be an endpoint answering `401` to a sender that had no
//     way to know why. The secret this command resolved is passed to the host
//     rather than left to the ambient environment, so the flag and the variable
//     mean the same thing here as they do on `fetch`.
//  4. **It does not terminate.** A receiver has no tip to stop at -- what it
//     folds arrives from somewhere else -- so it ends on a signal, exactly as
//     `run` does, and never on a report.
//  5. **It hosts a NAMED INDEXER**, and the name is the operator's
//     (`--indexer`, `INDEXER_NAME`): this process registers exactly the one name
//     it was given, and every other is refused with a `404` rather than served
//     by the only indexer this host happens to hold (ADR-0036). ONE name per
//     process is what this command builds today; a host registering SEVERAL is a
//     registry with more entries in it and no change to the route
//     (`ServerOptions.getIndexer`).
// ---------------------------------------------------------------------------------------------------

/** Starts the HTTP surface. Defaults to the Node platform adapter's `startServer`, imported lazily. */
export type ServerStart = (options: StartOptions) => Promise<RunningServer>;

/** What a test may substitute for the real world. A deployment substitutes none of it. */
export type IndexDependencies = {
	/** Loads the processor module. Defaults to a dynamic `import()`. */
	importModule?: (specifier: string) => Promise<any>;
	/** Builds the libSQL handle for the store. Defaults to `createNodeDB`. */
	createDB?: (url: string) => RemoteSQL;
	/** Substituted by a test; a deployment uses the Node adapter. */
	startServer?: ServerStart;
	/**
	 * Stop on SIGINT and SIGTERM. On by default, because that is what a container
	 * sends. Off in a test, which stops it through `deps.signal` or `stop()`
	 * instead of installing handlers on the test runner's process.
	 */
	handleSignals?: boolean;
	/** Stops the receiver from outside, the way a signal handler would. */
	signal?: AbortSignal;
	/** Where the startup lines go. Defaults to the console. */
	log?: (...args: unknown[]) => void;
	/** The environment flags fall back to. Defaults to `process.env`. */
	env?: EnvRecord;
};

/** An `index` process, from the outside: what it receives on, what it folds into, and how to stop it. */
export type RunningReceiver<ABI extends Abi = Abi, ProcessResultType = unknown> = {
	/** Where the HTTP surface is answering, with the port the OS actually gave it. */
	url: string;
	port: number;
	/** The ONE handle the store folds into and the server answers over. */
	db: RemoteSQL;
	store: StateStore;
	processor: EventProcessor<ABI, ProcessResultType>;
	/** What it indexes, which is also half of the wire identity a sender must assert. */
	source: IndexingSource<ABI>;
	/**
	 * The receiving half itself: authoritative about the cursor, deriving every
	 * reorg, making no chain call. Exposed so a caller can assert WHICH engine
	 * folds -- and read the `{source, config}` a sender has to match -- rather
	 * than trust it.
	 */
	streamBuilder: StreamBuilder<ABI, ProcessResultType>;
	/**
	 * Resolves when it has been asked to stop, which is the only way a receiver
	 * ends: a signal, or `stop()`. Reaching a tip is not one of the ways, because
	 * this process has no tip -- what it folds arrives from somewhere else.
	 */
	stopped: Promise<void>;
	/** Ask it to stop, wait for it, and shut the server down. */
	stop(): Promise<void>;
	/** Stop listening and drop the signal handlers, without asking it to stop. */
	close(): Promise<void>;
};

/**
 * Assemble the receiving half and start answering on it.
 *
 * Returns as soon as it is up -- the same shape `run` and `startFetcher` already
 * have -- so a caller gets something it can query and stop, and `indexMain` is
 * the thin part that turns "stopped" into an exit code.
 *
 * The ORDER is the same contract `prepareIndexing` keeps: the configuration is
 * resolved FIRST and is pure (a flag this command does not own, a missing
 * database, a missing secret or a source only a node could supply is refused
 * before anything is opened), then the module is loaded and the store is built,
 * and only then is a port bound. A configuration this command refuses therefore
 * leaves no database open, no port bound and no signal handler installed.
 */
export async function index<ABI extends Abi = Abi, ProcessResultType = unknown>(
	options: Options,
	deps: IndexDependencies = {},
): Promise<RunningReceiver<ABI, ProcessResultType>> {
	const log = deps.log ?? console.log;
	const env = deps.env ?? (process.env as EnvRecord);

	// Stopping a receiver is a signal, so ONE controller carries every way of
	// asking: the process's signals, a caller's `stop()`, and whatever the caller
	// passed in as `deps.signal`.
	const controller = new AbortController();
	const stop = () => controller.abort();
	if (deps.signal?.aborted) {
		controller.abort();
	} else {
		deps.signal?.addEventListener('abort', stop, {once: true});
	}
	// Nothing is INSTALLED on the process yet: a configuration this command
	// refuses never starts anything, so it must not leave a signal handler behind
	// either.
	let releaseSignals = () => {};
	try {
		// FIRST, and pure: nothing is imported, opened or bound before this returns.
		const config: IndexConfig<ABI> = resolveCommandConfig<'index', ABI>('index', options, env);
		logger.info({store: config.destination.store, source: config.source.from, port: config.serving.port});

		const processorModule = await loadProcessorModule<ABI, ProcessResultType>(config.processor, {
			...(deps.importModule ? {importModule: deps.importModule} : {}),
		});
		const declared = instantiateProcessor<ABI, ProcessResultType, EntityProcessor<ABI, any>>(processorModule, {
			processorPath: config.processor,
		});

		const providedStreamConfig = streamConfigFor(env);
		const streamConfig = resolveStreamConfig(providedStreamConfig);
		const {processor, store, db, recordReorg, appendEmissions} = await buildProcessor<ABI, ProcessResultType>(
			declared,
			config.destination,
			{
				finalityDepth: streamConfig.finality,
				// the name the OPERATOR gave, which is also the route segment a sender
				// addresses: one value, required here and never defaulted, because on this
				// half it routes as well as keys (ADR-0036)
				indexer: config.wire.indexer,
				...(deps.createDB ? {createDB: deps.createDB} : {}),
			},
		);

		// No provider, and no `resolveSource` fallback: this is the whole of how a
		// chain-free command learns what it indexes.
		const source = await openExplicitSource<ABI>(config.source);

		// The receiving half of ADR-0004, and the SAME object `run` folds through:
		// authoritative about the cursor, deriving every reorg, making no chain call.
		// It reads the persisted cursor on every batch rather than holding one, which
		// is what makes a resumed or replayed push safe.
		// ...and it counts the reverts it concludes, and stores the emissions it folded,
		// through the two ports the store's owner built, exactly as `run` and `build`
		// do. The ingest route below is a CALLER of `receive` and writes neither itself,
		// so a process that both concludes and receives cannot double-count a revert
		// (ADR-0050) or store a batch twice (ADR-0052).
		const streamBuilder = new StreamBuilder<ABI, ProcessResultType>(processor, source, {
			stream: providedStreamConfig,
			recordReorg,
			appendEmissions,
		});

		// The store's own tables, before a port is bound rather than when the first
		// push lands. A receiver OWNS its database, and everything `load` refuses -- an
		// illegal entity declaration, a retention window that does not cover what a
		// reorg can reach -- is a fact about this deployment rather than about the
		// batch that happened to arrive first. Discovered lazily it would be a `500` to
		// a sender, on a process still reporting itself healthy; discovered here it is
		// a refusal that never starts. It is idempotent (`ensureMigrated`), so the
		// stream-builder's own `load` on every batch costs nothing extra, and it is
		// deliberately NOT gated on `--no-auto-setup`: that flag is about the SERVER's
		// fixed-table schema, and the entity tables are the store's own, which the
		// first batch would create anyway.
		await processor.load(source, streamConfig);

		releaseSignals = deps.handleSignals === false ? () => {} : stopOnSignals(controller);

		const start = deps.startServer ?? defaultStartServer;
		const server = await start({
			// ONE handle, two users: the store folds into it and the server answers
			// over it. Two connections to one URL would be two views of it, and
			// against `:memory:` not even the same database.
			db,
			port: config.serving.port,
			...(config.serving.hostname === undefined ? {} : {hostname: config.serving.hostname}),
			autoSetup: config.serving.autoSetup,
			// The secret this command RESOLVED (flag first, `INGEST_TOKEN` behind it),
			// handed over rather than left to the ambient environment, so the wire's one
			// name means the same thing on both halves of a split deployment.
			env: {INGEST_TOKEN: config.wire.token},
			// What makes this command the RECEIVER: the capability is injected by the
			// host, because which processor runs against which source -- and under which
			// NAME -- is a deployment's choice and not an HTTP app's. Without it the same
			// routes answer `501`; with it, they answer for this one name and refuse every
			// other with a `404`.
			// Written out rather than built with `indexerRegistry` (`@etherfold/server`)
			// for the same reason the server is imported LAZILY below: this module's
			// assembly must not pull hono into a process that only folds.
			getIndexer: (_c, name) => (name === config.wire.indexer ? {ingestion: streamBuilder} : undefined),
			// ...and this is what makes a split deployment observable: `index` owns the
			// store, so it is the half that can say where the fold has got to. A read
			// tier owns none and is given none.
			getCursorReport: () => readCursorReport(store),
		});

		const close = async () => {
			releaseSignals();
			deps.signal?.removeEventListener('abort', stop);
			await server.close();
		};

		const stopped = new Promise<void>((resolve) => {
			if (controller.signal.aborted) return resolve();
			controller.signal.addEventListener('abort', () => resolve(), {once: true});
		});

		log(
			`etherfold index: receiving pushes for ${JSON.stringify(config.wire.indexer)} on ` +
				`${server.url}/${config.wire.indexer}/ingest, folding into ${config.destination.db}`,
		);
		log(`  status: ${server.url}/status`);
		logger.info(`index: listening on ${server.url}, folding into ${config.destination.db}`);

		return {
			url: server.url,
			port: server.port,
			db,
			store,
			processor,
			source,
			streamBuilder,
			stopped,
			stop: async () => {
				controller.abort();
				await close();
			},
			close,
		};
	} catch (err) {
		// it never started: leave no handler on the process and no listener on the
		// caller's signal
		releaseSignals();
		deps.signal?.removeEventListener('abort', stop);
		throw err;
	}
}

/**
 * `etherfold index` as a PROCESS: start it, keep receiving until something stops
 * it, and resolve the exit code.
 *
 * `0` when it was ASKED to stop (a signal, which is the only ordinary way a
 * receiver ends) and `1` when it could not start at all -- a refused
 * configuration, a module it cannot drive, a database it cannot open. The
 * distinction is the same one `runMain` and `runFetcherProcess` make, for the
 * same reason: a process that is up and achieving nothing is indistinguishable
 * from a working one until somebody reads the state it is not producing.
 */
export async function indexMain(
	options: Options,
	deps: IndexDependencies & {
		exit?: (code: number) => void;
		error?: (...args: unknown[]) => void;
	} = {},
): Promise<void> {
	const exit = deps.exit ?? ((code: number) => process.exit(code));
	const error = deps.error ?? console.error;

	let running: RunningReceiver | undefined;
	try {
		running = await index(options, deps);
		await running.stopped;
		await running.close();
		exit(0);
	} catch (err) {
		error(err);
		await running?.close().catch(() => undefined);
		exit(1);
	}
}

async function defaultStartServer(options: StartOptions): Promise<RunningServer> {
	// Imported lazily for the same reason `run` and `serve` do it: the commands
	// that share this module's assembly must not pay for the server's dependency
	// tree (hono, the node HTTP adapter) to fold into a database.
	const {startServer} = await import('@etherfold/platform-nodejs');
	return startServer(options);
}
