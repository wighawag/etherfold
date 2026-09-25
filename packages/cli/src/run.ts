import type {Abi, EventProcessor, ReceivingIndexer, StreamWriter} from '@etherfold/core';
import type {FetcherHost, RunSummary} from '@etherfold/fetcher-host';
import type {RunningServer, StartOptions} from '@etherfold/platform-nodejs';
import {stopOnSignals} from '@etherfold/platform-nodejs-fetcher';
import type {WritableStateStore} from '@etherfold/processor-entities';
import {logs} from 'named-logs';
import type {RemoteSQL} from 'remote-sql';
import {foldingStatusReport} from './folding.js';
import {prepareIndexing, type IndexingDependencies} from './index.js';
import type {Options} from './types.js';

const logger = logs('etherfold');

// ---------------------------------------------------------------------------------------------------
// `etherfold run`: ONE PROCESS THAT FOLLOWS, FOLDS AND ANSWERS
// ---------------------------------------------------------------------------------------------------
// The command the whole command set exists for (`CONTEXT.md`, "The COMBINED
// deployment is the milestone; the SPLIT is a deployment choice"). It is
// ASSEMBLY and nothing else: the two ADR-0003 halves wired together in one
// process by `createDirectIngestion`, folding through the same `StreamBuilder` a
// split deployment receives into, over the same store, on ONE libSQL handle --
// all of which is `prepareIndexing`, shared verbatim with the one-shot.
//
// `run` is that assembly with TWO differences and no third:
//
//  1. **It does not stop at the tip.** The abort the one-shot fires from its
//     first caught-up or idle report is not fired here (`driveCycles`,
//     `src/index.ts`), so it follows the tip and backs off to the poll interval
//     when there is nothing above the cursor. Stopping is a SIGNAL, not a report.
//  2. **It serves.** The server starts on the handle the store folds into, with a
//     cursor reporter that reads that store, so `/status` reports a cursor that
//     ADVANCES while the process runs.
//
// And one thing it deliberately does NOT do: it accepts no INGESTION. A remote
// sender pushing into a process that is already fetching for itself would be a
// second writer nobody asked for, so the namespaced ingestion routes answer
// `501 ingestion-not-accepted` to an authenticated caller (`401` to an
// unauthenticated one: the token guard sits on the PATH, ahead of the capability
// lookup, so what this deployment does is not something an anonymous caller can
// probe). The command for receiving pushes is `index`.
//
// That refusal covers the WRITE path and nothing else. It used to be expressed
// by registering NO named indexer at all, which took the FEED, the canonical
// pointer, the state-moved signal and the operator's own promote/revert route
// down with it -- every one of them dark on the shape most apps point at, and
// none of that was ever decided. So this process registers the one name it folds
// under as a READ-ONLY entry: `liveIngestions` is left OFF, which the registry
// seam reads as "this name accepts no ingestion" (`IndexerRegistryEntry`,
// `@etherfold/server`), and everything else that name holds answers.
//
// ## It HOLDS GENERATIONS, and it is the shape that may add one and promote one
//
// The fold is a GENERATION in a durable registry over the handle it folds into
// (`openFolding`, `folding.ts`), exactly as `index`'s is, so what a developer
// tests locally is what deploys down to which tables the state lands in. What
// `run` has that `build` has not is TIME: it is a long-running host, so a
// successor may be added BESIDE the live fold (`RunningIndexer.container`), it is
// advanced by a bounded rebuild between fetch cycles, and the canonical pointer
// moves when it catches up. Nothing about the state a reader sees moves while it
// does: the successor folds into its own table namespace and the pointer moves
// once, at the end.
//
// ## ...and it is the shape a RECONFIGURE can reach
//
// A successor used to arrive exactly one way -- by restarting this process, so
// that the container registered a new generation as it OPENED -- because nothing
// watched a file and no route added one. `POST /{indexer}/admin/reconfigure`
// (`@etherfold/server`) is the trigger that removes the restart, and this process
// answers it: it RE-READS its own configuration, re-imports the processor module
// and registers whatever generation that names beside the live fold
// (`reconfigure.ts`). Whatever noticed the file changed stays OUTSIDE, so one
// mechanism serves a dev watcher, a deploy hook and a CI step, and this process
// never grows an opinion about how anybody's editor saves files.
// ---------------------------------------------------------------------------------------------------

