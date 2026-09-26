import {
	createDirectIngestion,
	resolveStreamConfig,
	type Abi,
	type EventProcessor,
	type GenerationId,
	type IndexingSource,
	type ReceivingIndexer,
	type StreamWriter,
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
import type {EntityProcessor, StateStore, WritableStateStore} from '@etherfold/processor-entities';
import type {ReconfigureReport, WaitingReport} from '@etherfold/server';
import {openProcessorArrival} from '@etherfold/utils';
import type {EIP1193ProviderWithoutEvents} from 'eip-1193';
import {JSONRPCHTTPProvider} from 'eip-1193-jsonrpc-provider';
import {logs} from 'named-logs';
import type {RemoteSQL} from 'remote-sql';
import {refuseUnbundledProcessor, resolveCommandConfig} from './config.js';
import {
	openFolding,
	openFoldingDatabase,
	openIndexingSource,
	openWaitingFolding,
	requireArrivedBundle,
	streamConfigFor,
} from './folding.js';
import {arrivalQueue, reconfigurerFor} from './reconfigure.js';
import {uploaderFor} from './upload.js';
import type {BuildConfig, ConfigFor, Options, RunConfig} from './types.js';

export * from './config.js';
export * from './types.js';
export {readCursorReport, readStatusReport, type ReportedFold, type StoreCursorReport} from './cursorReport.js';
export {
	foldPartsFor,
	foldingStatusReport,
	openFolding,
	openFoldingDatabase,
	openExplicitSource,
	openIndexingSource,
	openWaitingFolding,
	streamConfigFor,
	type FoldParts,
	type FoldingAssembly,
	type WaitingFoldingAssembly,
} from './folding.js';
export {arrivalQueue, reconfigurerFor, type ArrivalQueue, type ReconfigureContext} from './reconfigure.js';
export {uploaderFor, type ConfiguredSource, type UploadContext} from './upload.js';
export {
	describeUpload,
	upload,
	uploadMain,
	uploadRouteOf,
	type UploadAnswer,
	type UploadDependencies,
	type UploadedGeneration,
} from './uploadCommand.js';
export {canonicalGenerationIn, canonicalStateNamespaceIn, heldGenerationsIn, type ReadTierOptions} from './readTier.js';
export {recordReorg, reorgRecorderFor} from './reorgCounters.js';
export {
	DEFAULT_PRUNE_BUDGET,
	DEFAULT_PRUNE_INTERVAL_SECONDS,
	pruneHeldMore,
	pruneHeldUntilComplete,
	statesHeldBy,
} from './pruning.js';
export {fetch, fetchMain, prepareFetching, type FetchDependencies} from './fetch.js';
export {
	DEFAULT_REBUILD_INTERVAL_SECONDS,
	index,
	indexMain,
	type IndexDependencies,
	type RunningReceiver,
} from './indexCommand.js';
export {run, runMain, type RunDependencies, type RunningIndexer} from './run.js';
export {serve, type ServeDependencies, type StartedServer} from './serve.js';
import {newlyStalledFollowers, rebuildUntilLevel} from './followers.js';
import {DEFAULT_PRUNE_BUDGET, pruneHeldMore, pruneHeldUntilComplete} from './pruning.js';

const logger = logs('etherfold');

/** What a test may substitute for the real world. */
export type IndexingDependencies = {
	/** Loads the processor module. Defaults to a dynamic `import()`. */
	importModule?: (specifier: string) => Promise<any>;
	/**
	 * THE BYTES THE INJECTED ARRIVAL STANDS FOR: what an arrival substituted through
	 * `importModule` would have read off disk, since a module object carries no bytes
	 * of its own.
	 *
	 * It is the other half of ONE seam and is meaningless without its partner.
	 * `importModule` lets a caller state WHAT comes back for a `--processor` path, and
	 * this lets it state the BUNDLE that thing is. Its identity is then DERIVED from
	 * these octets exactly as a real bundle's is (ADR-0086), and the registration
	 * stores them exactly as it stores a real bundle's (ADR-0092) -- so a substituted
	 * arrival registers a generation the way a deployment does, and there is no route
	 * that names a fold without keeping its code. It used to be `processorIdentity`, a
	 * bare NAME, and a name with no bytes behind it is the one registration a Node
	 * deployment must not be able to make. An injected arrival with neither is
	 * REFUSED (`requireArrivedBundle`).
	 *
	 * The bytes are SYNTHETIC in every suite that supplies them and that is correct:
	 * nothing evaluates them here (the module comes from `importModule`), and what is
	 * under test is which generation answered and what was stored for it.
	 *
	 * **BYTES ON DISK WIN, always.** Where the path names a real self-contained bundle,
	 * those octets are read, hashed and stored and this value is not consulted.
	 *
	 * It is NOT a way for an author to declare an identity, which is the one thing
	 * ADR-0086 forbids. No flag and no environment variable reaches it, it sits beside
	 * `importModule` in the type documented as what a TEST substitutes, and a
	 * deployment substitutes neither.
	 */
	processorBundle?: Uint8Array;
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
	/**
	 * What this process fetches. On a `run` started with NOTHING configured it is the
	 * source its first fold carried, and it is REFUSED until there is one (ADR-0093) --
	 * as are `host` below, and `processor`, `store` and `streamWriter` until something
	 * folds: see `waiting`.
	 */
	source: IndexingSource<ABI>;
	processor: EventProcessor<ABI, ProcessResultType>;
	/**
	 * The OPENING fold's receiving half. Present so a test can assert WHICH engine
	 * folds, rather than trust it -- and ABSENT where that fold has none, which under
	 * ADR-0087 is an ordinary state rather than a crash (`FoldingAssembly`).
	 *
	 * It is deliberately NOT what this process feeds: the fetcher below pushes into
	 * whatever the container holds LIVE at the moment of the ask, never into a value
	 * captured here.
	 */
	streamWriter: StreamWriter<ABI>;
	/**
	 * THE GENERATIONS THIS PROCESS HOLDS, and which one answers reads.
	 *
	 * The same container `index` folds through, over the same durable registry, which
	 * is what makes "a developer's local `run` and a deployed server differ in
	 * EXECUTION and in nothing else" true of generations too. `run` may ADD a fold to
	 * it and promote one; `build` opens with one and exits, so the container it hands
	 * back holds exactly that one.
	 */
	container: ReceivingIndexer<ABI, ProcessResultType, WritableStateStore>;
	/** The sending half, plus the policy for reading what a cycle did. */
	host: FetcherHost<ABI>;
	/** The store the OPENING fold folds into: its own table namespace (ADR-0053). */
	store: WritableStateStore;
	/**
	 * ANY generation's state by identity, UNCLAIMED (`FoldingAssembly.stateOf`): what
	 * `/status` reads a canonical generation's position from when nothing here folds it.
	 */
	stateOf(id: GenerationId): StateStore;
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
	 * RE-READ this deployment's own configuration and register whatever generation
	 * it now names, beside the incumbent -- what `POST /{indexer}/admin/reconfigure`
	 * does on this process (`reconfigure.ts`).
	 *
	 * It is built HERE, by the assembly, because re-reading is redoing exactly the
	 * two resolutions above -- the processor module and the source -- and a second
	 * place that knew how to do that would be a second answer to what this process
	 * folds.
	 *
	 * `run` is the shape that EXPOSES it, and `build` deliberately does not: a
	 * one-shot has no HTTP surface to pull the trigger from, so it re-reads its
	 * configuration exactly once, at start-up. That is NOT the same as holding one
	 * generation -- a re-run `build` over a database it already wrote with changed
	 * processor bytes registers a successor beside the canonical generation at that
	 * single read, folds it, and settles the pointer onto it before exiting
	 * (`driveCycles`). It is handed back for both because the assembly is shared
	 * verbatim and a conditional field would be a type for a distinction the commands
	 * already draw.
	 */
	reconfigure(): Promise<ReconfigureReport>;
	/**
	 * RECEIVE a processor bundle's BYTES and register the generation they name, beside
	 * the incumbent -- what `POST /{indexer}/admin/upload` does on this process
	 * (`upload.ts`).
	 *
	 * Built here for the reason `reconfigure` is: it registers into the same container,
	 * through the same fold assembly, over the same database, and it waits in the SAME
	 * line as the re-read so two arrivals never decide against one registry at once.
	 * `run` is the shape that exposes it; `build` has no HTTP surface to receive on.
	 */
	upload(bundle: Uint8Array): Promise<ReconfigureReport>;
	/**
	 * WHAT `/status` SAYS while this process is WAITING for a processor (ADR-0093), and
	 * nothing when it is not.
	 *
	 * Only a `run` started with NOTHING configured ever waits, and only until something
	 * names what it fetches: until then it has no fetcher, and `host` and `source` are
	 * refused rather than answered with a placeholder. Every configured assembly answers
	 * nothing here.
	 */
	waiting(): WaitingReport | undefined;
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
	// ...and the one part of it that is a FILE rather than a string: a `--processor`
	// path naming an unbundled entry point is refused HERE, with the build command an
	// author needs, rather than from inside a loader once a database is open
	// (ADR-0086, ADR-0048). Nothing has been imported or opened at this line.
	if (resolved.processor !== undefined) {
		await refuseUnbundledProcessor(command, resolved.processor, {substitutedArrival: deps.importModule !== undefined});
	}

	logger.info({nodeUrl: resolved.nodeUrl, store: resolved.destination.store, source: resolved.source.from});

	// The CLI owns its provider construction (rate-limited JSON-RPC). The processor/source resolution
	// logic is shared with the server via the helpers in @etherfold/utils.
	const provider =
		deps.provider ??
		(new JSONRPCHTTPProvider(resolved.nodeUrl, {
			requestsPerSecond: resolved.rps,
		}) as unknown as EIP1193ProviderWithoutEvents);

	// NOTHING CONFIGURED (ADR-0093): a `run` given neither a processor nor a source, which
	// the resolver has already told apart from a source with no processor (refused). It
	// is assembled over the SAME database, registry and stream ends, with no fold and no
	// source of its own, and its fetcher comes to exist when a source does.
	if (resolved.processor === undefined) {
		return prepareWaiting<ABI, ProcessResultType, C>(command, options, deps, env, resolved as RunConfig<ABI>, provider);
	}
	const processorPath = resolved.processor;

	// WHAT THE `--processor` PATH TURNS OUT TO BE. A path is still how a deployment
	// names its processor and that has not changed (ADR-0086); what the path points
	// AT must be a self-contained BUNDLE, which is read and hashed here and whose hash
	// IS the generation's processor identity. A path naming an unbundled module
	// resolves through the module system exactly as it always did and is REFUSED
	// below, because nothing is left that could name its fold. Nothing here bundles
	// anything.
	//
	// The CLI intentionally constructs the processor with NO factory argument (the
	// server passes its folder); see MEDIUM-3.
	const arrival = await openProcessorArrival<ABI, ProcessResultType, EntityProcessor<ABI, any>>(processorPath, {
		...(deps.importModule ? {importModule: deps.importModule} : {}),
	});
	const {processorModule} = arrival;
	const declared = arrival.processor;
	// WHAT THIS DEPLOYMENT'S ARRIVAL READ: the bundle and the identity that is its hash.
	// Real bytes on a disk answer first and are never overruled; an arrival a caller
	// SUBSTITUTED states the bytes it stands for, because a module object has none (see
	// `IndexingDependencies.processorBundle`). Absent from both is a fold with no name
	// and no code, which is refused rather than papered over (`requireArrivedBundle`).
	const arrived = requireArrivedBundle(processorPath, arrival, deps.processorBundle);

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

	const source: IndexingSource<ABI> = await openIndexingSource<ABI, ProcessResultType>(
		resolved.source,
		processorModule,
		provider,
	);

	// The GENERATION CONTAINER, and inside it the receiving half of ADR-0004:
	// authoritative about the cursor, deriving every reorg, making no chain call. It
	// reads the persisted cursor on every batch rather than holding one, which is what
	// makes an interrupted run resume from the store instead of from the start block.
	// Both PORTS are the store owner's, handed to the engine that concludes what they
	// record: the count is taken once inside `receive` (ADR-0050) and the emission
	// stream is appended there too, before the fold (ADR-0052). So a combined
	// process stores what it folded exactly as a receiver behind an HTTP route does,
	// and the database `build` emits carries its stream.
	const {container, store, processor, streamWriter, stateOf} = await openFolding<ABI, ProcessResultType>(
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
			// WHAT THE ARRIVAL READ: a generation folded from a bundle is named by that
			// bundle's hash, and the engine below this line never asks where the value came
			// from (ADR-0086) -- and it KEEPS those bytes, stored with its registration
			// (ADR-0092).
			arrived,
			// WHEN a successor takes over, on the one command that TAKES the input. Only
			// `run` resolves it (`OWNERSHIP`, `config.ts`): a one-shot's successor is settled
			// under the DEFAULT policy before it exits, and whether it should also take the
			// flag is a question about that command's inputs which nothing has answered --
			// so it is refused rather than carried (`NEVER_PROMOTES_BUILD`).
			...(resolved.command === 'run' && resolved.promotion !== undefined ? {promotion: resolved.promotion} : {}),
		},
	);

	const host = fetcherHostOver<ABI, ProcessResultType>(
		source,
		resolved,
		env,
		providedStreamConfig,
		provider,
		container,
	);

	// ONE LINE for every arrival this process answers -- the re-read and the upload --
	// so no two of them decide "is this identity already held" against one registry at
	// the same time (`arrivalQueue`, `reconfigure.ts`).
	const arrivals = arrivalQueue();

	return {
		// the switch inside `resolveCommandConfig` produced exactly the arm named by
		// `command`, which the compiler cannot see through a generic parameter
		config: resolved as ConfigFor<C, ABI>,
		source,
		processor,
		streamWriter,
		container,
		host,
		store,
		stateOf,
		db,
		reconfigure: reconfigurerFor<ABI, ProcessResultType>(
			{
				options,
				env,
				provider,
				db,
				dbUrl: resolved.destination.db,
				indexer: resolved.indexer,
				container,
				...(deps.importModule ? {importModule: deps.importModule} : {}),
				// the SAME pair, so a re-read resolves the identity this process came up with
				// rather than a second answer that would register a spurious successor on every
				// call (`reconfigure.ts`)
				...(deps.processorBundle === undefined ? {} : {processorBundle: deps.processorBundle}),
			},
			arrivals,
		),
		// THE UPLOAD, over the same container, database and destination, in the same line.
		// The source the operator CONFIGURED is handed over only where there is one: that
		// is the only source an upload is held to (`upload.ts`), and a source that came from
		// the processor module is not one.
		upload: uploaderFor<ABI, ProcessResultType>(
			{
				provider,
				db,
				destination: resolved.destination,
				stream: providedStreamConfig,
				container,
				...(resolved.source.from === 'processor-module' ? {} : {configured: {origin: resolved.source, source}}),
			},
			arrivals,
		),
		// ...and it is not WAITING: it was configured with what it folds and what it fetches
		waiting: () => undefined,
		index: () => driveCycles(command, host, container, deps),
	};
}

