import {coherentWithTheReadCases} from './cases/coherentWithTheRead.js';
import {convergenceCases} from './cases/convergence.js';
import {oneHandlerCases} from './cases/oneHandler.js';
import {tokenCases} from './cases/theToken.js';
import type {ConformanceCase, ConformanceFailure, ConformanceResult, StateMovedTransportFactory} from './types.js';

/**
 * EVERY CASE A TRANSPORT MUST PASS to be an ADAPTER rather than a second
 * semantics.
 *
 * ADR-0083's opening claim is that one notification model is delivered over
 * whichever transport a deployment has -- a `MessagePort` from a worker, a
 * `BroadcastChannel` from the indexing tab, a server's stream -- so that an app
 * writes ONE handler and pointing it at a hosted indexer is a deployment choice
 * rather than a rewrite. Three adapters built against one decided shape is
 * necessary and not sufficient: three independently-correct adapters drift into
 * three semantics one edit at a time, and each goes on passing its own file's
 * tests while it does. This list is the thing that stops that, and it is
 * deliberately the same shape `@etherfold/state-store-conformance` has -- ONE
 * case list, several subjects, a thin runner -- so a behaviour somebody adds is
 * added for every transport at once because there is only one place to add it.
 *
 * ## What the chapters are, and what each is FOR
 *
 * The four places three correct adapters usually stop agreeing, in order:
 *
 * - **one handler** -- the value, the sequence, and what a reader ATTACHING is
 *   told. The last of those is the one a transport is most likely to "improve"
 *   on its own, by handing a late joiner the previous notification.
 * - **the coherence token** -- that it does not move while nothing invalidates,
 *   that a RETRACTION arrives whole and rotated, and that a PROMOTION arrives as
 *   a token nobody has held rather than as an event of its own.
 * - **a dropped notification** -- nothing is held for a reader that was away,
 *   and it converges anyway. Both halves, because each is worthless alone.
 * - **coherent with what a reader reads** -- what happens when an app ACTS on
 *   the notification, which is what the whole signal is for.
 *
 * ## The selection, and the one thing it is driven by
 *
 * Only the last chapter varies, and it varies on what the transport's READER can
 * do rather than on what the transport is: a reader with a state surface is
 * asked the coherence question, and a reader with none (the server today, whose
 * query layer is deferred) is asked how it is told the position on connect. A
 * transport offering NEITHER fails a case saying so rather than silently
 * skipping the only chapter that could have caught the failure -- the same rule
 * the store suite applies to a backend that claims a guarantee and hands the
 * suite no way to contend for it.
 */
export async function stateMovedConformanceCases(factory: StateMovedTransportFactory): Promise<ConformanceCase[]> {
	// Read from a PROBE, exactly as the store suite reads a backend's capabilities
	// from one: what a transport OFFERS is a fact about the transport and must not
	// vary between calls, and asking the first case's own subject would make the
	// case list depend on the order the cases run in.
	const probe = await factory();
	const offers = {readsUpTo: probe.readsUpTo, positionOnConnect: probe.positionOnConnect};
	await probe.close();

	return [
		...oneHandlerCases(factory),
		...tokenCases(factory),
		...convergenceCases(factory),
		...coherentWithTheReadCases(factory, offers),
	];
}

/**
 * Run every case and report what failed, without a test runner.
 *
 * It exists so the suite can be asserted ON rather than merely run: a test that
 * feeds it a deliberately-diverging transport (one that replays the last
 * notification to a late joiner, say) checks WHICH cases went red, which is the
 * only way to prove the chapters are not decoration. It is equally how a
 * transport built outside this repository -- the anticipated GraphQL
 * subscription adapter is the obvious one -- checks itself.
 *
 * It does not stop at the first failure, because "which of them did I break" is
 * the question a transport author actually has.
 */
export async function runStateMovedConformance(factory: StateMovedTransportFactory): Promise<ConformanceResult> {
	const list = await stateMovedConformanceCases(factory);
	const failures: ConformanceFailure[] = [];

	for (const one of list) {
		try {
			await one.run();
		} catch (error) {
			failures.push({group: one.group, name: one.name, error});
		}
	}

	return {passed: list.length - failures.length, failures};
}
