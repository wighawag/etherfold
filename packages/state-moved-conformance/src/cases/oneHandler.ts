import {expect} from 'vitest';
import {anAppend, APPLIED_FIELDS, cases, listening, over, stillSilent, told} from '../harness.js';
import type {ConformanceCase, StateMovedTransportFactory} from '../types.js';

const GROUP = 'one handler';

/**
 * WHAT AN APP'S OWN HANDLER SEES, and it must be the same thing on every
 * transport.
 *
 * This is the chapter that makes story 2 -- "one handler for local and remote, so
 * that offline and hosted builds are the same code" -- a thing that FAILS A TEST
 * when it stops being true. Every case here attaches `readerRule`, the two lines
 * of ADR-0083 written once above all three transports, and asserts on what that
 * ONE function was handed and what it CONCLUDED.
 *
 * The three properties are deliberately separate, because they break separately:
 * the VALUE (which fields cross, and with what in them), the SEQUENCE (one
 * notification per applied block, in order, with nothing coalesced) and the
 * ATTACH semantics (a reader that arrives late is told nothing, which is the one
 * of the three that a transport is most likely to "improve" on its own).
 */
export function oneHandlerCases(factory: StateMovedTransportFactory): ConformanceCase[] {
	return cases(GROUP, {
		'carries the FIVE fields core publishes for an applied block, and not one more': () =>
			over(factory, async (transport) => {
				const reader = await listening(transport);
				const block = await transport.applyNextBlock();
				await told(reader, (received) => received.length >= 1, `the block ${block} it applied`);

				const applied = anAppend(reader.received[0]);
				// An EXACT key set: a transport that adds a field of its own is how one
				// notification model becomes three, since an app written against the richer
				// one then breaks the moment it is pointed at the others.
				expect(Object.keys(applied).sort()).toEqual([...APPLIED_FIELDS]);
				expect(applied.block).toBe(block);
				// The entity NAMES the block's mutations touched: strings, bounded by the
				// declaration. EMPTY is a legal answer (a fold with no entity declarations
				// has no names), so what is asserted is the TYPE and never the count.
				expect(Array.isArray(applied.entities)).toBe(true);
				for (const entity of applied.entities) expect(typeof entity).toBe('string');
				// Two opaque values a reader COMPARES and RENDERS. Non-empty, because an
				// empty token compares equal to the next empty one and would say "nothing
				// you hold is stale" for ever.
				expect(applied.coherence).toMatch(/\S/);
				expect(applied.generation).toMatch(/\S/);
			}),

		'tells a reader about a block that touched NOTHING, with an empty set rather than a silence': () =>
			over(factory, async (transport) => {
				const reader = await listening(transport);
				// An ordinary block FIRST, so the reader is holding a token by the time the empty
				// one arrives. Otherwise the empty block is this reader's first contact, which
				// invalidates everything for a reason that has nothing to do with emptiness.
				const first = await transport.applyNextBlock();
				await told(reader, (received) => received.length >= 1, `the block ${first} it applied`);
				const held = anAppend(reader.received[0]).coherence;

				const empty = await transport.applyNextEmptyBlock();
				await told(reader, (received) => received.length >= 2, `the empty block ${empty}`);

				// "One notification per APPLIED block" is ONE rule. The block WAS applied -- its
				// cursor moved with it -- and its handler simply mutated nothing, so what crosses
				// is an append naming it with an EMPTY changed-set. A transport that dropped it,
				// on the reasoning that an empty array is nothing worth posting, would leave a
				// reader unable to tell a fold that touched nothing from a fold that has STOPPED,
				// and would make one rule into two with the second one undocumented.
				const applied = anAppend(reader.received[1]);
				expect(applied.block).toBe(empty);
				expect(applied.entities).toEqual([]);
				// Still the full five fields: an empty changed-set narrows what is IN the payload
				// and not its shape, so the one handler still reads it without a special case.
				expect(Object.keys(applied).sort()).toEqual([...APPLIED_FIELDS]);

				// The token did not move, because nothing a reader holds became stale: an empty
				// block is an APPEND. So the rule's narrow line runs, and narrowly by an empty
				// set is NOTHING to re-read -- which is the correct answer, and is why publishing
				// it costs a reader nothing while withholding it would cost it the truth.
				expect(applied.coherence).toBe(held);
				expect(reader.decisions[1]).toEqual({invalidate: []});
			}),

		'runs the two-line rule unchanged: a token it has not held invalidates EVERYTHING, the next one NARROWLY': () =>
			over(factory, async (transport) => {
				const reader = await listening(transport);
				await transport.applyNextBlock();
				await told(reader, (received) => received.length >= 1, 'the first block');
				const first = anAppend(reader.received[0]);
				await transport.applyNextBlock();
				await told(reader, (received) => received.length >= 2, 'the second block');

				// A reader that has just attached holds NO token, so the first notification
				// says invalidate everything however ordinary it is -- which is correct, and
				// is the same line that repairs a missed retraction.
				expect(reader.decisions[0]).toEqual({invalidate: 'everything'});
				// ...and then narrowly, using the names the block touched, because the token
				// did not move.
				expect(reader.decisions[1]).toEqual({invalidate: [...anAppend(reader.received[1]).entities]});
				expect(reader.held()).toBe(first.coherence);
			}),

		'tells a reader ONCE PER APPLIED BLOCK, in the order the fold applied them': () =>
			over(factory, async (transport) => {
				const reader = await listening(transport);
				const blocks = [await transport.applyNextBlock(), await transport.applyNextBlock()];
				await told(reader, (received) => received.length >= 2, `the blocks ${blocks.join(' and ')}`);

				// Nothing coalesced, nothing reordered, nothing duplicated: a transport that
				// batched two notifications into one would leave an app rendering a block it
				// was never told about, and one that re-delivered would have a cache
				// invalidate twice for one move.
				expect(reader.received.map((moved) => anAppend(moved).block)).toEqual(blocks);
			}),

		'tells a reader that attaches PART WAY THROUGH nothing, until the fold moves again': () =>
			over(factory, async (transport) => {
				const early = await listening(transport);
				const first = await transport.applyNextBlock();
				await told(early, (received) => received.length >= 1, `block ${first}`);

				// A notification is a thing that HAPPENED, so there is nothing current to
				// hand a reader that has just arrived, and replaying the last one would
				// report a move that landed some time ago. What this reader does instead is
				// READ, which is what it was going to do with the notification anyway.
				const late = await listening(transport);
				await stillSilent(late, 0);

				const second = await transport.applyNextBlock();
				await told(late, (received) => received.length >= 1, `block ${second}`);
				expect(late.received.map((moved) => anAppend(moved).block)).toEqual([second]);
				// ...and the reader that was here from the start heard both, so the silence
				// above was this transport holding nothing rather than this transport being
				// asleep.
				expect(early.received.map((moved) => anAppend(moved).block)).toEqual([first, second]);
			}),
	});
}