/**
 * THE ONE FETCHER a chain-following command builds, over the source it fetches.
 *
 * Built at start on a configured deployment, and on a `run` started with NOTHING
 * configured (ADR-0093) at the moment its container first names a source -- from the
 * canonical generation it instantiated at `open`, or from its first upload. Either way it
 * is built ONCE, over ONE source, which is what a `run` has always fetched: a later
 * upload carrying different contracts is a successor on a new stream, exactly as on a
 * deployment whose source came from its processor module.
 */
function fetcherHostOver<ABI extends Abi, ProcessResultType>(
	source: IndexingSource<ABI>,
	resolved: RunConfig<ABI> | BuildConfig<ABI>,
	env: EnvRecord,
	providedStreamConfig: ReturnType<typeof streamConfigFor>,
	provider: EIP1193ProviderWithoutEvents,
	container: ReceivingIndexer<ABI, ProcessResultType, WritableStateStore>,
): FetcherHost<ABI> {
	return createFetcherHost<ABI>(
		resolveFetcherHostConfig<ABI>(env, {
			source,
			nodeUrl: resolved.nodeUrl,
			stream: providedStreamConfig,
			...(resolved.rps === undefined ? {} : {requestsPerSecond: resolved.rps}),
		}),
		{
			provider,
			// THE WIRE WITH NO WIRE: the same two components a split deployment runs, in one
			// process, with nothing between them -- and, exactly as on the HTTP side, the
			// receiver a batch reaches is RESOLVED at the moment of the ask rather than
			// captured here.
			//
			// It used to be `createDirectIngestion(container.ingestion)`, one receiver read
			// off the container at `open`. Two things were wrong with that and only one of
			// them was visible. The visible one: that getter THROWS for a FOLD with no
			// receiver, so the whole assembly rested on the opening fold never being a
			// follower -- which ADR-0087 retires, since no generation fetches and what a
			// stream's address resolves to is the DEPLOYMENT's own writer of it. The other:
			// a captured receiver is PINNED, so a deployment whose live set moved while it
			// ran (a successor registered beside the incumbent, a generation deleted by
			// another process) went on feeding the one it read at start-up.
			//
			// `container.liveIngestions()` is the question the ingest route already asks per
			// batch (`@etherfold/server`), answered from the REGISTRY rather than from
			// memory, and it reconciles writer succession on the way. So the combined shape
			// and the split shape now route on one fact.
			target: createDirectIngestion(() => container.liveIngestions()),
		},
	);
}

