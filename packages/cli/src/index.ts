import {
	createDirectIngestion,
	generationDigestOf,
	resolveStreamConfig,
	retryCanAdvance,
	type Abi,
	type EventProcessor,
	type IndexingSource,
	type ReceivingIndexer,
	type StreamBuilder,
} from '@etherfold/core';
import {
	createFetcherHost,
	resolveFetcherHostConfig,
	runFetcherLoop,
	sleep,
	type CycleReport,
	type EnvRecord,
	type FetcherHost,
	type RunSummary,
	type Sleep,
} from '@etherfold/fetcher-host';
import type {EntityProcessor, StateStore} from '@etherfold/processor-entities';
import {instantiateProcessor, loadProcessorModule, resolveSource, type ProcessorModule} from '@etherfold/utils';
import type {EIP1193ProviderWithoutEvents} from 'eip-1193';
import {JSONRPCHTTPProvider} from 'eip-1193-jsonrpc-provider';
import {logs} from 'named-logs';
import type {RemoteSQL} from 'remote-sql';
import {resolveCommandConfig} from './config.js';
import {openFolding, openFoldingDatabase, openExplicitSource, streamConfigFor} from './folding.js';
import type {BuildConfig, ConfigFor, Options, RunConfig, SourceOrigin} from './types.js';

export * from './config.js';
export * from './types.js';
export {readCursorReport, readStatusReport, type ReportedFold, type StoreCursorReport} from './cursorReport.js';
export {
	foldingStatusReport,
	openFolding,
	openFoldingDatabase,
	openExplicitSource,
	streamConfigFor,
	type FoldingAssembly,
} from './folding.js';
export {canonicalGenerationIn, canonicalStateNamespaceIn, heldGenerationsIn, type ReadTierOptions} from './readTier.js';
export {recordReorg, reorgRecorderFor} from './reorgCounters.js';
export {fetch, fetchMain, prepareFetching, type FetchDependencies} from './fetch.js';
export {index, indexMain, type IndexDependencies, type RunningReceiver} from './indexCommand.js';
export {run, runMain, type RunDependencies, type RunningIndexer} from './run.js';
export {serve, type ServeDependencies, type StartedServer} from './serve.js';

const logger = logs('etherfold');

/** What a test may substitute for the real world. */
export type IndexingDependencies = {
	/** Loads the processor module. Defaults to a dynamic `import()`. */
	importModule?: (specifier: string) => Promise<any>;
	/** The chain. Defaults to the rate-limited JSON-RPC provider this CLI owns. */
	provider?: EIP1193ProviderWithoutEvents;
	/** Builds the libSQL handle for the store. Defaults to `createNodeDB`. */
	createDB?: (url: string) => RemoteSQL;
	/** The wait between cycles. Defaults to a real sleep. */
	sleep?: Sleep;
	/** Stops the run from outside, the way a signal handler would. */
	signal?: AbortSignal;
	/** Every cycle report, in order, after this command has acted on it. */
	onReport?: (report: CycleReport) => void;
	/** The environment flags fall back to. Defaults to `process.env`. */
	env?: EnvRecord;
};

/**
 * The commands this assembly serves: the ones that FOLLOW a chain and FOLD it.
 *
 * `index` folds too and is deliberately not here: it receives its batches over
 * the wire and makes no chain call, so it builds no provider and no
 * `LogFetcher`. It resolves through the same `resolveCommandConfig` and assembles
 * differently, which is the distinction the command table already draws.
 */
export type ChainFollowingCommand = 'run' | 'build';

/** Everything the assembled pipeline is made of, so a caller can drive it and look at it. */
export type PreparedIndexing<
	ABI extends Abi = Abi,
	ProcessResultType = unknown,
	C extends ChainFollowingCommand = ChainFollowingCommand,
