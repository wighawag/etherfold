import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import type {StateApplied, StateMoved, StateRetracted} from '@etherfold/core';
import {EntityEventProcessor, EntityStateView} from '@etherfold/processor-entities';
import {openForReading, openForWriting} from '@etherfold/state-store';
import {
	connectToIndexerHost,
	createBrowserStateStore,
	openStateMovedAcrossTabs,
	serveIndexerHost,
	stateMovedChannelName,
	type HostAccess,
	type HostProgress,
	type IndexerPort,
	type StateMovedAcrossTabs,
} from '../src/index.js';
import {wire} from './utils/port.js';
import {
	BRANCH_A_TIP,
	BRANCH_B,
	BRANCH_B_TIP,
	EXPECTED_A,
	EXPECTED_B,
	FINALITY,
	fakeChain,
	processor,
	readState,
	SOURCE,
	type TestABI,
} from '../browser/workload.js';

/**
 * A READER TAB LEARNING FROM THE INDEXING TAB -- over a real `BroadcastChannel`,
 * in node.
 *
 * The **state-moved signal** (ADR-0083) crossing between tabs of one browser
 * profile, which is what stops a second window of an app being a stale window
 * without that window running a fold of its own. The transport is an ADAPTER and
 * not a second semantics: what a reader is handed here is the value
 * `@etherfold/core` published, exactly as `IndexerPort.onStateMoved` hands it to
 * the tab that holds a port.
 *
 * What runs in a REAL browser, with two real tabs each holding its OWN host over
 * ONE database, is `browser/readerTabLearnsFromTheIndexingTab.spec.ts`; these are
 * the same claims on every commit, because that run needs browser binaries a
 * clean checkout does not have. Node has a real `BroadcastChannel` (and a real
 * `MessagePort`), so everything except "two documents" is reachable here.
 *
 * ## Nothing here waits on a clock
 *
 * The chain is GATED, exactly as in `aTabLearnsTheStateMovedAcrossThePort`: the
 * provider answers nothing until a test releases it, so a listener established
 * beforehand cannot miss a block and every assertion is about the SEQUENCE of
 * notifications. The one duration is a QUIET, which is a bound on silence rather
 * than a measurement.
 */

