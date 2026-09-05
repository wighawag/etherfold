import {
	createDirectIngestion,
	resolveStreamConfig,
	StreamBuilder,
	type Abi,
	type EventProcessor,
	type IndexingSource,
} from '@etherfold/core';
import {
	createFetcherHost,
	resolveFetcherHostConfig,
	runFetcherLoop,
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
import {buildProcessor, openExplicitSource, streamConfigFor} from './folding.js';
import type {BuildConfig, ConfigFor, Options, RunConfig, SourceOrigin} from './types.js';

export * from './config.js';
export * from './types.js';
export {readCursorReport, type StoreCursorReport} from './cursorReport.js';
export {buildProcessor, openExplicitSource, streamConfigFor} from './folding.js';
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
	/** The sending half, plus the policy for reading what a cycle did. */
	host: FetcherHost<ABI>;
	/** The store the processor folds into. */
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
 * The processor is loaded and the state destination is built -- both BEFORE the
 * source is resolved, which is the first thing that can touch the chain. So a
 * module this command cannot drive, or a store it cannot open, fails without
 * first issuing `eth_chainId`.
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
	const {processor, store, db, recordReorg, appendEmissions} = await buildProcessor<ABI, ProcessResultType>(
		declared,
		resolved.destination,
		{
			finalityDepth: streamConfig.finality,
			// The NAME this process's stored emissions are keyed on. A combined command
			// routes no batch by name, so it may DEFAULT one (ADR-0052) -- which is the
			// whole reason this shape can store a stream at all: the emission table's key
			// is `NOT NULL` and there was no fold-side value to put in it.
			indexer: resolved.indexer,
			// The one-shot binds no port, so nothing else ever creates the fixed tables --
			// and `build` exists to emit a publishable ARTIFACT, which must carry its
			// schema version and the reverts it concluded or it loses its provenance the
			// moment it becomes somebody's input. `run` gets the same tables from the
			// server it starts, where `--no-auto-setup` can still decline them.
			applyFixedSchema: command === 'build',
			...(deps.createDB ? {createDB: deps.createDB} : {}),
		},
	);

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

	// The receiving half of ADR-0004: authoritative about the cursor, derives every reorg, makes no
	// chain call. It reads the persisted cursor on every batch rather than holding one, which is what
	// makes an interrupted run resume from the store instead of from the start block.
	// Both PORTS are the store owner's, handed to the engine that concludes what they
	// record: the count is taken once inside `receive` (ADR-0050) and the emission
	// stream is appended there too, before the fold (ADR-0052). So a combined
	// process stores what it folded exactly as a receiver behind an HTTP route does,
	// and the database `build` emits carries its stream.
	const streamBuilder = new StreamBuilder<ABI, ProcessResultType>(processor, source, {
		stream: providedStreamConfig,
		recordReorg,
		appendEmissions,
	});

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
		host,
		store,
		db,
		index: () => driveCycles(command, host, deps),
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
 */
async function driveCycles<ABI extends Abi>(
	command: ChainFollowingCommand,
	host: FetcherHost<ABI>,
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

	try {
		const summary = await runFetcherLoop(host, {
			signal: controller.signal,
			...(deps.sleep ? {sleep: deps.sleep} : {}),
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
