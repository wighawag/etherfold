import type {Abi, IndexingSource, ProvidedStreamConfig, RetryPolicy} from '@etherfold/core';
import {resolveBackoff, type BackoffConfig, type ResolvedBackoff} from './backoff.js';

/**
 * A deployment's configuration, as read from an environment.
 *
 * A plain record rather than `process.env` or a serverless runtime's `env`,
 * because that difference between hosts is not an interesting one: both are
 * objects with string values. Keeping the parsing here is what makes every
 * host's configuration IDENTICAL rather than merely similar.
 */
export type EnvRecord = Record<string, string | undefined>;

/**
 * Configuration that is wrong in a way no amount of waiting fixes.
 *
 * Carries `retryable: false` for the same reason every refusal in
 * `@etherfold/core` does: a host reads the flag rather than the type, so a
 * misconfigured deployment stops and says so instead of retrying forever.
 *
 * It NEVER quotes a value, only the variable that held it: the two variables
 * most likely to be wrong (`INGEST_TOKEN`, `ETH_NODE_URI`) are both credentials.
 */
export class FetcherConfigError extends Error {
	readonly name = 'FetcherConfigError';
	readonly retryable = false;

	constructor(message: string) {
		super(message);
	}
}

/** The most common `eth_getLogs` result cap, and the value `suspectResultCount` defaults to. */
export const COMMON_RESULT_CAP = 10000;

export type FetcherHostConfig<ABI extends Abi> = {
	/** What to index. MUST be the same source the receiver was built with. */
	source: IndexingSource<ABI>;
	/**
	 * The indexer-server's base URL. `/{indexer}/ingest` and
	 * `/{indexer}/ingest/expected-from-block` hang off it.
	 *
	 * Optional, and required in practice for a SPLIT deployment only. A combined
	 * host, which feeds a stream-builder in its own process through
	 * `createDirectIngestion`, supplies the target directly and has no URL to give:
	 * demanding one would be demanding configuration for a network that is not
	 * there. `FetcherHost` refuses at construction if there is neither a target nor
	 * an endpoint, which is the moment both facts are known.
	 */
	endpoint?: string;
	/**
	 * The NAMED INDEXER this fetcher pushes into (`INDEXER_NAME`): one indexed
	 * answer set over one chain, and the first segment of every ingest route.
	 *
	 * Supplied by the operator and NEVER defaulted (ADR-0036): a receiving host
	 * registers the N named indexers it was built with, so a name this deployment
	 * invented would be refused with a `404` at best, and would push another
	 * tenant's logs at worst.
	 *
	 * Optional here for exactly the same reason `endpoint` and `token` are: a
	 * COMBINED host has no route to address, because its target is a stream-builder
	 * in this same process. `FetcherHost` demands it where the answer is known.
	 */
	indexer?: string;
	/**
	 * The server's `INGEST_TOKEN`, presented as a bearer token.
	 *
	 * Never logged, never reported and never included in an error message: a wrong
	 * or unset one comes back as a `401`, surfaced as a non-retryable
	 * `IngestionRefusedError` that names the VARIABLE and not the value.
	 *
	 * Optional for the same reason as `endpoint`: a shared secret authenticates a
	 * caller across a network, and a combined host is not one.
	 */
	token?: string;
	/** The JSON-RPC endpoint this fetcher reads the chain from. May itself carry an API key. */
	nodeUrl: string;
	/**
	 * **SET THIS TO YOUR NODE'S REAL `eth_getLogs` RESULT CAP.**
	 *
	 * This is the sharpest edge in a fetcher deployment, and an adapter is where it
	 * gets configured, so it is stated here as well as at the option it feeds.
	 *
	 * A node that caps `eth_getLogs` SILENTLY returns exactly N logs with no error,
	 * and nothing distinguishes that from a range that genuinely holds N. The only
	 * detection there is is matching N exactly. So a node capping at 5000 while this
	 * says 10000 hands back 5000 logs, the guard does not fire, a SHORT range is
	 * pushed as a complete one, and the receiver reads the missing logs as an
	 * absence -- an absence is a reorg, and a reorg deletes state.
	 *
	 * Leaving it at the default asserts that your node caps at exactly 10000 or does
	 * not cap silently at all. If you do not know, ask your provider; if you cannot
	 * find out, set it low enough to be certain, at the cost of extra re-fetches.
	 *
	 * It is NOT `maxEventsPerFetch`, and it is deliberately resolved independently
	 * of it (see that option).
	 */
	suspectResultCount: number;
	/**
	 * How many events one `eth_getLogs` aims for, which is what sets the SPAN each
	 * fetch asks for (the range fetcher targets ~80% of this).
	 *
	 * Two things to know before touching it:
	 *
	 * - RAISING it to dodge a truncation guard makes truncation MORE likely, since
	 *   it widens the range asked for. That is not what this knob is for.
	 * - LOWERING it is the only lever a host has over the SIZE of a batch, since it
	 *   narrows the range and therefore lowers `toBlock` -- the one legal way to
	 *   make a payload smaller (ADR-0004 forbids sending part of a range outright).
	 *   It bounds the batch by EVENT COUNT, which is a proxy for bytes and not a
	 *   bound on them. See `work/notes/observations/nothing-bounds-the-size-of-an-ingest-batch.md`.
	 */
	maxEventsPerFetch: number;
	/**
	 * The widest block range one `eth_getLogs` may cover, whatever it holds.
	 *
	 * The other lever on batch size, and the blunter one: it bounds the RANGE
	 * directly rather than through a count, which matters on a first sync, where the
	 * gap between the start block and the tip is millions of blocks wide and the
	 * count is the only thing keeping a single fetch from asking for all of it.
	 * Lowering it lowers `toBlock`, which is the one legal way to make a payload
	 * smaller.
	 */
	maxBlocksPerFetch?: number;
	/** MUST match the receiver's, since `{source, config}` is hashed into the wire identity. */
	stream: ProvidedStreamConfig;
	/** Rate limit applied to the JSON-RPC provider this host builds. */
	requestsPerSecond?: number;
	/**
	 * The BOUNDED retry core applies inside a single cycle, to the calls that can
	 * fail transiently (a provider read, a push to an unreachable server).
	 *
	 * Distinct from `backoff`, which is this host's wait BETWEEN cycles: by the time
	 * a host sees a `retry` report, these attempts are already spent. Kept short on
	 * an invocation-scoped host especially, since they are spent inside its budget.
	 */
	retry?: RetryPolicy;
	/** How many `409` corrections one cycle follows before yielding. Core's default is 2. */
	maxCorrectionsPerCycle?: number;
	backoff: ResolvedBackoff;
};

