import type {Abi, FetchedStream, ReceivingIndexer} from '@etherfold/core';
import type {CycleReport, CycleRunner, FetcherHost} from '@etherfold/fetcher-host';
import {logs} from 'named-logs';

const logger = logs('etherfold');

// ---------------------------------------------------------------------------------------------------
// ONE FETCHER PER STREAM THIS DEPLOYMENT FETCHES, kept in step with the folds it holds
// ---------------------------------------------------------------------------------------------------
// A `run` used to build ONE fetcher over ONE source: the configured one, or, with nothing
// configured, the source its first fold carried (ADR-0093). So an upload carrying
// DIFFERENT contracts (the ordinary "add an event" deploy) registered a successor on a
// new stream that nothing appended to: it never caught up and was never promoted.
//
// The maintainer's decision of 2026-09-26 is a SECOND WRITER: while a successor sits on a
// stream other than the canonical generation's, that stream is fetched too, by its own
// fetcher, appending through the container's `StreamWriter` for that stream. The
// incumbent's fetcher goes on running beside it, which is the whole reason this was
// chosen over MOVING the one fetcher: the generation that answers reads keeps advancing
// while its successor catches up.
//
// ADR-0087's rule is unchanged and stays structural: each stored stream has exactly ONE
// writer (the container holds one per stream), and this holds exactly ONE fetcher per
// stream, keyed on the stream digest. So this adds a second STREAM with its own writer,
// never a second writer of one stream.
//
// WHICH streams are fetched is never decided here. It is the container's answer
// (`ReceivingIndexer.fetchedStreams`), derived from the folds it holds, which follow the
// slots: a successor is held from its registration, a promotion onto another stream
// stops folding the incumbent, and a replaced successor is dropped. This set RECONCILES
// against that answer before every cycle, starting a fetcher for a stream that appeared
// and stopping the one for a stream that left, so the old stream's fetcher stops after a
// promotion rather than running for ever.
// ---------------------------------------------------------------------------------------------------

/**
 * EVERY FETCHER A CHAIN-FOLLOWING COMMAND RUNS, one per stream it fetches, driven as ONE
 * cycle (`CycleRunner`, `@etherfold/fetcher-host`).
 *
 * A cycle runs each fetcher's own cycle in turn, OLDEST FIRST, so the stream the node came
 * up fetching is fetched before a newcomer's in every cycle, and reports the one of their
 * reports that most needs acting on (`significance`). Each fetcher keeps its own backoff,
 * and the wait after a cycle is the SHORTEST any of them asked for: a stream still catching
 * up is not held back by one that is idle at the tip.
 *
 * With ONE stream, which is every deployment that has not received new contracts, a cycle
 * is exactly that one fetcher's cycle and the wait is exactly its wait.
 */
export class StreamFetchers<ABI extends Abi> implements CycleRunner {
	/** One fetcher per stream digest, in the order they were started. */
	private readonly hosts = new Map<string, FetcherHost<ABI>>();
	/** What each fetcher's last cycle reported, which is what its own backoff is computed from. */
	private readonly lastReports = new Map<FetcherHost<ABI>, CycleReport>();

	constructor(
		private readonly container: Pick<ReceivingIndexer<ABI, any, any>, 'fetchedStreams'>,
		/** Build the fetcher of ONE stream, pointed at its source and pushing into the container. */
		private readonly buildFetcher: (fetched: FetchedStream<ABI>) => FetcherHost<ABI>,
	) {}

