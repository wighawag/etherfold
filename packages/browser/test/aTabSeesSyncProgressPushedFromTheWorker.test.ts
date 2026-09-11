import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {EntityEventProcessor, type EntityStateView} from '@etherfold/processor-entities';
import {openForWriting} from '@etherfold/state-store';
import {
	connectToIndexerHost,
	createBrowserStateStore,
	createProgressReadable,
	serveIndexerHost,
	type HostAccess,
	type HostProgress,
	type IndexerPort,
	type SyncPhase,
} from '../src/index.js';
import {wire} from './utils/port.js';
import {BRANCH_A_TIP, FINALITY, fakeChain, processor, SOURCE, START_BLOCK, type TestABI} from '../browser/workload.js';

/**
 * A TAB SEEING SYNC PROGRESS PUSHED FROM ITS HOST -- over a real `MessagePort`,
 * in node.
 *
 * What runs in a REAL browser with a REAL dedicated worker is the
 * `progress-pushed-from-the-worker` case of `browser/hostedInAWorker.spec.ts`,
 * which is where "the fold is in another execution context" is a fact rather
 * than an arrangement of objects. These are the same claims on every commit,
 * because that run needs browser binaries a clean checkout does not have.
 *
 * ## Nothing here waits on a clock, and that is a design of the fixture
 *
 * The chain is GATED (`gatedChain`): the provider answers nothing until the test
 * releases it. So the tab subscribes BEFORE the host can have got anywhere, the
 * first value it is handed is the host's opening state rather than whatever it
 * happened to reach, and the assertions are about the SEQUENCE of pushes and the
 * values in them. The only waiting is for a push that SAYS the fold is done
 * (`untilPushed`), never for a duration.
 */

