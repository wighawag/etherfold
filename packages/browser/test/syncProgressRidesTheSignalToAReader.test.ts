import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {EntityEventProcessor, EntityStateView} from '@etherfold/processor-entities';
import {openForWriting} from '@etherfold/state-store';
import {
	connectToIndexerHost,
	createBrowserStateStore,
	createProgressReadable,
	openStateMovedAcrossTabs,
	serveIndexerHost,
	stateMovedChannelName,
	type HostAccess,
	type HostProgress,
	type IndexerPort,
	type StateMovedAcrossTabs,
} from '../src/index.js';
import {wire} from './utils/port.js';
import {BRANCH_A_TIP, fakeChain, FINALITY, processor, SOURCE, type TestABI} from '../browser/workload.js';

/**
 * SYNC PROGRESS RIDING THE CROSS-TAB SIGNAL -- over a real `BroadcastChannel`,
 * in node.
 *
 * "Syncing, 400 blocks behind", rendered in a tab that is not the one folding.
 * A tab that HOSTS the fold is told over its port (ADR-0082, and that push is
 * untouched by any of this); a tab that is merely READING has no host to ask and
 * CANNOT work it out -- the **sync cursor** is opaque behind the storage seam
 * (ADR-0027) and a reader deserialising it would breach that. So the side that
 * knows publishes, on the ONE channel a reader already listens to (ADR-0083),
 * rather than on a second mechanism with its own lifetime and its own silence.
 *
 * What runs in a REAL browser, with real tabs each holding its own host, is
 * `browser/syncProgressRidesTheSignalToAReader.spec.ts`; these are the same
 * claims on every commit, because that run needs browser binaries a clean
 * checkout does not have.
 *
 * ## Nothing here waits on a clock
 *
 * The one duration is a QUIET, which is a bound on silence rather than a
 * measurement; every positive claim is waited for as a VALUE.
 */

