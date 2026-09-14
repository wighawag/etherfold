import 'fake-indexeddb/auto';
import {describeStateMovedConformance, runStateMovedConformance} from '@etherfold/state-moved-conformance';
import type {StateMoved, StateMovedHandler} from '@etherfold/core';
import {describe, expect, it} from 'vitest';
import {openCrossTabTransport, openPortTransport} from './utils/stateMovedTransports.js';

/**
 * ONE HANDLER, EVERY TRANSPORT -- the browser half.
 *
 * ADR-0083 opens with a claim: one notification model delivered over whichever
 * transport a deployment has, so that `MessagePort`, `BroadcastChannel` and SSE
 * are ADAPTERS and not three semantics. Until all three existed nobody could
 * check it, and three adapters that each pass the tests in their own file is
 * exactly what drift looks like on the day before it is noticed.
 *
 * So the cases are DATA, in `@etherfold/state-moved-conformance`, and this file
 * is a thin runner: TWO transports here (a tab's port to its host, and the
 * cross-tab channel to a tab that holds none), the THIRD in `@etherfold/server`
 * against the same list. A behaviour somebody adds is added for all three at
 * once, because there is only one place to add it, and a behaviour that stops
 * holding on one of them is a named failure naming that one.
 */

await describeStateMovedConformance('across a tab\u2019s PORT to its host', openPortTransport);
await describeStateMovedConformance('across the CROSS-TAB channel', openCrossTabTransport);

/**
 * AND THE SUITE ITSELF IS NOT DECORATION.
 *
 * A conformance suite is only worth what its failures are worth, so the cheapest
 * way for this one to rot is for a case to stop being able to fail. These feed
 * it transports that are WRONG in exactly the ways a real adapter goes wrong --
 * each a thing somebody might do believing it an improvement -- and assert on
 * WHICH cases went red. It is the same check
 * `@etherfold/state-store-conformance` makes with deliberately-lying backends.
 */
describe('the suite catches a transport that drifted', () => {
	it('catches one that REPLAYS the last notification to a reader that attaches late', async () => {
		// The "improvement": a late joiner is handed the last notification so it has
		// something to act on. It makes a reader invalidate for a block it may
		// already have rendered, and it is per-client state in the one producer that
		// must hold none.
		const outcome = await runStateMovedConformance(async () => {
			const real = await openPortTransport();
			let last: StateMoved | undefined;
			real.onStateMoved((moved) => (last = moved));
			return {
				...real,
				onStateMoved(handler: StateMovedHandler) {
					const detach = real.onStateMoved(handler);
					if (last) handler(last);
					return detach;
				},
			};
		});

		expect(outcome.failures.map((failure) => failure.name)).toContain(
			'tells a reader that attaches PART WAY THROUGH nothing, until the fold moves again',
		);
	});

	it('catches one that RE-STAMPS the coherence token on its way across', async () => {
		// The "improvement": the transport mints its own token so a reader can tell
		// this connection's notifications apart. Every notification then says
		// invalidate EVERYTHING, and the narrow-invalidation half of the model -- the
		// reason `entities` exists at all -- is silently gone.
		const outcome = await runStateMovedConformance(async () => {
			const real = await openPortTransport();
			let stamp = 0;
			return {
				...real,
				onStateMoved(handler: StateMovedHandler) {
					return real.onStateMoved((moved) => handler({...moved, coherence: `re-stamped-${stamp++}`}));
				},
			};
		});

		expect(outcome.failures.map((failure) => failure.name)).toContain(
			'does not move while the fold is only appending, so a reader invalidates NARROWLY',
		);
	});

	it('catches one that DROPS the retraction and carries appends alone', async () => {
		// The "improvement": a retraction is filtered out as an internal detail, since
		// "the next notification repairs it anyway". It does not: after a reorg the
		// stale entities are the abandoned branch's, and no later changed-set names
		// them.
		const outcome = await runStateMovedConformance(async () => {
			const real = await openPortTransport();
			return {
				...real,
				onStateMoved(handler: StateMovedHandler) {
					return real.onStateMoved((moved) => {
						if (moved.kind !== 'retracted') handler(moved);
					});
				},
			};
		});

		expect(outcome.failures.map((failure) => failure.name)).toContain(
			'carries a RETRACTION whole: the fork point it reverted to, and no entity set',
		);
	});

	it('catches one that SWALLOWS a notification whose changed-set is empty', async () => {
		// The "improvement": an empty `entities` array means nothing was touched, so there
		// is nothing worth posting. It makes "one notification per APPLIED block" into two
		// rules with the second one undocumented, and it leaves a reader unable to tell a
		// fold that touched nothing from a fold that has stopped -- the block WAS applied
		// and its cursor moved with it.
		const outcome = await runStateMovedConformance(async () => {
			const real = await openPortTransport();
			return {
				...real,
				onStateMoved(handler: StateMovedHandler) {
					return real.onStateMoved((moved) => {
						if (moved.kind === 'applied' && moved.entities.length === 0) return;
						handler(moved);
					});
				},
			};
		});

		expect(outcome.failures.map((failure) => failure.name)).toContain(
			'tells a reader about a block that touched NOTHING, with an empty set rather than a silence',
		);
	});

	it('REFUSES a transport that answers neither convergence question, rather than skipping the chapter', async () => {
		// A capability-driven selection that can select NOTHING is how a suite becomes
		// decoration: this transport's reader could neither re-read nor be told where
		// the fold is, so nothing could check that acting on a notification is not
		// answered from underneath it.
		const outcome = await runStateMovedConformance(async () => {
			const {readsUpTo: _dropped, ...blind} = await openPortTransport();
			return blind;
		});

		expect(outcome.failures.map((failure) => failure.name)).toContain(
			'answers one of the two convergence questions: a READ surface, or the position ON CONNECT',
		);
	});
});
