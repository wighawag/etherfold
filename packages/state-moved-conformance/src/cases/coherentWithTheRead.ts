import {expect} from 'vitest';
import {anAppend, cases, listening, over, told} from '../harness.js';
import type {ConformanceCase, StateMovedTransport, StateMovedTransportFactory} from '../types.js';

const GROUP = 'coherent with what a reader reads';

/**
 * THE HALF THAT MAKES THE SIGNAL WORTH ANYTHING: what happens when a reader acts
 * on it.
 *
 * The first four chapters are about the notification. This one is about the
 * thing an app does NEXT, and it is where a transport that looked right stops
 * being right: a notification naming block N that is answered by a read from
 * BELOW N is worse than no notification at all, because the app re-read, got the
 * old answer, and now believes it is current.
 *
 * ## The two shapes, and why a transport must offer one of them
 *
 * A transport is asked whichever question it can answer:
 *
 * - **it has a read surface** (both browser transports: a tab's port proxies the
 *   store's reads, a reader tab opens the same storage for reading). Then the
 *   claim is the coherence one above -- told about block N, a read does not
 *   answer from below N.
 * - **it has none** (the server today: status, ingest, feed and admin, with the
 *   query layer deliberately deferred to
 *   `the-same-query-runs-against-a-worker-and-a-server`). Then convergence cannot
 *   be "re-query and compare", so the transport owes the other half instead: a
 *   connecting reader is TOLD the position and the token at once. The pinned-read
 *   version of this case arrives with that spec.
 *
 * Offering NEITHER is a failure and never a skip, which is the same rule the
 * store conformance suite applies to a backend that claims `singleWriter` and
 * hands the suite no way to contend for it: a capability-driven selection that
 * can select NOTHING is how a suite becomes decoration.
 */
export function coherentWithTheReadCases(
	factory: StateMovedTransportFactory,
	offers: Pick<StateMovedTransport, 'readsUpTo' | 'positionOnConnect'>,
): ConformanceCase[] {
	if (!offers.readsUpTo && !offers.positionOnConnect) {
		return cases(GROUP, {
			'answers one of the two convergence questions: a READ surface, or the position ON CONNECT': async () => {
				expect.fail(
					`this transport offers neither \`readsUpTo\` nor \`positionOnConnect\`, so nothing here can check that a ` +
						`reader acting on a notification is not answered from underneath it. A transport whose reader can READ ` +
						`implements \`readsUpTo\`; one with no state surface (the server today) implements ` +
						`\`positionOnConnect\`, which is how a reader with nothing to re-query converges.`,
				);
			},
		});
	}

	return [
		...(offers.readsUpTo
			? cases(GROUP, {
					'after a notification naming block N, a read does not answer from BELOW N': () =>
						over(factory, async (transport) => {
							const reader = await listening(transport);
							await transport.applyNextBlock();
							await told(reader, (received) => received.length >= 1, 'the first block');
							await transport.applyNextBlock();
							await told(reader, (received) => received.length >= 2, 'the second block');

							// The number in the notification and the number the read accounts for are
							// two answers about one fold, and this is the only case that puts them
							// side by side. An app told "block N moved" re-reads THROUGH THE SURFACE
							// IT ALREADY HOLDS, and a read answered from below N would have it render
							// the previous state and stop asking.
							const named = anAppend(reader.received.at(-1)).block;
							const answered = await transport.readsUpTo!();
							if (answered === undefined) {
								expect.fail(`told about block ${named}, and a read answers for no block at all`);
							}
							expect(answered, `told about block ${named}, but a read answers from ${answered}`).toBeGreaterThanOrEqual(
								named,
							);
						}),

					'answers from BELOW the fork point after a retraction, rather than from the branch it withdrew': () =>
						over(factory, async (transport) => {
							const reader = await listening(transport);
							await transport.applyNextBlock();
							await told(reader, (received) => received.length >= 1, 'the first block');
							const forkPoint = await transport.retract();
							await told(reader, (received) => received.some((moved) => moved.kind === 'retracted'), 'the retraction');

							// A reorg WITHDRAWS data, so the read a reader is told to make must not
							// still be answering out of the abandoned branch. What it may answer from
							// is the fork point or anything the REPLACEMENT applied above it, which is
							// exactly what the notifications after the retraction name.
							const answered = (await transport.readsUpTo!()) ?? 0;
							const namedSince = reader.received
								.slice(reader.received.findIndex((moved) => moved.kind === 'retracted'))
								.filter((moved) => moved.kind === 'applied')
								.map((moved) => moved.block);
							const highest = Math.max(forkPoint, ...namedSince);
							expect(
								answered,
								`the fold reverted to ${forkPoint} and a read answers from ${answered}`,
							).toBeLessThanOrEqual(highest);
						}),
				})
			: []),
		...(offers.positionOnConnect
			? cases(GROUP, {
					'tells a reader WHERE THE FOLD IS when it connects, since it has no state to re-query': () =>
						over(factory, async (transport) => {
							const reader = await listening(transport);
							const block = await transport.applyNextBlock();
							await told(reader, (received) => received.length >= 1, `block ${block}`);
							const carried = anAppend(reader.received.at(-1));

							// A SECOND reader, connecting after everything above landed: this is the
							// reconnecting client, and what it is handed at once is how it learns
							// whether what it already holds is stale. Nothing is replayed to it -- the
							// notifications it missed are gone, which is what "the producer holds no
							// per-client state" costs and what this repairs.
							const position = await transport.positionOnConnect!();
							if (position.lastToBlock === undefined) {
								expect.fail(`connected after block ${block} had been folded and was told no position at all`);
							}
							// NOT BELOW the block a reader was told about, which is the same coherence
							// claim the read case makes one shape up: the position is a COVERAGE claim
							// about the stream, so it stands at or above the last block applied out of it.
							expect(
								position.lastToBlock,
								`block ${block} was applied, and a connecting reader is told the fold is at ${position.lastToBlock}`,
							).toBeGreaterThanOrEqual(block);
							expect(position.coherence).toBe(carried.coherence);
						}),
				})
			: []),
	];
}
