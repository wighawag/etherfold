import type {StateMoved, StateMovedHandler} from '@etherfold/core';

/**
 * WHAT A READER DECIDED about one notification, which is the whole of what an
 * app does with the signal.
 *
 * Two outcomes and no third, because the rule has two lines: `everything` is
 * `queryClient.invalidateQueries()` with no argument, and a list of entity names
 * is the narrow call per name. Recording the DECISION rather than the
 * notification is what makes the suite's central claim assertable: the cases
 * compare what a reader CONCLUDED on each transport, not what bytes reached it.
 */
export type Invalidation = {readonly invalidate: 'everything'} | {readonly invalidate: readonly string[]};

/** A reader, with what it has decided so far. */
export type Reader = {
	/**
	 * THE HANDLER, and it is the only thing a transport is ever handed.
	 *
	 * A plain `StateMovedHandler`: the shape ADR-0083 defines once, so that a
	 * `MessagePort`, a `BroadcastChannel` and a server's stream are three ways of
	 * calling ONE function rather than three subscription conventions.
	 */
	readonly handler: StateMovedHandler;
	/** What it decided, oldest first. */
	readonly decisions: readonly Invalidation[];
	/** Every notification it was handed, oldest first, for the cases that assert on the value. */
	readonly received: readonly StateMoved[];
	/** The **coherence token** it is holding right now, or `undefined` before the first notification. */
	held(): string | undefined;
};

/**
 * THE READER'S WHOLE RULE, AS CODE: **token unchanged, invalidate NARROWLY using
 * `entities`; token changed, invalidate EVERYTHING** (ADR-0083).
 *
 * This function is the load-bearing part of the suite and not a fixture. The
 * claim being checked is that an app writes ONE handler and points it at
 * whichever transport its deployment has, so the cases must run the SAME handler
 * on all three -- not three handlers that happen to agree. It lives here, above
 * every transport, and nothing in it can name one: it takes a `StateMoved` and
 * returns nothing, which is what a client library's `invalidateQueries`,
 * `refetchQueries` or `reexecuteOperation` callback is.
 *
 * Note what the rule does NOT have to do, and why each absence is a property of
 * the payload rather than a simplification here:
 *
 * - it does not special-case a RETRACTION, because a retraction always carries a
 *   rotated token, so the first line already covers it;
 * - it does not special-case a PROMOTION, because the pointer move publishes
 *   nothing and what arrives next carries a token this reader has never held;
 * - it does not special-case a MISSED notification, because the next one repairs
 *   it by the same comparison.
 *
 * The `kind` narrowing on the second line is the one thing the compiler forces,
 * and that is deliberate too: a retraction has no `entities` and no `block`, so a
 * reader that read either off one does not compile rather than invalidating
 * against a number that means the opposite of what it thinks.
 *
 * `alreadyHolding` is a reader that has been here before: a backgrounded tab
 * coming back, or an app reconnecting a dropped stream. It still holds the token
 * it was last told, and it is the case the whole best-effort decision rests on,
 * so the suite has to be able to express it without pushing a fake notification
 * through the handler it is testing.
 */
export function readerRule(alreadyHolding?: string): Reader {
	const decisions: Invalidation[] = [];
	const received: StateMoved[] = [];
	let held: string | undefined = alreadyHolding;

	const handler: StateMovedHandler = (moved) => {
		received.push(moved);
		if (moved.coherence !== held) {
			held = moved.coherence;
			decisions.push({invalidate: 'everything'});
			return;
		}
		decisions.push({invalidate: moved.kind === 'applied' ? [...moved.entities] : []});
	};

	return {handler, decisions, received, held: () => held};
}
