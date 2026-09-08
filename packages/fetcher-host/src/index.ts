/**
 * The host-side half of the log-fetcher.
 *
 * `@etherfold/core` decides what a fetch cycle IS (`LogFetcher.fetchAndPush()`),
 * and deliberately says nothing about when one runs. This package is the layer
 * above: it reads a deployment's configuration, turns a cycle's outcome into one
 * of five things a scheduler can act on, says how long to wait after each, and
 * offers the two shapes a schedule comes in -- a loop for a host that owns a
 * process, one bounded run for a host that gets an invocation.
 *
 * `platforms/nodejs-fetcher` is the adapter built on it. What an adapter adds is
 * a runtime: an environment, a provider, signals or a trigger. What it must NOT
 * add is anywhere to remember a block number. ADR-0003 and ADR-0004: the receiver
 * owns the cursor, the `409` is the correction path, and a fetcher that persisted
 * its own cursor would have reintroduced the split brain the wire contract
 * removes.
 *
 * ## Why there is one schedule shape
 *
 * Because driving the chain needs a host that can hold a PROCESS. A serverless
 * runtime is an excellent home for the receiving half, which serves requests and
 * whose work is short and per-request, and a poor one for this half: its trigger
 * fires on a schedule rather than continuously, its invocations are capped well
 * below what a first sync takes, and a batch has to be held in memory while it is
 * built. So there is no invocation-shaped scheduler here, and no serverless
 * fetcher to want one.
 *
 * What DOES vary is where the batch goes. `createHttpIngestion` pushes it to an
 * indexer-server elsewhere (a Worker, say), and `createDirectIngestion` hands it
 * to a stream-builder in this very process, which is how a single Node deployable
 * runs both halves. Both are `IngestionTarget`s, so that choice reaches this
 * package as a dependency and changes nothing else about it.
 */
export {delayForReport, resolveBackoff, type BackoffConfig, type ResolvedBackoff} from './backoff.js';
export {
	COMMON_RESULT_CAP,
	describeFetcherHostConfig,
	FetcherConfigError,
	parseIndexingSource,
	parseLearnedRange,
	redactUrl,
	resolveFetcherHostConfig,
	streamConfigFromEnv,
	type EnvRecord,
	type FetcherHostConfig,
	type FetcherHostConfigOverrides,
} from './config.js';
export {createFetcherHost, FetcherHost, isRetryable, type CycleReport, type FetcherHostDependencies} from './host.js';
export {createJSONRPCProvider} from './provider.js';
export {runFetcherLoop, sleep, type LoopOptions, type RunSummary, type Sleep} from './schedule.js';
