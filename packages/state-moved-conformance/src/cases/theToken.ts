import {expect} from 'vitest';
import {anAppend, aRetraction, cases, listening, over, RETRACTED_FIELDS, told} from '../harness.js';
import type {ConformanceCase, StateMovedTransportFactory} from '../types.js';

const GROUP = 'the coherence token';

/**
 * THE THREE THINGS THE TOKEN DOES, asked of every transport.
 *
 * ADR-0083 calls the token the load-bearing part, because best-effort delivery
 * and retraction do not otherwise compose. That is a property of the PRODUCER,
 * and it is already asserted where it is produced -- but it is worth nothing to
 * an app unless the transport carries it FAITHFULLY, and the ways to break that
 * are quiet: a transport that re-stamped a token, cached one, or dropped a
 * notification it thought was redundant would leave a reader under-invalidating
 * with no symptom until the next reorg.
 *
 * So: it does not move while nothing invalidates, a RETRACTION arrives whole and
 * rotated, and a PROMOTION arrives as a token nobody has seen on the next
 * notification rather than as an event of its own.
 */
export function tokenCases(factory: StateMovedTransportFactory): ConformanceCase[] {
	return cases(GROUP, {
		'does not move while the fold is only appending, so a reader invalidates NARROWLY': () =>
			over(factory, async (transport) => {
				const reader = await listening(transport);
				await transport.applyNextBlock();
				await transport.applyNextBlock();
				await told(reader, (received) => received.length >= 2, 'two applied blocks');

				const tokens = new Set(reader.received.map((moved) => moved.coherence));
				expect(tokens.size, `${tokens.size} tokens for two ordinary appends`).toBe(1);
			}),

		'carries a RETRACTION whole: the fork point it reverted to, and no entity set': () =>
			over(factory, async (transport) => {
				const reader = await listening(transport);
				await transport.applyNextBlock();
				await told(reader, (received) => received.length >= 1, 'the block it applied');
				const before = reader.received[0]!.coherence;

				const forkPoint = await transport.retract();
				await told(reader, (received) => received.some((moved) => moved.kind === 'retracted'), 'the retraction');

				const retracted = aRetraction(reader.received.find((moved) => moved.kind === 'retracted'));
				expect(Object.keys(retracted).sort()).toEqual([...RETRACTED_FIELDS]);
				// The HIGHEST BLOCK THAT STILL STANDS, which is the vocabulary `revertTo`,
				// the `removed` markers and the canonical view's rewind already share.
				expect(retracted.forkPoint).toBe(forkPoint);
				// ROTATED as it was published, so a retraction under the old token is
				// unexpressible: a reader that received this invalidates everything ONCE.
				expect(retracted.coherence).not.toBe(before);
				expect(reader.decisions.at(reader.received.indexOf(retracted))).toEqual({invalidate: 'everything'});
			}),

		'carries the appends AFTER a retraction under the SAME rotated token, so a reader narrows again': () =>
			over(factory, async (transport) => {
				const reader = await listening(transport);
				await transport.applyNextBlock();
				await told(reader, (received) => received.length >= 1, 'the block it applied');
				await transport.retract();
				await told(reader, (received) => received.some((moved) => moved.kind === 'retracted'), 'the retraction');
				const retracted = aRetraction(reader.received.find((moved) => moved.kind === 'retracted'));
				const at = reader.received.indexOf(retracted);

				// The chain moves on, on the branch that replaced the one taken back.
				await transport.applyNextBlock();
				await told(
					reader,
					(received) => received.length > at + 1 && received[received.length - 1]!.kind === 'applied',
					'an append after the retraction',
				);

				const after = anAppend(reader.received.at(-1));
				// A reader that RECEIVED the retraction is now holding exactly the token the
				// appends after it carry, so it goes back to invalidating narrowly at the
				// next block rather than throwing its cache away on every one of them.
				expect(after.coherence).toBe(retracted.coherence);
				expect(reader.decisions.at(-1)).toEqual({invalidate: [...after.entities]});
			}),

		'says NOTHING for a promotion, and the next notification wears a token no reader has held': () =>
			over(factory, async (transport) => {
				const reader = await listening(transport);
				await transport.applyNextBlock();
				await told(reader, (received) => received.length >= 1, 'the block it applied');
				const before = anAppend(reader.received[0]);
				const toldSoFar = reader.received.length;

				// A pointer move has no block to name and no fold applied anything, so there
				// is deliberately no event kind for it: a reader does not care that a
				// promotion is a different thing, and two kinds would be two code paths in
				// every app.
				await transport.promote();
				expect(
					reader.received.length,
					`this transport published something for a pointer move: ${JSON.stringify(reader.received.slice(toldSoFar))}`,
				).toBe(toldSoFar);

				await transport.applyNextBlock();
				await told(reader, (received) => received.length > toldSoFar, 'the block folded after the promotion');

				const after = anAppend(reader.received.at(-1));
				// A different fold answers now, which from a cache's point of view is
				// indistinguishable from "everything you hold may be wrong" -- ONE comparison
				// and one code path rather than two.
				expect(after.coherence).not.toBe(before.coherence);
				expect(reader.decisions.at(-1)).toEqual({invalidate: 'everything'});
				// ...and it NAMES the lineage that answered, which the token can never do
				// because a reader must never parse it.
				expect(after.generation).not.toBe(before.generation);
			}),
	});
}
