import type {SyncPhase} from './envelope.js';

/**
 * WHEN A DRIVER RESTS, AND WHAT PHASE IT IS IN -- decided once, for every host.
 *
 * This module is to the DRIVE CADENCE what `cases.ts` is to the boundary: the
 * only place the rule lives. There are two drivers in this package and there
 * will go on being two, for the reason `mainThread.ts` records -- `serve.ts`
 * opens a container and advances it in a loop of its own, while
 * `createIndexerState` IS the main-thread host and has driven its container
 * through an auto-index loop since long before this port existed. What was
 * duplicated between them was never the SCHEDULING, which genuinely differs
 * (one `await`s a rest it can be woken from, the other re-arms a `setTimeout`);
 * it was the DECISION, which does not differ at all and had been written out
 * twice.
 *
 * Twice meant two chances to be wrong, and both were taken. Each driver decided
 * whether to rest from the CANONICAL generation's cursor alone, so a successor
 * added by a reconfigure advanced one fetch range per interval while the process
 * sat idle -- an hour of wall clock, on the default four seconds, for a
 * successor with a thousand ranges of history. Fixing it in one driver and not
 * the other would have left the three hosting shapes disagreeing about something
 * ADR-0082 says they cannot disagree about, and fixing it in both by hand is the
 * same bug waiting for its third spelling.
 *
 * ## What is decided here
 *
 * Two things, together, because they are one question asked twice and an app is
 * shown the answer to both: the coarse PHASE the cycle ended in, and whether the
 * driver should REST before the next one. Keeping them in one function is what
 * makes "a host reporting `at-tip` while its loop goes on fetching" unexpressible
 * rather than merely absent -- that is two answers to one question, and an app
 * told "live" over an incomplete fold is the failure it produces.
 *
 * ## What is NOT decided here
 *
 * How long a rest lasts, how it is waited out, whether it can be woken, what a
 * cycle does before or after, retries, demotion, and every reactive or pushed
 * report. Those are the drivers' own, and they differ.
 */

/** The two phases a COMPLETED cycle can leave a host in. */
export type CyclePhase = Extract<SyncPhase, 'at-tip' | 'catching-up'>;

/** What a driver does once a cycle has landed. */
export type CyclePacing = {
	/** The coarse phase to report. */
	readonly phase: CyclePhase;
	/** Whether to rest before the next cycle, rather than advancing again at once. */
	readonly rest: boolean;
};

/**
 * A container whose generations can be asked where they have got to.
 *
 * Structural on purpose, and far narrower than `Indexer`: this module reads two
 * block numbers per generation and nothing else, so it names exactly that. An
 * `Indexer<ABI, T>` satisfies it for every `ABI` without the generic having to be
 * threaded through here -- which it cannot be, since `Indexer` is invariant in
 * `ABI` and both drivers hold a different instantiation of it.
 *
 * It also accepts `undefined`, which the main-thread host needs: its container is
 * built by `init` rather than by construction, so a cycle can be paced before
 * there is one.
 */
export type PacedContainer = {
	readonly generations: readonly {
		readonly lastSync?: {readonly lastToBlock: number; readonly latestBlock: number};
	}[];
};

/**
 * WHERE EVERY HELD GENERATION'S CURSOR IS, as one value two cycles compare on.
 *
 * Taken BEFORE a cycle and compared with the value after it, which is how a
 * driver knows whether the cycle it just ran achieved anything. A string rather
 * than a structure because it is only ever compared for equality, and `'none'`
 * for a generation with no cursor so that a generation ACQUIRING one reads as
 * movement -- which it is.
 */
export function cursorsOf(container: PacedContainer | undefined): string {
	return (container?.generations ?? []).map((generation) => generation.lastSync?.lastToBlock ?? 'none').join('|');
}

/**
 * IS ANY GENERATION THIS CONTAINER HOLDS STILL SHORT OF ITS OWN TIP?
 *
 * Asked of EVERY held generation rather than of the canonical one, because
 * `Indexer.indexMore` advances them all: a successor rebuilding beside a
 * canonical generation that is already level is exactly the case the canonical
 * cursor cannot see, and it is the case that cost the hour.
 *
 * A generation with NO cursor yet counts as BEHIND. It has answered no advance,
 * which is precisely what a generation a reconfigure has just added looks like,
 * so calling it level is how a driver rests through the whole of the work it was
 * just asked to start. It cannot spin on that: one cycle gives it a cursor, and
 * a generation that never gets one never moves, which `pacingAfterCycle` rests
 * on.
 */
export function someGenerationBehind(container: PacedContainer | undefined): boolean {
	return (container?.generations ?? []).some(
		(generation) =>
			generation.lastSync === undefined || generation.lastSync.lastToBlock < generation.lastSync.latestBlock,
	);
}

/**
 * THE COARSE PHASE A COMPLETED CYCLE LEAVES A HOST IN.
 *
 * Exported on its own because a driver may need the phase at a point where it is
 * not deciding a rest -- `createIndexerState.advanceOnce` reports it after every
 * advance, including the ones `indexToLatest` drives rather than the auto-index
 * loop -- and the alternative is re-spelling the rule there, which is exactly
 * how the two drivers came apart in the first place.
 *
 * It is `catching-up` whenever ANY held generation is short of its tip, so a
 * host rebuilding a successor beside a level canonical generation says so rather
 * than reporting the container as live.
 */
export function phaseAfterCycle(container: PacedContainer | undefined): CyclePhase {
	return someGenerationBehind(container) ? 'catching-up' : 'at-tip';
}

/**
 * WHAT TO DO AFTER A CYCLE: the phase to report, and whether to rest.
 *
 * `cursorsBefore` is `cursorsOf(container)` taken before the cycle ran.
 *
 * ## The rest is not simply "nothing is behind"
 *
 * A generation that is behind and CANNOT advance -- a follower whose stream is
 * not being appended to, a cursor that stands still for any reason -- would
 * otherwise drive this loop as fast as the event loop allows, against a provider
 * a browser user is rate-limited on. So a cycle that moved NOTHING rests even
 * while something is behind. The phase stays honest (`catching-up`, because it
 * IS behind) and the pace falls back to exactly what it was before any of this,
 * which makes the guard strictly safer than the rule it protects.
 *
 * That is the one place the two halves deliberately come apart: `phase` answers
 * "is the fold complete", `rest` answers "is there anything useful to do right
 * now", and a stalled generation is genuinely `catching-up` AND genuinely not
 * worth spinning on. Every other combination is the same question.
 */
export function pacingAfterCycle(container: PacedContainer | undefined, cursorsBefore: string): CyclePacing {
	const behind = someGenerationBehind(container);
	const moved = cursorsOf(container) !== cursorsBefore;
	return {
		phase: phaseAfterCycle(container),
		rest: !behind || !moved,
	};
}
