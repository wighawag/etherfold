import {generationDigestOf, type GenerationId, type SuccessorReplacementAtStart} from '@etherfold/core';
import {logs} from 'named-logs';

const logger = logs('etherfold');

// ---------------------------------------------------------------------------------------------------
// A START MAY NOT SILENTLY DELETE A DIFFERENT PENDING SUCCESSOR
// ---------------------------------------------------------------------------------------------------
// ADR-0084's and ADR-0093's amendments of 2026-09-26, and ADR-0094's third consequence.
// A START with a configured `--processor` (`run`, `build` or `index`: all three open
// the same container over the same slots) deletes what `successor` holds -- row, state
// and stored bytes -- in two cases:
//
//  - REPLACE: the processor differs from the canonical generation's, so it registers as
//    the new `successor`, and that slot holds ONE;
//  - DISCARD: the processor IS the canonical generation's, so the start folds toward
//    exactly that, and a different pending successor, which would otherwise be promoted
//    and serve code the configuration does not name, is deleted (ADR-0094).
//
// A pending successor is work in progress, often an upload somebody sent to a `node`
// over the same database, and the stored bytes are the only copy of its code. So the
// container asks BEFORE anything is registered or deleted
// (`ReceivingIndexerOptions.confirmReplacingSuccessorAtStart`), naming which of the two
// it is, and this is the CLI's answer, the same for all three commands and both cases:
//
//  - `--override` given: the start goes ahead, and says what it deleted;
//  - an INTERACTIVE start (stdin is a TTY): it ASKS, naming both generations, and
//    goes ahead only on a yes;
//  - otherwise: it is REFUSED by name, naming `--override`.
//
// Only the START is guarded. A re-read (on `run`) and an upload (on `node`, ADR-0094)
// are already deliberate acts on a running node and replace a pending successor as
// they always did. `node` itself is never guarded: it starts with no configured
// processor, so its starts replace nothing.
// ---------------------------------------------------------------------------------------------------

/** What a test substitutes for the terminal. */
export type StartGuardDependencies = {
	/**
	 * Whether this start can ASK somebody. Defaults to `process.stdin.isTTY`: a start
	 * under a supervisor, a container or a pipeline has nobody to answer, and waiting
	 * for an answer there would be a start that never finishes.
	 */
	interactive?: boolean;
	/** Ask one yes/no question and answer it. Defaults to a prompt on the terminal. */
	confirm?: (question: string) => Promise<boolean>;
};

/** One generation, the way the admin listing names it: its digest, then the pair it stands for. */
function named(id: GenerationId): string {
	return `${generationDigestOf(id)} {stream: ${id.stream}, processor: ${id.processor}}`;
}

/** What a start would do to the pending successor, said in full, and the one verb the question asks about. */
function whatTheStartWouldDelete(deletion: SuccessorReplacementAtStart): {what: string; verb: 'Replace' | 'Discard'} {
	if (deletion.kind === 'discard') {
		return {
			verb: 'Discard',
			what:
				`this start is configured with the CANONICAL generation ${named(deletion.canonical)}, and a configured ` +
				`start folds toward exactly what its configuration names, so it would DISCARD the pending successor ` +
				`${named(deletion.pending)} -- still catching up, perhaps an upload, and otherwise to be promoted over ` +
				`it -- and DELETE it: its row, its state and its stored bundle. Nothing takes its place`,
		};
	}
	return {
		verb: 'Replace',
		what:
			`this start would register the configured processor as ${named(deletion.arriving)} in the \`successor\` ` +
			`slot, which REPLACES the pending successor ${named(deletion.pending)} -- still catching up, perhaps an ` +
			`upload -- and DELETES it: its row, its state and its stored bundle`,
	};
}

/**
 * The CLI's answer to a start that would delete a different pending successor, by
 * replacing it or by discarding it: go ahead under `--override`, ask where somebody can
 * answer, refuse by name otherwise.
 */
export function startGuardFor(
	override: boolean,
	deps: StartGuardDependencies = {},
): (deletion: SuccessorReplacementAtStart) => Promise<void> {
	return async (deletion) => {
		const {what, verb} = whatTheStartWouldDelete(deletion);
		const lower = verb.toLowerCase();
		if (override) {
			logger.warn(`${what}. --override was given, so it goes ahead.`);
			return;
		}
		const interactive = deps.interactive ?? process.stdin.isTTY === true;
		if (interactive) {
			const confirm = deps.confirm ?? askOnTheTerminal;
			if (await confirm(`${what}. ${verb} it? [y/N] `)) return;
			throw new Error(`${what}. Declined, so nothing was registered or deleted, and this start stops here.`);
		}
		throw new Error(
			`${what}. A start may not do that silently, and nobody can be asked here (stdin is not a terminal), so it ` +
				`is REFUSED and nothing was registered or deleted. Pass --override to let this start ${lower} it (a ` +
				`pipeline that redeploys per commit passes it once, in its deploy configuration), or start with the ` +
				`pending successor's processor to keep it -- or, to keep it with no processor configured at all, start ` +
				`\`etherfold node\` over this database, which takes its code by upload and deletes nothing at start.`,
		);
	};
}

/** A yes/no prompt on the terminal: `y` or `yes`, in any case, is a yes and everything else a no. */
async function askOnTheTerminal(question: string): Promise<boolean> {
	const {createInterface} = await import('node:readline/promises');
	const terminal = createInterface({input: process.stdin, output: process.stdout});
	try {
		const answer = await terminal.question(question);
		return /^y(es)?$/i.test(answer.trim());
	} finally {
		terminal.close();
	}
}
