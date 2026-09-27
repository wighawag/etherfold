import {expect} from 'vitest';
import {
	anAppend,
	aRepointing,
	aRetraction,
	cases,
	listening,
	over,
	REPOINTED_FIELDS,
	RETRACTED_FIELDS,
	told,
} from '../harness.js';
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
 * rotated, and a PROMOTION arrives AT ONCE, as a notification of its own wearing
 * a token nobody has seen, with the block after it under that same token.
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

		'ANNOUNCES a promotion AT ONCE, with no block to wait for: a rotated token and the generation that answers now':
			() =>
				over(factory, async (transport) => {
					const reader = await listening(transport);
					await transport.applyNextBlock();
					await told(reader, (received) => received.length >= 1, 'the block it applied');
					const before = anAppend(reader.received[0]);
					const toldSoFar = reader.received.length;

					// NO BLOCK FOLLOWS: the chain has gone quiet, which is exactly the case in which
					// "the next notification carries the new token" never arrives, and a reader went
					// on rendering the retired generation while reads answered the new one.
					await transport.promote();
					await told(reader, (received) => received.length > toldSoFar, 'the promotion');

					const announced = aRepointing(reader.received[toldSoFar]);
					// no block (none was applied) and no entity set (the token already says it all)
					expect(Object.keys(announced).sort()).toEqual([...REPOINTED_FIELDS]);
					// A different fold answers now, which from a cache's point of view is
					// indistinguishable from "everything you hold may be wrong" -- the SAME
					// comparison a retraction rides, so the reader's rule has no third line.
					expect(announced.coherence).not.toBe(before.coherence);
					expect(reader.decisions.at(toldSoFar)).toEqual({invalidate: 'everything'});
					// ...and it NAMES the lineage that answers, which the token can never do
					// because a reader must never parse it.
					expect(announced.generation).not.toBe(before.generation);
				}),

		'carries the block AFTER a promotion under the SAME rotated token, so a reader invalidates everything ONCE': () =>
			over(factory, async (transport) => {
				const reader = await listening(transport);
				await transport.applyNextBlock();
				await told(reader, (received) => received.length >= 1, 'the block it applied');
				const toldSoFar = reader.received.length;
				await transport.promote();
				await told(reader, (received) => received.length > toldSoFar, 'the promotion');

				await transport.applyNextBlock();
				await told(reader, (received) => received.length > toldSoFar + 1, 'the block folded after the promotion');

				// ONE announcement and ONE append, and the append does not rotate a second
				// time: a confusing pair would have a reader throw its cache away twice.
				const since = reader.received.slice(toldSoFar);
				expect(since.map((moved) => moved.kind)).toEqual(['repointed', 'applied']);
				const announced = aRepointing(since[0]);
				const after = anAppend(since[1]);
				expect(after.coherence).toBe(announced.coherence);
				expect(after.generation).toBe(announced.generation);
				expect(reader.decisions.slice(toldSoFar)).toEqual([
					{invalidate: 'everything'},
					{invalidate: [...after.entities]},
				]);
			}),
	});
}
