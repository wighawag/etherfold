import type {Retention} from './capabilities.js';
import {retentionFloor} from './retention.js';

/**
 * ## The half of retention nothing could see
 *
 * `capabilities.ts` is what a store CLAIMS about its retention and `retention.ts`
 * is what a deployment SETS. This is the third question, and until now nothing
 * anywhere could answer it: is the claim actually being ENFORCED against the
 * bytes?
 *
 * Enforcing retention has two halves and they are enforced by different people.
 * `assertRetained` bounds what a read may ask about the moment a floor exists,
 * and it runs on every read whatever the host does. `prune` physically drops the
 * versions below that floor, and ADR-0022 makes it an explicit call the HOST
 * schedules, deliberately, because it costs time proportional to what it drops.
 * So a host that rolled its own indexing loop and never schedules one gets the
 * REFUSALS of a bounded store and the FOOTPRINT of an unbounded one: strictly
 * worse than either honest position, and the store's own report says nothing
 * about it, because the report is about the CLAIM.
 *
 * Every host this repository ships prunes unconditionally
 * (`the-browser-indexing-loop-schedules-its-prune`,
 * `the-cli-schedules-the-prune-its-retention-implies`), so the broken
 * configuration is unreachable with a shipped host. This is what makes it
 * VISIBLE with a bespoke one.
 *
 * ## Why this is a separate ASYNCHRONOUS read and not a field on `capabilities`
 *
 * The capability report is a synchronous getter, readable before `migrate` and
 * before the database is even open, which is the point of it: a caller
 * discovers a missing capability at startup rather than from a wrong answer
 * later. This answer is DURABLE -- a store pruned yesterday must not come back
 * today saying never -- so it lives in storage, and a value in storage cannot be
 * produced by a sync getter before the storage is open. Asserting both would
 * force either an async `capabilities` (breaking every consumer of it, including
 * the `assertRetained` call sites in both versioned backends) or an in-memory
 * flag that resets on reload, which is a report that lies about the case it
 * exists to catch.
 *
 * The precedent for adding an AXIS rather than overloading one is already on
 * that report: `asOf` is a separate field from `retention` because they FAIL
 * differently. So does this. A store with no floor cannot fail this way at all.
 *
 * ## Where the answer is kept
 *
 * Under `retentionEnforcement`, one of the seam's own three records
 * (`records.ts`), which is a keyspace INSIDE each store that no caller can
 * address: an opaque string the store never interprets, never versioned, never
 * reverted and never pruned, which is precisely the durability this needs. It
 * rode the cursor port at first, beside the snapshot origin, and moved out with
 * it for the reason that port records: a caller choosing `retentionEnforcement`
 * for its own cursor would have made a pruned store report it never pruned, and
 * a store that under-reports its own enforcement looks exactly like a store that
 * is fine.
 *
 * It is the one record that never travels through the port's calls. A backend
 * writes it INSIDE the same transaction as the deletion it describes -- which is
 * the whole reason the number recorded and the number deleted against cannot
 * drift -- and reads it back in its own `readRetentionEnforcement`.
 */

/**
 * Bumped when the record's SHAPE changes in a way an older reader would misread.
 *
 * A record this build does not recognise is read as "never pruned" rather than
 * refused -- see `retentionEnforcementOf`, where the asymmetry with the snapshot
 * origin is argued.
 */
const RECORD_FORMAT = 1;

/** What is written under `retentionEnforcement`: small, versioned, self-describing. */
type PruneRecord = {readonly format: number; readonly floor: number};

/**
 * Whether this store's retention is being enforced against its STORAGE, as data.
 *
 * The three arms are the three genuinely different situations, and the first is
 * not a degenerate case of the others: a store with no floor is not failing to
 * prune, it is a store for which pruning is a no-op by contract
 * (`unbounded`, or `revert-only` with no declared finality depth). Reporting it
 * as "never pruned" would make the most common deployment in the project look
 * broken.
 */
