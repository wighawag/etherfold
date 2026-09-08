import {
	createHttpIngestion,
	LogFetcher,
	type Abi,
	type FetchCycleOutcome,
	type FetchLike,
	type IngestionTarget,
	type RetryableError,
} from '@etherfold/core';
import type {EIP1193ProviderWithoutEvents} from 'eip-1193';
import {logs} from 'named-logs';
import {delayForReport, type ResolvedBackoff} from './backoff.js';
import {describeFetcherHostConfig, FetcherConfigError, type FetcherHostConfig} from './config.js';
import {createJSONRPCProvider} from './provider.js';

const namedLogger = logs('@etherfold/fetcher-host');

type PushedOutcome = Extract<FetchCycleOutcome, {status: 'pushed'}>;
type UpToDateOutcome = Extract<FetchCycleOutcome, {status: 'up-to-date'}>;
type YieldedOutcome = Extract<FetchCycleOutcome, {status: 'yielded'}>;

/**
 * One cycle, classified into the five things a scheduler can do about it.
 *
 * Three of the five are not failures, which is the distinction this type exists
 * to keep visible: `idle` means the chain has produced nothing above the cursor,
 * and `contended` means the cycle was corrected repeatedly without landing,
 * which is what redundant fetchers do to each other. Both mean back off. Neither
 * means alert.
 *
 * The other two are split by the ERROR's own `retryable` flag and by nothing
 * else -- not by a status code, not by a message, and not by a list of error
 * names kept here, which would drift the moment `@etherfold/core` gained another
 * refusal.
 */
export type CycleReport =
	| {
			kind: 'progress';
			outcome: PushedOutcome;
			/** The pushed range reached the tip this cycle observed, so there is nothing known to be left. */
			caughtUp: boolean;
			summary: string;
	  }
	| {kind: 'idle'; outcome: UpToDateOutcome; summary: string}
	| {
			kind: 'contended';
			outcome: YieldedOutcome;
			/** How many consecutive cycles have ended this way. One is ordinary; a run is a signal. */
			run: number;
			summary: string;
	  }
	| {
			kind: 'retry';
			error: unknown;
			/** How many consecutive cycles have failed this way, which is what the backoff escalates on. */
			run: number;
			summary: string;
	  }
	| {kind: 'fatal'; error: unknown; summary: string};

/**
 * Whether waiting could help, asked of the ERROR and never decided here.
 *
 * The same structural read `@etherfold/core` makes, for the same reasons: an
 * error crossing from a second copy of core still classifies correctly, and
 * anything WITHOUT the property is retried, because those are the errors core did
 * not throw (a node's JSON-RPC error, a dropped socket) and transience is the
 * honest default for them.
 *
 * `packages/fetcher-host/test/classification.test.ts` asks this of a real
 * instance of every error core throws, so the two cannot drift apart quietly.
 */
