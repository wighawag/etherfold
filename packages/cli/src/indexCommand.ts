import {
	generationDigestOf,
	resolveStreamConfig,
	type Abi,
	type EventProcessor,
	type IndexingSource,
	type ReceivingIndexer,
	type StreamWriter,
} from '@etherfold/core';
import type {EnvRecord} from '@etherfold/fetcher-host';
import type {RunningServer, StartOptions} from '@etherfold/platform-nodejs';
import {stopOnSignals} from '@etherfold/platform-nodejs-fetcher';
import type {EntityProcessor, WritableStateStore} from '@etherfold/processor-entities';
import {openProcessorArrival} from '@etherfold/utils';
import {logs} from 'named-logs';
import type {RemoteSQL} from 'remote-sql';
import {refuseUnbundledProcessor, resolveCommandConfig} from './config.js';
import {newlyStalledFollowers} from './followers.js';
import {
	foldingStatusReport,
	openFolding,
	openFoldingDatabase,
	openExplicitSource,
	requireArrivedBundle,
	streamConfigFor,
} from './folding.js';
import {DEFAULT_PRUNE_BUDGET, DEFAULT_PRUNE_INTERVAL_SECONDS, pruneHeldMore} from './pruning.js';
import {startGuardFor, type StartGuardDependencies} from './startGuard.js';
import type {IndexConfig, Options} from './types.js';
import {printMessage} from './printMessage.js';

const logger = logs('etherfold');

/**
 * How often a receiver takes its turn at the bounded rebuild, in seconds.
 *
 * ## Why a CLOCK, and what that costs under load
 *
 * `run` needs no such number: it has a CYCLE, so the bounded rebuild rides in the
 * gap the loop already waits between fetches (`driveCycles`, `src/index.ts`).
 * `index` has no cycle. Its loop is driven by ARRIVALS -- a sender pushes and it
 * folds -- and that is exactly why the turn must NOT be taken there. ADR-0022
 * says the rebuild is a call the HOST SCHEDULES and never a side effect of a
 * write, ingest is the only other thing that happens in this process, so "one
 * chunk after each batch" would be that side effect wearing a different hat: it
 * would put an arbitrarily long catch-up between a sender and its
 * acknowledgement, on the path this command exists to serve, for work that batch
 * did not cause. So it is a clock, which is the same answer the scheduled prune
 * beside it reached for the same reason, and the two are serialised so that one
 * database handle never carries two maintenance passes at once.
 *
 * FOUR SECONDS, because that is `run`'s own cadence rather than a new number: the
 * gap a caught-up `run` waits is its poll interval, which defaults to 4s
 * (`pollIntervalMs`, `@etherfold/fetcher-host`), so a follower advances at the
 * same rate on both shapes and an operator watching an upgrade sees one story.
 *
 * WHAT IT COSTS UNDER LOAD. A tick with nothing to advance is a few registry
 * reads -- the same bargain `run`'s unconditional call already states -- and a
 * tick WITH something to advance is bounded by construction at
 * `DEFAULT_MAX_EMISSIONS_PER_CHUNK` (2000) stored emissions, so a large catch-up
 * is spread over ticks rather than paid for in one. The bound is on the CHUNK and
 * not on the clock: under a heavy ingest load the two contend for the one handle
 * for the length of one chunk, and the ingest path wins the next tick outright,
 * because an overlapping tick is SKIPPED rather than queued. Tuning this down
 * buys a slightly earlier promotion; tuning it up delays one. Neither changes how
 * much work a pass does.
 */
