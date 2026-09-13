import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {generationDigestOf, type StateApplied, type StateMoved, type StateRetracted} from '@etherfold/core';
import {EntityEventProcessor, type EntityStateView} from '@etherfold/processor-entities';
import {openForWriting} from '@etherfold/state-store';
import {
	connectToIndexerHost,
	createBrowserStateStore,
	serveIndexerHost,
	type HostAccess,
	type HostProgress,
	type IndexerPort,
} from '../src/index.js';
import {wire} from './utils/port.js';
import {
	BRANCH_A_TIP,
	BRANCH_B,
	BRANCH_B_TIP,
	FINALITY,
	fakeChain,
	processor,
	SOURCE,
	type TestABI,
} from '../browser/workload.js';

/**
 * A TAB LEARNING THAT THE STATE MOVED -- over a real `MessagePort`, in node.
 *
 * The **state-moved signal** (ADR-0083) reaching the tab that holds a port to a
 * host (ADR-0082), which is what lets an app with the indexer in a worker RE-READ
 * at the right moment instead of polling on an interval it invented. What runs in
 * a REAL browser against a REAL worker is the `state moved` group of
 * `browser/hostingShapes.ts`, run against all three hosting shapes by
 * `browser/threeHostingShapes.spec.ts`; these are the same claims on every
 * commit, because that run needs browser binaries a clean checkout does not have.
 *
 * ## Nothing here waits on a clock
 *
 * The chain is GATED, exactly as in `aTabSeesSyncProgressPushedFromTheWorker`:
 * the provider answers nothing until the test releases it, so a subscription
 * established beforehand cannot miss a block, and every assertion is about the
 * SEQUENCE of notifications and the values in them. The one thing that is a
 * duration is the QUIET at the tip, and it is a bound on silence rather than a
 * measurement of anything.
 */