export function isRetryable(error: unknown): boolean {
	return (error as RetryableError | undefined)?.retryable !== false;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * The wire's configuration, demanded only once it is known that there IS a wire.
 *
 * `resolveFetcherHostConfig` cannot make this check: whether an endpoint is
 * required depends on whether the caller supplies its own target, which is not
 * part of the environment. Making it here means a split deployment still fails
 * at startup naming the missing variable, and a combined one is never asked for
 * a URL it has no use for.
 */
function httpOptions<ABI extends Abi>(
	config: FetcherHostConfig<ABI>,
	dependencies: FetcherHostDependencies,
): {endpoint: string; indexer: string; token: string; fetch?: FetchLike} {
	const missing = [
		...(config.endpoint ? [] : ['INGEST_ENDPOINT']),
		// the NAMED INDEXER the route segment carries: a receiving host registers the
		// names it was built with and defaults none, so a fetcher that has no name has
		// nothing to address (ADR-0036)
		...(config.indexer ? [] : ['INDEXER_NAME']),
		...(config.token ? [] : ['INGEST_TOKEN']),
	];
	if (missing.length > 0) {
		// "A", "A and B", "A, B and C": an Oxford-less list, so the two-variable case
		// reads exactly as it did before a third variable existed
		const named =
			missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}` : missing[0];
		throw new FetcherConfigError(
			`${named} ${missing.length > 1 ? 'are' : 'is'} unset, and this host pushes over HTTP. ` +
				`Set ${missing.length > 1 ? 'them' : 'it'}, or hand this host an ingestion target of its own ` +
				`(createDirectIngestion, for a process that also runs the stream-builder).`,
		);
	}
	return {
		endpoint: config.endpoint as string,
		indexer: config.indexer as string,
		token: config.token as string,
		...(dependencies.fetch ? {fetch: dependencies.fetch} : {}),
	};
}

export type FetcherHostDependencies = {
	/** Supply a provider instead of building one from `nodeUrl`. */
	provider?: EIP1193ProviderWithoutEvents;
	/**
	 * Supply a transport instead of building the HTTP one from `endpoint` and `token`.
	 *
	 * This is how a COMBINED host is built: pass `createDirectIngestion(builder)`
	 * (`@etherfold/core`) and the fetcher feeds a stream-builder in this same
	 * process, with no wire, no URL and no shared secret. Everything else on this
	 * object stays exactly as it is in a split deployment, which is the point:
	 * whether the halves are one process or two is a deployment decision, not two
	 * implementations.
	 */
	target?: IngestionTarget;
	/** The `fetch` the HTTP transport uses. A runtime's own, or a test's in-process handler. */
	fetch?: FetchLike;
};

/**
 * A configured fetcher plus the policy for reading what a cycle did.
 *
 * It is the whole of the host layer that is NOT scheduling, which is exactly why
 * it is shared: the difference between a process holding a loop and a trigger
 * handing out invocations is when `runCycle()` is called and by what, and it
 * should be nothing else. Every host builds one of these from the same
 * configuration and acts on the same five reports.
 *
 * Note what it does not have: anywhere to put a block number. It holds counters
 * for consecutive failures and consecutive yields -- facts about this RUN, used
 * to escalate a delay and to warn about a run of contention -- and it drops them
 * on progress. Nothing here persists anything, and a host that added a cursor
 * beside it would have re-introduced the split brain ADR-0004 removes.
 */
export class FetcherHost<ABI extends Abi> {
	readonly fetcher: LogFetcher<ABI>;
	readonly config: FetcherHostConfig<ABI>;

	private failureRun = 0;
	private contentionRun = 0;
	private cycles = 0;

	constructor(config: FetcherHostConfig<ABI>, dependencies: FetcherHostDependencies = {}) {
		this.config = config;
		const provider =
			dependencies.provider ?? createJSONRPCProvider(config.nodeUrl, {requestsPerSecond: config.requestsPerSecond});
		const target = dependencies.target ?? createHttpIngestion(httpOptions(config, dependencies));

		this.fetcher = new LogFetcher<ABI>(provider, config.source, target, {
			stream: config.stream,
			retry: config.retry,
			fetch: {
				maxEventsPerFetch: config.maxEventsPerFetch,
				...(config.maxBlocksPerFetch !== undefined ? {maxBlocksPerFetch: config.maxBlocksPerFetch} : {}),
			},
			// passed EXPLICITLY, never left to default to `maxEventsPerFetch`: the two
			// are independent, and `config.ts` says why at length
			suspectResultCount: config.suspectResultCount,
			...(config.maxCorrectionsPerCycle !== undefined ? {maxCorrectionsPerCycle: config.maxCorrectionsPerCycle} : {}),
		});
	}

	get backoff(): ResolvedBackoff {
		return this.config.backoff;
	}

	/** Cycles run by THIS host object. A restarted host starts at zero, having nothing to carry. */
	get cyclesRun(): number {
		return this.cycles;
	}

	/** Consecutive retryable failures, reset by any cycle that gets an answer. */
	get consecutiveFailures(): number {
		return this.failureRun;
	}

	/** Consecutive `yielded` cycles, reset by any cycle that lands or finds nothing to do. */
	get consecutiveContentions(): number {
		return this.contentionRun;
	}

	/** What an operator should see once, at startup. Carries no credential. */
	describe(): string {
		return describeFetcherHostConfig(this.config);
	}

	/**
	 * Run one cycle and classify it. Does not throw, and does not wait.
	 *
	 * Both halves of that are deliberate. Not throwing means a scheduler is a loop
	 * over a value rather than a `try`/`catch` written twice, once per host, with
	 * the classification quietly different in each. Not waiting means the WAIT is
	 * the scheduler's, which is what lets a process sleep and lets a cron-triggered
	 * host treat its interval as the backoff and simply return.
	 */
	async runCycle(): Promise<CycleReport> {
		this.cycles++;
		let outcome: FetchCycleOutcome;
		try {
			outcome = await this.fetcher.fetchAndPush();
		} catch (err) {
			if (!isRetryable(err)) {
				// No waiting fixes this one: a bad token, a foreign {source, config}, the
				// wrong chain, a suspected truncation. A host that retried it would retry
				// forever, which is the failure the two refusal codes exist to prevent.
				this.failureRun = 0;
				const summary = `stopping: ${messageOf(err)}`;
				namedLogger.error(summary);
				return {kind: 'fatal', error: err, summary};
			}
			this.failureRun++;
			const summary = `cycle failed (${this.failureRun} in a row), and it is worth another: ${messageOf(err)}`;
			namedLogger.error(summary);
			return {kind: 'retry', error: err, run: this.failureRun, summary};
		}

		this.failureRun = 0;

		if (outcome.status === 'pushed') {
			this.contentionRun = 0;
			const caughtUp = outcome.toBlock >= outcome.latestBlock;
			const summary =
				`pushed [${outcome.fromBlock}, ${outcome.toBlock}] of ${outcome.latestBlock}: ` +
				`${outcome.logs} log(s), ${outcome.applied} applied, ${outcome.retracted} retracted` +
				(outcome.corrections > 0 ? `, after ${outcome.corrections} correction(s)` : '') +
				(outcome.reorg ? `, receiver derived a ${outcome.reorg.cause} reorg at ${outcome.reorg.blockNumber}` : '');
			namedLogger.info(summary);
			return {kind: 'progress', outcome, caughtUp, summary};
		}

		if (outcome.status === 'up-to-date') {
			this.contentionRun = 0;
			const summary = `nothing to do: the next batch starts at ${outcome.expectedFromBlock}, the tip is ${outcome.latestBlock}`;
			namedLogger.info(summary);
			return {kind: 'idle', outcome, summary};
		}

		this.contentionRun++;
		const summary =
			`yielded after ${outcome.corrections} correction(s) without landing a batch ` +
			`(${this.contentionRun} cycle(s) in a row); the next batch starts at ${outcome.expectedFromBlock}`;
		if (this.contentionRun >= this.config.backoff.contentionRunAlert) {
			// One is ordinary. A RUN of them means every cycle this fetcher starts is
			// overtaken before it lands, which is worth a human's attention: usually
			// another sender, but a receiver whose cursor moves for some other reason
			// looks exactly the same from here.
			namedLogger.warn(
				`${summary}. That is the redundant-sender signature; if no second fetcher is running, look at the receiver.`,
			);
		} else {
			namedLogger.info(summary);
		}
		return {kind: 'contended', outcome, run: this.contentionRun, summary};
	}

	/** How long to wait before the next cycle, from the backoff this deployment configured. */
	delayFor(report: CycleReport): number {
		return delayForReport(report, this.config.backoff);
	}
}

/**
 * Build a host from resolved configuration.
 *
 * The one line both adapters share, and the reason the startup log is written
 * once: it names the node and the endpoint by HOST only, since an RPC URL is a
 * credential at every hosted provider and this is the line most likely to be
 * copied into an issue.
 */
export function createFetcherHost<ABI extends Abi>(
	config: FetcherHostConfig<ABI>,
	dependencies: FetcherHostDependencies = {},
): FetcherHost<ABI> {
	const host = new FetcherHost<ABI>(config, dependencies);
	namedLogger.info(`log-fetcher configured: ${host.describe()}`);
	return host;
}