/** Everything a caller may pass by hand, on top of (or instead of) an environment. */
export type FetcherHostConfigOverrides<ABI extends Abi> = Partial<
	Omit<FetcherHostConfig<ABI>, 'backoff' | 'stream'>
> & {
	stream?: ProvidedStreamConfig;
	backoff?: BackoffConfig;
};

function readNumber(env: EnvRecord, name: string): number | undefined {
	const raw = env[name];
	if (raw === undefined || raw.trim() === '') {
		return undefined;
	}
	const value = Number(raw);
	if (!Number.isFinite(value)) {
		throw new FetcherConfigError(`${name} must be a number, and is not. Fix the deployment's environment.`);
	}
	return value;
}

/**
 * Parse an `IndexingSource` out of the JSON a deployment configures.
 *
 * Deliberately strict and deliberately loud. A source is half of the wire
 * IDENTITY, so a typo here does not produce a fetcher that indexes slightly the
 * wrong thing: it produces one the receiver refuses with a context mismatch,
 * which is a good outcome reached expensively. Catching the shape here means the
 * message names the field instead of naming two hashes that differ.
 */
export function parseIndexingSource<ABI extends Abi>(json: string, variable = 'INDEXING_SOURCE'): IndexingSource<ABI> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (err) {
		throw new FetcherConfigError(`${variable} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
	const source = parsed as IndexingSource<ABI>;
	if (!source || typeof source !== 'object') {
		throw new FetcherConfigError(`${variable} must be a JSON object: {chainId, contracts: [...]}`);
	}
	if (typeof source.chainId !== 'string') {
		// a decimal STRING, as `IndexingSource` declares it: `1`, not `0x1` and not 1
		throw new FetcherConfigError(`${variable}.chainId must be a decimal string, e.g. "1" for mainnet`);
	}
	const contracts = source.contracts as {abi?: unknown; address?: unknown}[] | {abi?: unknown};
	if (Array.isArray(contracts)) {
		if (contracts.length === 0) {
			throw new FetcherConfigError(`${variable}.contracts is empty, so this fetcher would index nothing`);
		}
		for (const [index, contract] of contracts.entries()) {
			if (!Array.isArray(contract?.abi)) {
				throw new FetcherConfigError(`${variable}.contracts[${index}].abi must be an ABI array`);
			}
			if (typeof contract.address !== 'string' || !contract.address.startsWith('0x')) {
				throw new FetcherConfigError(`${variable}.contracts[${index}].address must be a 0x address`);
			}
		}
	} else if (!Array.isArray((contracts as {abi?: unknown})?.abi)) {
		// the ALL-contracts form: one ABI, every address
		throw new FetcherConfigError(`${variable}.contracts must be an array of contracts, or {abi, startBlock}`);
	}
	return source;
}

function required(value: string | undefined, variable: string, what: string): string {
	if (value === undefined || value.trim() === '') {
		throw new FetcherConfigError(`${variable} is unset, and it is ${what}.`);
	}
	return value;
}

/**
 * Resolve one deployment's configuration from an environment plus explicit
 * overrides, with the overrides winning.
 *
 * Every host calls THIS, which is what keeps their configuration identical: the
 * same variable names, the same defaults and the same refusals whatever the
 * runtime. What an adapter adds is where the record comes from and when a cycle
 * runs.
 */
/**
 * The stream settings the ENVIRONMENT owns, and the only place they are read.
 *
 * Exported because the commands that hold BOTH halves of the wire in one process
 * have to hand the identical config to each, and the way to get that wrong is to
 * derive it twice. A caller that needs the same config the fetcher host would
 * have used asks for it here rather than re-reading the variable.
 *
 * `STREAM_FINALITY` is the whole of it: `STREAM_ALWAYS_FETCH_TIMESTAMPS` and
 * `STREAM_ALWAYS_FETCH_TRANSACTIONS` set flags that no longer exist (ADR-0073),
 * so they are no longer read and are ignored like any other unrecognised
 * variable.
 */
export function streamConfigFromEnv(env: EnvRecord): ProvidedStreamConfig {
	return {
		...(readNumber(env, 'STREAM_FINALITY') !== undefined ? {finality: readNumber(env, 'STREAM_FINALITY')} : {}),
	};
}

export function resolveFetcherHostConfig<ABI extends Abi>(
	env: EnvRecord = {},
	overrides: FetcherHostConfigOverrides<ABI> = {},
): FetcherHostConfig<ABI> {
	const source =
		overrides.source ??
		parseIndexingSource<ABI>(
			required(env.INDEXING_SOURCE, 'INDEXING_SOURCE', 'what tells this fetcher which chain and contracts to read'),
		);

	const maxEventsPerFetch = overrides.maxEventsPerFetch ?? readNumber(env, 'MAX_EVENTS_PER_FETCH') ?? COMMON_RESULT_CAP;

	const retryAttempts = readNumber(env, 'RETRY_ATTEMPTS');
	const retryInitialDelayMs = readNumber(env, 'RETRY_INITIAL_DELAY_MS');

	// NOT `?? maxEventsPerFetch`, which is what core falls back to when it is told
	// nothing. The two numbers mean different things -- what this fetcher ASKS for,
	// and what the node will silently refuse to exceed -- so lowering the first
	// (the only lever a host has over batch size) must not quietly lower the
	// second: a suspect count under the node's real cap makes every fetch that
	// lands on it re-fetch a halved range for no reason, and a single block that
	// holds exactly that many stops the fetcher outright.
	const suspectResultCount =
		overrides.suspectResultCount ?? readNumber(env, 'SUSPECT_RESULT_COUNT') ?? COMMON_RESULT_CAP;

	if (!Number.isInteger(suspectResultCount) || suspectResultCount <= 0) {
		throw new FetcherConfigError(`SUSPECT_RESULT_COUNT must be a positive whole number of logs`);
	}

	// REPLACED, not merged. A caller that hands over a stream config has already
	// resolved it -- it holds the other half of the wire and both must hash the same
	// object -- so merging its config OVER the environment's is the wrong operation:
	// a spread can ADD a key but can never say "no finality here", which made an
	// override meaning "take the default" indistinguishable from an absent one. The
	// combined commands passed exactly that, so the sender resolved `STREAM_FINALITY`
	// while the receiver resolved the default and the two could never talk.
	const stream: ProvidedStreamConfig = overrides.stream ?? streamConfigFromEnv(env);

	return {
		source,
		// NOT `required(...)`: whether a wire needs configuring depends on something
		// this function cannot see, namely whether the caller is handing over its own
		// ingestion target. `FetcherHost` makes that check where the answer is known.
		endpoint: overrides.endpoint ?? env.INGEST_ENDPOINT,
		indexer: overrides.indexer ?? env.INDEXER_NAME,
		token: overrides.token ?? env.INGEST_TOKEN,
		nodeUrl: overrides.nodeUrl ?? required(env.ETH_NODE_URI, 'ETH_NODE_URI', "the chain's JSON-RPC endpoint"),
		suspectResultCount,
		maxEventsPerFetch,
		maxBlocksPerFetch: overrides.maxBlocksPerFetch ?? readNumber(env, 'MAX_BLOCKS_PER_FETCH'),
		stream,
		retry: overrides.retry ?? {
			...(retryAttempts !== undefined ? {attempts: retryAttempts} : {}),
			...(retryInitialDelayMs !== undefined ? {initialDelayMs: retryInitialDelayMs} : {}),
		},
		requestsPerSecond: overrides.requestsPerSecond ?? readNumber(env, 'REQUESTS_PER_SECOND'),
		maxCorrectionsPerCycle: overrides.maxCorrectionsPerCycle ?? readNumber(env, 'MAX_CORRECTIONS_PER_CYCLE'),
		backoff: resolveBackoff({
			pollIntervalMs: readNumber(env, 'POLL_INTERVAL_MS'),
			catchUpDelayMs: readNumber(env, 'CATCH_UP_DELAY_MS'),
			minRetryDelayMs: readNumber(env, 'MIN_RETRY_DELAY_MS'),
			maxRetryDelayMs: readNumber(env, 'MAX_RETRY_DELAY_MS'),
			contentionRunAlert: readNumber(env, 'CONTENTION_RUN_ALERT'),
			...overrides.backoff,
		}),
	};
}

/**
 * A URL with everything after the host replaced.
 *
 * An RPC URL is a credential far more often than it looks: `.../v2/<API-KEY>`
 * is the standard shape at every hosted provider. So the one line an operator
 * most wants in a startup log -- which node am I pointed at -- is exactly the
 * line most likely to leak a key, and it is printed host-only.
 */
export function redactUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const hasSecretShapedPath = parsed.pathname !== '/' && parsed.pathname !== '';
		return `${parsed.protocol}//${parsed.host}${hasSecretShapedPath ? '/…' : ''}`;
	} catch {
		return '<unparseable url>';
	}
}

/**
 * What a host prints when it starts: everything an operator needs to recognise a
 * misconfiguration, and nothing that would burn a credential into a log file.
 *
 * The `suspectResultCount` line is spelled out rather than merely reported,
 * because a default that is silently wrong for your node is the one failure here
 * that corrupts state instead of stopping.
 */
export function describeFetcherHostConfig<ABI extends Abi>(config: FetcherHostConfig<ABI>): string {
	const contracts = Array.isArray(config.source.contracts)
		? `${config.source.contracts.length} contract(s)`
		: 'every contract';
	return [
		`chain ${config.source.chainId}, ${contracts}`,
		`node ${redactUrl(config.nodeUrl)}`,
		config.endpoint ? `pushing to ${redactUrl(config.endpoint)}` : `delivering in-process, with no wire`,
		`suspectResultCount=${config.suspectResultCount} (this deployment asserts that is your node's REAL eth_getLogs ` +
			`cap, or that it does not cap silently; set SUSPECT_RESULT_COUNT if it is not)`,
		`maxEventsPerFetch=${config.maxEventsPerFetch}`,
	].join('; ');
}