let counter = 0;
const freshName = () => `reader-tab-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/** The blocks this fixture carries logs in, which are therefore the blocks a fold APPLIES. */
const APPLIED_BLOCKS = [100, 102, 104];

/** The captured stream behind a gate: nothing is fetched until `release()`. */
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
 * A TAB THAT IS LISTENING to the other tabs, recording what it was told and
 * letting a test WAIT ON A VALUE rather than on a duration.
 *
 * The subject is the adapter itself, so this records exactly what
 * `onStateMoved` delivered, in the order it delivered it.
 */
function listening(tabs: StateMovedAcrossTabs) {
	const received: StateMoved[] = [];
	const waiting: {matches: (moved: StateMoved) => boolean; resolve: (moved: StateMoved) => void}[] = [];
	const stop = tabs.onStateMoved((moved) => {
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

/** What the tab that HOLDS THE PORT does: forward its host's signal to the other tabs. */
function publishingFrom(port: IndexerPort, tabs: StateMovedAcrossTabs) {
	return port.onStateMoved(tabs.publish);
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

/** The state as a READER TAB reads it: the same database, opened for READING. */
async function readAsAReaderTab(databaseName: string) {
	return readState(
		new EntityStateView(openForReading(await createBrowserStateStore(processor.entities, {databaseName}))),
	);
}

describe('a reader tab told by the indexing tab', () => {
	it('is handed the value the FOLD published, the same one that crossed the port', async () => {
		const databaseName = freshName();
		const ends = wire();
		const chain = gatedChain();
		const host = hostOver(ends.host, databaseName, chain);
		const port = connectToIndexerHost(ends.tab);

		/** The INDEXING tab: it holds the port, and forwards what it is told. */
		const indexingTab = openStateMovedAcrossTabs({databaseName});
		/** The READER tab: no port, no host, no fold. */
		const readerTab = openStateMovedAcrossTabs({databaseName});
		const acrossThePort: StateMoved[] = [];
		const detachPort = port.onStateMoved((moved) => acrossThePort.push(moved));
		const forwarding = publishingFrom(port, indexingTab);
		const told = listening(readerTab);

		try {
			// Listening BEFORE the provider has answered anything, so nothing below
			// depends on how fast the fold ran.
			expect(told.received).toEqual([]);
			chain.release();

			await told.until((moved) => moved.kind === 'applied' && moved.block === APPLIED_BLOCKS.at(-1));
			await untilAtTip(port);

			// ONE PER APPLIED BLOCK, in the order the fold applied them, in a tab that
			// asked the host nothing.
			expect(told.applied().map((moved) => moved.block)).toEqual(APPLIED_BLOCKS);

			// THE VALUE IS CORE'S OWN. Not a browser-flavoured variant, not a value this
			// transport composed, and INDISTINGUISHABLE from what crossed the port --
			// which is the whole claim: an app writes ONE handler (ADR-0083).
			expect(told.received).toEqual(acrossThePort.slice(0, told.received.length));
			for (const moved of told.applied()) {
				expect(Object.keys(moved).sort()).toEqual(['block', 'coherence', 'entities', 'generation', 'kind']);
			}

			// AND THE READER RE-READS TO THE WRITER'S STATE. It holds no port and no
			// fold: the notification is the only thing that told it to look.
			expect(await readAsAReaderTab(databaseName)).toEqual(EXPECTED_A);
		} finally {
			told.stop();
			forwarding();
			detachPort();
			readerTab.close();
			indexingTab.close();
			host.dispose();
			port.close();
			ends.close();
		}
	});

	/**
	 * THE SCOPE IS THE STORAGE, which is the same rule the **writer token** settles
	 * by living inside the store it guards: two unrelated indexers on one origin
	 * never contend BECAUSE their storage identities differ, and a channel scoped to
	 * an origin, a tab or a name an app invented would put them back together
	 * silently.
	 *
	 * Both directions, because only one of them is interesting on its own: a channel
	 * that carried nothing anywhere would pass the negative half.
	 */
	it('is scoped by the storage the fold writes into: the app next door hears nothing', async () => {
		const databaseName = freshName();
		const nextDoor = freshName();
		const ends = wire();
		const chain = gatedChain();
		const host = hostOver(ends.host, databaseName, chain);
		const port = connectToIndexerHost(ends.tab);

		const indexingTab = openStateMovedAcrossTabs({databaseName});
		const sameStore = openStateMovedAcrossTabs({databaseName});
		const anotherStore = openStateMovedAcrossTabs({databaseName: nextDoor});
		const forwarding = publishingFrom(port, indexingTab);
		const heard = listening(sameStore);
		const deaf = listening(anotherStore);

		try {
			chain.release();
			await heard.until((moved) => moved.kind === 'applied' && moved.block === APPLIED_BLOCKS.at(-1));
			await untilAtTip(port);

			// THE NAME IS THE STORAGE IDENTITY and not a second knob that can drift from
			// it: two stores are two names, one store is one name.
			expect(stateMovedChannelName({databaseName})).not.toBe(stateMovedChannelName({databaseName: nextDoor}));
			expect(stateMovedChannelName({databaseName})).toBe(stateMovedChannelName({databaseName}));

			// A tab of the SAME store heard every block...
			expect(heard.applied().map((moved) => moved.block)).toEqual(APPLIED_BLOCKS);
			// ...and the app next door, on the same origin, heard nothing at all.
			expect(deaf.received).toEqual([]);
		} finally {
			heard.stop();
			deaf.stop();
			forwarding();
			for (const tab of [sameStore, anotherStore, indexingTab]) tab.close();
			host.dispose();
			port.close();
			ends.close();
		}
	});

	/**
	 * BEST-EFFORT, AND THE TOKEN IS WHAT MAKES THAT SAFE. Nothing is buffered for a
	 * tab that was not listening, and what repairs it is the NEXT notification --
	 * which after a reorg arrives with a rotated token, so a reader that missed the
	 * retraction still invalidates everything (ADR-0083).
	 */
	it('holds nothing for a tab that was not listening, and that tab converges on the next notification', async () => {
		const databaseName = freshName();
		const ends = wire();
		const chain = gatedChain();
		const host = hostOver(ends.host, databaseName, chain);
		const port = connectToIndexerHost(ends.tab);

		const indexingTab = openStateMovedAcrossTabs({databaseName});
		const forwarding = publishingFrom(port, indexingTab);

		try {
			chain.release();
			await untilAtTip(port);

			// A TAB THAT ARRIVES LATE: the whole of branch A was applied and published
			// before this channel existed.
			const lateTab = openStateMovedAcrossTabs({databaseName});
			const told = listening(lateTab);
			await new Promise((resolve) => setTimeout(resolve, 100));
			// NOTHING WAS KEPT FOR IT. No replay, no backlog, no "last notification".
			expect(told.received).toEqual([]);

			// THE CHAIN MOVES ON -- here by taking block 104 back, which is the case the
			// token exists for. The late tab is told about it and converges.
			chain.serve(BRANCH_B, BRANCH_B_TIP);
			const retracted = (await told.until((moved) => moved.kind === 'retracted')) as StateRetracted;
			expect(retracted.forkPoint).toBe(103);
			const replacement = (await told.until(
				(moved) => moved.kind === 'applied' && moved.block === 104,
			)) as StateApplied;
			// The retraction and the appends after it carry ONE token, so a reader that
			// received either invalidates everything exactly once.
			expect(replacement.coherence).toBe(retracted.coherence);

			await untilAtTip(port, BRANCH_B_TIP);
			// ...and what it reads is the writer's state, including the blocks it was
			// never told about.
			expect(await readAsAReaderTab(databaseName)).toEqual(EXPECTED_B);

			told.stop();
			lateTab.close();
		} finally {
			forwarding();
			indexingTab.close();
			host.dispose();
			port.close();
			ends.close();
		}
	});

	/**
	 * A TAB DOES NOT HEAR ITSELF, and that is what one channel object per tab buys:
	 * a tab hosting its own worker publishes what its port told it and is not told
	 * it again, so nothing has to name the publisher in order to filter it out.
	 */
	it('does not hand a tab back its own publication', async () => {
		const databaseName = freshName();
		const indexingTab = openStateMovedAcrossTabs({databaseName});
		const otherTab = openStateMovedAcrossTabs({databaseName});
		const itself = listening(indexingTab);
		const other = listening(otherTab);

		try {
			const moved: StateMoved = {
				kind: 'applied',
				block: 104,
				coherence: 'a-token',
				entities: ['counter', 'token'],
				generation: 'a-generation',
			};
			indexingTab.publish(moved);
			await other.until(() => true);

			expect(other.received).toEqual([moved]);
			expect(itself.received).toEqual([]);
		} finally {
			itself.stop();
			other.stop();
			indexingTab.close();
			otherTab.close();
		}
	});

	/**
	 * NO ELECTION, NO LEASE, NO HEARTBEAT. Which tab indexes is
	 * `one-tab-indexes-and-the-others-read` and is a rung above this: here every
	 * indexing tab publishes and every tab listens, which is correct if noisy.
	 *
	 * The structural half of that claim is that NOTHING on the wire names the
	 * publisher -- a reader that could tell who published is a reader that could
	 * elect.
	 */
	it('takes a second publishing tab as noise rather than an error, and nothing names who published', async () => {
		const databaseName = freshName();
		const oneIndexingTab = openStateMovedAcrossTabs({databaseName});
		const anotherIndexingTab = openStateMovedAcrossTabs({databaseName});
		const readerTab = openStateMovedAcrossTabs({databaseName});
		const told = listening(readerTab);

		try {
			const first: StateMoved = {
				kind: 'applied',
				block: 104,
				coherence: 'one-fold',
				entities: ['token'],
				generation: 'a-generation',
			};
			const second: StateMoved = {...first, coherence: 'another-fold'};
			oneIndexingTab.publish(first);
			anotherIndexingTab.publish(second);
			await told.until((moved) => moved.kind === 'applied' && moved.coherence === 'another-fold');

			// BOTH arrived, neither refused, and what a reader does about two folds is
			// what it does about one: compare the token and re-read.
			expect(told.received).toEqual([first, second]);
			for (const moved of told.received) {
				expect(Object.keys(moved).sort()).toEqual(['block', 'coherence', 'entities', 'generation', 'kind']);
			}
		} finally {
			told.stop();
			for (const tab of [oneIndexingTab, anotherIndexingTab, readerTab]) tab.close();
		}
	});

	/**
	 * A `BroadcastChannel` carries whatever anybody posts to it, exactly as a worker
	 * scope does -- so somebody else's traffic must be IGNORED rather than taken for
	 * a notification. The port already holds this line (`isPortPush`); this one must
	 * not be weaker.
	 */
	it('ignores a message on its channel that is not ours', async () => {
		const databaseName = freshName();
		const stranger = new BroadcastChannel(stateMovedChannelName({databaseName}));
		const readerTab = openStateMovedAcrossTabs({databaseName});
		const indexingTab = openStateMovedAcrossTabs({databaseName});
		const told = listening(readerTab);

		try {
			stranger.postMessage({hello: 'from another library'});
			stranger.postMessage({kind: 'applied', block: 9, coherence: 'x', entities: [], generation: 'g'});
			stranger.postMessage({protocol: 'somebody/else', kind: 'stateMoved', value: {kind: 'applied', block: 9}});

			// A publication AFTER them, on the same channel: messages arrive in order, so
			// being told this one is proof the three above were seen and dropped.
			const moved: StateMoved = {
				kind: 'retracted',
				forkPoint: 103,
				coherence: 'a-token',
				generation: 'a-generation',
			};
			indexingTab.publish(moved);
			await told.until(() => true);

			expect(told.received).toEqual([moved]);
		} finally {
			told.stop();
			stranger.close();
			readerTab.close();
			indexingTab.close();
		}
	});
});