export const DEFAULT_REBUILD_INTERVAL_SECONDS = 4;

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
// Seven things define it, and most of them are constraints rather than features:
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
//  6. **What that name resolves to is a GENERATION CONTAINER**, the same one
//     `run` folds through (`openFolding`, `folding.ts`), so the two commands
//     differ in where their batches come from and in nothing else. A CHANGED
//     `{source, config}` or a changed processor therefore registers a generation
//     beside the live one instead of reaching `processor.clear()` -- at RESTART,
//     which is the only moment this command adds a fold, because `open()` is the
//     one caller of `container.add` it wires up (the other is the upload, and
//     `upload.ts` is a `node`-only surface). What a BATCH naming a fold this
//     process does not hold gets is a refusal, not a generation: the ingest route
//     selects a receiver by matching `{source, config}` against the live wire
//     contexts and answers `400 context-mismatch` listing the ones it holds
//     (`@etherfold/server`). This paragraph used to claim the batch created the
//     generation, and no code path ever did that -- creating a fold from an
//     unseen batch would be a FEATURE (a receiver that registers generations on
//     a sender's say-so), not a thing that was here and stopped working.
//     Because the container answers the registry entry's two questions itself,
//     this name also carries the two OPTIONAL ones -- the listing and the pointer
//     move (ADR-0057) -- which a host holding a bare receiver cannot.
//  7. **It SCHEDULES the bounded rebuild for the generations it holds**, on a
//     clock, exactly as it schedules the prune below and for the same ADR-0022
//     reason. That call is what ADVANCES a fold added at `open` to level and then
//     SETTLES the pointer, so a redeployed receiver finishes its processor
//     upgrade instead of holding an armed successor for ever. See
//     `DEFAULT_REBUILD_INTERVAL_SECONDS` for where the turn comes from and what it
//     costs under load.
// ---------------------------------------------------------------------------------------------------

/** Starts the HTTP surface. Defaults to the Node platform adapter's `startServer`, imported lazily. */
export type ServerStart = (options: StartOptions) => Promise<RunningServer>;

/** What a test may substitute for the real world. A deployment substitutes none of it. */
export type IndexDependencies = {
	/** Loads the processor module. Defaults to a dynamic `import()`. */
	importModule?: (specifier: string) => Promise<any>;
	/**
	 * The BYTES the arrival substituted through `importModule` stands for, on the same
	 * terms the combined shapes take them (`IndexingDependencies.processorBundle`, which
	 * documents it): bytes on a disk win, and these are named and stored only where the
	 * injected arrival read none.
	 *
	 * It is here rather than left to the combined commands because one `--processor`
	 * path must not name two different generations depending on which command was
	 * pointed at it, and this half of the wire resolves its arrival itself.
	 */
	processorBundle?: Uint8Array;
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
	/**
	 * Seconds between scheduled prune passes. Defaults to
	 * `DEFAULT_PRUNE_INTERVAL_SECONDS`; `0` disables the schedule entirely.
	 *
	 * A test sets it low to observe a pass without waiting a minute, or to `0`
	 * when a background delete would race what it is asserting. A DEPLOYMENT
	 * leaves it alone: retention is configured with `--retention`, and starving
	 * the schedule is not how a deployment says it wants nothing dropped.
	 */
	pruneIntervalSeconds?: number;
	/**
	 * Seconds between scheduled rebuild passes. Defaults to
	 * `DEFAULT_REBUILD_INTERVAL_SECONDS`; `0` disables the schedule entirely.
	 *
	 * The same instrument `pruneIntervalSeconds` is, for the same reason and with the
	 * same warning: a test sets it low to watch an upgrade finish without waiting for
	 * a deployment's clock, or to `0` to assert that the SCHEDULE is what finishes it.
	 * A DEPLOYMENT leaves it alone, and there is deliberately NO FLAG for it -- the
	 * number a deployment wants is the one the constant argues for, and turning it off
	 * is turning off processor upgrades on this half.
	 */
	rebuildIntervalSeconds?: number;
	/** Where the startup lines go. Defaults to the console. */

	log?: (...args: unknown[]) => void;
	/** The environment flags fall back to. Defaults to `process.env`. */
	env?: EnvRecord;
	/**
	 * WHO THIS START ASKS before it replaces or discards a different pending successor: whether
	 * anybody can be asked, and how (`startGuardFor`). Defaults to the terminal.
	 */
	startGuard?: StartGuardDependencies;
};

