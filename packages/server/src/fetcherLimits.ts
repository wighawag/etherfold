import type {FetcherLimits} from '@etherfold/core';
import {logs} from 'named-logs';

const logger = logs('@etherfold/server');

/**
 * The `fetcher` field on `/status`: what the CHAIN-FACING half of this
 * deployment believes about the node it reads.
 *
 * An envelope, exactly as `cursor` is, and for one of its two reasons rather
 * than both. The reason it SHARES: a reporter that cannot answer must be
 * distinguishable from a deployment that has nothing to report, so a failure is
 * `{reported: false, reason}` and never an omission (ADR-0047 rejected omitting
 * for that reason, and an operator reads both fields on one page, so two
 * degradation conventions would be worse than a little repetition).
 *
 * The reason it does NOT share: the contents are TYPED here rather than carried
 * verbatim. A sync cursor is opaque because its meaning lives behind the storage
 * seam and belongs to a processor (ADR-0027), so this package could not name its
 * shape without taking on a dependency and a meaning that are not its. A learned
 * range is `@etherfold/core`'s -- a package this one already depends on -- it is
 * three small numbers and a count, and nothing about it is a host's private
 * vocabulary. So there is no `value` to hide behind, no serialisability probe to
 * run (the shape is numbers and a string union), and a dashboard reading
 * `fetcher.learnedRange.ceiling` is reading a documented field rather than
 * parsing something the server promised not to understand.
 */
export type StatusFetcher = ({reported: true} & FetcherLimits) | {reported: false; reason: string};

/**
 * Ask the host's fetcher reporter, and never let the answer fail the request.
 *
 * The same rule the cursor reporter and the reorg counters follow in this route:
 * `/status` is the page an operator watches while something is wrong, so a
 * reporter that throws, rejects or has nothing to say degrades to a reason and
 * changes neither `healthy` nor the status code.
 */
export async function reportFetcherLimits(
	report: () => FetcherLimits | undefined | Promise<FetcherLimits | undefined>,
): Promise<StatusFetcher> {
	let reported: FetcherLimits | undefined;
	try {
		reported = await report();
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		logger.error(`status: the fetcher reporter failed: ${reason}`);
		return {reported: false, reason};
	}

	if (reported === undefined) {
		return {reported: false, reason: `the fetcher reporter has nothing to report`};
	}

	return {reported: true, learnedRange: reported.learnedRange, suspectResultCount: reported.suspectResultCount};
}