/**
 * How long a `run` started with NOTHING configured waits between two looks at whether it
 * has been told what to fetch, where nothing woke it sooner.
 *
 * An upload WAKES it at once; this is the bound for every other way a source can arrive
 * (an operator's promote onto a generation it can instantiate), so it is a ceiling on
 * how long such a node sits with a source and no fetcher, not a cadence anything folds on.
 */
export const WAITING_POLL_MS = 1_000;

/**
 * THE WORDS `/status` CARRIES while a node started with nothing configured has no source
 * to fetch (ADR-0093).
 */
function waitingFor(indexer: string): WaitingReport {
	return {
		for: 'processor',
		message:
			`this node was started with no processor and no source (ADR-0093), and nothing it holds names what to ` +
			`fetch: it fetches nothing and folds nothing new until a processor is uploaded to it (\`etherfold upload\`, ` +
			`POST /${indexer}/admin/upload). Reads are answered by the canonical generation where its registry names one, ` +
			`and refused until then.`,
	};
}

/**
 * The accessor of a thing a node started with NOTHING configured does not have yet,
 * refused with the reason rather than answered with a placeholder (ADR-0093).
 */
function notYet(what: string): never {
	throw new Error(
		`this \`etherfold run\` was started with no processor and no source (ADR-0093) and has not been told what to ` +
			`fetch yet, so it has no ${what}: it is WAITING for a processor to be uploaded.`,
	);
}