let counter = 0;
const freshName = () => `pushed-progress-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * The captured stream behind a gate, served in SMALL RANGES.
 *
 * Two properties this file needs and `fakeChain` alone does not have. The GATE
 * holds every provider call until `release()`, so a subscription established
 * beforehand cannot miss a transition. The narrow `maxBlocksPerFetch` (below)
 * makes the fold take several advances over a five-block fixture, so "the number
 * advances as the worker folds" is a sequence with something in it rather than
 * one jump from nothing to done.
 *
 * The width has to stay ABOVE the finality depth: a cycle rewinds by the
 * unconfirmed window before it fetches, so a range narrower than that window
 * re-asks for the blocks it already has and the cursor never moves (see
 * `work/notes/observations/a-fetch-narrower-than-finality-never-advances.md`).
 */
function gatedChain(failWith?: Error) {
	const chain = fakeChain();
	let open: () => void;
	const gate = new Promise<void>((resolve) => (open = resolve));
	const underlying = chain.provider.request.bind(chain.provider);
	return {
		ranges: chain.ranges,
		release: () => open(),
		provider: {
			async request(args: {method: string; params?: unknown}): Promise<unknown> {
				await gate;
				if (failWith && args.method === 'eth_getLogs') throw failWith;
				return underlying(args as never);
			},
		} as never,
	};
}

function hostOver(access: HostAccess, databaseName: string, chain: ReturnType<typeof gatedChain>) {
	return serveIndexerHost<TestABI, EntityStateView>(
		{
			createState: async () => openForWriting(await createBrowserStateStore(processor.entities, {databaseName})),
			createProcessor: (store) => new EntityEventProcessor<TestABI>(store, processor),
			provider: chain.provider,
			source: SOURCE,
			// Two blocks at a time, so the fixture's five blocks take several advances.
			config: {stream: {finality: FINALITY}, fetch: {numBlocksToFetchAtStart: 4, maxBlocksPerFetch: 4}},
			tipIntervalInSeconds: 0.05,
		},
		access,
	);
}

/**
 * Collect what the host pushes, and let a test WAIT ON A VALUE rather than on a
 * duration.
 *
 * `untilPushed` resolves on the first push that satisfies a predicate, which is
 * what keeps every case here independent of how fast anything ran: the fold is
 * finished when a push SAYS it is.
 */
function collecting(port: IndexerPort) {
	const pushes: HostProgress[] = [];
	const waiting: {matches: (progress: HostProgress) => boolean; resolve: (progress: HostProgress) => void}[] = [];
	const stop = port.onProgress((progress) => {
		pushes.push(progress);
		for (const waiter of [...waiting]) {
			if (waiter.matches(progress)) {
				waiting.splice(waiting.indexOf(waiter), 1);
				waiter.resolve(progress);
			}
		}
	});
	return {
		pushes,
		stop,
		untilPushed(matches: (progress: HostProgress) => boolean): Promise<HostProgress> {
			const already = pushes.find(matches);
			if (already) return Promise.resolve(already);
			return new Promise<HostProgress>((resolve) => waiting.push({matches, resolve}));
		},
	};
}

const phasesOf = (pushes: readonly HostProgress[]): SyncPhase[] => pushes.map((push) => push.phase);

describe('a tab watching its host fold', () => {
	it('is pushed the progress as the fold advances, and never asked to poll for it', async () => {
		const ends = wire();
		const chain = gatedChain();
		const host = hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);
		const collected = collecting(port);

		try {
			// The FIRST thing a subscriber is handed is where the fold is now, which
			// here is nowhere: the provider has not answered a single call.
			const opening = await collected.untilPushed(() => true);
			expect(opening.phase).toBe('waiting');
			expect(opening.lastToBlock).toBeUndefined();
			expect(opening.blocksBehindTip).toBeUndefined();

			chain.release();
			const done = await collected.untilPushed((progress) => progress.phase === 'at-tip');

			// "syncing, N blocks behind", arriving as the fold advances
			expect(done.latestBlock).toBe(BRANCH_A_TIP);
			expect(done.lastToBlock).toBe(BRANCH_A_TIP);
			expect(done.blocksBehindTip).toBe(0);
			expect(done.numBlocksProcessedSoFar).toBe(BRANCH_A_TIP - START_BLOCK);
			expect(done.syncPercentage).toBe(100);

			// The NUMBER ADVANCED rather than jumping from nothing to done: more than
			// one report carried a cursor, and the distance to the tip only ever
			// shrank.
			const withACursor = collected.pushes.filter((push) => push.blocksBehindTip !== undefined);
			expect(withACursor.length).toBeGreaterThan(1);
			expect(withACursor.map((push) => push.blocksBehindTip)).toEqual(
				[...withACursor.map((push) => push.blocksBehindTip!)].sort((a, b) => b - a),
			);
			expect(withACursor.map((push) => push.lastToBlock)).toEqual(
				[...withACursor.map((push) => push.lastToBlock!)].sort((a, b) => a - b),
			);

			// and the host's own answer agrees with the last thing it pushed
			expect(host.progress()).toEqual(done);
		} finally {
			collected.stop();
			host.dispose();
			port.close();
			ends.close();
		}
	});

	/**
	 * THE CADENCE IS APPLIED WORK, and the way to tell is a host that is BUSY and
	 * SILENT at the same time.
	 *
	 * A driver at the tip advances on its rest interval for ever, so a push per
	 * turn of that loop would be a timer wearing a signal's clothes -- the polling
	 * this channel replaced, with the cost merely moved to the other end of the
	 * wire. The count of `eth_getLogs` ranges is what says the host went on
	 * working while it said nothing.
	 */
	it('says nothing while the driver rests at the tip, however many times it advances', async () => {
		const ends = wire();
		const chain = gatedChain();
		const host = hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);
		const collected = collecting(port);

		try {
			await collected.untilPushed(() => true);
			chain.release();
			await collected.untilPushed((progress) => progress.phase === 'at-tip');

			const pushed = collected.pushes.length;
			const fetched = chain.ranges.length;
			// Ten rest intervals' worth, with a listener attached throughout.
			await new Promise((resolve) => setTimeout(resolve, 500));

			expect(chain.ranges.length).toBeGreaterThan(fetched);
			expect(collected.pushes.length).toBe(pushed);
		} finally {
			collected.stop();
			host.dispose();
			port.close();
			ends.close();
		}
	});

	it('reports the coarse phase at each transition, in order', async () => {
		const ends = wire();
		const chain = gatedChain();
		const host = hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);
		const collected = collecting(port);

		try {
			await collected.untilPushed(() => true);
			chain.release();
			await collected.untilPushed((progress) => progress.phase === 'at-tip');

			// Every one of the five is in the vocabulary, and the ones this run passes
			// through arrive in the order a fold passes through them.
			const seen = phasesOf(collected.pushes);
			const distinct = seen.filter((phase, index) => phase !== seen[index - 1]);
			expect(distinct).toEqual(['waiting', 'loading', 'catching-up', 'at-tip']);

			// `at-tip` is the DRIVER's own rest condition and not a threshold beside
			// it: no report claims the tip while the cursor says otherwise, and none
			// claims to be catching up once it is level.
			for (const push of collected.pushes) {
				if (push.phase === 'at-tip') expect(push.lastToBlock).toBe(push.latestBlock);
				if (push.phase === 'catching-up' && push.blocksBehindTip !== undefined) {
					expect(push.lastToBlock).toBeLessThanOrEqual(push.latestBlock!);
				}
			}
		} finally {
			collected.stop();
			host.dispose();
			port.close();
			ends.close();
		}
	});

	/**
	 * The trap the envelope's own note names: a container that has loaded and not
	 * yet fetched publishes `0` of `0`, so EQUALITY alone is true before a single
	 * log has been asked for. A tab told `at-tip` there would render "live" over an
	 * empty database.
	 */
	it('never calls an unfetched cursor the tip, and reports no distance it has not learnt', async () => {
		const ends = wire();
		const chain = gatedChain();
		const host = hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);
		const collected = collecting(port);

		try {
			await collected.untilPushed(() => true);
			chain.release();
			await collected.untilPushed((progress) => progress.phase === 'at-tip');

			for (const push of collected.pushes) {
				if (push.latestBlock === 0) {
					expect(push.phase).not.toBe('at-tip');
					expect(push.blocksBehindTip).toBeUndefined();
					expect(push.syncPercentage).toBeUndefined();
				}
			}
		} finally {
			collected.stop();
			host.dispose();
			port.close();
			ends.close();
		}
	});

	it('stops receiving pushes when the last listener lets go, and starts again when one returns', async () => {
		const ends = wire();
		const chain = gatedChain();
		const host = hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);
		const collected = collecting(port);

		// EVERYTHING that reaches this end of the wire, whether or not a listener
		// wanted it: "stopped receiving" is a claim about the WIRE and not about a
		// callback that is no longer called.
		const arrived: unknown[] = [];
		ends.tabEndpoint.addEventListener('message', (event) => arrived.push(event.data));

		try {
			await collected.untilPushed(() => true);
			collected.stop();
			// The unsubscribe is a round trip; this one is, too, so it cannot overtake
			// it.
			await port.progress();
			const posted = arrived.length;

			chain.release();
			// The fold runs to the tip with nobody listening. Asked DIRECTLY, the host
			// says it got there -- so the silence is a host that stopped POSTING and
			// not a host that stopped folding.
			let answered = await port.progress();
			for (let attempt = 0; attempt < 400 && answered.phase !== 'at-tip'; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 20));
				answered = await port.progress();
			}
			expect(answered.phase).toBe('at-tip');
			// ...and every message that arrived meanwhile was an ANSWER to one of those
			// questions. Not one push.
			expect(arrived.slice(posted).every((message) => (message as {kind: string}).kind === 'response')).toBe(true);
			expect(collected.pushes.length).toBe(1);

			// A listener that comes back is told where the fold is, without waiting for
			// it to move again -- which it never will, because it is at the tip.
			const second = collecting(port);
			const resumed = await second.untilPushed(() => true);
			expect(resumed.phase).toBe('at-tip');
			expect(resumed.lastToBlock).toBe(BRANCH_A_TIP);
			second.stop();
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});

	it('keeps pushing to the listeners that remain, and tells a late one where the fold is', async () => {
		const ends = wire();
		const chain = gatedChain();
		const host = hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);
		const first = collecting(port);

		try {
			await first.untilPushed(() => true);

			// A second listener on an OPEN subscription: it missed the answer that
			// opened it, so it is handed the last thing the host said rather than
			// nothing.
			const second = collecting(port);
			expect((await second.untilPushed(() => true)).phase).toBe('waiting');

			// one of them lets go, and the other one is still served
			second.stop();
			chain.release();
			const done = await first.untilPushed((progress) => progress.phase === 'at-tip');
			expect(done.lastToBlock).toBe(BRANCH_A_TIP);
			expect(second.pushes.length).toBe(1);
		} finally {
			first.stop();
			host.dispose();
			port.close();
			ends.close();
		}
	});

	/**
	 * A host that STOPPED must say so. Silence looks exactly like a stall, which
	 * is where "is it broken?" reports come from (ADR-0082).
	 */
	it('pushes the refusal when the driver stops on something waiting cannot fix', async () => {
		const ends = wire();
		const refusal = Object.assign(new Error(`this node will not serve those logs`), {
			name: 'RefusedError',
			retryable: false,
		});
		const chain = gatedChain(refusal);
		const host = hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);
		const collected = collecting(port);

		try {
			await collected.untilPushed(() => true);
			chain.release();

			const refused = await collected.untilPushed((progress) => progress.phase === 'refused');
			expect(refused.indexing).toBe(false);
			expect(refused.failure?.name).toBe('RefusedError');
			expect(refused.failure?.message).toContain('will not serve those logs');
		} finally {
			collected.stop();
			host.dispose();
			port.close();
			ends.close();
		}
	});

	it('carries a push through a REAL structured clone, and posts no value that could not cross', async () => {
		const ends = wire();
		const chain = gatedChain();
		const host = hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);
		const collected = collecting(port);

		try {
			await collected.untilPushed(() => true);
			chain.release();
			const done = await collected.untilPushed((progress) => progress.phase === 'at-tip');

			// It already crossed a MessagePort to get here, which is the claim; this
			// says so a second time in one line, against the algorithm itself.
			expect(structuredClone(done)).toEqual(done);
		} finally {
			collected.stop();
			host.dispose();
			port.close();
			ends.close();
		}
	});
});

describe('the progress helper', () => {
	it('is a view over the pushed signal and holds nothing of its own', async () => {
		const ends = wire();
		const chain = gatedChain();
		const host = hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);
		const collected = collecting(port);
		const progress = createProgressReadable(port);

		try {
			// Before the host has answered it invents NOTHING. A synthetic zero here
			// would render as a fold that had finished.
			expect(progress.$state).toBeUndefined();

			// What an app binds to: the same `subscribe` contract every store this
			// package publishes has, so `$progress` in a template and `useStores` in
			// React both work with no adapter.
			const bound: (HostProgress | undefined)[] = [];
			const unbind = progress.subscribe((value) => bound.push(value));
			expect(bound).toEqual([undefined]);

			await collected.untilPushed(() => true);
			chain.release();
			const done = await collected.untilPushed((value) => value.phase === 'at-tip');

			// IDENTITY, not equality: what it holds is the host's own last report,
			// kept by reference. Nothing here composed a value out of what it already
			// had, which is what makes it a view rather than a second source of truth.
			expect(progress.$state).toBe(collected.pushes[collected.pushes.length - 1]);
			expect(progress.$state).toBe(done);
			expect(bound[bound.length - 1]).toBe(done);
			// and every value it published is one the host pushed, in that order
			expect(bound.slice(1)).toEqual(collected.pushes);

			unbind();
			progress.close();
		} finally {
			collected.stop();
			host.dispose();
			port.close();
			ends.close();
		}
	});

	it('releases the subscription it opened, so a closed one stops being fed', async () => {
		const ends = wire();
		const chain = gatedChain();
		const host = hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);
		const progress = createProgressReadable(port);

		const arrived: unknown[] = [];
		ends.tabEndpoint.addEventListener('message', (event) => arrived.push(event.data));

		try {
			// wait for the subscription to be open, without waiting on a clock
			await new Promise<void>((resolve) => {
				const unbind = progress.subscribe((value) => {
					if (value) {
						resolve();
						queueMicrotask(() => unbind());
					}
				});
			});
			progress.close();
			await port.progress();
			const posted = arrived.length;

			chain.release();
			let answered = await port.progress();
			for (let attempt = 0; attempt < 400 && answered.phase !== 'at-tip'; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 20));
				answered = await port.progress();
			}
			expect(answered.phase).toBe('at-tip');
			expect(arrived.slice(posted).every((message) => (message as {kind: string}).kind === 'response')).toBe(true);
			expect(progress.$state?.phase).toBe('waiting');
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});
});