export type RetentionEnforcement =
	/**
	 * No floor, so there is nothing to enforce and `prune` is a documented no-op.
	 *
	 * `unbounded` keeps everything by claim, and `revert-only` with no declared
	 * finality depth has stated no floor to prune at (`retentionFloor`).
	 */
	| {readonly kind: 'no-floor'}
	/**
	 * A floor exists and NO prune pass has ever run on this storage.
	 *
	 * This is the report a bespoke host with a hand-rolled loop gets, and it is
	 * the whole reason the read exists. It is also what a correctly-wired host
	 * reports for the moment between opening and its first scheduled pass, so it
	 * is a signal to look rather than a proof of breakage.
	 */
	| {readonly kind: 'never-pruned'; readonly floor: number | undefined}
	/**
	 * A floor exists and a prune pass ran, most recently at `prunedTo`.
	 *
	 * Recorded whether or not that pass deleted anything: a healthy host pruning
	 * on a schedule deletes nothing on most cycles, and treating "deleted
	 * something" as the evidence would make the healthy case the alarm.
	 */
	| {
			readonly kind: 'pruned';
			readonly floor: number | undefined;
			/**
			 * The floor the last pass ran at.
			 *
			 * Kept APART from `floor` (the floor as it stands now) because the
			 * distance between them is the actually useful diagnostic: a host that
			 * pruned once a year ago reports `pruned`, and only the gap says so.
			 */
			readonly prunedTo: number;
	  };

/**
 * The record a backend writes for a prune pass, or `undefined` when there was no
 * floor to run at.
 *
 * It takes the FLOOR the pass ran at -- `PruneReport.floor`, which is
 * `retentionFloor`, which is `retainedRange(...).from`, which is the boundary a
 * read is refused at -- rather than the report, so that a backend holding the
 * deletion inside a transaction can write the record inside the SAME one. That
 * is what keeps the number recorded and the number deleted against from
 * drifting: they are one variable.
 *
 * A pass with no floor writes NOTHING, rather than a record saying so. A store
 * with no floor answers `no-floor` from its retention alone, so a marker would
 * be a second source for one answer, and an `unbounded` store would start
 * accumulating a cursor-port entry for a pass that by contract did nothing.
 */
export function pruneRecord(floor: number | undefined): string | undefined {
	if (floor === undefined) return undefined;
	return JSON.stringify({format: RECORD_FORMAT, floor} satisfies PruneRecord);
}

/**
 * Assemble the report from what a backend knows: its retention, its tip, and
 * whatever that backend has recorded for its last prune pass.
 *
 * Written once here rather than four times, because the three situations are a
 * property of the MODEL and not of any substrate, and a backend that answered
 * this question its own way would be the drift the conformance suite exists to
 * catch.
 *
 * Two decisions are inside it:
 *
 * - **Whether there is a floor is a fact about the SETTING, never about how far
 *   the store has got.** It is asked at block 0 deliberately: a windowed store
 *   floors at 0 there and an `unbounded` one floors nowhere at any tip, so the
 *   answer is the setting's. Asking at the real tip would answer `no-floor` for
 *   a configured store that has applied no block yet, which is exactly the store
 *   a bespoke host is most likely to be misconfiguring.
 * - **An unreadable record reads as `never-pruned` rather than throwing.**
 *   Deliberately unlike the snapshot origin, which throws: that marker is a
 *   SAFETY floor, and treating its absence as "never bootstrapped" has a store
 *   claim history it never received. This one is a DIAGNOSTIC, so the failure
 *   modes are not symmetric -- under-claiming enforcement asks a human to look
 *   at a store that is fine, while a throw would take down a store whose data is
 *   in no way suspect.
 */
export function retentionEnforcementOf(
	retention: Retention,
	finalityDepth: number | undefined,
	tip: number | undefined,
	recorded: string | undefined,
): RetentionEnforcement {
	if (retentionFloor(retention, 0, finalityDepth) === undefined) return {kind: 'no-floor'};

	const floor = tip === undefined ? undefined : retentionFloor(retention, tip, finalityDepth);
	const prunedTo = recordedFloor(recorded);
	return prunedTo === undefined ? {kind: 'never-pruned', floor} : {kind: 'pruned', floor, prunedTo};
}

/** The floor of the last recorded pass, or `undefined` for absent, corrupt or foreign records. */
function recordedFloor(recorded: string | undefined): number | undefined {
	if (recorded === undefined) return undefined;
	let record: PruneRecord | undefined;
	try {
		record = JSON.parse(recorded) as PruneRecord;
	} catch {
		return undefined;
	}
	if (record?.format !== RECORD_FORMAT || typeof record.floor !== 'number') return undefined;
	return record.floor;
}