/**
 * Assemble a `run` started with NOTHING configured (ADR-0093): the same database, the
 * same registry and the same stream ends a configured `run` has, a container with no fold
 * and no source of its own (`openWaitingFolding`), and NO FETCHER until there is
 * something to fetch.
 *
 * ## How the fetcher comes to exist after start
 *
 * A configured `run` builds its one fetcher over the source it resolved at start. This
 * one has none, and a placeholder source would fetch something nobody chose, so the
 * fetcher is built LATE, by the drive loop (`index`), at the first moment the container
 * names what this deployment fetches (`ReceivingIndexer.fetchedSource`): at `open`, where
 * the registry's canonical generation could be instantiated from its stored bundle, or at
 * the first upload the container registers. From then on it is the fetcher a configured
 * `run` has, over the same wire, and `driveCycles` drives it exactly as it drives that
 * one.
 *
 * Until then `index` WAITS -- on a wake an upload rings, and on `WAITING_POLL_MS` for
 * any other arrival -- and `/status` says so (`waiting`).
 */
async function prepareWaiting<ABI extends Abi, ProcessResultType, C extends ChainFollowingCommand>(
	command: C,
	options: Options,
	deps: IndexingDependencies,
	env: EnvRecord,
	resolved: RunConfig<ABI>,
	provider: EIP1193ProviderWithoutEvents,
): Promise<PreparedIndexing<ABI, ProcessResultType, C>> {
	const providedStreamConfig = streamConfigFor(env);
	const streamConfig = resolveStreamConfig(providedStreamConfig);
	const db = await openFoldingDatabase(resolved.destination, {
		applyFixedSchema: resolved.serving.autoSetup,
		...(deps.createDB ? {createDB: deps.createDB} : {}),
	});
	const {container, stateOf, foldParts} = await openWaitingFolding<ABI, ProcessResultType>(resolved.destination, db, {
		stream: providedStreamConfig,
		finalityDepth: streamConfig.finality,
		indexer: resolved.indexer,
		...(resolved.promotion === undefined ? {} : {promotion: resolved.promotion}),
		provider,
	});

	/** The one fetcher, once there is a source; see the JSDoc for when. */
	let host: FetcherHost<ABI> | undefined;
	const startFetchingIfTold = (): FetcherHost<ABI> | undefined => {
		if (host) return host;
		const source = container.fetchedSource;
		if (!source) return undefined;
		host = fetcherHostOver<ABI, ProcessResultType>(source, resolved, env, providedStreamConfig, provider, container);
		logger.info(
			`run: this node was started with nothing configured and now knows what to fetch, so it starts fetching ` +
				`(ADR-0093)`,
		);
		return host;
	};
	// the canonical generation instantiated at `open` may have told it already
	startFetchingIfTold();

	/** Rung by an upload the container registered, so the wait ends at once rather than on the next look. */
	let wake: () => void = () => {};
	const arrivals = arrivalQueue();
	const receive = uploaderFor<ABI, ProcessResultType>(
		{
			provider,
			db,
			destination: resolved.destination,
			stream: providedStreamConfig,
			container,
			// NO `configured`: a node started with nothing configured has no source the
			// OPERATOR chose, so an upload carrying different contracts is a successor on a
			// new stream rather than a mismatch (`upload.ts`, ADR-0093)
			foldParts,
		},
		arrivals,
	);

	return {
		config: resolved as ConfigFor<C, ABI>,
		get source(): IndexingSource<ABI> {
			return container.fetchedSource ?? notYet('source');
		},
		get processor(): EventProcessor<ABI, ProcessResultType> {
			return container.processor;
		},
		get streamWriter(): StreamWriter<ABI> {
			return container.ingestion;
		},
		container,
		get host(): FetcherHost<ABI> {
			return host ?? notYet('fetcher');
		},
		get store(): WritableStateStore {
			return container.state;
		},
		stateOf,
		db,
		reconfigure: reconfigurerFor<ABI, ProcessResultType>(
			{
				options,
				env,
				provider,
				db,
				dbUrl: resolved.destination.db,
				indexer: resolved.indexer,
				container,
				...(deps.importModule ? {importModule: deps.importModule} : {}),
			},
			arrivals,
		),
		upload: async (bundle) => {
			const report = await receive(bundle);
			wake();
			return report;
		},
		waiting: () => (host ? undefined : waitingFor(resolved.indexer)),
		index: async () => {
			const wait = deps.sleep ?? sleep;
			// WAITING, until something names what to fetch or the process is asked to stop:
			// a wait that fetches nothing and folds nothing, and says so on `/status`.
			while (!startFetchingIfTold()) {
				if (deps.signal?.aborted) return {cycles: 0, pushed: 0, stoppedBecause: 'stopped'};
				await Promise.race([
					new Promise<void>((resolve) => {
						wake = resolve;
					}),
					wait(WAITING_POLL_MS, deps.signal),
				]);
			}
			return driveCycles(command, startFetchingIfTold() as FetcherHost<ABI>, container, deps);
		},
	};
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
 * **There is exactly ONE retryable refusal the one-shot does not retry, and it is
 * not a bound.** `NoLiveReceiverError` with nothing live at all says this process
 * has nowhere to push. Since ADR-0087 that is a much narrower state than it was:
 * a stream's address resolves to the DEPLOYMENT's own writer of that stream, held
 * for as long as any registered generation folds it, so "every fold here is a
 * follower" no longer reaches it at all -- which was the whole defect, since a
 * restarted deployment answered it for ever while reporting itself healthy. What
 * is left is a process holding no fold. It is re-thrown on the one-shot for the
 * same reason a `fatal` is: a one-shot that folded nothing must not report
 * success, and a CI job depends on the code rather than on parsing output.
 *
 * Deliberately NOT a stop on `contended`, on either command: a yielded cycle
 * means another sender moved the cursor, and stopping there would report success
 * having landed nothing.
 *
 * Stopping a follower of the TIP is therefore a signal and never a report, which
 * is what `deps.signal` carries in from the caller (`run` installs the process's signal
 * handlers on it; a test aborts it by hand).
 *
 * ## The second difference, and it is the SAME one: who advances a SUCCESSOR
 *
 * A `run` is a long-running host, so it has TIME to advance a successor: under
 * ADR-0087 no generation fetches, so EVERY fold is advanced by a bounded REBUILD
 * its host SCHEDULES (ADR-0022) over the stream the deployment stored -- taking
 * each delta live where it is level, and reading the rows back where it is
 * behind -- rather than by the wire. The gap the loop
 * already waits between cycles is that host's own clock, so one chunk is taken
 * there -- bounded by construction, on the same thread as the fold, so it can
 * neither stall a cycle beyond a chunk nor write into the incumbent's tables
 * while it folds.
 *
 * A `build` has no such gap to spend, because it EXITS -- so it takes that same
 * bounded step ONCE, after the loop and before it returns, beside the retention
 * pass that is there for the identical reason. It is not that a one-shot never
 * holds a successor: re-run a `build` over a database it already wrote with
 * CHANGED processor bytes and it is a different identity, so the container
 * registers a successor beside the canonical generation exactly as a restarted
 * `run` does. What was missing was the SETTLE, so that build folded its successor
 * to the tip and exited with the pointer still naming the OLD generation -- and
 * the artifact it published therefore served the old fold, with a fully caught-up
 * newer one sitting in the database beside it.
 *
 * WHAT THAT STEP PROMISES, and it is BOUNDED without being a single chunk: it
 * carries every fold this build holds to the end of the stream AS IT STANDS, and
 * settles the pointer. It loops only while a chunk stopped on its BUDGET -- "more
 * is waiting right now" -- so it terminates on the stream's own finite length,
 * and every stop reason that recurs for ever ends it (ADR-0070). It used to be
 * ONE chunk, on the premise that a re-run `build`'s successor was fed by the WIRE
 * and was already level by the time the loop ended, leaving only the settle.
 * ADR-0087 removes that premise: a fold that came up behind advances by
 * re-folding, and one chunk is not a catch-up.
 *
 * WHERE THE SUCCESSOR COMES FROM, in the two ways it can arrive. A generation is
 * registered when the container OPENS, from config, so a RESTART is one of them
 * -- and what makes a restart survivable is not the process being long-lived but
 * the registry and the state being ROWS: the new process finds the incumbent
 * already there, still canonical, still answering, and registers the successor
 * beside it. The other way needs no restart at all, and is the one "a reconfigure
 * can reach a long-running host" was always read as meaning: this process RE-READS
 * its own configuration when asked to, over HTTP
 * (`POST /{indexer}/admin/reconfigure`, `reconfigure.ts`), and registers whatever
 * generation that names beside the live fold while it goes on answering. Nothing
 * inside this process watches a file: whatever notices a rebuild stays outside and
 * pulls that trigger. What the long-running shape buys is the half described
 * above: somewhere to put the bounded rebuild that carries the successor to level
 * once it exists.
 *
 * The loop sleeps only where it decided to WAIT, so a process still catching the
 * chain up flat out (`CATCH_UP_DELAY_MS=0`) advances its followers once it
 * reaches the tip rather than while it is behind it. That is the right order and
 * not a compromise: the generation that answers reads is the one still being
 * caught up, and a rebuild competing with it for the same handle would slow the
 * thing every reader is waiting on.
 *
 * ## The third thing that gap is for: the PRUNE this deployment's retention implies
 *
 * The same clock, the same argument, a different verb (`pruning.ts`). A
 * retention floor is enforced on two halves -- refused on read, DROPPED from
 * storage -- and the second half is a call the HOST schedules and never a side
 * effect of a write (ADR-0022). So one BOUNDED pass rides in the gap between
 * cycles, unconditionally, since a store with no floor is a no-op there and its
 * floor is not a question this loop can ask.
 *
 * Here `build` differs rather than abstaining: it has an EXIT, so its passes run
 * until the state is at its floor once it has reached the tip, because the
 * database it exits with is a publishable artifact.
 */
async function driveCycles<ABI extends Abi, ProcessResultType>(
	command: ChainFollowingCommand,
	host: FetcherHost<ABI>,
	container: ReceivingIndexer<ABI, ProcessResultType, WritableStateStore>,
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
	 * WHY THE ONE-SHOT GAVE UP, when it gave up on something retryable.
	 *
	 * Set from `onReport` and re-thrown after the loop, beside the `fatal` re-throw,
	 * because that is where the loop's outcome is turned into this command's: the
	 * report cannot throw from inside `runFetcherLoop` without turning an ordinary
	 * classification into an exception the loop never contracted to handle.
	 */
	let nothingToFeed: unknown;
	/**
	 * WHAT THE HOST DOES IN THE GAP IT WAITS: one bounded rebuild chunk for every
	 * follower held AND the pointer settled once, one bounded prune pass over the
	 * states held, then the sleep the loop asked for.
	 *
	 * Both are the same bargain and both FAIL SOFT. A rebuild that fails is LOGGED
	 * and the loop carries on: the successor is behind by one chunk and the canonical
	 * generation goes on answering, which is the whole shape of a rebuild running
	 * beside a live fold. A prune that fails leaves a store larger than it asked to
	 * be, which is not a wrong answer.
	 *
	 * ## Why it is UNCONDITIONAL, exactly like the prune beneath it
	 *
	 * It used to be gated on how many FOLLOWERS the container held, and that gate made
	 * the whole restart-shape upgrade unreachable: a successor that arrived at `open`
	 * was not a follower, because `follows` was decided from "do I already hold a fold
	 * on this stream" and at `open` the fold list is empty -- so a redeployed process's
	 * successor was fed by the WIRE, held no rebuild, caught up, and the settle it
	 * needed was never called. The gate answered the wrong question: whether anything
	 * is being REBUILT, rather than whether anything might be PROMOTED.
	 *
	 * Under ADR-0087 there is nothing left to gate on at all: no generation fetches,
	 * so EVERY fold advances by re-folding the stream this deployment stored, and
	 * `rebuildMore` is what does it -- plus the settle, once.
	 *
	 * What it costs when there is nothing to do is a few registry reads per cycle, in
	 * the gap the loop already waits, which is the same bargain the prune below
	 * states for itself. It decides nothing about where a rebuild gets its turn on
	 * `index`, which has no drive loop at all
	 * (`an-index-process-advances-the-successor-it-registered` owns that); this is the
	 * loop `run` already had, no longer refusing to call a settle.
	 */
	/** Which followers have already been reported as stalled, so it is said once and not per cycle. */
	const reportedStalled = new Set<string>();

	const betweenCycles: Sleep = async (ms, signal) => {
		if (!stopAtTip) {
			try {
				for (const stalled of newlyStalledFollowers(await container.rebuildMore(), reportedStalled)) {
					// `console.error` and NOT the named-logs logger, for the reason
					// `processorSetup.ts` already documents at its own diagnostic: this
					// package captures `logs('etherfold')` at module scope and only the
					// `fetch` and `index` commands ever import `named-logs-console`, so on
					// the commands that reach this loop a `logger.error` is a silent no-op.
					// A permanent stall reported into nothing is the defect, not the fix.
					console.error(
						`the rebuild of generation ${stalled.id} cannot advance (${stalled.reason}) and retrying will not ` +
							`change that. It stays behind and never becomes level, so it will not take over writing its ` +
							`stream. This needs a look; the canonical generation is unaffected and goes on answering.`,
					);
				}
			} catch (err) {
				logger.error(`a rebuild chunk failed; the canonical generation is unaffected and the next cycle retries`, err);
			}
		}
		// THE OTHER HALF OF RETENTION, on the same clock and for the same reason: a
		// window bounds what a READ may ask about from the moment it is configured,
		// and this is what bounds the BYTES (ADR-0022 -- a call the HOST schedules,
		// never a side effect of a write). Unconditional: it is a no-op wherever there
		// is no floor, and a store's floor is not a question this loop can ask (see
		// `pruning.ts`). One BOUNDED pass, here in the gap the loop already waits, so
		// a backlog drains over cycles instead of stalling the cycle that met it.
		try {
			const pruned = await pruneHeldMore(container, {maxVersions: DEFAULT_PRUNE_BUDGET});
			if (!pruned.complete) {
				logger.info(
					`pruned ${pruned.versionsDeleted} versions and the budget of ${DEFAULT_PRUNE_BUDGET} stopped the pass ` +
						`before the state reached its retention floor. The next cycle continues.`,
				);
			}
		} catch (err) {
			// The same shape as the rebuild above: indexing is what this process is for,
			// and a delete that could not run leaves a store LARGER than it asked to be
			// rather than an answer that is wrong. The next cycle retries.
			logger.error(`a scheduled prune failed; the fold is unaffected and the next cycle retries`, err);
		}
		await wait(ms, signal);
	};

	try {
		const summary = await runFetcherLoop(host, {
			signal: controller.signal,
			sleep: betweenCycles,
			onReport: (report) => {
				if (report.kind === 'progress') {
					console.log(`${report.outcome.toBlock} / ${report.outcome.latestBlock}`);
				}
				deps.onReport?.(report);
				if (stopAtTip && (report.kind === 'idle' || (report.kind === 'progress' && report.caughtUp))) {
					controller.abort();
				}
				// ...and the one retryable refusal a ONE-SHOT cannot wait out: nothing here is
				// live for the wire to feed, and this command has no gap between cycles for the
				// rebuild that would change that. Read STRUCTURALLY rather than with
				// `instanceof`, for the reason `isRetryable` is structural: two copies of
				// `@etherfold/core` in one dependency tree would otherwise turn a deliberate exit
				// into the hang it exists to prevent.
				if (stopAtTip && report.kind === 'retry' && (report.error as {name?: string})?.name === 'NoLiveReceiverError') {
					nothingToFeed = report.error;
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
		if (nothingToFeed !== undefined) {
			// AHEAD of the exit work below, exactly as the `fatal` re-throw is: this build
			// fetched nothing, so there is no artifact to settle a pointer on or prune to a
			// floor, and doing either would dress a run that achieved nothing as one that
			// finished. The error says what the state is and what closes it.
			throw nothingToFeed;
		}

		// THE ONE-SHOT'S EXIT WORK, and the one place a `run` has nothing to match:
		// `build` exits, so "the next cycle continues" has no next cycle, and the
		// database it exits with is a publishable ARTIFACT. A `build` STOPPED from
		// outside skips ALL of it, and that is the same rule for both halves: a caller
		// asking a process to stop is not asking it to finish a delete or a promotion
		// first, and the tip it stopped at is not the tip either was written for.
		if (stopAtTip && !deps.signal?.aborted) {
			try {
				// EVERY FOLD CARRIED TO THE END OF THE STREAM AS IT STANDS, and the pointer
				// settled. It is the same `rebuildMore` `run` makes in the gap between cycles,
				// LOOPED here because this command has no such gap and its database is a
				// publishable ARTIFACT: under ADR-0087 no generation fetches, so a fold that came
				// up BEHIND -- a re-run `build` with changed bytes over a database that already
				// holds the history -- advances by re-folding rather than by the wire, and one
				// bounded chunk is not a catch-up.
				//
				// It stays BOUNDED, which is the property a one-shot may never give up: the loop
				// runs only while a chunk stopped on its BUDGET, so it terminates on the stream's
				// own finite length, and every reason that recurs for ever ends it (ADR-0070).
				for (const stalled of await rebuildUntilLevel(container, reportedStalled)) {
					console.error(
						`the rebuild of generation ${stalled.id} cannot advance (${stalled.reason}) and retrying will not ` +
							`change that, so this build exits with that generation still behind. The canonical generation is ` +
							`unaffected; this needs a look.`,
					);
				}
			} catch (err) {
				// `console.error` and NOT the named-logs logger, for the reason the rebuild
				// diagnostic above already documents: on the commands that reach this loop a
				// `logger.error` is a silent no-op, and this is the one line that says the
				// artifact may serve a generation this build did not just fold.
				//
				// FAIL SOFT, like the prune below and for the same reason: the exit code is about
				// what this command FOLDED, and it folded everything it was asked to. What is
				// wrong is which generation the pointer names, which a re-run settles.
				console.error(
					`the settle of this build failed, so the canonical pointer may still name the generation this build ` +
						`did not just fold. The state it folded is unaffected and re-running the command settles it.`,
					err,
				);
			}
			try {
				// ...and THE PRUNE, the one place a single pass is not enough: the passes stay
				// bounded and this loops them until the state is at its floor. AFTER the settle,
				// so the generation the artifact now serves is pruned to the floor its retention
				// asked for rather than one pass later.
				await pruneHeldUntilComplete(container, {maxVersions: DEFAULT_PRUNE_BUDGET});
			} catch (err) {
				// It folded everything it was asked to fold, which is what the exit code is
				// about: the artifact holds more history than its retention covers, and
				// re-running the command prunes it.
				logger.error(`the scheduled prune of this build failed; the state it folded is unaffected`, err);
			}
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
 * ## HOW MANY GENERATIONS IT HOLDS IS THE DATABASE'S ANSWER, NOT THE COMMAND'S
 *
 * This used to claim the one-shot "opens the container with one fold and exits, so
 * it never adds a second and never promotes". The first half was measured FALSE
 * and the second was true only because of it, so the claim is CORRECTED here
 * rather than made true by refusing: a `build` that refused to register a
 * successor would be a new refusal an operator meets on the ordinary redeploy,
 * where the honest behaviour -- fold the new generation and publish it -- costs
 * nothing and is what the generation model is for.
 *
 * Run twice over the SAME inputs it RESOLVES the same generation rather than
 * registering another (the registry's own rule), which costs a pointer read at
 * start-up. Run again with CHANGED processor bytes it is a different identity, so
 * the container registers a SUCCESSOR beside the canonical generation exactly as a
 * restarted `run` does -- and the fold it comes up holding is that successor, fed
 * by the wire to the tip. It then SETTLES the pointer once before exiting
 * (`driveCycles`), so the artifact serves the generation this build just folded
 * rather than the one the previous build left behind.
 *
 * That is what keeps a `build` artifact indistinguishable from a `run` database on
 * the generation axis -- exactly the axis it must not be distinguishable on, since
 * the artifact's whole purpose is to become somebody else's INPUT. What it still
 * does NOT do is hold a reconfigure: nothing can register a successor into a
 * running `build`, because it has no route to ask it to, and its settle promises
 * ONE bounded step rather than waiting for anything to catch up.
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
