import {logs} from 'named-logs';
import type {ProcessorDriftComparison, ProcessorDriftReport} from './types.js';

const namedLogger = logs('@etherfold/core');

/* ---------------------------------------------------------------------------
 * WHAT A DIFFERENCE BETWEEN TWO CODE FINGERPRINTS MEANS, AND HOW IT IS SAID
 *
 * `utils/fingerprint.ts` derives the fingerprint and records what it survives;
 * this is the one place that turns a PAIR of them into a report. It exists as a
 * function rather than as a method on whichever class happened to need it first
 * because four surfaces ask the same question and an operator must have exactly
 * one phrase to grep for: the chain-facing `IndexerGeneration` as it adopts a
 * cursor, the receiving `StreamBuilder` and `GenerationRebuild` as they adopt
 * theirs, and the CLI's reconfigure endpoint as it compares a re-imported module
 * with the fold that is running.
 *
 * ## The three rules it enforces for all of them
 *
 * 1. **EITHER SIDE MISSING IS "UNKNOWN", NEVER "DRIFTED".** A cursor persisted
 *    before the field existed, and a processor whose handlers are all bound or
 *    proxied and therefore have no readable source, both answer `undefined`. A
 *    report on those would fire once for every existing deployment on upgrade,
 *    and a report that cried wolf on day one is a report nobody reads on day two.
 * 2. **IT IS A QUESTION FOR THE AUTHOR, NOT A VERDICT.** The fingerprint does not
 *    survive minification, a change of transpiler or target, or a comment edit
 *    under a toolchain that keeps comments (`utils/fingerprint.ts` measures all
 *    three), so every message ends by naming that possibility and by saying the
 *    fingerprint is advisory.
 * 3. **NOTHING HERE ACTS.** It builds a value and, through `announceProcessorDrift`,
 *    logs it. It registers nothing, discards nothing and enters no identity --
 *    which is the whole of why the false positive above is affordable.
 * ------------------------------------------------------------------------- */

/** What a comparison is made of: the two fingerprints, the hash they agree on, and which question is being asked. */
export type ProcessorDriftInputs = {
	/** The version hash BOTH sides carry. A differing one is an upgrade, and an upgrade is never a drift. */
	processorHash: string;
	/** Which pair this is. See `ProcessorDriftComparison`. */
	compared: ProcessorDriftComparison;
	/** The fingerprint of the code behind what this deployment already has, or `undefined` for "unknown". */
	previousFingerprint: string | undefined;
	/** The fingerprint of the code as it is now, or `undefined` for "unknown". */
	currentFingerprint: string | undefined;
};

/**
 * The report for this pair, or `undefined` when there is nothing to say.
 *
 * `undefined` covers both "they agree" and "one side cannot answer", and the
 * caller treats them identically: it reports nothing. They are deliberately not
 * distinguished here, because a surface that acted on the difference would be
 * acting on the absence of information.
 */
export function processorDriftReport(inputs: ProcessorDriftInputs): ProcessorDriftReport | undefined {
	const {processorHash, compared, previousFingerprint, currentFingerprint} = inputs;
	if (!previousFingerprint || !currentFingerprint || previousFingerprint === currentFingerprint) {
		return undefined;
	}
	const message =
		`PROCESSOR DRIFT: the processor's version hash is unchanged (${processorHash}) but its handler code is not ` +
		`${whatDiffers(compared, previousFingerprint, currentFingerprint)} ` +
		`If no logic changed, this is a re-minification, a transpiler change or a comment edit and can be ignored ` +
		`(the fingerprint is advisory: it enters no identity and never discards state or registers a generation on ` +
		`its own).`;
	return {processorHash, compared, previousFingerprint, currentFingerprint, message};
}

/**
 * The middle of the message: what the two fingerprints ARE, what follows from
 * that, and the one action that changes it.
 *
 * The opening and the closing are shared above, so the `PROCESSOR DRIFT` phrase
 * and the advisory caveat are identical whoever asked. What differs is the only
 * thing that differs between the two questions: WHICH pair this is, and
 * therefore what the reader is being told about their deployment. Both arms end
 * in "bump the processor's `version`", because that is the single thing an author
 * can do about either.
 */
function whatDiffers(compared: ProcessorDriftComparison, previous: string, current: string): string {
	switch (compared) {
		case 'persisted-state':
			return (
				`(state was computed by ${previous}, running ${current}). ` +
				`The persisted state was computed by DIFFERENT logic and is being reused as if it were current. ` +
				`Bump the processor's \`version\` to discard and recompute it.`
			);
		case 'reloaded-module':
			return (
				`(this deployment is running ${previous}, the module just re-read is ${current}). ` +
				`The edit WAS read and it names the generation this deployment already holds, so nothing was ` +
				`registered and the fold goes on running the code it came up with. ` +
				`Bump the processor's \`version\` to say that this is a different fold.`
			);
	}
}

/**
 * Say it: at ERROR in the logs, and to the host's listener if it set one.
 *
 * The log is unconditional because a callback nobody sets would be a silent
 * detector, and it is `error` because "the state you are serving was computed by
 * code that no longer exists" is not an info. The listener is CONTAINED for the
 * reason every listener in this package is: a report must not be able to break
 * the load, the batch or the reload it was noticed during.
 */
export function announceProcessorDrift(
	report: ProcessorDriftReport,
	listener: ((report: ProcessorDriftReport) => void) | undefined,
): void {
	namedLogger.error(report.message);
	if (!listener) return;
	try {
		listener(report);
	} catch (err) {
		namedLogger.error(`onProcessorDrift listener threw`, err);
	}
}