/** Starts the HTTP surface. Defaults to the Node platform adapter's `startServer`, imported lazily. */
export type ServerStart = (options: StartOptions) => Promise<RunningServer>;

export type RunDependencies = IndexingDependencies & {
	/** Substituted by a test; a deployment uses the Node adapter. */
	startServer?: ServerStart;
	/**
	 * Stop on SIGINT and SIGTERM. On by default, because that is what a container
	 * sends. Off in a test, which stops it through `deps.signal` or `stop()`
	 * instead of installing handlers on the test runner's process.
	 */
	handleSignals?: boolean;
	/** Where the startup lines go. Defaults to the console. */
	log?: (...args: unknown[]) => void;
};

/** A `run` process, from the outside: what it answers on, what it folds into, and how to stop it. */
export type RunningIndexer<ABI extends Abi = Abi, ProcessResultType = unknown> = {
	/** Where the HTTP surface is answering, with the port the OS actually gave it. */
	url: string;
	port: number;
	/** The ONE handle the store folds into and the server answers over. */
	db: RemoteSQL;
	store: WritableStateStore;
	processor: EventProcessor<ABI, ProcessResultType>;
	/**
	 * The OPENING fold's receiving half. Present so a caller can assert WHICH engine
	 * folds, rather than trust it -- and ABSENT where that fold has none, which under
	 * ADR-0087 is an ordinary state rather than a crash (`FoldingAssembly`). What this
	 * process FEEDS is resolved per ask from the container, never from here.
	 */
	streamWriter: StreamWriter<ABI>;
	/**
	 * THE GENERATIONS THIS PROCESS HOLDS: the registry, the canonical pointer, and
	 * the folds over them.
	 *
	 * Exposed because this is the shape that may grow one. A reconfigure reaching a
	 * long-running host is `container.add(...)`, which registers a SUCCESSOR beside
	 * the live fold rather than discarding its state, and the pointer moves on its
	 * own once that successor has caught up. It is the same object `index` holds and
	 * the same one `/status` is reported from.
	 */
	container: ReceivingIndexer<ABI, ProcessResultType, WritableStateStore>;
	/** The sending half, plus the policy for reading what a cycle did. */
	host: FetcherHost<ABI>;
	/**
	 * Resolves when the loop has stopped, with what the run did; REJECTS with the
	 * error of a `fatal` report, which is a refusal no waiting fixes.
	 */
	stopped: Promise<RunSummary>;
	/** Ask it to stop after the cycle in flight, wait for it, and shut the server down. */
	stop(): Promise<RunSummary>;
	/** Stop listening and drop the signal handlers, without asking the loop to stop. */
	close(): Promise<void>;
};

/**
 * Assemble the pipeline, start the server on the handle it folds into, and start
 * following the chain.
 *
 * Returns as soon as both are up -- the same shape `startServer`
 * (`@etherfold/platform-nodejs`) and `startFetcher`
 * (`@etherfold/platform-nodejs-fetcher`) already have -- so a caller gets
 * something it can query and stop, and `runMain` is the thin part that turns
 * "stopped" into an exit code.
 *
 * The ORDER matters twice over. The configuration is resolved and the module,
 * the store and the source are opened FIRST, inside `prepareIndexing`, so a
 * missing node URL or a module this command cannot drive is refused before a
 * port is bound. Then the server starts, and only then the loop: a process that
 * is following the chain is one an operator can already ask `/status`.
 */
