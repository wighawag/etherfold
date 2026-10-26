import type {Abi, FetchLike} from '@etherfold/core';
import type {CycleReport, EnvRecord} from '@etherfold/fetcher-host';
import {
	runFetcherProcess,
	startFetcher,
	type RunningFetcher,
	type StartFetcherOptions,
} from '@etherfold/platform-nodejs-fetcher';
import type {EIP1193CoreProvider} from 'eip-1193';
import {resolveCommandConfig} from './config.js';
import {openExplicitSource} from './folding.js';
import type {FetchConfig, Options} from './types.js';

// ---------------------------------------------------------------------------------------------------
// `etherfold fetch`: THE CHAIN-FACING HALF, AND THE ONLY WAY TO RUN ONE
// ---------------------------------------------------------------------------------------------------
// A FRONT DOOR, not a new deployable. `platforms/nodejs-fetcher` already ships
// the whole thing -- the loop, the signals a container sends, the exit code --
// and what it did not have is a flag surface, because it was configured from the
// environment only. So this module is the translation and nothing else: resolve
// this command's row of the table (flags first, environment behind them), open
// the source it named, and hand the answer to the adapter as the overrides it
// already takes.
//
// The standalone `etherfold-fetch` binary is RETIRED in the same change, which
// is what makes this the ONE way to run a fetcher. The adapter survives as a
// LIBRARY, exactly as `platforms/nodejs` already does: no binary, and the CLI
// imports its start function.
//
// What this command does NOT own, and each absence is a decision:
//
//  - **No processor**, ever: the chain-facing half holds none (ADR-0003). Its
//    source is therefore always an EXPLICIT one, since there is no module to
//    read contracts out of.
//  - **No store and no database**, so `--store` and `--db` are REFUSED rather
//    than accepted and ignored (`src/config.ts`).
//  - **Nowhere to remember a block number.** No state file, no lock file, no
//    from-block: progress across restarts comes from the receiver's cursor and
//    from nothing else (ADR-0004), and the `409` on the next start is the
//    recovery.
// ---------------------------------------------------------------------------------------------------

/** What a test substitutes for the world; a deployment supplies none of it. */
export type FetchDependencies = {
	/** The environment flags fall back to. Defaults to `process.env`. */
	env?: EnvRecord;
	/** The chain. Defaults to the rate-limited JSON-RPC provider the fetcher host builds. */
	provider?: EIP1193CoreProvider;
	/** The wire. Defaults to the runtime's own `fetch`; a test hands over an in-process receiver. */
	fetch?: FetchLike;
	/**
	 * Stop on SIGINT and SIGTERM. On by default, because that is what a container
	 * sends and a fetcher has nothing to flush: the cycle in flight finishes, and
	 * what it did or did not deliver is settled by the receiver's cursor next time.
	 */
	handleSignals?: boolean;
	/** Every cycle report, in order. For metrics, or a test waiting for one. */
	onReport?: (report: CycleReport) => void;
};

/**
 * This command's row of the table, resolved and opened, in the shape the Node
 * fetcher adapter takes.
 *
 * Named for `prepareIndexing` (`src/index.ts`) and doing the same job one layer
 * thinner: everything that can be refused is refused HERE, before a chain is
 * dialled or a loop is started, and what comes back is the argument to
 * `startFetcher`.
 *
 * Only the inputs that a CLI is asked about are overridden. Everything else
 * a fetcher deployment configures -- `SUSPECT_RESULT_COUNT`, the fetch bounds,
 * the backoff, the stream identity -- is left to the environment the adapter
 * already reads, because those are the fetcher host's published contract and a
 * second name for any of them would be a second way to say one thing.
 */
export async function prepareFetching<ABI extends Abi = Abi>(
	options: Options,
	deps: FetchDependencies = {},
): Promise<StartFetcherOptions<ABI>> {
	const env = deps.env ?? (process.env as EnvRecord);
	// FIRST, and pure: a flag this command does not own, a missing node URL, a
	// missing endpoint or token, or a source only a processor module could have
	// supplied is refused here.
	const config: FetchConfig<ABI> = resolveCommandConfig<'fetch', ABI>('fetch', options, env);

	return {
		env,
		// two arms and no third, which is the type talking: a chain-facing half holds
		// no processor, so the module route -- the only one that can cost an
		// `eth_chainId` call -- is not available to it and was already refused by name
		// (`requireExplicitSource`). `index` lands on the same two arms for its own,
		// independent reason, which is why opening one is shared (`src/folding.ts`).
		source: await openExplicitSource<ABI>(config.source),
		nodeUrl: config.nodeUrl,
		endpoint: config.wire.endpoint,
		// the NAMED INDEXER on that server: the first segment of every ingest route
		// this fetcher calls, and a name the receiver was built with or every push is a
		// 404 (ADR-0036)
		indexer: config.wire.indexer,
		token: config.wire.token,
		...(config.rps === undefined ? {} : {requestsPerSecond: config.rps}),
		...(deps.handleSignals === undefined ? {} : {handleSignals: deps.handleSignals}),
		...(deps.onReport ? {onReport: deps.onReport} : {}),
		dependencies: {
			...(deps.provider ? {provider: deps.provider} : {}),
			...(deps.fetch ? {fetch: deps.fetch} : {}),
		},
	};
}

/**
 * Start the fetch loop and hand back the handle the adapter returns.
 *
 * Named for the command, as `run` and `serve` are, which does mean this module
 * has a local binding called `fetch`: it shadows the global one HERE and nowhere
 * else, and the wire's own `fetch` is never called from this file -- it is passed
 * through to the adapter as a dependency.
 */
export async function fetch<ABI extends Abi = Abi>(
	options: Options,
	deps: FetchDependencies = {},
): Promise<RunningFetcher<ABI>> {
	return startFetcher<ABI>(await prepareFetching<ABI>(options, deps));
}

/**
 * `etherfold fetch` as a PROCESS: start it, keep running until something stops
 * it, and resolve the exit code.
 *
 * The exit code is the ADAPTER's, not this command's: `runFetcherProcess` is
 * taken WHOLE rather than reimplemented over `startFetcher`, so `0` when it was
 * asked to stop and `1` when it stopped on a refusal no waiting fixes is one
 * answer in one place -- the same one the retired binary resolved, because it is
 * the same function. A fetcher that stays up while achieving nothing is
 * indistinguishable from a working one until somebody reads the state it is not
 * producing.
 *
 * What this adds is the CONFIGURATION half: a refusal raised before a loop
 * exists is not something the adapter can be handed, so it is caught here and
 * exits `1` the way every other refusal in this CLI does.
 */
export async function fetchMain<ABI extends Abi = Abi>(
	options: Options,
	deps: FetchDependencies & {
		exit?: (code: number) => void;
		error?: (...args: unknown[]) => void;
	} = {},
): Promise<void> {
	const exit = deps.exit ?? ((code: number) => process.exit(code));
	const error = deps.error ?? console.error;
	try {
		exit(await runFetcherProcess<ABI>(await prepareFetching<ABI>(options, deps)));
	} catch (err) {
		error(err instanceof Error ? err.message : err);
		exit(1);
	}
}
