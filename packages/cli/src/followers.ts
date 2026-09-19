import {generationDigestOf, retryCanAdvance, type RebuildReport, type ReceivingIndexer} from '@etherfold/core';
import type {Abi} from '@etherfold/core';
import type {WritableStateStore} from '@etherfold/processor-entities';

/**
 * WHICH followers have just become unable to advance, and are therefore worth
 * saying something about.
 *
 * A rebuild chunk that merely has more to do, or nothing to do yet, is the
 * ordinary case and says nothing. A rebuild that CANNOT advance is different in
 * kind: the same three `RebuildStop` reasons recur on every call, so polling
 * never resolves them and the fold never becomes level -- so it never catches up
 * with the stream and is never promoted (ADR-0070). Silence there is what made
 * it an invisible permanent stall.
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
	return stalledIn(reports, reported);
}

/**
 * DRIVE THE REBUILD UNTIL EVERY FOLD HAS CONSUMED THE STREAM AS IT STANDS, then
 * stop.
 *
 * The one-shot's half of what `run` gets from having TIME. Under ADR-0087 no
 * generation fetches: the deployment appends to the stream and every generation
 * folds it, taking each delta live where it is level and reading the rows back
 * where it is behind. A fold that comes up BEHIND -- a re-run `build` with changed
 * processor bytes over a database that already holds the history -- therefore
 * needs the rebuild rather than the wire, and one bounded chunk is not a
 * catch-up.
 *
 * **It stays BOUNDED, which is what a one-shot may never give up.** It loops only
 * while a chunk stopped on its BUDGET, which means "more is waiting right now" --
 * the stream is finite and each pass consumes some of it, so the loop terminates
 * on the stream's own length. Every other stop reason ends it: `stream-consumed`
 * is done, `nothing-stored` is a stream the writer has not appended to, and the
 * three that recur for ever need a human (ADR-0070). It is deliberately NOT
 * `while (!complete)`, which polls those three at full rate for ever.
 *
 * The pointer is settled by each pass, so the artifact exits serving the
 * generation this build just folded.
 */
export async function rebuildUntilLevel<ABI extends Abi, ProcessResultType>(
	container: ReceivingIndexer<ABI, ProcessResultType, WritableStateStore>,
	reported: Set<string>,
): Promise<{readonly id: string; readonly reason: string}[]> {
	const stalled: {readonly id: string; readonly reason: string}[] = [];
	for (;;) {
		const reports = await container.rebuildMore();
		stalled.push(...stalledIn(reports, reported));
		if (!reports.some((report) => report.stopped.reason === 'budget')) {
			return stalled;
		}
	}
}

function stalledIn(
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
