import type {UsedPromotionConfig} from '@etherfold/core';
import {logs} from 'named-logs';

const logger = logs('@etherfold/server');

/**
 * The `promotion` field on `/status`: WHEN this deployment moves the canonical
 * pointer on its own, and what happens to the generation left behind.
 *
 * An envelope, exactly as `cursor` and `fetcher` are, and for the same shared
 * reason: a reporter that cannot answer must be distinguishable from a deployment
 * that has nothing to report, so a failure is `{reported: false, reason}` and
 * never an omission (ADR-0047 rejected omitting for that reason, and an operator
 * reads these fields on one page, so two degradation conventions would be worse
 * than a little repetition).
 *
 * It is TYPED rather than carried verbatim, for `fetcher`'s reason: this is
 * `@etherfold/core`'s `UsedPromotionConfig` -- a package this one already depends
 * on -- and it is a three-valued string plus a boolean, with nothing in it that
 * belongs to a host's private vocabulary. So there is no `value` to hide behind
 * and no serialisability probe to run.
 *
 * ## Why this is on `/status` at all
 *
 * Because the policy is otherwise INVISIBLE, and its whole point is that it
 * changes when a successor takes over answering reads. An operator watching a
 * rebuild on this page can already see a successor catching up; without this they
 * would have to infer from behaviour whether the pointer is going to move on its
 * own, when it moves, or only when they ask -- and the value that is in force is
 * the one thing the deployment knows for certain. It is RESOLVED (both halves
 * filled in) rather than as-configured, so what is read back is what will actually
 * happen, not what somebody typed.
 */
export type StatusPromotion = ({reported: true} & UsedPromotionConfig) | {reported: false; reason: string};

/**
 * Ask the host's promotion reporter, and never let the answer fail the request.
 *
 * The same rule the cursor reporter, the fetcher reporter and the reorg counters
 * follow in this route: `/status` is the page an operator watches while something
 * is wrong, so a reporter that throws, rejects or has nothing to say degrades to a
 * reason and changes neither `healthy` nor the status code.
 */
export async function reportPromotion(
	report: () => UsedPromotionConfig | undefined | Promise<UsedPromotionConfig | undefined>,
): Promise<StatusPromotion> {
	let reported: UsedPromotionConfig | undefined;
	try {
		reported = await report();
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		logger.error(`status: the promotion reporter failed: ${reason}`);
		return {reported: false, reason};
	}

	if (reported === undefined) {
		return {reported: false, reason: `the promotion reporter has nothing to report`};
	}

	return {reported: true, policy: reported.policy, dropOnPromotion: reported.dropOnPromotion};
}