> = {
	/**
	 * This command's row of the table, resolved once.
	 *
	 * Handed back rather than kept private because a command that also SERVES needs
	 * the address it resolved (`run`), and resolving it a second time in the
	 * command would be a second call site for one answer.
	 */
	config: ConfigFor<C, ABI>;
	source: IndexingSource<ABI>;
	processor: EventProcessor<ABI, ProcessResultType>;
	/** The receiving half. Present so a test can assert WHICH engine folds, rather than trust it. */
	streamBuilder: StreamBuilder<ABI, ProcessResultType>;
	/**
	 * THE GENERATIONS THIS PROCESS HOLDS, and which one answers reads.
	 *
	 * The same container `index` folds through, over the same durable registry, which
	 * is what makes "a developer's local `run` and a deployed server differ in
	 * EXECUTION and in nothing else" true of generations too. `run` may ADD a fold to
	 * it and promote one; `build` opens with one and exits, so the container it hands
	 * back holds exactly that one.
	 */
	container: ReceivingIndexer<ABI, ProcessResultType, StateStore>;
	/** The sending half, plus the policy for reading what a cycle did. */
	host: FetcherHost<ABI>;
	/** The store the OPENING fold folds into: its own table namespace (ADR-0053). */
	store: StateStore;
	/**
	 * The ONE libSQL handle this command built, which the store folds into.
	 *
	 * Exposed because a command that also serves hands this SAME handle to the
	 * server (`platforms/nodejs`'s `StartOptions.db` takes one), so the store and
	 * the read surface see one database rather than two connections with two views
	 * of it -- against `:memory:` they would not even be the same database.
	 */
	db: RemoteSQL;
	/**
	 * Drive the assembled pipeline, and return what the run did. Throws on a
	 * `fatal` report.
	 *
	 * WHERE IT STOPS is the one difference between the two commands: `build` stops
	 * at the tip, `run` follows it (see `driveCycles`).
	 */
	index(): Promise<RunSummary>;
};

/**
 * Assemble the two ADR-0003 halves in one process, with the transport removed.
 *
 * ```
 * LogFetcher -> createDirectIngestion -> StreamBuilder -> EventProcessor -> StateStore
 * ```
 *
 * ## Why this and not `IndexerGeneration`
 *
 * Because there is one server-side folding engine or there are two.
 * `work/specs/tasked/one-command-runs-the-whole-pipeline.md` builds `run` and
 * `index` on the same `StreamBuilder` and asserts they produce identical state
 * from the same input; that assertion is worth making only if the transport is
 * the only difference between them. Folding here through a second engine would
 * turn it into an equivalence between two IMPLEMENTATIONS that happen to agree
 * today. `IndexerGeneration` also cannot be split into halves at all (it opens
 * `load()` with `eth_chainId`, which is why the chain-free `StreamBuilder`
 * exists), and what it has that a server does not want is the kept-stream CACHE:
 * here the folder or the database IS the durable artifact. It stays the
 * browser's engine and is not constructed anywhere in this path.
 *
 * ## The order of what happens here is part of the contract
 *
 * The configuration is resolved, the processor module is loaded and the DATABASE
 * is opened -- all BEFORE the source is resolved, which is the first thing that
 * can touch the chain. So a missing node URL, a module this command cannot drive,
 * a database it cannot open and one it may not migrate all fail without first
 * issuing `eth_chainId`.
 *
 * What no longer comes before the source is the STORE, and that is ADR-0053
 * rather than a loosened rule: a generation's tables are named from the generation
 * identity, whose stream half is a function of the source, so there is nothing to
 * name until the source is known. The refusals that used to sit there (an illegal
 * entity declaration, a retention window a reorg can outreach) still happen before
 * a single batch is folded -- they are the state store's own, at CONSTRUCTION,
 * which is now inside `openFolding`.
 */
export async function prepareIndexing<
	ABI extends Abi,
	ProcessResultType,
	C extends ChainFollowingCommand = ChainFollowingCommand,
