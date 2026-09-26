import type {CycleReport} from './host.js';

/**
 * How a host schedules a fetcher: a LOOP, driven by whoever owns the process.
 *
 * It is HERE, above `@etherfold/core` and below the adapter, because scheduling
 * is the only thing a host adds and `@etherfold/core` must name no scheduler
 * (ADR-0003, and a test in core reads the sources to keep it that way).
 *
 * It names no runtime: `setTimeout` is all it needs, so an adapter contributes a
 * process, its signals and an exit code, and nothing else.
 *
 * ## Why there is only one shape
 *
 * An earlier version of this file also carried `runBoundedFetcherRun`, the shape
 * a host that gets an INVOCATION would use. It is gone because no host in this
 * design can use it. Driving the chain needs a process that can sit in a loop:
 * a serverless trigger fires on a schedule at best once a minute, caps an
 * invocation well below what a first sync takes, and holds a whole batch in
 * memory while it works. That is why the serverless runtime here hosts the
 * RECEIVING half, where the work is per-request and short, and the fetching half
 * runs somewhere that can hold a process, whether it pushes over HTTP or feeds a
 * stream-builder in the same process (`createDirectIngestion`, `@etherfold/core`).
 *
 * Keeping the bounded shape around for a host nobody expects to build would have
 * been a speculative export with a real cost: another public function, another
 * set of outcomes on `RunSummary`, and a test suite asserting two shapes agree
 * when only one of them can ever run. It is about forty lines, and it can come
 * back the day an invocation-scoped host with a workable budget does.
 */

/** Sleep that wakes early when the run is asked to stop. Replaceable so a test need not really wait. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const sleep: Sleep = (ms, signal) =>
	new Promise<void>((resolve) => {
		if (signal?.aborted) {
			return resolve();
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			resolve();
		}
		signal?.addEventListener('abort', onAbort, {once: true});
	});

export type RunSummary = {
	cycles: number;
	/** Ranges landed during this run. Zero is normal for a run that found nothing to do. */
	pushed: number;
	/** Why the run ended. `stopped` is a signal or an abort; `fatal` needs a human. */
	stoppedBecause: 'stopped' | 'fatal';
	lastReport?: CycleReport;
	/** Set only when the run ended on a refusal no waiting fixes. */
	error?: unknown;
};

/**
 * WHAT THE LOOP DRIVES: something that runs one classified cycle and says how long to
 * wait after it.
 *
 * A `FetcherHost` is one, over one source. So is anything that runs SEVERAL of them as
 * one cycle -- a combined `run` that fetches a second stream beside the first, for a
 * successor that arrived with new contracts, drives one of those -- which is why the
 * loop asks for these two methods and nothing else: scheduling is the same whatever is
 * behind them.
 */
export type CycleRunner = {
	/** Run one cycle and classify it. Does not throw, and does not wait. */
	runCycle(): Promise<CycleReport>;
	/** How long to wait after `report` before the next cycle. */
	delayFor(report: CycleReport): number;
};

export type LoopOptions = {
	/** Abort to stop the loop; it finishes the cycle in flight and returns. */
	signal?: AbortSignal;
	/** Called with every report, in order. The adapter's hook for metrics or its own logging. */
	onReport?: (report: CycleReport) => void;
	sleep?: Sleep;
};

/**
 * Drive cycles until stopped: the shape a host that can hold a process uses.
 *
 * It follows the tip continuously, which in practice means it spends a first
 * sync running cycles back to back (each `progress` report that has not reached
 * the tip is followed by `catchUpDelayMs`, zero by default) and then settles
 * into one cycle per `pollIntervalMs`. Anything that is not progress backs off
 * on the curve `delayFor` computes.
 *
 * A refusal ENDS the loop, and there is deliberately no option to carry on past
 * one. A bad token, a foreign `{source, config}` or a provider on the wrong chain
 * does not become right by being tried again, so a "keep going anyway" switch
 * could only ever produce the failure the two refusal codes exist to prevent: a
 * host that looks healthy while achieving nothing. What to do about it is the
 * adapter's (exit non-zero, fail the invocation), and both are louder than
 * staying up.
 */
export async function runFetcherLoop(host: CycleRunner, options: LoopOptions = {}): Promise<RunSummary> {
	const wait = options.sleep ?? sleep;
	const summary: RunSummary = {cycles: 0, pushed: 0, stoppedBecause: 'stopped'};

	while (!options.signal?.aborted) {
		const report = await host.runCycle();
		summary.cycles++;
		summary.lastReport = report;
		if (report.kind === 'progress') {
			summary.pushed++;
		}
		options.onReport?.(report);

		if (report.kind === 'fatal') {
			summary.stoppedBecause = 'fatal';
			summary.error = report.error;
			return summary;
		}

		const delay = host.delayFor(report);
		if (delay > 0) {
			await wait(delay, options.signal);
		}
	}

	return summary;
}