let counter = 0;
const freshName = () => `progress-tab-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * A REPORT A HOST COULD HAVE MADE, written out here so a case about the
 * TRANSPORT does not have to run a fold to have something to carry.
 *
 * It is the sentence the whole task is for, as data: catching up, four hundred
 * blocks behind the chain tip.
 */
const FOUR_HUNDRED_BEHIND: HostProgress = {
	host: 'dedicated-worker',
	scope: 'DedicatedWorkerGlobalScope',
	indexing: true,
	phase: 'catching-up',
	lastToBlock: 600,
	latestBlock: 1000,
	blocksBehindTip: 400,
	numBlocksProcessedSoFar: 600,
	syncPercentage: 60,
};

/** The same host, further along. */
const moved = (over: Partial<HostProgress>): HostProgress => ({...FOUR_HUNDRED_BEHIND, ...over});

/**
 * EVERY WORD A REPORT MAY CARRY. A test's copy of `HostProgress`'s field list,
 * so that a second vocabulary appearing on this channel is a failure rather than
 * a thing nobody notices.
 */
const PROGRESS_VOCABULARY = [
	'host',
	'scope',
	'indexing',
	'phase',
	'lastToBlock',
	'latestBlock',
	'blocksBehindTip',
	'numBlocksProcessedSoFar',
	'syncPercentage',
	'failure',
];

/** The captured stream behind a gate: nothing is fetched until `release()`. */
function gatedChain() {
	const chain = fakeChain();
	let open: () => void;
	const gate = new Promise<void>((resolve) => (open = resolve));
	const underlying = chain.provider.request.bind(chain.provider);
	return {
		release: () => open(),
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
 * A TAB THAT IS LISTENING FOR PROGRESS, recording what it was told and letting a
 * case WAIT ON A VALUE rather than on a duration.
 *
 * The subject is the adapter, so this records exactly what `onProgress`
 * delivered, in the order it delivered it.
 */
function rendering(tabs: StateMovedAcrossTabs) {
	const received: HostProgress[] = [];
	const waiting: {matches: (progress: HostProgress) => boolean; resolve: (progress: HostProgress) => void}[] = [];
	const stop = tabs.onProgress((progress) => {
		received.push(progress);
		for (const waiter of [...waiting]) {
			if (waiter.matches(progress)) {
				waiting.splice(waiting.indexOf(waiter), 1);
				waiter.resolve(progress);
			}
		}
	});
	return {
		received,
		stop,
		/** The sentence an app puts on screen, from the last thing this tab was told. */
		rendered: () => {
			const last = received[received.length - 1];
			if (!last) return 'nothing yet';
			return last.phase === 'at-tip' ? 'live' : `syncing, ${last.blocksBehindTip} blocks behind`;
		},
		until(matches: (progress: HostProgress) => boolean): Promise<HostProgress> {
			const already = received.find(matches);
			if (already) return Promise.resolve(already);
			return new Promise<HostProgress>((resolve) => waiting.push({matches, resolve}));
		},
	};
}

/** What the tab that HOLDS THE PORT does: forward its host's report to the other tabs. */
function publishingFrom(port: IndexerPort, tabs: StateMovedAcrossTabs) {
	return port.onProgress(tabs.publishProgress);
}

/** A bound on SILENCE, which is the one thing that cannot be waited for as a value. */
const quiet = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('sync progress riding the cross-tab signal', () => {
	it('renders in a reader tab the report the HOST made, the same value that crossed the port', async () => {
		const databaseName = freshName();
		const ends = wire();
		const chain = gatedChain();
		const host = hostOver(ends.host, databaseName, chain);
		const port = connectToIndexerHost(ends.tab);

		/** The INDEXING tab: it holds the port, and forwards what it is told. */
		const indexingTab = openStateMovedAcrossTabs({databaseName});
		/** The READER tab: no port, no host, no fold, no cursor to deserialise. */
		const readerTab = openStateMovedAcrossTabs({databaseName});
		const acrossThePort: HostProgress[] = [];
		const detachPort = port.onProgress((progress) => acrossThePort.push(progress));
		const forwarding = publishingFrom(port, indexingTab);
		const reader = rendering(readerTab);

		try {
			// Listening BEFORE the provider has answered anything, so nothing below
			// depends on how fast the fold ran.
			expect(reader.received).toEqual([]);
			expect(reader.rendered()).toBe('nothing yet');
			chain.release();

			const live = await reader.until((progress) => progress.phase === 'at-tip');

			// WHAT THE TAB THAT DOES THE WORK IS TOLD, in a tab that asked nobody
			// anything: same shape, same meaning, same numbers.
			expect(live.lastToBlock).toBe(BRANCH_A_TIP);
			expect(live.latestBlock).toBe(BRANCH_A_TIP);
			expect(live.blocksBehindTip).toBe(0);
			expect(reader.rendered()).toBe('live');

			// THE VALUE IS THE HOST'S OWN. Not a reader-side derivation, not a second
			// vocabulary for how far the fold has got: what this tab holds is byte for
			// byte what the port handed the tab that holds one.
			expect(reader.received).toEqual(acrossThePort.slice(0, reader.received.length));
			// ...and it went past 'catching-up' on the way, which is where the number in
			// "syncing, N blocks behind" is the one worth rendering.
			expect(reader.received.map((progress) => progress.phase)).toContain('catching-up');
			// ONE VOCABULARY, and nothing cursor-shaped in it. What crossed is the words
			// ADR-0082 chose for a tab to render; a reader that was handed a serialised
			// cursor to unpack would be reading through the storage seam (ADR-0027).
			for (const progress of reader.received) {
				for (const field of Object.keys(progress)) expect(PROGRESS_VOCABULARY).toContain(field);
			}
		} finally {
			reader.stop();
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
	 * ONE CHANNEL, TWO THINGS A READER CAN BE TOLD. Progress does not get a channel
	 * of its own: a second one would be a second lifetime, a second name to scope
	 * and a second thing to be silent, for one question a reader already has an ear
	 * open for.
	 */
	it('travels on the SAME channel as the state-moved signal, scoped to the same storage', async () => {
		const databaseName = freshName();
		const nextDoor = freshName();
		const indexingTab = openStateMovedAcrossTabs({databaseName});
		const readerTab = openStateMovedAcrossTabs({databaseName});
		const anotherStore = openStateMovedAcrossTabs({databaseName: nextDoor});
		const reader = rendering(readerTab);
		const deaf = rendering(anotherStore);
		const told: unknown[] = [];
		let toldOne: () => void;
		const aNotification = new Promise<void>((resolve) => (toldOne = resolve));
		const listening = readerTab.onStateMoved((value) => {
			told.push(value);
			toldOne();
		});

		try {
			// ONE NAME, and it is the one the previous task composed: the storage
			// identity and nothing else.
			expect(readerTab.channelName).toBe(stateMovedChannelName({databaseName}));
			expect(indexingTab.channelName).toBe(readerTab.channelName);

			indexingTab.publishProgress(FOUR_HUNDRED_BEHIND);
			indexingTab.publish({
				kind: 'applied',
				block: 601,
				coherence: 'a-token',
				entities: ['counter'],
				generation: 'a-generation',
			});

			await reader.until(() => true);
			await aNotification;
			expect(reader.rendered()).toBe('syncing, 400 blocks behind');
			// Both arrived, on ONE channel object, through the two verbs that answer the
			// two different questions.
			expect(told).toHaveLength(1);
			// ...and the app next door, on the same origin, heard neither.
			await quiet();
			expect(deaf.received).toEqual([]);
		} finally {
			listening();
			reader.stop();
			deaf.stop();
			for (const tab of [indexingTab, readerTab, anotherStore]) tab.close();
		}
	});

	/**
	 * PROGRESS IS A STATE, so a listener attaching part way through is handed WHERE
	 * THE FOLD IS rather than nothing.
	 *
	 * That is the port's own rule (`subscribeToProgress` ANSWERS with the current
	 * value) carried onto this channel, and it is deliberately the OPPOSITE of what
	 * `onStateMoved` does one line away: a notification is a thing that HAPPENED,
	 * and handing a late listener the previous one would have it invalidate for a
	 * block it may already have read.
	 */
	it('hands a listener that attaches later the last report at once, with nothing new published', async () => {
		const databaseName = freshName();
		const indexingTab = openStateMovedAcrossTabs({databaseName});
		const readerTab = openStateMovedAcrossTabs({databaseName});
		const early = rendering(readerTab);

		try {
			indexingTab.publishProgress(FOUR_HUNDRED_BEHIND);
			await early.until(() => true);

			// A SECOND LISTENER IN A TAB THAT WAS ALREADY LISTENING: nothing is
			// published after this line, and it renders anyway.
			const late = rendering(readerTab);
			const held = await late.until(() => true);
			expect(held).toEqual(FOUR_HUNDRED_BEHIND);
			expect(late.rendered()).toBe('syncing, 400 blocks behind');
			// ONE report and never a backlog: what a late listener gets is WHERE THE
			// FOLD IS, not the three places it has been.
			expect(late.received).toHaveLength(1);
			late.stop();
		} finally {
			early.stop();
			indexingTab.close();
			readerTab.close();
		}
	});

	/**
	 * A TAB THAT OPENED INTO A QUIET CHAIN asks, and the tab that knows answers.
	 *
	 * The case that makes the rule above insufficient on its own: a host resting at
	 * the tip pushes NOTHING, so a tab opened after the fold finished has heard
	 * nothing and would have nothing to render for as long as the chain stays
	 * quiet. So attaching with nothing held ASKS on the channel, and a tab holding a
	 * report re-posts the LAST one it published.
	 *
	 * It is an ASK and not a request: nothing is awaited, nothing is retried, and a
	 * channel with no publisher on it answers nothing at all (the case below).
	 */
	it('answers a tab that opened after the fold went quiet, because it ASKS', async () => {
		const databaseName = freshName();
		const indexingTab = openStateMovedAcrossTabs({databaseName});

		try {
			indexingTab.publishProgress(moved({phase: 'at-tip', lastToBlock: 1000, blocksBehindTip: 0}));
			await quiet();

			// A TAB OPENED AFTER ALL OF THAT, on a chain that is not going to move.
			const newTab = openStateMovedAcrossTabs({databaseName});
			const reader = rendering(newTab);
			const told = await reader.until(() => true);

			expect(told).toEqual(moved({phase: 'at-tip', lastToBlock: 1000, blocksBehindTip: 0}));
			expect(reader.rendered()).toBe('live');
			// EXACTLY ONE: what is re-posted is where the fold IS, and there is no
			// backlog to replay because nothing is kept per listening tab.
			await quiet();
			expect(reader.received).toHaveLength(1);

			reader.stop();
			newTab.close();
		} finally {
			indexingTab.close();
		}
	});

	/**
	 * NOTHING IS KEPT PER LISTENING TAB: what a publisher holds is ONE report, its
	 * own last, however many tabs are listening -- and a tab that missed three
	 * reports is handed the third rather than all three.
	 */
	it('holds one report and not a backlog, however many tabs ask for it', async () => {
		const databaseName = freshName();
		const indexingTab = openStateMovedAcrossTabs({databaseName});

		try {
			indexingTab.publishProgress(FOUR_HUNDRED_BEHIND);
			indexingTab.publishProgress(moved({lastToBlock: 800, blocksBehindTip: 200}));
			indexingTab.publishProgress(moved({lastToBlock: 900, blocksBehindTip: 100}));
			await quiet();

			const tabs = [
				openStateMovedAcrossTabs({databaseName}),
				openStateMovedAcrossTabs({databaseName}),
				openStateMovedAcrossTabs({databaseName}),
			];
			const readers = tabs.map(rendering);
			await Promise.all(readers.map((reader) => reader.until(() => true)));
			await quiet();

			for (const reader of readers) {
				expect(reader.received).toEqual([moved({lastToBlock: 900, blocksBehindTip: 100})]);
				expect(reader.rendered()).toBe('syncing, 100 blocks behind');
			}

			for (const reader of readers) reader.stop();
			for (const tab of tabs) tab.close();
		} finally {
			indexingTab.close();
		}
	});

	/** An ASK nobody can answer is answered by nobody, and is not an error. */
	it('leaves a tab with nothing to render where no tab holds a report', async () => {
		const databaseName = freshName();
		const aloneTab = openStateMovedAcrossTabs({databaseName});
		const otherTab = openStateMovedAcrossTabs({databaseName});
		const reader = rendering(aloneTab);

		try {
			await quiet();
			expect(reader.received).toEqual([]);
			expect(reader.rendered()).toBe('nothing yet');
		} finally {
			reader.stop();
			aloneTab.close();
			otherTab.close();
		}
	});

	/**
	 * A TAB DOES NOT HEAR ITSELF, exactly as it does not for the notification: a tab
	 * that holds a host is told over its port and hearing its own publication back
	 * would be an avoidable duplicate.
	 */
	it('does not hand a tab back its own progress publication', async () => {
		const databaseName = freshName();
		const indexingTab = openStateMovedAcrossTabs({databaseName});
		const otherTab = openStateMovedAcrossTabs({databaseName});
		const itself = rendering(indexingTab);
		const other = rendering(otherTab);

		try {
			indexingTab.publishProgress(FOUR_HUNDRED_BEHIND);
			await other.until(() => true);

			expect(other.received).toEqual([FOUR_HUNDRED_BEHIND]);
			expect(itself.received).toEqual([]);
		} finally {
			itself.stop();
			other.stop();
			indexingTab.close();
			otherTab.close();
		}
	});

	/**
	 * A SECOND PUBLISHING TAB IS NOISE rather than an error, and what a reader
	 * renders is the LAST report it was told.
	 *
	 * Which tab indexes is `one-tab-indexes-and-the-others-read`, a rung above this,
	 * so until it exists every tab holding a host may publish. A receiver holds what
	 * it was last told and composes nothing out of two reports -- merging them would
	 * be the second source of truth this is not.
	 */
	it('takes a second publishing tab as noise, rendering the last report rather than a merge', async () => {
		const databaseName = freshName();
		const oneIndexingTab = openStateMovedAcrossTabs({databaseName});
		const anotherIndexingTab = openStateMovedAcrossTabs({databaseName});
		const readerTab = openStateMovedAcrossTabs({databaseName});
		const reader = rendering(readerTab);

		try {
			oneIndexingTab.publishProgress(FOUR_HUNDRED_BEHIND);
			anotherIndexingTab.publishProgress(moved({host: 'main-thread', scope: 'Window', lastToBlock: 100}));
			await reader.until((progress) => progress.host === 'main-thread');

			expect(reader.received).toHaveLength(2);
			expect(reader.received[1]).toEqual(moved({host: 'main-thread', scope: 'Window', lastToBlock: 100}));
		} finally {
			reader.stop();
			for (const tab of [oneIndexingTab, anotherIndexingTab, readerTab]) tab.close();
		}
	});

	/**
	 * A `BroadcastChannel` carries whatever anybody on the origin posts to it, so
	 * somebody else's traffic must be IGNORED rather than rendered as a fold's
	 * position.
	 */
	it('ignores a progress-shaped message on its channel that is not ours', async () => {
		const databaseName = freshName();
		const stranger = new BroadcastChannel(stateMovedChannelName({databaseName}));
		const readerTab = openStateMovedAcrossTabs({databaseName});
		const indexingTab = openStateMovedAcrossTabs({databaseName});
		const reader = rendering(readerTab);

		try {
			stranger.postMessage({hello: 'from another library'});
			stranger.postMessage(FOUR_HUNDRED_BEHIND);
			stranger.postMessage({protocol: 'somebody/else', kind: 'progress', value: FOUR_HUNDRED_BEHIND});
			stranger.postMessage({protocol: 'etherfold/state-moved', kind: 'progress', value: {phase: 42}});

			// A publication AFTER them, on the same channel: messages arrive in order, so
			// being told this one is proof the four above were seen and dropped.
			indexingTab.publishProgress(FOUR_HUNDRED_BEHIND);
			await reader.until(() => true);
			await quiet();

			expect(reader.received).toEqual([FOUR_HUNDRED_BEHIND]);
		} finally {
			reader.stop();
			stranger.close();
			readerTab.close();
			indexingTab.close();
		}
	});

	/**
	 * THE APP-FACING BINDING IS THE SAME ONE, unchanged: the small readable a tab
	 * with a host binds to its port binds to this channel, because both are the
	 * same `onProgress`.
	 *
	 * It is a VIEW either way -- it holds the last report by reference, derives
	 * nothing and invents nothing while it waits -- which is what lets an app that
	 * moves from hosting to reading keep its progress bar.
	 */
	it('binds through createProgressReadable, so a reader tab renders with the same helper', async () => {
		const databaseName = freshName();
		const indexingTab = openStateMovedAcrossTabs({databaseName});
		const readerTab = openStateMovedAcrossTabs({databaseName});
		const progress = createProgressReadable(readerTab);

		try {
			// NOTHING INVENTED WHILE IT WAITS: undefined until the tab that knows says
			// something, because a synthetic zero renders as a finished fold.
			expect(progress.$state).toBeUndefined();

			const seen: (HostProgress | undefined)[] = [];
			const unsubscribe = progress.subscribe((value) => seen.push(value));
			indexingTab.publishProgress(FOUR_HUNDRED_BEHIND);
			await new Promise<void>((resolve) => {
				const stop = readerTab.onProgress(() => {
					stop();
					resolve();
				});
			});

			expect(progress.$state).toEqual(FOUR_HUNDRED_BEHIND);
			expect(seen.at(-1)).toEqual(FOUR_HUNDRED_BEHIND);
			unsubscribe();
			progress.close();
		} finally {
			indexingTab.close();
			readerTab.close();
		}
	});

	/**
	 * PUBLISHING AFTER CLOSE is a tab going away, not a failure: the ordinary cause
	 * is a teardown releasing the channel before the port subscription feeding it,
	 * and an app unmounting is not a place to throw.
	 */
	it('drops a report published after close rather than raising at a host that has already advanced', async () => {
		const databaseName = freshName();
		const indexingTab = openStateMovedAcrossTabs({databaseName});
		const readerTab = openStateMovedAcrossTabs({databaseName});
		const reader = rendering(readerTab);

		try {
			indexingTab.close();
			expect(() => indexingTab.publishProgress(FOUR_HUNDRED_BEHIND)).not.toThrow();
			await quiet();
			expect(reader.received).toEqual([]);
		} finally {
			reader.stop();
			readerTab.close();
		}
	});
});