export async function run<ABI extends Abi = Abi, ProcessResultType = unknown>(
	options: Options,
	deps: RunDependencies = {},
): Promise<RunningIndexer<ABI, ProcessResultType>> {
	const log = deps.log ?? console.log;

	// Stopping a follower is a signal, so ONE controller carries every way of
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
	// refuses never starts a loop, so it must not leave a signal handler behind
	// either. `releaseSignals` stays a no-op until there is something to stop.
	let releaseSignals = () => {};
	try {
		const prepared = await prepareIndexing<ABI, ProcessResultType, 'run'>('run', options, {
			...deps,
			signal: controller.signal,
		});
		const {serving, destination, indexer} = prepared.config;

		// The Node fetcher adapter's own handler, reused rather than written again:
		// which signals a container sends, and what happens to the cycle in flight, is
		// one answer for every process this repo runs.
		releaseSignals = deps.handleSignals === false ? () => {} : stopOnSignals(controller);

		const start = deps.startServer ?? defaultStartServer;
		const server = await start({
			// ONE handle, two users: the store folds into it and the server answers
			// over it. Two connections to one URL would be two views of it, and
			// against `:memory:` not even the same database.
			db: prepared.db,
			port: serving.port,
			...(serving.hostname === undefined ? {} : {hostname: serving.hostname}),
			autoSetup: serving.autoSetup,
			// THE ONE NAME THIS PROCESS FOLDS UNDER, registered READ-ONLY: every row of
			// its stored stream and every row of its generation registry is already keyed
			// on this value (ADR-0036), so the routes that read them resolve to what this
			// process already holds, and every other name is a `404` rather than this
			// one's answers served under a name an app guessed.
			//
			// `liveIngestions` is ABSENT, and that absence is the whole write-path
			// refusal: the seam reads it as "this name accepts no ingestion"
			// (`IndexerRegistryEntry`, `@etherfold/server`) and the ingest routes answer
			// `501 ingestion-not-accepted`. It is deliberately NOT an empty list, which
			// means "no live wire contexts right now" on a host that DOES accept pushes
			// -- a transient state, not this permanent one -- and it is deliberately not
			// left to `INGEST_TOKEN` being unset, which is a door an operator opens by
			// setting a variable for an unrelated reason.
			//
			// Written out rather than built with `indexerRegistry` / `indexerEntryOn`
			// (`@etherfold/server`) for the same reason the server is imported LAZILY
			// below: this module's assembly must not pull hono into a process that only
			// folds (`etherfold build` shares it). The questions are FORWARDED rather
			// than spread, because they are methods on an object that reads its own
			// durable state: copying them off the container would unbind them.
			getIndexer: (_c, name) =>
				name === indexer
					? {
							// THE DATABASE THIS NAME OWNS (ADR-0053): the one handle the store folds
							// into and this server answers over, which is what makes the feed a read of
							// the rows this process is writing rather than of somebody else's.
							db: prepared.db,
							// WHICH generation answers reads, read from the durable pointer on every
							// question -- not the fold this process happens to run, which is not the
							// same thing while a successor is catching up.
							canonicalGeneration: () => prepared.container.canonicalGeneration(),
							// ...and what there is to point AT, plus the move itself (ADR-0057). This
							// is the shape that HOLDS generations and may add one, so it is a shape an
							// operator may need to revert: a bad upgrade here is reverted over HTTP
							// exactly as it is on `index`, rather than by restarting the process.
							generations: () => prepared.container.generations(),
							promote: (id) => prepared.container.promote(id),
							// ...and WHAT EACH SLOT NAMES, plus the verb that takes what NONE of them
							// does (ADR-0084). This is the shape that ACCUMULATES generations -- every
							// reconfigure registers one beside the live fold -- so it is the shape whose
							// operator most needs the disk back, and a cap that refuses here names what
							// could be deleted and would otherwise hand over nothing to delete it with.
							slots: () => prepared.container.slots(),
							reclaim: () => prepared.container.reclaim(),
							// ...and WHETHER EACH GENERATION CAN FOLD HERE (ADR-0092): held, instantiable from
							// its stored bundle, or frozen and why -- what an operator reads before a revert.
							folding: () => prepared.container.folding(),
							// ...and the TRIGGER that gives an operator something to point AT: this
							// process RE-READS its own configuration and registers whatever generation
							// that now names, beside the live fold (`reconfigure.ts`). `run` is the shape
							// that can answer it -- it holds the module path, the source and the container
							// at once -- so a changed processor reaches a RUNNING deployment instead of
							// waiting for a restart, and nothing stops answering while it does.
							reconfigure: () => prepared.reconfigure(),
							// ...and the SIGNAL this fold publishes as it applies each block (ADR-0083),
							// with the token it is publishing under. A combined process APPLIES the
							// blocks, so it is a shape that can tell a reader the state moved; the two
							// are forwarded together because a stream that could deliver notifications
							// but not say which token is in force could not answer a reconnecting
							// client.
							onStateMoved: (handler) => prepared.container.onStateMoved(handler),
							coherenceNow: () => prepared.container.coherenceNow(),
						}
					: undefined,
			// ONE entry per generation held, which is one until something adds a
			// successor and two while it catches up: the shape of `/status` does not
			// depend on how many a deployment happens to hold.
			getCursorReport: () => foldingStatusReport(prepared.container),
			// The other half of the pipeline, on the same page: what the CHAIN-FACING half
			// has learned about the node it reads (ADR-0074). `run` is the shape that can
			// report it at all, because it is the one that holds both halves -- `index` and
			// `serve` inject none and their `/status` carries no `fetcher` field.
			//
			// Reported so an operator can hand it BACK through `LEARNED_RANGE` on the next
			// start. Nothing here persists it: the fetcher holds no state worth losing, and
			// this is what moves the memory to whoever is already durable.
			getFetcherLimits: () => prepared.host.fetcher.limits,
			// WHEN THIS PROCESS TAKES A SUCCESSOR OVER, on the page an operator already
			// watches. `run` is the shape that decides it at all -- it is the one command
			// that registers a successor beside a live fold -- and this is the CONTAINER's
			// resolved answer rather than the CLI's parsed flag, so what is read back is
			// what the thing that moves the pointer will actually do, default included.
			getPromotionPolicy: () => prepared.container.promotion,
		});

		const close = async () => {
			releaseSignals();
			deps.signal?.removeEventListener('abort', stop);
			await server.close();
		};

		const stopped = prepared.index();
		// A `fatal` rejects this promise, and the caller holding the handle is who
		// gets it. Attaching a no-op handler here keeps Node from reporting an
		// unhandled rejection in the window before that caller awaits it; it does not
		// swallow anything, because a promise may have any number of reactions.
		stopped.catch(() => undefined);

		log(`etherfold run: following the chain into ${destination.db}, answering on ${server.url}`);
		log(`  status: ${server.url}/status`);
		// WHERE THE READS ARE, named because the route segment is the one thing an app
		// pointed at this process has to know and the one thing it cannot guess: this
		// name may have been defaulted. `index` prints its ingest URL for the same
		// reason -- the surface a deployment exists to be reached on belongs on the line
		// an operator already reads.
		log(`  feed:   ${server.url}/${indexer}/feed`);
		logger.info(`run: listening on ${server.url}, folding into ${destination.db}`);

		return {
			url: server.url,
			port: server.port,
			db: prepared.db,
			store: prepared.store,
			processor: prepared.processor,
			streamWriter: prepared.streamWriter,
			container: prepared.container,
			host: prepared.host,
			stopped,
			stop: async () => {
				controller.abort();
				try {
					return await stopped;
				} finally {
					await close();
				}
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
 * `etherfold run` as a PROCESS: start it, keep running until something stops it,
 * and resolve the exit code.
 *
 * `0` when it was ASKED to stop (a signal, which is the only ordinary way a
 * follower ends) and `1` when it stopped because nothing it could do would help
 * -- a foreign `{source, config}`, the wrong chain, a suspected truncation -- or
 * because it could not start at all. The distinction is the same one
 * `runFetcherProcess` makes for a split fetcher, for the same reason: a process
 * that is up and achieving nothing is indistinguishable from a working one until
 * somebody reads the state it is not producing.
 *
 * Reaching the tip is NOT one of the ways this ends. That is `build`.
 */
export async function runMain(
	options: Options,
	deps: RunDependencies & {
		exit?: (code: number) => void;
		error?: (...args: unknown[]) => void;
	} = {},
): Promise<void> {
	const exit = deps.exit ?? ((code: number) => process.exit(code));
	const error = deps.error ?? console.error;

	let running: RunningIndexer | undefined;
	try {
		running = await run(options, deps);
		await running.stopped;
		await running.close();
		exit(0);
	} catch (err) {
		error(err);
		// the loop may have ended on its own (a fatal), so the server is still
		// listening and this is what stops it
		await running?.close().catch(() => undefined);
		exit(1);
	}
}

async function defaultStartServer(options: StartOptions): Promise<RunningServer> {
	// Imported lazily for the same reason `serve` does it: `etherfold build`
	// shares this module's assembly and must not pay for the server's dependency
	// tree (hono, the node HTTP adapter) to fold into a database and exit.
	const {startServer} = await import('@etherfold/platform-nodejs');
	return startServer(options);
}