let counter = 0;
const freshName = () => `state-moved-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/** The blocks this fixture carries logs in, which are therefore the blocks a fold APPLIES. */
const APPLIED_BLOCKS = [100, 102, 104];
/** Both declared entities are touched by every transfer: the token row and the counter. */
const TOUCHED = ['counter', 'token'];

/** The captured stream behind a gate: nothing is fetched until `release()`. See the module note. */
function gatedChain() {
	const chain = fakeChain();
	let open: () => void;
	const gate = new Promise<void>((resolve) => (open = resolve));
	const underlying = chain.provider.request.bind(chain.provider);
	return {
		ranges: chain.ranges,
		release: () => open(),
		serve: chain.serve,
		provider: {
			async request(args: {method: string; params?: unknown}): Promise<unknown> {
				await gate;
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
			config: {stream: {finality: FINALITY}, fetch: {numBlocksToFetchAtStart: 4, maxBlocksPerFetch: 4}},
			tipIntervalInSeconds: 0.05,
		},
		access,
	);
}

/**
 * Collect what the host says the fold did, and let a test WAIT ON A VALUE rather
 * than on a duration.
 */
function watching(port: IndexerPort) {
	const received: StateMoved[] = [];
	const waiting: {matches: (moved: StateMoved) => boolean; resolve: (moved: StateMoved) => void}[] = [];
	const stop = port.onStateMoved((moved) => {
		received.push(moved);
		for (const waiter of [...waiting]) {
			if (waiter.matches(moved)) {
				waiting.splice(waiting.indexOf(waiter), 1);
				waiter.resolve(moved);
			}
		}
	});
	return {
		received,
		stop,
		applied: () => received.filter((moved): moved is StateApplied => moved.kind === 'applied'),
		until(matches: (moved: StateMoved) => boolean): Promise<StateMoved> {
			const already = received.find(matches);
			if (already) return Promise.resolve(already);
			return new Promise<StateMoved>((resolve) => waiting.push({matches, resolve}));
		},
	};
}

/** Ask until the fold is level with the fixture's tip, without asserting on how long it took. */
async function untilAtTip(port: IndexerPort, tip = BRANCH_A_TIP): Promise<HostProgress> {
	for (let attempt = 0; attempt < 400; attempt++) {
		const progress = await port.progress();
		if (progress.failure) throw new Error(`the host stopped: ${progress.failure.name}: ${progress.failure.message}`);
		if (progress.latestBlock === tip && progress.lastToBlock === tip) return progress;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`the fold did not reach block ${tip}: ${JSON.stringify(await port.progress())}`);
}

describe('a tab told that the state moved', () => {
	it('is told once per applied block, as the fold applies them, and carries what CORE published', async () => {
		const ends = wire();
		const chain = gatedChain();
		const host = hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);
		const watched = watching(port);

		try {
			// Subscribed BEFORE the provider has answered anything, so nothing below
			// depends on how fast the fold ran.
			expect(watched.received).toEqual([]);
			chain.release();

			await watched.until((moved) => moved.kind === 'applied' && moved.block === APPLIED_BLOCKS.at(-1));
			await untilAtTip(port);

			// ONE PER APPLIED BLOCK, in the order the fold applied them. The quiet
			// blocks between them are not notifications: nothing was applied there.
			const applied = watched.applied();
			expect(applied.map((moved) => moved.block)).toEqual(APPLIED_BLOCKS);

			// THE VALUE IS CORE'S OWN, not a browser-flavoured variant of it: the four
			// fields ADR-0083 names and nothing beside them, with the entity NAMES the
			// block's mutations touched.
			for (const moved of applied) {
				expect(Object.keys(moved).sort()).toEqual(['block', 'coherence', 'entities', 'generation', 'kind']);
				expect([...moved.entities].sort()).toEqual(TOUCHED);
			}

			// The GENERATION is the one answering reads, rendered as everything that
			// reports which generation answered renders it -- so this is core's value
			// rather than a string this boundary composed.
			const canonical = (await port.generations()).find((one) => one.canonical)!;
			expect(applied.map((moved) => moved.generation)).toEqual(applied.map(() => generationDigestOf(canonical.record)));

			// ONE TOKEN THROUGHOUT, because nothing was retracted and the pointer did not
			// move: a reader comparing it invalidates NARROWLY, using `entities`.
			expect(new Set(applied.map((moved) => moved.coherence)).size).toBe(1);
			expect(applied[0]!.coherence).toMatch(/\S/);

			// It already crossed a `MessagePort` to get here, which is the claim; this
			// says so a second time against the algorithm itself.
			expect(structuredClone(applied[0]!)).toEqual(applied[0]);
		} finally {
			watched.stop();
			host.dispose();
			port.close();
			ends.close();
		}
	});

	/**
	 * THE CADENCE IS APPLIED WORK, and the way to tell is a host that is BUSY and
	 * SILENT at the same time. A host resting at the tip advances on its interval
	 * for ever and applies nothing, so a notification there would be a timer
	 * wearing a signal's clothes.
	 */
	it('says NOTHING while the driver rests at the tip, however many times it advances', async () => {
		const ends = wire();
		const chain = gatedChain();
		const host = hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);
		const watched = watching(port);

		try {
			chain.release();
			await untilAtTip(port);
			await watched.until((moved) => moved.kind === 'applied' && moved.block === APPLIED_BLOCKS.at(-1));

			const told = watched.received.length;
			const fetched = chain.ranges.length;
			// Ten rest intervals' worth, with a listener attached throughout.
			await new Promise((resolve) => setTimeout(resolve, 500));

			expect(chain.ranges.length).toBeGreaterThan(fetched);
			expect(watched.received.length).toBe(told);
		} finally {
			watched.stop();
			host.dispose();
			port.close();
			ends.close();
		}
	});

	/**
	 * A REORG IS A CASE OF THE SIGNAL AND NOT AN INCREMENT: it is caused here by
	 * serving a different branch, rather than asserted as a message shape.
	 */
	it('carries the RETRACTION whole, with the rotated token the appends after it wear', async () => {
		const ends = wire();
		const chain = gatedChain();
		const host = hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);
		const watched = watching(port);

		try {
			chain.release();
			await untilAtTip(port);
			const beforeTheReorg = watched.applied().at(-1)!;

			// Block 104 is replaced: same 100 and 102, a different 104, one block higher
			// tip. It is inside the finality window, so the fold takes the branch back.
			chain.serve(BRANCH_B, BRANCH_B_TIP);
			const retracted = (await watched.until((moved) => moved.kind === 'retracted')) as StateRetracted;

			// It names the FORK POINT it reverted to -- the highest block that still
			// stands -- and carries no entity set, because a rotated token already says
			// invalidate everything.
			expect(Object.keys(retracted).sort()).toEqual(['coherence', 'forkPoint', 'generation', 'kind']);
			// One BELOW the lowest block the stream took back (104), which is what "the
			// highest block that still stands" means: block 102's transfer is untouched.
			expect(retracted.forkPoint).toBe(103);
			// ROTATED: a reader that received this invalidates everything ONCE...
			expect(retracted.coherence).not.toBe(beforeTheReorg.coherence);

			// ...and is then holding exactly the token the replacement blocks carry, so
			// it goes back to invalidating narrowly at the next one.
			const replacement = (await watched.until(
				(moved) => moved.kind === 'applied' && moved.coherence !== beforeTheReorg.coherence,
			)) as StateApplied;
			expect(replacement.block).toBe(104);
			expect(replacement.coherence).toBe(retracted.coherence);
		} finally {
			watched.stop();
			host.dispose();
			port.close();
			ends.close();
		}
	});

	it('stops posting when the tab lets go, and starts again when a listener returns', async () => {
		const ends = wire();
		const chain = gatedChain();
		const host = hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);
		const watched = watching(port);

		// EVERYTHING that reaches this end of the wire, whether or not a listener
		// wanted it: "stopped receiving" is a claim about the WIRE and not about a
		// callback that is no longer called.
		const arrived: {kind: string; push?: string}[] = [];
		ends.tabEndpoint.addEventListener('message', (event) => arrived.push(event.data as {kind: string}));

		try {
			watched.stop();
			// The unsubscribe is a round trip; this one is too, so it cannot overtake it.
			await port.progress();
			const posted = arrived.length;

			chain.release();
			await untilAtTip(port);
			// The fold applied every block with nobody listening. Asked DIRECTLY the host
			// says it got there, so the silence is a host that stopped POSTING and not a
			// host that stopped folding.
			expect(arrived.slice(posted).every((message) => message.kind === 'response')).toBe(true);
			expect(watched.received).toEqual([]);

			// A listener that comes back is told NOTHING about the blocks it missed --
			// there is nothing current to hand it, and replaying a block that landed a
			// while ago would report a move that did not just happen. What it does
			// instead is read.
			const second = watching(port);
			await port.progress();
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(second.received).toEqual([]);
			second.stop();
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});

	/**
	 * TWO PUSHES, TWO SUBSCRIPTIONS. They answer different questions at different
	 * cadences (ADR-0082 keeps progress its own thing), so a tab watching one is
	 * not billed for the other.
	 */
	it('leaves the progress push exactly as it was: subscribed to separately, and pushed on its own cadence', async () => {
		const ends = wire();
		const chain = gatedChain();
		const host = hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);

		const arrived: {kind: string; push?: string}[] = [];
		ends.tabEndpoint.addEventListener('message', (event) => arrived.push(event.data as {kind: string}));

		try {
			// ONLY the signal is subscribed to...
			const watched = watching(port);
			chain.release();
			await watched.until((moved) => moved.kind === 'applied' && moved.block === APPLIED_BLOCKS.at(-1));
			await untilAtTip(port);

			// ...so not one progress push was posted, though the fold passed through
			// every phase on its way to the tip.
			const pushes = arrived.filter((message) => message.kind === 'push');
			expect(pushes.length).toBeGreaterThan(0);
			expect(pushes.every((message) => message.push === 'stateMoved')).toBe(true);

			// The progress push, subscribed to afterwards, behaves exactly as it always
			// has: the ANSWER to the subscribe is where the fold is now, which is what
			// makes a tab that attached to a finished fold correct immediately.
			const first = await new Promise<HostProgress>((resolve) => {
				const stop = port.onProgress((progress) => {
					resolve(progress);
					queueMicrotask(() => stop());
				});
			});
			expect(first.phase).toBe('at-tip');
			expect(first.lastToBlock).toBe(BRANCH_A_TIP);
			watched.stop();
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});

	/**
	 * A worker scope receives whatever anybody posts to it, and the namespace is
	 * what tells our traffic from somebody else's (the envelope's own note). A
	 * second push must not weaken that.
	 */
	it('still ignores a message that is not ours rather than answering it', async () => {
		const ends = wire();
		const chain = gatedChain();
		const host = hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);
		const watched = watching(port);

		const arrived: {kind?: string}[] = [];
		ends.tabEndpoint.addEventListener('message', (event) => arrived.push(event.data as {kind?: string}));

		try {
			chain.release();
			await untilAtTip(port);
			const answered = arrived.length;
			// What the fold legitimately said before any of this, so what follows is about
			// the stranger's traffic alone.
			const told = watched.received.length;

			// Somebody else's traffic, including a message that WEARS the new push's
			// name under another protocol.
			ends.tabEndpoint.postMessage({fixture: 'release'});
			ends.tabEndpoint.postMessage({protocol: 'somebody/else', kind: 'request', id: 1, case: 'subscribeToStateMoved'});
			ends.tabEndpoint.postMessage({kind: 'push', push: 'stateMoved', value: {kind: 'applied', block: 9}});
			// A round trip AFTER them: messages on one wire arrive in order, so an answer
			// to this is proof the host saw all three first.
			await port.progress();

			// Exactly one message came back, and it is the answer to the question that
			// was actually asked.
			expect(arrived.slice(answered).map((message) => message.kind)).toEqual(['response']);
			// ...and nothing a stranger posted at the TAB was taken for a notification.
			expect(watched.received.length).toBe(told);
		} finally {
			watched.stop();
			host.dispose();
			port.close();
			ends.close();
		}
	});
});