	/**
	 * BRING THE FETCHERS INTO STEP WITH WHAT THE CONTAINER FETCHES: start one for every
	 * stream that has none, stop the one of every stream no fold here reads any more.
	 *
	 * Where the container names NO stream at all while fetchers are running, they are
	 * KEPT rather than all stopped. Nothing a deployment does on purpose empties the set
	 * (a promotion only moves the fetch, and the canonical generation is always folded),
	 * so an empty answer is a transient state -- the one a generation deleted by another
	 * process leaves -- and a fetcher that keeps asking is what reports it: its push is
	 * refused as `NoLiveReceiverError`, which is retryable on a `run` and ends a `build`
	 * (`driveCycles`), before any chain call is made for it.
	 */
	async reconcile(): Promise<void> {
		const fetched = await this.container.fetchedStreams();
		if (fetched.length === 0) return;
		const wanted = new Set(fetched.map((one) => one.stream));
		for (const [stream, host] of this.hosts) {
			if (wanted.has(stream)) continue;
			this.hosts.delete(stream);
			this.lastReports.delete(host);
			logger.info(
				`run: the stream ${stream} is no longer read by any generation this process folds, so its fetcher stops ` +
					`(ADR-0087: a stream is fetched while a fold here reads it)`,
			);
		}
		for (const one of fetched) {
			if (this.hosts.has(one.stream)) continue;
			this.hosts.set(one.stream, this.buildFetcher(one));
			if (this.hosts.size > 1) {
				logger.info(
					`run: the stream ${one.stream} is read by a generation this process folds and was not fetched yet, so it ` +
						`gets a fetcher of its own, beside the ${this.hosts.size - 1} already running`,
				);
			}
		}
	}

	/** How many streams are being fetched: zero only on a `run` still WAITING for a processor (ADR-0093). */
	get size(): number {
		return this.hosts.size;
	}

	/** The digests of the streams being fetched, oldest first. */
	streams(): readonly string[] {
		return [...this.hosts.keys()];
	}

	/** The fetcher of ONE stream, if it is being fetched. */
	fetcherFor(stream: string): FetcherHost<ABI> | undefined {
		return this.hosts.get(stream);
	}

	/**
	 * THE OLDEST FETCHER RUNNING: the one a single-stream deployment has, and the one a
	 * caller that reports ONE fetcher (`/status`'s learned range, `RunningIndexer.host`)
	 * reads. `undefined` only while nothing is fetched.
	 */
	get primary(): FetcherHost<ABI> | undefined {
		return this.hosts.values().next().value;
	}

	/**
	 * RUN ONE CYCLE OF EVERY FETCHER, after reconciling them with what the container
	 * fetches, and report the one that most needs acting on.
	 */
	async runCycle(): Promise<CycleReport> {
		await this.reconcile();
		let reported: CycleReport | undefined;
		for (const host of [...this.hosts.values()]) {
			const report = await host.runCycle();
			this.lastReports.set(host, report);
			if (!reported || significance(report) < significance(reported)) reported = report;
		}
		if (!reported) {
			// Unreachable from the commands, which drive this only once there is something to
			// fetch; said rather than invented, and retryable so a loop waits for a stream.
			const error = new Error(`this deployment fetches no stream yet, so there was no cycle to run`);
			return {kind: 'retry', error, run: 1, summary: error.message};
		}
		return reported;
	}

	/** The SHORTEST wait any fetcher's own backoff asks for after its last cycle. */
	delayFor(report: CycleReport): number {
		let delay: number | undefined;
		for (const host of this.hosts.values()) {
			const own = host.delayFor(this.lastReports.get(host) ?? report);
			delay = delay === undefined ? own : Math.min(delay, own);
		}
		return delay ?? 0;
	}
}

/**
 * WHICH OF SEVERAL REPORTS A CYCLE REPORTS: the one that most needs acting on, lowest
 * first.
 *
 * A `fatal` ends the loop whichever stream met it. A `retry` outranks progress so a
 * `build` sees the refusal it exits on (`NoLiveReceiverError`). Progress still BEHIND the
 * tip outranks everything calmer, and `caughtUp` progress and `idle` come last, so a
 * `build` stops at the tip only once EVERY stream it fetches has reached it.
 */
function significance(report: CycleReport): number {
	switch (report.kind) {
		case 'fatal':
			return 0;
		case 'retry':
			return 1;
		case 'progress':
			return report.caughtUp ? 4 : 2;
		case 'contended':
			return 3;
		case 'idle':
			return 5;
	}
}