>(command: C, options: Options, deps: IndexingDependencies = {}): Promise<PreparedIndexing<ABI, ProcessResultType, C>> {
	const env = deps.env ?? (process.env as EnvRecord);
	// FIRST, and pure: a missing node URL, a missing database, a store nothing
	// implements or a source this command cannot reach is refused here, before a
	// module is imported, a database is opened or the chain is dialled.
	const resolved: RunConfig<ABI> | BuildConfig<ABI> = resolveCommandConfig<ChainFollowingCommand, ABI>(
		command,
		options,
		env,
	);

	logger.info({nodeUrl: resolved.nodeUrl, store: resolved.destination.store, source: resolved.source.from});

	// The CLI owns its provider construction (rate-limited JSON-RPC). The processor/source resolution
	// logic is shared with the server via the helpers in @etherfold/utils.
	const provider =
		deps.provider ??
		(new JSONRPCHTTPProvider(resolved.nodeUrl, {
			requestsPerSecond: resolved.rps,
		}) as unknown as EIP1193ProviderWithoutEvents);

	// The CLI intentionally constructs the processor with NO factory argument (the server passes its
	// folder); see MEDIUM-3.
	const processorModule = await loadProcessorModule<ABI, ProcessResultType>(resolved.processor, {
		...(deps.importModule ? {importModule: deps.importModule} : {}),
	});
	const declared = instantiateProcessor<ABI, ProcessResultType, EntityProcessor<ABI, any>>(processorModule, {
		processorPath: resolved.processor,
	});

	// derived ONCE and handed to both halves below: the sending fetcher host and the
	// receiving stream builder hash this same object into the wire identity
	const providedStreamConfig = streamConfigFor(env);
	const streamConfig = resolveStreamConfig(providedStreamConfig);
	// The ONE handle, with the fixed tables on it: the generation registry and the
	// canonical pointer are rows (ADR-0054), so they have to be there before a fold
	// can register itself. `build` applies them unconditionally -- it binds no port,
	// so nothing else in this process ever would, and the database it emits is a
	// publishable ARTIFACT that must carry its schema version, the reverts it
	// concluded and the generation it folded under. `run` applies what
	// `--no-auto-setup` said, and declining against an unmigrated database is a
	// refusal there rather than a process that comes up and achieves nothing.
	const db = await openFoldingDatabase(resolved.destination, {
		applyFixedSchema: resolved.command === 'build' ? true : resolved.serving.autoSetup,
		...(deps.createDB ? {createDB: deps.createDB} : {}),
	});

	const source: IndexingSource<ABI> | undefined = await openSource<ABI, ProcessResultType>(
		resolved.source,
		processorModule,
		provider,
	);
	if (!source || !source.contracts) {
		throw new Error(
			`contracts data not found in the processor module, it needs to be provided either as exported field named "contractsData" or as field "contractsDataPerChain" indexed by chainID`,
		);
	}

	// The GENERATION CONTAINER, and inside it the receiving half of ADR-0004:
	// authoritative about the cursor, deriving every reorg, making no chain call. It
	// reads the persisted cursor on every batch rather than holding one, which is what
	// makes an interrupted run resume from the store instead of from the start block.
	// Both PORTS are the store owner's, handed to the engine that concludes what they
	// record: the count is taken once inside `receive` (ADR-0050) and the emission
	// stream is appended there too, before the fold (ADR-0052). So a combined
	// process stores what it folded exactly as a receiver behind an HTTP route does,
	// and the database `build` emits carries its stream.
	const {container, store, processor, streamBuilder} = await openFolding<ABI, ProcessResultType>(
		declared,
		resolved.destination,
		db,
		{
			source,
			stream: providedStreamConfig,
			finalityDepth: streamConfig.finality,
			// The NAME this process's stored emissions and generation records are keyed on.
			// A combined command routes no batch by name, so it may DEFAULT one (ADR-0052) --
			// which is the whole reason this shape can store a stream at all: the emission
			// table's key is `NOT NULL` and there was no fold-side value to put in it.
			indexer: resolved.indexer,
		},
	);

	const host = createFetcherHost<ABI>(
		resolveFetcherHostConfig<ABI>(env, {
			source,
			nodeUrl: resolved.nodeUrl,
			stream: providedStreamConfig,
			...(resolved.rps === undefined ? {} : {requestsPerSecond: resolved.rps}),
		}),
		{
			provider,
			// the wire with no wire: the same two components a split deployment runs, in
			// one process, with nothing between them
			target: createDirectIngestion(streamBuilder),
		},
	);

	return {
		// the switch inside `resolveCommandConfig` produced exactly the arm named by
		// `command`, which the compiler cannot see through a generic parameter
		config: resolved as ConfigFor<C, ABI>,
		source,
		processor,
		streamBuilder,
		container,
		host,
		store,
		db,
		index: () => driveCycles(command, host, container, deps),
	};
}

/**
 * Turn a resolved source ORIGIN into the source itself.
 *
 * The origin was decided from the flags and the environment alone; this is where
 * the side effect it names actually happens, and the three arms are deliberately
 * not equivalent. Both explicit arms are CHAIN-FREE, which is what lets `index`
 * -- the receiving half, which makes no chain call at all -- resolve a source as
 * a first-class case rather than as a special case bolted on. The module arm is
 * the only one that may cost an `eth_chainId` call, and it is the only one a
 * chain-free caller is refused (`requireExplicitSource`).
 */
