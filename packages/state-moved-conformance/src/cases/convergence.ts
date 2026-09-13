import {expect} from 'vitest';
import {anAppend, cases, listening, over, stillSilent, told} from '../harness.js';
import type {ConformanceCase, StateMovedTransportFactory} from '../types.js';

const GROUP = 'a dropped notification';

/**
 * WHAT HAPPENS TO A READER THAT MISSED SOMETHING, which is the case the whole
 * delivery decision rests on.
 *
 * ADR-0083 makes delivery best-effort, at-most-once and unordered, and holds NO
 * per-client state -- which is what stops a SharedWorker's memory growing with
 * the number of open tabs, and is the property every transport downstream
 * depends on. The price is that a reader which was not listening is not told
 * afterwards, and the thing that makes that SAFE rather than merely cheap is the
 * token.
 *
 * Both halves are asserted, because each is worthless without the other: a
 * transport that BUFFERED would pass the convergence case while breaking the
 * memory property, and one that held nothing but re-stamped tokens would pass
 * the memory property while leaving a reader under-invalidating for ever.
 *
 * The drop is taken ACROSS A RETRACTION deliberately, because that is the case
 * the token exists for: "a missed notification is repaired by the next one" is
 * true of an APPEND and FALSE of a retraction, since the stale entities are the
 * ABANDONED branch's and no later changed-set names them.
 */
export function convergenceCases(factory: StateMovedTransportFactory): ConformanceCase[] {
	return cases(GROUP, {
		'holds nothing for a reader that was not listening, and replays nothing when it comes back': () =>
			over(factory, async (transport) => {
				const first = await listening(transport);
				await transport.applyNextBlock();
				await told(first, (received) => received.length >= 1, 'the first block');
				first.detach();

				// The fold moves with nobody attached. Nothing is buffered, nothing is
				// retried and nothing is remembered about the reader that went away.
				const missed = await transport.applyNextBlock();
				const late = await listening(transport);
				await stillSilent(late, 0);
				expect(late.received, `block ${missed} was replayed to a reader that arrived after it`).toEqual([]);
			}),

		'converges a reader that missed a RETRACTION, on the next notification alone': () =>
			over(factory, async (transport) => {
				const reader = await listening(transport);
				await transport.applyNextBlock();
				await told(reader, (received) => received.length >= 1, 'the first block');
				const held = reader.held();
				expect(held).toMatch(/\S/);

				// GO AWAY, exactly as a backgrounded tab or a dropped connection does, and
				// miss the reorg entirely.
				reader.detach();
				await transport.retract();

				// COME BACK STILL HOLDING THE TOKEN FROM BEFORE. A reader repaired only by
				// block numbers would now invalidate NARROWLY on the next append and keep
				// dead-branch rows on screen indefinitely; the token is what closes it, for
				// the cost of one field.
				const back = await listening(transport, held);
				expect(back.held()).toBe(held);

				await transport.applyNextBlock();
				await told(back, (received) => received.length >= 1, 'a notification after the reorg it missed');

				const after = anAppend(back.received.at(-1));
				expect(after.coherence).not.toBe(held);
				// ...so the FIRST thing it does on coming back is throw everything away,
				// which is the only correct answer after a branch it never heard about was
				// withdrawn.
				expect(back.decisions[0]).toEqual({invalidate: 'everything'});
			}),
	});
}
