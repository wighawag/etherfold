import type {StateApplied, StateMoved, StateMovedDetach, StateRetracted} from '@etherfold/core';
import {expect} from 'vitest';
import {readerRule, type Reader} from './reader.js';
import type {ConformanceCase, StateMovedTransport, StateMovedTransportFactory} from './types.js';

/** Turn a group of named assertions into cases, in the order they were written. */
export function cases(group: string, entries: Record<string, () => Promise<void>>): ConformanceCase[] {
	return Object.entries(entries).map(([name, run]) => ({group, name, run}));
}

/**
 * OPEN A TRANSPORT, RUN one body against it, AND LET GO -- whatever the body did.
 *
 * Every case takes a fresh transport, exactly as every store-conformance case
 * takes a fresh store: these open real folds, real wires and real streams, and a
 * case that left one attached would leak a subscriber into the next case's
 * assertions about how many there are.
 */
export async function over(
	factory: StateMovedTransportFactory,
	body: (transport: StateMovedTransport) => Promise<void>,
): Promise<void> {
	const transport = await factory();
	try {
		await body(transport);
	} finally {
		await transport.close();
	}
}

/**
 * AN APP ATTACHED TO THIS TRANSPORT: the two-line rule, listening.
 *
 * Returns the reader and its detach together, because a case that wants to
 * demonstrate a DROPPED notification has to be able to stop listening without
 * closing anything else. `alreadyHolding` is the reader that has been here
 * before and still holds the token it was last told.
 */
export async function listening(
	transport: StateMovedTransport,
	alreadyHolding?: string,
): Promise<Reader & {detach: StateMovedDetach}> {
	const reader = readerRule(alreadyHolding);
	const detach = await transport.onStateMoved(reader.handler);
	return {...reader, detach};
}

/**
 * WAIT UNTIL WHAT A READER WAS TOLD SATISFIES `predicate`, and fail SAYING WHAT
 * IT WAS TOLD INSTEAD.
 *
 * A deadline and never a sleep. Delivery on these transports is asynchronous and
 * best-effort, so a case that slept a fixed time would be slow on the fast
 * transports and flaky on the slow one; every assertion in this suite is about a
 * VALUE, and this exists only so that a transport which never carries what was
 * expected fails with a readable diff rather than hanging the run.
 */
export async function told(
	reader: Pick<Reader, 'received'>,
	predicate: (received: readonly StateMoved[]) => boolean,
	what: string,
): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate(reader.received)) {
		if (Date.now() > deadline) {
			expect.fail(`this transport never carried ${what}. It carried: ${JSON.stringify(reader.received)}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

/**
 * NOTHING MORE ARRIVED, held for long enough to be a claim rather than a
 * coincidence.
 *
 * The one duration in the suite, and it BOUNDS a silence rather than measuring
 * anything: "a reader that attached at the tip is told nothing" cannot be
 * asserted by a value, because the value is the absence of one.
 */
export async function stillSilent(reader: Pick<Reader, 'received'>, since: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 200));
	expect(reader.received.slice(since), `this transport told a reader something nothing had asked it to say`).toEqual(
		[],
	);
}

/**
 * The notification as an APPEND, REFUSING one that is not.
 *
 * The signal is a union since a retraction became a first-class case of it, so
 * an assertion about `block` or `entities` has to narrow. Doing it through one
 * helper keeps the failure useful and keeps it HONEST where a filter would not:
 * a retraction where an append was expected is a failure here rather than
 * something quietly skipped.
 */
export function anAppend(moved: StateMoved | undefined): StateApplied {
	if (moved?.kind !== 'applied') {
		expect.fail(`expected an applied-block notification, got ${JSON.stringify(moved ?? null)}`);
	}
	return moved;
}

/** The same, for the withdrawal. */
export function aRetraction(moved: StateMoved | undefined): StateRetracted {
	if (moved?.kind !== 'retracted') {
		expect.fail(`expected a retraction, got ${JSON.stringify(moved ?? null)}`);
	}
	return moved;
}

/**
 * THE FIELDS THE SIGNAL CARRIES, per case of it -- asserted as an exact key set
 * and never a subset.
 *
 * A subset check would pass a transport that added a field of its own, which is
 * exactly how one notification model becomes three: an app written against the
 * richer transport then breaks when it is pointed at the others, and the payload
 * is the thing ADR-0083 says is very hard to widen later.
 */
export const APPLIED_FIELDS = ['block', 'coherence', 'entities', 'generation', 'kind'] as const;
export const RETRACTED_FIELDS = ['coherence', 'forkPoint', 'generation', 'kind'] as const;