async function openSource<ABI extends Abi, ProcessResultType>(
	origin: SourceOrigin<ABI>,
	processorModule: ProcessorModule<ABI, ProcessResultType>,
	provider: EIP1193ProviderWithoutEvents,
): Promise<IndexingSource<ABI> | undefined> {
	if (origin.from === 'processor-module') {
		return resolveSource<ABI, ProcessResultType>(processorModule, provider as never);
	}
	return openExplicitSource<ABI>(origin);
}

/**
 * Drive cycles until this command has nothing left to do, then stop.
 *
 * ## The ONE difference between `build` and `run`, and there is no second one
 *
 * `runFetcherLoop` follows the tip forever and has no stop-at-tip option, which
 * is right for a host that is meant to keep running. `run` is exactly that loop.
 * The one-shot is that same loop plus an `AbortController` aborted from
 * `onReport`, and `stopAtTip` below is the whole of it: two reports mean a
 * one-shot's work is done -- a `progress` that reached the tip it observed
 * (`caughtUp`), and an `idle` (there was nothing above the cursor to fetch).
 *
 * Everything else is the loop's own business on BOTH commands -- a `retry` backs
 * off and tries again, a `fatal` ends the loop by itself and is re-thrown here so
 * the process exits non-zero.
 *
 * **A retryable failure is never bounded, on either command.** The one-shot
 * decided that and deliberately left the follower's answer to this command; it
 * is the same answer, and more obviously right here. `runFetcherLoop` escalates
 * to a capped delay (a minute by default), a node that comes back is the ordinary
 * case, and a bound would turn a transient outage into a stopped indexer that
 * only a supervisor restarts -- which is exactly the loop we would have written
 * by hand. What is NOT retried forever is a refusal no waiting fixes: that is a
 * `fatal`, and it stops the process with a non-zero code.
 *
 * Deliberately NOT a stop on `contended`, on either command: a yielded cycle
 * means another sender moved the cursor, and stopping there would report success
 * having landed nothing.
 *
 * Stopping a FOLLOWER is therefore a signal and never a report, which is what
 * `deps.signal` carries in from the caller (`run` installs the process's signal
 * handlers on it; a test aborts it by hand).
 *
 * ## The second difference, and it is the SAME one: who advances a SUCCESSOR
 *
 * A `run` is a long-running host, so a reconfigure can reach it: a fold added
 * beside the live one is a FOLLOWER, and a follower is advanced by a bounded
 * REBUILD its host SCHEDULES (ADR-0022) rather than by the wire. The gap the loop
 * already waits between cycles is that host's own clock, so one chunk is taken
 * there -- bounded by construction, on the same thread as the fold, so it can
 * neither stall a cycle beyond a chunk nor write into the incumbent's tables
 * while it folds. A `build` schedules none: a one-shot has no reconfigure, holds
 * exactly ONE generation and exits, so there is never a second fold to advance,
 * and never a promotion.
 *
 * The loop sleeps only where it decided to WAIT, so a process still catching the
 * chain up flat out (`CATCH_UP_DELAY_MS=0`) advances its followers once it
 * reaches the tip rather than while it is behind it. That is the right order and
 * not a compromise: the generation that answers reads is the one still being
 * caught up, and a rebuild competing with it for the same handle would slow the
 * thing every reader is waiting on.
 */