/** An `index` process, from the outside: what it receives on, what it folds into, and how to stop it. */
export type RunningReceiver<ABI extends Abi = Abi, ProcessResultType = unknown> = {
	/** Where the HTTP surface is answering, with the port the OS actually gave it. */
	url: string;
	port: number;
	/** The ONE handle the store folds into and the server answers over. */
	db: RemoteSQL;
	store: WritableStateStore;
	processor: EventProcessor<ABI, ProcessResultType>;
	/** What it indexes, which is also half of the wire identity a sender must assert. */
	source: IndexingSource<ABI>;
	/**
	 * The OPENING fold's receiving half: authoritative about the cursor, deriving
	 * every reorg, making no chain call. Exposed so a caller can assert WHICH engine
	 * folds -- and read the `{source, config}` a sender has to match -- rather than
	 * trust it.
	 *
	 * ABSENT where that fold has none, which under ADR-0087 is an ordinary state
	 * rather than a crash (`FoldingAssembly`). What the ingest ROUTE selects between
	 * has never been this field: it is `container.liveIngestions()`, resolved per
	 * batch from the registry.
	 */
	streamWriter: StreamWriter<ABI>;
	/**
	 * THE GENERATIONS THIS PROCESS HOLDS, which is what the name it registered
	 * resolves to: the durable registry, the canonical pointer and the folds over
	 * them. The same container `run` holds.
	 */
	container: ReceivingIndexer<ABI, ProcessResultType, WritableStateStore>;
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
		// ...and the one part of it that is a FILE: a `--processor` path naming an
		// unbundled entry point is refused with the build command that fixes it, before
		// a module is imported, a database is opened or a port is bound (ADR-0086).
		await refuseUnbundledProcessor('index', config.processor, {substitutedArrival: deps.importModule !== undefined});
		logger.info({store: config.destination.store, source: config.source.from, port: config.serving.port});

		// WHAT THE `--processor` PATH TURNS OUT TO BE: a self-contained BUNDLE, read and
		// hashed, or a module the module system resolves (ADR-0086). The RECEIVING half
		// resolves it through the same arrival the combined shapes do, because one path
		// naming one file must not name two different generations depending on which
		// command was pointed at it.
		const arrival = await openProcessorArrival<ABI, ProcessResultType, EntityProcessor<ABI, any>>(config.processor, {
			...(deps.importModule ? {importModule: deps.importModule} : {}),
		});
		const declared = arrival.processor;
		// bytes on a disk answer first; an arrival a caller SUBSTITUTED states the bytes it
		// stands for; neither answering is a fold with no name and no code, and is refused
		// (`requireArrivedBundle`).
		const arrived = requireArrivedBundle(config.processor, arrival, deps.processorBundle);

		const providedStreamConfig = streamConfigFor(env);
		const streamConfig = resolveStreamConfig(providedStreamConfig);

		// The ONE handle, with the fixed tables on it: a fold REGISTERS its generation
		// before it reads or writes anything, and the registry and the canonical pointer
		// are rows (ADR-0054). `--no-auto-setup` still means somebody else migrates this
		// database, and against one that has not been migrated it is a refusal that never
		// binds a port rather than an endpoint answering 500 to every sender.
		const db = await openFoldingDatabase(config.destination, {
			applyFixedSchema: config.serving.autoSetup,
			...(deps.createDB ? {createDB: deps.createDB} : {}),
		});

		// No provider, and no `resolveSource` fallback: this is the whole of how a
		// chain-free command learns what it indexes.
		const source = await openExplicitSource<ABI>(config.source);

		// The GENERATION CONTAINER, and inside it the receiving half of ADR-0004 -- the
		// SAME assembly `run` folds through: authoritative about the cursor, deriving
		// every reorg, making no chain call. It reads the persisted cursor on every batch
		// rather than holding one, which is what makes a resumed or replayed push safe.
		// ...and it counts the reverts it concludes, and stores the emissions it folded,
		// through the two ports the store's owner built, exactly as `run` and `build`
		// do. The ingest route below is a CALLER of `receive` and writes neither itself,
		// so a process that both concludes and receives cannot double-count a revert
		// (ADR-0050) or store a batch twice (ADR-0052).
		const {container, processor, store, streamWriter, stateOf} = await openFolding<ABI, ProcessResultType>(
			declared,
			config.destination,
			db,
			{
				source,
				stream: providedStreamConfig,
				finalityDepth: streamConfig.finality,
				// the name the OPERATOR gave, which is also the route segment a sender
				// addresses: one value, required here and never defaulted, because on this
				// half it routes as well as keys (ADR-0036)
				indexer: config.wire.indexer,
				// what the ARRIVAL read: the bundle, named by its hash (ADR-0086) and kept with
				// the registration (ADR-0092)
				arrived,
				// A START MAY NOT SILENTLY REPLACE A DIFFERENT PENDING SUCCESSOR (ADR-0084's
				// amendment of 2026-09-26), on this half as on `run`: an `index -p X` against a
				// database holding an upload still catching up asks, is refused, or goes ahead
				// under --override.
				confirmReplacingSuccessorAtStart: startGuardFor(config.override, deps.startGuard),
			},
		);

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
			// Written out rather than built with `indexerRegistry` / `indexerEntryOn`
			// (`@etherfold/server`) for the same reason the server is imported LAZILY
			// below: this module's assembly must not pull hono into a process that only
			// folds. The four questions are FORWARDED rather than spread, because they are
			// methods on an object that reads its own durable state: copying them off the
			// container would unbind them.
			getIndexer: (_c, name) =>
				name === config.wire.indexer
					? {
							// THE DATABASE THIS NAME OWNS (ADR-0053), which on this command is the
							// same handle every generation folds into and the server answers over:
							// one process, one named indexer, one database. A host registering
							// several gives each name its own, and that is a registry with more
							// entries in it rather than a change to this route.
							db,
							// ONE per LIVE WIRE CONTEXT, DERIVED from the registry rather than
							// captured: a filter-change successor is fed beside the incumbent, and a
							// generation deleted by an operator stops being fed without this process
							// being told.
							liveIngestions: () => container.liveIngestions(),
							// WHICH generation answers reads, both halves in one read of the durable
							// pointer -- not the fold this process happens to run
							canonicalGeneration: () => container.canonicalGeneration(),
							// ...and what there is to point AT, plus the move itself (ADR-0057): the
							// two OPTIONAL questions, which this name can answer precisely because it
							// resolves to a container over a durable registry rather than to a bare
							// receiver. That is what makes `POST /{indexer}/admin/canonical-generation`
							// -- promote forwards, revert BACK -- answer here instead of `501`.
							generations: () => container.generations(),
							promote: (id) => container.promote(id),
							// ...and WHAT EACH SLOT NAMES, plus the verb that takes what NONE of them does
							// (ADR-0084), forwarded together for the same reason: a surface reporting what
							// may be reclaimed on a host that cannot reclaim it would be telling an operator
							// about an instrument they do not have. This half owns the database, so it is
							// the half whose disk fills up.
							slots: () => container.slots(),
							reclaim: () => container.reclaim(),
							// ...and WHETHER EACH GENERATION CAN FOLD HERE (ADR-0092): held, instantiable from
							// its stored bundle, or frozen and why -- what an operator reads before a revert.
							folding: () => container.folding(),
							// ...and the SIGNAL this fold publishes as it applies each block (ADR-0083),
							// reached the same way and for the same reason: this command is the half of
							// a split deployment that APPLIES the blocks, so it is the only half that
							// can tell a reader the state moved. The server package applies none, which
							// is why what it holds is the way to reach this rather than a producer of
							// its own, and why a transport over it needs no change here to attach.
							onStateMoved: (handler) => container.onStateMoved(handler),
							// ...and the TOKEN that fold is publishing under right now, which is the same
							// publisher's other answer and is forwarded with it rather than after it: a
							// transport over the network tells a client AT CONNECT whether what it already
							// holds is stale, because a remote reader has no store to re-read (ADR-0083).
							coherenceNow: () => container.coherenceNow(),
						}
					: undefined,
			// ...and this is what makes a split deployment observable: `index` owns the
			// store, so it is the half that can say where the fold has got to. A read
			// tier owns none and is given none. ONE entry per generation held, in the
			// same field a host mid-upgrade fills with two.
			getCursorReport: () => foldingStatusReport(container, stateOf),
		});

		// RECLAIM WHAT THE RETENTION NO LONGER COVERS, on a clock, because this
		// command has no cycle to prune between.
		//
		// `--retention` is accepted here exactly as it is on `run` (`config.ts`), and
		// its own help text promises that what falls outside the window is "both
		// refused on read and DROPPED from storage". The refusal half has always
		// worked; without this the storage half did not, so a bounded receiver got the
		// answers of a windowed store and the footprint of an unbounded one -- the
		// worst-of-both `a-configured-window-is-actually-pruned` exists to kill.
		//
		// A TIMER is the honest schedule for a receiver. ADR-0022 forbids a prune as a
		// side effect of a write, and the ingest path is the only other thing that
		// happens here, so "between batches" would be exactly that side effect wearing
		// a different hat. A clock is owned by the HOST, which is what that ADR asks
		// for, and this process is a long-lived Node one that can hold a timer -- the
		// constraint recorded for Workers (`work/notes/findings/
		// a-worker-cannot-hold-a-timer-across-requests.md`) is about a STORE on that
		// platform and does not reach a CLI host.
		//
		// It calls UNCONDITIONALLY: a prune with no floor is a no-op (ADR-0022), and a
		// host holding the seam cannot tell whether a `revert-only` store has one
		// anyway, because the capability report carries no depth.
		// The FLAG wins where it was given, then the test's injection, then the default.
		// A deployment sets `--prune-interval` (or `PRUNE_INTERVAL`) and never the
		// dependency, which exists so a test can observe a pass without waiting a minute.
		const pruneEverySeconds =
			config.pruneIntervalSeconds ?? deps.pruneIntervalSeconds ?? DEFAULT_PRUNE_INTERVAL_SECONDS;
		// ADVANCE WHAT THIS PROCESS HOLDS, on the same kind of clock and for the same
		// ADR-0022 reason (`DEFAULT_REBUILD_INTERVAL_SECONDS`, which argues the cadence
		// and the cost). No flag resolves into this: a deployment has no say in it, and
		// the dependency exists so a test can watch an upgrade finish without waiting for
		// a deployment's clock.
		const rebuildEverySeconds = deps.rebuildIntervalSeconds ?? DEFAULT_REBUILD_INTERVAL_SECONDS;

		// ONE MAINTENANCE PASS AT A TIME over the ONE handle, which is the whole of how
		// two clocks stay out of each other's way -- and out of the ingest path's.
		//
		// It guards the case a clock has that a cycle does not: a pass slower than its
		// interval. Ticks would otherwise STACK, and several concurrent prune passes over
		// one store spend the budget several times for the deletes a single pass would
		// have made. Shared between the two timers rather than one flag each, because the
		// scarce thing is the DATABASE HANDLE and not the verb: a rebuild chunk and a
		// prune pass running at once would contend with the fold that the sender is
		// waiting on, which is precisely what riding the host's own gap is supposed to
		// avoid. A SKIPPED tick is never a lost one -- both passes are resumable by
		// construction and the next tick continues -- so dropping is right where queueing
		// would let a backlog grow behind a slow pass.
		let maintaining = false;
		const maintain = (pass: () => Promise<void>) => {
			if (maintaining) return;
			maintaining = true;
			void (async () => {
				try {
					await pass();
				} finally {
					maintaining = false;
				}
			})();
		};

		/** Which folds have already been reported as stalled, so it is said once and not per tick. */
		const reportedStalled = new Set<string>();
		/**
		 * ONE bounded rebuild chunk for every fold held AND the pointer settled once.
		 *
		 * The SAME call `run` makes in the gap between its cycles, unconditionally and for
		 * the reason stated there: `rebuildMore` is TWO things, and gating it on "is
		 * anything being rebuilt" answers the wrong question. It used to be the wrong
		 * question in a sharper way -- a successor registered at `open` was NOT a follower,
		 * so it was fed by the WIRE and held no rebuild at all, and what it needed from
		 * here was the SETTLE alone. Under ADR-0087 no generation fetches, so this call is
		 * what ADVANCES every fold as well as what settles the pointer, and a tick that
		 * never runs is a successor that never moves.
		 *
		 * The stall report is `run`'s own (`followers.ts`) rather than a second copy: a
		 * rebuild that cannot advance recurs identically on every call, so polling never
		 * resolves it (ADR-0070), and since ADR-0087 EVERY fold this command holds
		 * advances that way -- no generation fetches, so a fold catches up by re-folding
		 * the stream the sender's batches stored.
		 *
		 * It FAILS SOFT, exactly as the prune below does: the canonical generation goes on
		 * answering, the successor is behind by one chunk, and the next tick retries.
		 */
		const advanceHeldGenerations = async (): Promise<void> => {
			try {
				for (const stalled of newlyStalledFollowers(await container.rebuildMore(), reportedStalled)) {
					logger.error(
						`index: the rebuild of generation ${stalled.id} cannot advance (${stalled.reason}) and retrying will not ` +
							`change that. It stays behind, never becomes level and is therefore never promoted. ` +
							`This needs a look; the canonical generation is unaffected and goes on answering.`,
					);
				}
			} catch (err) {
				logger.error(
					`index: a rebuild chunk failed; the canonical generation is unaffected and the next tick retries`,
					err,
				);
			}
		};

		const prunePass = async (): Promise<void> => {
			try {
				const pruned = await pruneHeldMore(container, {maxVersions: DEFAULT_PRUNE_BUDGET});
				if (!pruned.complete) {
					logger.info(
						`index: pruned ${pruned.versionsDeleted} versions and the budget of ${DEFAULT_PRUNE_BUDGET} ` +
							`stopped the pass before the store reached its floor. The next tick continues.`,
					);
				}
			} catch (err) {
				// Receiving is what this process is FOR. A delete that could not run
				// leaves a store larger than it asked to be, which is worth saying and
				// not worth refusing a batch over.
				logger.error(`index: a scheduled prune failed; the fold is unaffected and the next tick retries`, err);
			}
		};

		const rebuildTimer =
			rebuildEverySeconds > 0
				? setInterval(() => maintain(advanceHeldGenerations), rebuildEverySeconds * 1000)
				: undefined;
		const pruneTimer =
			pruneEverySeconds > 0 ? setInterval(() => maintain(prunePass), pruneEverySeconds * 1000) : undefined;
		// Neither pass is ever a reason for the process to stay alive: what holds it up is
		// the server listening.
		rebuildTimer?.unref?.();
		pruneTimer?.unref?.();

		const close = async () => {
			if (rebuildTimer) clearInterval(rebuildTimer);
			if (pruneTimer) clearInterval(pruneTimer);
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
		await sayWhatFeedsASuccessor(container, `${server.url}/${config.wire.indexer}/ingest`, log);

		return {
			url: server.url,
			port: server.port,
			db,
			store,
			processor,
			source,
			streamWriter,
			container,
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
 * SAY WHAT WILL FEED THE SUCCESSOR THIS PROCESS CAME UP HOLDING, because on this
 * half the answer is not "this process".
 *
 * The restart-shaped upgrade is now finishable here: a successor registered at
 * `open` is armed from its slot (ADR-0084) and the tick above settles the pointer
 * once it is level. What the tick CANNOT do is advance it, and that is structural
 * rather than missing. `index` has no chain-facing half by design -- no provider,
 * no `LogFetcher`, no fetcher host -- and a fold added at `open` is not a FOLLOWER
 * either (`add` decides that from "do I already hold a fold on this stream", and
 * at `open` the fold list is empty), so it holds no rebuild over the stored stream
 * to be carried by. It is fed by the WIRE and by nothing else: a sender has to
 * push for ITS OWN `{source, config}`, which it discovers by asking
 * `POST /{indexer}/ingest/expected-from-block`.
 *
 * So the one way this upgrade silently never finishes is a sender that is pushing
 * something else -- a different source, or a different stream config -- whose
 * batches are refused as a foreign context by the ingest route while `/status`
 * goes on looking healthy. That refusal is visible on the SENDER and nowhere on
 * this half, which is exactly the shape of stall worth one line at start-up. The
 * alternative considered and rejected was giving `index` a fetcher so it could
 * feed its own successor, which would delete the property that defines the
 * command.
 *
 * Said ONCE, at start-up, through the operator's own startup lines rather than the
 * log facade, because it is a fact about the deployment that was just configured
 * and not an event. A process holding no successor says nothing, so the line
 * means something wherever it appears.
 *
 * It cannot REFUSE a start-up: a diagnostic read that failed against a registry
 * this process has already opened and bound a port over would otherwise throw past
 * a `catch` that closes neither the server nor the timers, so a receiver would die
 * of the line explaining itself. The read is said to have failed and the process
 * goes on receiving.
 */
async function sayWhatFeedsASuccessor<ABI extends Abi, ProcessResultType>(
	container: ReceivingIndexer<ABI, ProcessResultType, WritableStateStore>,
	ingestUrl: string,
	log: (...args: unknown[]) => void,
): Promise<void> {
	const opening = container.held()[0];
	if (!opening) return;
	let slots: Awaited<ReturnType<typeof container.slots>>;
	try {
		slots = await container.slots();
	} catch (err) {
		logger.error(`index: the slots could not be read, so this process cannot say what it came up holding`, err);
		return;
	}
	// WHAT THE SLOT SAYS this generation is FOR, which is the same question the arming
	// asks and is deliberately not "how did this fold arrive" (ADR-0084). A registry
	// that names a successor always names a canonical too -- the first generation of an
	// empty registry takes the pointer -- so there is nothing to report without one.
	const successor = slots.successor;
	const canonical = slots.canonical;
	if (!successor || !canonical) return;
	const held = generationDigestOf(opening.record);
	if (generationDigestOf(successor) !== held) return;

	log(
		`  upgrade in progress: this process holds generation ${held} in the SUCCESSOR slot, beside the canonical ` +
			`${generationDigestOf(canonical)}, which goes on answering reads until the successor is level. This command ` +
			`makes no chain call, so nothing here fetches for it: it advances ONLY from what a sender pushes at ` +
			`${ingestUrl} for its own {source, config}` +
			`. Every generation here READS the stored stream this deployment stores, and none of them writes one ` +
			`(ADR-0087). A sender configured for a different source or stream config is refused there as a foreign context ` +
			`(400 context-mismatch), and a successor nothing pushes to never becomes level, so the pointer never moves.`,
	);
	logger.info(`index: holding ${held} as a successor beside the canonical ${generationDigestOf(canonical)}`);
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
	const error = deps.error ?? printMessage;

	let running: RunningReceiver | undefined;
	try {
		running = await index(options, deps);
		await running.stopped;
		await running.close();
		exit(0);
	} catch (err) {
		error(err);
		logger.error('the command stopped', err);
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
