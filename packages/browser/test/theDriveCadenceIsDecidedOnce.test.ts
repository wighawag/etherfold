import {describe, expect, it} from 'vitest';
import {
	cursorsOf,
	pacingAfterCycle,
	phaseAfterCycle,
	someGenerationBehind,
	type PacedContainer,
} from '../src/host/pacing.js';

/**
 * THE DRIVE CADENCE, AS A DECISION RATHER THAN AS TWO LOOPS.
 *
 * Both hosts in this package used to decide whether to rest from the CANONICAL
 * generation's cursor alone, each in its own loop, and both were wrong in the
 * same way: `Indexer.indexMore` advances EVERY generation, so a successor added
 * by a reconfigure got one fetch range per interval while the process sat idle.
 * Fixing that in two places would have been the same bug waiting for its third
 * spelling, so the rule moved into `host/pacing.ts` and the loops kept only what
 * genuinely differs between them -- how a rest is waited out.
 *
 * The point of that extraction is THIS file. The rule used to be reachable only
 * by standing up a container, a store, a fake chain and a port, which is why the
 * interesting cases (a generation with no cursor, a generation that cannot
 * advance) were awkward to state and went untested. As a pure function over two
 * block numbers per generation it can simply be asked.
 *
 * The end-to-end behaviour is pinned separately, over real hosts, in
 * `everyGenerationIsLevelBeforeTheDriverRests.test.ts`.
 */

/** A container holding generations at the given cursors; `undefined` means "no cursor yet". */
function holding(...generations: ({at: number; tip: number} | undefined)[]): PacedContainer {
	return {
		generations: generations.map((generation) =>
			generation === undefined ? {} : {lastSync: {lastToBlock: generation.at, latestBlock: generation.tip}},
		),
	};
}

const LEVEL = {at: 105, tip: 105};
const BEHIND = {at: 100, tip: 105};

describe('whether any generation is still short of its tip', () => {
	it('is false when every generation is level', () => {
		expect(someGenerationBehind(holding(LEVEL, LEVEL))).toBe(false);
	});

	it('sees a generation the CANONICAL cursor cannot', () => {
		// The whole defect in one assertion: the first generation is at the tip, so a
		// rule reading only the canonical cursor called this container level.
		expect(someGenerationBehind(holding(LEVEL, BEHIND))).toBe(true);
	});

	it('counts a generation with NO cursor as behind', () => {
		// Exactly what a generation a reconfigure just added looks like. Calling it
		// level is how a driver rests through the whole of the work it was just asked
		// to start.
		expect(someGenerationBehind(holding(LEVEL, undefined))).toBe(true);
	});

	it('says nothing is behind when there is nothing to be behind', () => {
		// A container that holds no generation, and the `undefined` container the
		// main-thread host has before `init` builds one.
		expect(someGenerationBehind(holding())).toBe(false);
		expect(someGenerationBehind(undefined)).toBe(false);
	});
});

describe('the phase a completed cycle leaves a host in', () => {
	it('is `at-tip` only when the WHOLE container is level', () => {
		expect(phaseAfterCycle(holding(LEVEL, LEVEL))).toBe('at-tip');
		expect(phaseAfterCycle(holding(LEVEL, BEHIND))).toBe('catching-up');
		expect(phaseAfterCycle(holding(LEVEL, undefined))).toBe('catching-up');
	});
});

describe('the cursor snapshot two cycles are compared on', () => {
	it('changes when any generation moves, including the canonical one', () => {
		expect(cursorsOf(holding(LEVEL, BEHIND))).not.toBe(cursorsOf(holding(LEVEL, {at: 101, tip: 105})));
	});

	it('changes when a generation ACQUIRES a cursor, because that is movement', () => {
		expect(cursorsOf(holding(undefined))).not.toBe(cursorsOf(holding({at: 0, tip: 0})));
	});

	it('is stable when nothing moved', () => {
		expect(cursorsOf(holding(LEVEL, BEHIND))).toBe(cursorsOf(holding(LEVEL, BEHIND)));
	});
});

describe('what a driver does after a cycle', () => {
	it('RESTS once everything is level, whatever the cycle did', () => {
		const container = holding(LEVEL, LEVEL);
		const moved = pacingAfterCycle(container, cursorsOf(holding(LEVEL, {at: 104, tip: 105})));

		expect(moved).toEqual({phase: 'at-tip', rest: true});
	});

	it('does NOT rest while something is behind and the cycle advanced it', () => {
		// The fix: this is the successor catching up, and it must not pay an interval
		// per range.
		const container = holding(LEVEL, {at: 104, tip: 105});
		const pacing = pacingAfterCycle(container, cursorsOf(holding(LEVEL, {at: 100, tip: 105})));

		expect(pacing).toEqual({phase: 'catching-up', rest: false});
	});

	it('RESTS while something is behind but the cycle moved NOTHING', () => {
		// The hot-loop guard, and the one place phase and rest deliberately come
		// apart: a generation that cannot advance is genuinely still `catching-up`,
		// and genuinely not worth spinning on. Without this the loop would run as fast
		// as the event loop allows against a rate-limited provider.
		const container = holding(LEVEL, BEHIND);
		const pacing = pacingAfterCycle(container, cursorsOf(container));

		expect(pacing).toEqual({phase: 'catching-up', rest: true});
	});

	it('does not rest on the cycle that gives a new generation its first cursor', () => {
		// A reconfigure adds a generation with no cursor; the cycle that follows gives
		// it one, which is movement, so the catch-up proceeds without an interval
		// between its ranges.
		const before = cursorsOf(holding(LEVEL, undefined));
		const pacing = pacingAfterCycle(holding(LEVEL, {at: 100, tip: 105}), before);

		expect(pacing).toEqual({phase: 'catching-up', rest: false});
	});

	it('rests if a new generation never gets a cursor at all', () => {
		// The same shape as a stalled generation: behind by the no-cursor rule, and
		// moving nothing. It must pace rather than spin.
		const container = holding(LEVEL, undefined);

		expect(pacingAfterCycle(container, cursorsOf(container))).toEqual({phase: 'catching-up', rest: true});
	});

	it('behaves exactly as the old canonical-cursor rule did for ONE generation', () => {
		// The overwhelmingly common case, and the reason this change is not a
		// behavioural surprise: with a single generation held, phase and rest are the
		// same answers the previous rule gave.
		expect(pacingAfterCycle(holding(LEVEL), cursorsOf(holding({at: 104, tip: 105})))).toEqual({
			phase: 'at-tip',
			rest: true,
		});
		expect(pacingAfterCycle(holding({at: 104, tip: 105}), cursorsOf(holding({at: 100, tip: 105})))).toEqual({
			phase: 'catching-up',
			rest: false,
		});
	});
});