async function driveCycles<ABI extends Abi, ProcessResultType>(
	command: ChainFollowingCommand,
	host: FetcherHost<ABI>,
	container: ReceivingIndexer<ABI, ProcessResultType, StateStore>,
	deps: IndexingDependencies,
): Promise<RunSummary> {
	const stopAtTip = command === 'build';
	const controller = new AbortController();
	const stop = () => controller.abort();
	if (deps.signal?.aborted) {
		controller.abort();
	} else {
		deps.signal?.addEventListener('abort', stop, {once: true});
	}

	const wait = deps.sleep ?? sleep;
	/**
	 * One bounded chunk for every follower held, then the sleep the loop asked for.
	 *
	 * A rebuild that fails is LOGGED and the loop carries on: the successor is behind
	 * by one chunk and the canonical generation goes on answering, which is the whole
	 * shape of a rebuild running beside a live fold. It costs one in-memory check on
	 * a process holding no follower, which is every process until something adds one.
	 */
	/**
	 * Which followers this loop has already reported as unable to advance, so a
	 * permanent condition is said ONCE rather than on every cycle for ever.
	 */
	const stalled = new Set<string>();

	const advanceFollowers: Sleep = async (ms, signal) => {
		if (!stopAtTip && container.followers().length > 0) {
			try {
				for (const report of await container.rebuildMore()) {
					const id = generationDigestOf(report.generation);
					// A rebuild that merely has more to do, or nothing to do yet, is the
					// ordinary case and says nothing. A rebuild that CANNOT advance is
					// different in kind: the same three reasons recur on every call, so
					// polling never resolves them and the follower never becomes level --
					// it will never inherit a vacant write duty and never promote. Silence
					// there is what made this an invisible permanent stall (ADR-0070).
					if (retryCanAdvance(report.stopped)) {
						stalled.delete(id);
						continue;
					}
					if (stalled.has(id)) continue;
					stalled.add(id);
					logger.error(
						`the rebuild of generation ${id} cannot advance (${report.stopped.reason}) and retrying will not ` +
							`change that. It stays behind and never becomes level, so it will not take over writing its ` +
							`stream. This needs a look; the canonical generation is unaffected and goes on answering.`,
					);
				}
			} catch (err) {
				logger.error(`a rebuild chunk failed; the canonical generation is unaffected and the next cycle retries`, err);
			}
		}
		await wait(ms, signal);
	};

	try {
		const summary = await runFetcherLoop(host, {
			signal: controller.signal,
			sleep: advanceFollowers,
			onReport: (report) => {
				if (report.kind === 'progress') {
					console.log(`${report.outcome.toBlock} / ${report.outcome.latestBlock}`);
				}
				deps.onReport?.(report);
				if (stopAtTip && (report.kind === 'idle' || (report.kind === 'progress' && report.caughtUp))) {
					controller.abort();
				}
			},
		});

		if (summary.stoppedBecause === 'fatal') {
			// A refusal no waiting fixes: a foreign {source, config}, the wrong chain, a
			// suspected truncation. It is re-thrown so `main` resolves a non-zero exit
			// code and a CI job can depend on it rather than on parsing output.
			throw summary.error;
		}
		return summary;
	} finally {
		deps.signal?.removeEventListener('abort', stop);
	}
}

/**
 * Assemble the pipeline and drive it to the tip: what `etherfold build` is.
 *
 * Named for the command rather than for "running", because under the five-name
 * set `run` is a DIFFERENT deployment intent -- one that follows the chain,
 * answers queries and never terminates (`CONTEXT.md`, and `src/run.ts`). This
 * one stops at the tip, so it is `build`; the assembly under both is the same
 * `prepareIndexing`, and the difference is `driveCycles`'s `stopAtTip`.
 *
 * ## It holds exactly ONE generation, and that is the model at N=1
 *
 * A one-shot has no reconfigure: it opens the container with one fold and exits,
 * so it never adds a second and never promotes. Run twice over the same inputs it
 * RESOLVES the same generation rather than registering another (the registry's own
 * rule), which costs a pointer read at start-up and is what makes a `build`
 * artifact indistinguishable from a `run` database on the generation axis --
 * exactly the axis it must not be distinguishable on, since the artifact's whole
 * purpose is to become somebody else's INPUT.
 */
export async function build(options: Options, deps: IndexingDependencies = {}): Promise<RunSummary> {
	logger.info(JSON.stringify(options, null, 2));
	const prepared = await prepareIndexing<Abi, unknown>('build', options, deps);
	return prepared.index();
}

// Build to the tip and resolve the process exit code: 0 on success, 1 on failure. The `build`,
// `exit`, `log` and `error` collaborators are injectable so the success/failure contract can be
// unit-tested without driving the real process. `program.ts` calls this with `process.exit`.
export async function main(
	options: Options,
	deps?: {
		build?: (options: Options) => Promise<unknown>;
		exit?: (code: number) => void;
		log?: (...args: any[]) => void;
		error?: (...args: any[]) => void;
		/** The environment flags fall back to. Threaded from `createProgram`, so a test's env reaches the resolver. */
		env?: EnvRecord;
	},
): Promise<void> {
	const env = deps?.env;
	const buildFn = deps?.build ?? ((opts: Options) => build(opts, env ? {env} : {}));
	const exit = deps?.exit ?? ((code: number) => process.exit(code));
	const log = deps?.log ?? console.log;
	const error = deps?.error ?? console.error;
	try {
		await buildFn(options);
		log('DONE');
		exit(0);
	} catch (err) {
		error(err);
		exit(1);
	}
}
