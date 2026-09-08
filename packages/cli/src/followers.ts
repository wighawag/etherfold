import {generationDigestOf, retryCanAdvance, type RebuildReport} from '@etherfold/core';

/**
 * WHICH followers have just become unable to advance, and are therefore worth
 * saying something about.
 *
 * A rebuild chunk that merely has more to do, or nothing to do yet, is the
 * ordinary case and says nothing. A rebuild that CANNOT advance is different in
 * kind: the same three `RebuildStop` reasons recur on every call, so polling
 * never resolves them and the follower never becomes level -- it will never
 * inherit a vacant write duty and never promote (ADR-0070). Silence there is
 * what made it an invisible permanent stall.
 *
 * Reported ONCE per generation rather than on every cycle, because a condition
 * that recurs for ever would otherwise fill a log at the poll rate and become
 * its own kind of silence. `reported` is the caller's memory across cycles and is
 * MUTATED here: a generation that recovers is removed from it, so a later stall
 * is reported again rather than swallowed by a stale entry.
 *
 * A pure decision, separated from the loop that acts on it, so the dedup and the
 * reset are testable without driving a whole indexer.
 */
export function newlyStalledFollowers(
	reports: readonly RebuildReport[],
	reported: Set<string>,
): {readonly id: string; readonly reason: string}[] {
	const fresh: {id: string; reason: string}[] = [];
	for (const report of reports) {
		const id = generationDigestOf(report.generation);
		if (retryCanAdvance(report.stopped)) {
			// RECOVERED, or never stuck: forget it, so a later stall is heard.
			reported.delete(id);
			continue;
		}
		if (reported.has(id)) continue;
		reported.add(id);
		fresh.push({id, reason: report.stopped.reason});
	}
	return fresh;
}
