import {generationDigestOf, type GenerationId, type SuccessorReplacementAtStart} from '@etherfold/core';
import {logs} from 'named-logs';

const logger = logs('etherfold');

// ---------------------------------------------------------------------------------------------------
// A START MAY NOT SILENTLY REPLACE A DIFFERENT PENDING SUCCESSOR
// ---------------------------------------------------------------------------------------------------
// ADR-0084's and ADR-0093's amendments of 2026-09-26. A `run` started with a
// `--processor` that differs from the canonical generation's registers it as the new
// `successor`, and that slot holds ONE: registering into it DELETES what it held --
// row, state and stored bytes. A pending successor is work in progress, often an
// upload somebody sent to the running node, and for such a node the stored bytes are
// the only copy of its code. So where a start would replace a DIFFERENT pending
// successor, the container asks BEFORE anything is registered
// (`ReceivingIndexerOptions.confirmReplacingSuccessorAtStart`), and this is `run`'s
// answer:
//
//  - `--override` given: the start goes ahead, and says what it replaced;
//  - an INTERACTIVE start (stdin is a TTY): it ASKS, naming both generations, and
//    goes ahead only on a yes;
//  - otherwise: it is REFUSED by name, naming `--override`.
//
// Only the START is guarded. A re-read and an upload are already deliberate acts on
// a running node and replace a pending successor as they always did.
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

/**
 * `run`'s answer to a start that would replace a different pending successor: go
 * ahead under `--override`, ask where somebody can answer, refuse by name otherwise.
 */
export function startGuardFor(
	override: boolean,
	deps: StartGuardDependencies = {},
): (replacement: SuccessorReplacementAtStart) => Promise<void> {
	return async ({pending, arriving}) => {
		const what =
			`this start would register the configured processor as ${named(arriving)} in the \`successor\` slot, ` +
			`which REPLACES the pending successor ${named(pending)} -- still catching up, perhaps an upload -- and ` +
			`DELETES it: its row, its state and its stored bundle`;
		if (override) {
			logger.warn(`${what}. --override was given, so it goes ahead.`);
			return;
		}
		const interactive = deps.interactive ?? process.stdin.isTTY === true;
		if (interactive) {
			const confirm = deps.confirm ?? askOnTheTerminal;
			if (await confirm(`${what}. Replace it? [y/N] `)) return;
			throw new Error(`${what}. Declined, so nothing was registered or deleted, and this start stops here.`);
		}
		throw new Error(
			`${what}. A start may not do that silently, and nobody can be asked here (stdin is not a terminal), so it ` +
				`is REFUSED and nothing was registered or deleted. Pass --override to let this start replace it (a ` +
				`pipeline that redeploys per commit passes it once, in its deploy configuration), or start with the ` +
				`pending successor's processor, or with none, to keep it.`,
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
