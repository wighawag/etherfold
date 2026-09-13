import type {StateMoved, StateMovedDetach, StateMovedHandler} from '@etherfold/core';
import {DEFAULT_DATABASE_NAME} from '@etherfold/state-store-indexeddb';
import {logs} from 'named-logs';
import {sameProgress, type HostProgress} from './host/envelope.js';

const namedLogger = logs('@etherfold/browser');

/**
 * THE NAMESPACE THIS ADAPTER OWNS, used for BOTH halves of what it names: the
 * `BroadcastChannel`'s own name, and the envelope every message on it wears.
 *
 * ONE constant because they are one decision. A channel name that did not say
 * whose it was would collide with whatever else an origin broadcasts, and an
 * envelope that did not say so would make a stranger's message on our channel
 * indistinguishable from a notification -- which is the same rule the port
 * envelope states for a worker scope, here for the same reason: a channel
 * carries whatever anybody posts to it.
 */
export const STATE_MOVED_CHANNEL_PROTOCOL = 'etherfold/state-moved';

/**
 * WHICH STORAGE this signal is about, said the way the store itself is
 * configured.
 *
 * It is deliberately the SAME shape `BrowserStateStoreConfig`'s default arm has,
 * so what an app passes here is the value it already passed to
 * `createBrowserStateStore` rather than a second name that can drift from it.
 * Omitted means the store's own default (`etherfold-state`), resolved through the
 * backend's own constant so the two cannot answer differently.
 */
export type CrossTabStateStorage = {
	/**
	 * The IndexedDB database this state lives in: the **storage identity** on the
	 * browser default (ADR-0075, `CONTEXT.md` on the *writer token*).
	 */
	readonly databaseName?: string;
};

/**
 * THE CHANNEL A STORE'S NOTIFICATIONS TRAVEL ON, composed from the STORAGE
 * IDENTITY and nothing else.
 *
 * This is the whole scoping rule, and it is the **writer token**'s rule rather
 * than a new one: the token's scope is one unit of STORAGE precisely because the
 * token lives inside the storage it guards, which is why two unrelated indexers
 * on one origin never contend. On the browser default that identity is the
 * `databaseName` (`CONTEXT.md`, *storage identity*), so that is what names the
 * channel -- two tabs of one store hear each other, two apps sharing an origin do
 * not, and neither of those had to be arranged.
 *
 * What it deliberately is NOT scoped to is an ORIGIN, a TAB, a connection or a
 * name an app invented, each of which breaks the first of those silently: two
 * indexers on one origin would be told about each other's blocks and would
 * invalidate caches over state they do not hold. The glossary says this in as
 * many words about the token, and the channel follows it for the same reason --
 * one fact, two mechanisms that must not disagree.
 *
 * ```ts
 * stateMovedChannelName({databaseName: 'my-app-state'}); // 'etherfold/state-moved/my-app-state'
 * ```
 *
 * Exported because a test, a diagnostic or a devtool wants to NAME the channel
 * without opening one; an application does not need it.
 */
export function stateMovedChannelName(storage: CrossTabStateStorage = {}): string {
	return `${STATE_MOVED_CHANNEL_PROTOCOL}/${storage.databaseName ?? DEFAULT_DATABASE_NAME}`;
}

/** What one publication looks like ON the channel: the envelope, and core's value inside it. */
type StateMovedMessage = {
	readonly protocol: typeof STATE_MOVED_CHANNEL_PROTOCOL;
	readonly kind: 'stateMoved';
	readonly value: StateMoved;
};

/**
 * WHERE THE FOLD HAS GOT TO, on the same channel: the host's own report,
 * forwarded unchanged.
 *
 * A SECOND KIND on one envelope and deliberately not a second MESSAGE SHAPE and
 * not a second CHANNEL: it is the same split the port already makes (ADR-0082),
 * where `progress` and the notification are two pushes that answer different
 * questions at different cadences and are never merged into one. What a reader
 * has to have is an ear open, and it already has exactly one.
 */
type ProgressMessage = {
	readonly protocol: typeof STATE_MOVED_CHANNEL_PROTOCOL;
	readonly kind: 'progress';
	readonly value: HostProgress;
};

/**
 * WHERE IS THE FOLD? -- posted by a tab that has heard no report yet, and
 * answered by any tab that has one to give.
 *
 * It carries nothing, because it asks for one thing and names nobody: there is
 * no client id, no reply address and nothing to correlate, so no tab holds
 * anything about the tab that asked. See `onProgress` for why an ask exists at
 * all -- a host resting at the tip pushes nothing, so a tab opened into a quiet
 * chain would otherwise have nothing to render until the chain moved.
 */
type ProgressAskMessage = {
	readonly protocol: typeof STATE_MOVED_CHANNEL_PROTOCOL;
	readonly kind: 'progressAsk';
};

/**
 * OURS, or somebody else's? Narrow enough to be sure, and no wider.
 *
 * The same shape of check `isPortPush` makes on the port, and it is not
 * defensive programming: an origin's `BroadcastChannel` namespace is shared with
 * every other library the page loaded, and a message taken for a notification
 * would have a reader invalidating its cache on a stranger's traffic.
 */
function isStateMoved(data: unknown): data is StateMovedMessage {
	if (typeof data !== 'object' || data === null) return false;
	const message = data as Partial<StateMovedMessage>;
	if (message.protocol !== STATE_MOVED_CHANNEL_PROTOCOL || message.kind !== 'stateMoved') return false;
	const value = message.value as Partial<StateMoved> | undefined;
	return typeof value === 'object' && value !== null && (value.kind === 'applied' || value.kind === 'retracted');
}

/**
 * OURS, AND A REPORT? The same line as above, held at the same height.
 *
 * The four fields checked are the four a `HostProgress` always carries, so this
 * refuses a stranger's `{phase: 42}` rather than handing a progress bar a number
 * that is not one. The block figures are deliberately NOT required: they are
 * ABSENT until a tip has been learnt, which is the honest report of a host that
 * has not fetched.
 */
function isProgress(data: unknown): data is ProgressMessage {
	if (typeof data !== 'object' || data === null) return false;
	const message = data as Partial<ProgressMessage>;
	if (message.protocol !== STATE_MOVED_CHANNEL_PROTOCOL || message.kind !== 'progress') return false;
	const value = message.value as Partial<HostProgress> | undefined;
	if (typeof value !== 'object' || value === null) return false;
	return (
		typeof value.host === 'string' &&
		typeof value.scope === 'string' &&
		typeof value.indexing === 'boolean' &&
		typeof value.phase === 'string'
	);
}

/** Ours, and an ask? It carries nothing, so the envelope is the whole of it. */
function isProgressAsk(data: unknown): data is ProgressAskMessage {
	if (typeof data !== 'object' || data === null) return false;
	const message = data as Partial<ProgressAskMessage>;
	return message.protocol === STATE_MOVED_CHANNEL_PROTOCOL && message.kind === 'progressAsk';
}

/**
 * THIS TAB'S END OF THE CROSS-TAB SIGNAL: what it says to the other tabs, and
 * what it is told by them.
 *
 * ONE object for both directions deliberately -- see `openStateMovedAcrossTabs`
 * on why that is what keeps a tab from hearing itself.
 *
 * TWO THINGS a reader can be told over it, and they are the two the port already
 * carries (ADR-0082): the state MOVED (`publish` / `onStateMoved`), and WHERE
 * THE FOLD IS (`publishProgress` / `onProgress`). They are not merged, because
 * they answer different questions at different cadences; they share a channel,
 * because a second channel would be a second lifetime and a second silence for
 * a reader that already has this one open.
 */
export type StateMovedAcrossTabs = {
	/** WHICH channel this is on, as `stateMovedChannelName` composed it. */
	readonly channelName: string;
	/**
	 * TELL THE OTHER TABS what this tab's fold just did.
	 *
	 * Handed the value a producer published and posts it unchanged, so it is
	 * wired straight onto whatever this tab holds the signal through:
	 *
	 * ```ts
	 * const tabs = openStateMovedAcrossTabs({databaseName});
	 * indexer.onStateMoved(tabs.publish); // this tab has a host; the others do not
	 * ```
	 *
	 * POST AND FORGET. Nothing is acknowledged, nothing is retried and nothing is
	 * kept for a tab that was not listening: delivery is best-effort and the
	 * producer holds no per-client state (ADR-0083), which is what a reader's
	 * coherence token makes safe rather than merely cheap.
	 */
	publish(moved: StateMoved): void;
	/**
	 * BE TOLD BY ANOTHER TAB that the state moved. Returns the detach.
	 *
	 * The same verb and the same value as `IndexerPort.onStateMoved`, because it
	 * is the same signal over a second transport: an app writes ONE handler and
	 * the two lines of the reader rule do not change.
	 *
	 * ```ts
	 * let held: string | undefined;
	 * tabs.onStateMoved((moved) => {
	 *   if (moved.coherence !== held) {held = moved.coherence; return refetchEverything();}
	 *   if (moved.kind === 'applied') for (const entity of moved.entities) refetch(entity);
	 * });
	 * ```
	 *
	 * A tab that attaches part way through is told NOTHING until the next
	 * notification, exactly as on the port: a notification is a thing that
	 * HAPPENED rather than a value to render, and what a freshly attached tab does
	 * instead is READ.
	 */
	onStateMoved(listener: StateMovedHandler): StateMovedDetach;
	/**
	 * TELL THE OTHER TABS WHERE THIS TAB'S FOLD HAS GOT TO, so a tab that is merely
	 * reading can render "syncing, 400 blocks behind".
	 *
	 * Handed the report a HOST made and posts it unchanged, so it is wired straight
	 * onto the push a tab with a host already receives:
	 *
	 * ```ts
	 * const tabs = openStateMovedAcrossTabs({databaseName});
	 * indexer.onProgress(tabs.publishProgress); // this tab has a host; the others do not
	 * ```
	 *
	 * ## The value is the HOST'S, and this is a VIEW of it
	 *
	 * Nothing here composes, rounds, re-derives or re-times: a reader tab and a
	 * hosting tab render the same words from the same numbers because they are
	 * literally the same value (`HostProgress`, ADR-0082's vocabulary, whose
	 * distance to the chain tip is `blocksBehindTip` -- named for the tip it
	 * measures against, since bare `blocksBehind` already means how far a
	 * NON-CANONICAL generation is behind the canonical one). A reader could not
	 * compute this for itself in any case: the **sync cursor** is opaque behind the
	 * storage seam (ADR-0027), so the side that knows has to say.
	 *
	 * ## The CADENCE is the host's too, and no timer is introduced
	 *
	 * A report is posted when one is pushed at this tab, and the host pushes when a
	 * batch has been APPLIED or the phase changed and says nothing when the report
	 * would repeat the last one. So this channel carries progress at the port's
	 * cadence rather than at the cadence of the applied blocks it otherwise
	 * carries: nothing polls, nothing beats, and a host resting at the tip is
	 * silent.
	 *
	 * POST AND FORGET, exactly as `publish` is, with ONE report held: the last one
	 * THIS tab published, which is what an ask from a tab that opened later is
	 * answered with. One value whatever the number of listening tabs -- nothing is
	 * kept PER TAB, which is the property every transport in ADR-0083 rests on.
	 */
	publishProgress(progress: HostProgress): void;
	/**
	 * BE TOLD WHERE THE FOLD HAS GOT TO by the tab that is doing it. Returns the
	 * detach.
	 *
	 * The same verb, the same value and the same meaning as `IndexerPort.onProgress`,
	 * because it is the same report over a second transport -- so an app binds it
	 * with the same helper it would bind a port with:
	 *
	 * ```ts
	 * const progress = createProgressReadable(tabs); // a port works here too
	 * // {$progress.phase === 'at-tip' ? 'live' : `syncing, ${$progress.blocksBehindTip} blocks behind`}
	 * ```
	 *
	 * ## A tab attaching part way through IS told, and that is the opposite of
	 * `onStateMoved` one line above
	 *
	 * Progress is a STATE rather than a thing that HAPPENED, which is the same
	 * split the port makes: its progress subscribe ANSWERS with the current value,
	 * while its notification subscribe answers nothing. So a listener here is
	 * handed WHERE THE FOLD IS as soon as this tab knows it:
	 *
	 * - if this tab has already heard a report, that one, immediately;
	 * - otherwise this tab ASKS the other tabs, and any tab holding a report of its
	 *   own re-posts it. That ask is what stops a tab OPENED INTO A QUIET CHAIN
	 *   being blank for ever: a host resting at the tip pushes nothing, so there is
	 *   no next push to wait for.
	 *
	 * It is an ASK and not a request. Nothing is awaited, nothing is retried and no
	 * tab is remembered, so a channel with no tab holding a report answers nothing
	 * at all and this listener simply waits for the next push -- best-effort,
	 * exactly like everything else here.
	 *
	 * ## A REPEAT is not delivered
	 *
	 * A report identical to the one this tab already holds is dropped rather than
	 * handed on, which is the rule the host itself follows on the port (it posts
	 * nothing where the report would repeat the last one). It is what makes several
	 * tabs asking at once cost one render rather than one per ask, and it is
	 * SUPPRESSION and never composition: what is held is one report, by reference,
	 * replaced wholesale.
	 */
	onProgress(listener: (progress: HostProgress) => void): () => void;
	/**
	 * This tab is done with the signal: stop listening and stop being able to
	 * publish.
	 *
	 * Closing the underlying channel is what releases it, so a tab that opened one
	 * and let go of the reference without closing would go on receiving. A
	 * publication after this is DROPPED and noted rather than raised: the ordinary
	 * way it happens is a teardown releasing this before the port subscription that
	 * feeds it, which is a tab going away rather than a failure, and an app
	 * unmounting is not a place to throw.
	 */
	close(): void;
};

/**
 * OPEN THIS TAB'S END OF THE CROSS-TAB SIGNAL: the **state-moved signal**
 * (ADR-0083) over a `BroadcastChannel`, scoped to one store.
 *
 * ```ts
 * // every tab, whether or not it is the one indexing
 * const tabs = openStateMovedAcrossTabs({databaseName: 'my-app-state'});
 * tabs.onStateMoved(() => rerenderFromTheStore());
 * const progress = createProgressReadable(tabs); // "syncing, 400 blocks behind"
 *
 * // and, in a tab that holds a host, forward what that host tells it
 * indexer.onStateMoved(tabs.publish);
 * indexer.onProgress(tabs.publishProgress);
 * ```
 *
 * ## ONE CHANNEL, TWO THINGS A READER CAN BE TOLD
 *
 * They are the same two the PORT carries and they are kept apart for the same
 * reason (ADR-0082): where the fold has got to is a STATE a progress bar renders,
 * and the notification says WHAT MOVED so a cache invalidates narrowly. What they
 * SHARE is the channel, because a reader tab needs one ear open and not two -- a
 * second `BroadcastChannel` would be a second lifetime, a second name to scope
 * against the app next door, and a second thing that can be silent for one
 * question. The port's own `progress` push is untouched by any of this: a tab
 * holding a port is told over it, and this is for the tab that holds none.
 *
 * ## It is an ADAPTER and not a second semantics
 *
 * What is posted is the value the fold published, or the report the HOST made,
 * and a tab that receives either does exactly what a tab receiving it over a port
 * does. That is the claim ADR-0083 makes about every transport (`MessagePort`,
 * `BroadcastChannel`, a server's stream): the same notion, delivered over
 * whichever one a deployment has, so an app that later points at a remote indexer
 * keeps its handler. Nothing here composes, coalesces, filters or re-orders,
 * nothing here produces a notification of its own, and nothing here computes a
 * progress figure -- a reader could not, since the **sync cursor** is opaque
 * behind the storage seam (ADR-0027), which is precisely why the side that knows
 * has to say.
 *
 * ## What it is FOR: a second window that is not a stale window
 *
 * A tab that is not doing the indexing has no host to ask and no fold to
 * subscribe to, so without this it either polls an interval it invented or shows
 * state that stopped moving. Told by the tab that IS indexing, it re-reads the
 * same store through the reader handle it already holds.
 *
 * ## WHICH tab indexes is not this, and is deliberately absent
 *
 * There is no election here, no lease, no heartbeat and no "who is publishing"
 * question, and nothing on the wire names the publisher. Electing one indexing
 * tab is `one-tab-indexes-and-the-others-read`, a rung above this, and half of it
 * built here would be a half the spec then had to adopt or unpick. Until it
 * exists, EVERY indexing tab publishes and EVERY tab listens, which is correct if
 * noisy: a second publisher is a second reason to re-read, and re-reading twice
 * is what re-reading once already was. The **writer token** is what makes that
 * safe rather than this adapter -- only one tab's fold can be writing the store
 * at all (ADR-0075).
 *
 * ## A tab does not hear ITSELF, and that is why this is one object
 *
 * `BroadcastChannel` never delivers a message back to the object that posted it,
 * so a tab that publishes and listens through THIS one is not told what it just
 * said. That matters in the ordinary shape: a tab hosting its own worker gets
 * every notification over its port already, and hearing the same one again off
 * the channel would be an avoidable duplicate. Holding one channel per tab
 * settles it structurally, with nothing identifying the publisher and nothing to
 * de-duplicate against -- which is the ONE thing a publisher identity would have
 * bought, and it is not worth being half an election for.
 *
 * Two ends in ONE tab (two separate calls) DO hear each other, which is right: a
 * tab may legitimately hold two, and what it must never do is silently drop a
 * notification because something in the same document published it.
 *
 * ## Best-effort, and nothing kept for anybody
 *
 * Nothing is buffered, replayed or acknowledged, and the producer holds nothing
 * per receiving tab -- the property every transport in ADR-0083 rests on. A tab
 * that missed a notification converges on the next one, because the coherence
 * token it carries is one the reader has not seen and says invalidate
 * everything. The limit that follows is stated rather than engineered around: a
 * lost notification on a chain that then goes quiet leaves a reader stale until
 * the next block moves.
 */
export function openStateMovedAcrossTabs(storage: CrossTabStateStorage = {}): StateMovedAcrossTabs {
	const channelName = stateMovedChannelName(storage);
	if (typeof BroadcastChannel === 'undefined') {
		throw new Error(
			`this runtime has no BroadcastChannel, so the state-moved signal and the fold's progress cannot cross between ` +
				`tabs here. A tab that holds a port to a host is told both over that port (\`IndexerPort.onStateMoved\`, ` +
				`\`IndexerPort.onProgress\`) and needs none of this; what is unavailable is only the cross-tab hop. Nothing ` +
				`here falls back on its own: a poll invented at this boundary would be the interval ADR-0083 exists to ` +
				`replace.`,
		);
	}

	const channel = new BroadcastChannel(channelName);
	/**
	 * WHO IS LISTENING FOR A NOTIFICATION in this tab, and deliberately NO "last
	 * notification another tab published" beside them.
	 *
	 * The absence is the same decision the port makes: a notification is a thing
	 * that HAPPENED, so handing a late listener the previous one would have it
	 * invalidate for a block it may already have read. The REPORT below is kept
	 * precisely because it is the other kind of thing -- a state, whose current
	 * value is what a late listener wants.
	 */
	const listeners = new Set<StateMovedHandler>();
	/** Who is listening for WHERE THE FOLD IS, which is a different question. */
	const progressListeners = new Set<(progress: HostProgress) => void>();
	/**
	 * THE LAST REPORT ANOTHER TAB PUBLISHED, which is what a listener attaching
	 * later is handed.
	 *
	 * Kept where the notification deliberately keeps nothing, and the difference is
	 * the port's own: progress is a STATE, so the current one is the right thing to
	 * hand a late listener, while a notification is a thing that HAPPENED and
	 * replaying one would have a reader invalidate for a block it may already have
	 * read. It is recorded whether or not anybody is listening, since the whole
	 * point is the listener that attaches afterwards.
	 */
	let lastHeard: HostProgress | undefined;
	/**
	 * THE LAST REPORT THIS TAB PUBLISHED, which is what an ask is answered with.
	 *
	 * ONE value, replaced wholesale, and deliberately not one per listening tab:
	 * nothing here grows with the number of tabs (ADR-0083). Only what this tab's
	 * OWN host said is re-posted -- a tab that merely HEARD a report does not gossip
	 * it onwards, because that would keep a dead indexer's last number alive on the
	 * channel long after the tab that made it went away.
	 */
	let lastPublished: HostProgress | undefined;
	let closed = false;

	/** Post, or say why not. A failure here is the CHANNEL being gone, which is a tab going away. */
	const post = (message: StateMovedMessage | ProgressMessage | ProgressAskMessage, what: string): void => {
		try {
			channel.postMessage(message);
		} catch (error) {
			namedLogger.error(`${what} could not be posted to the other tabs`, error);
		}
	};

	/** Hand one report to one listener, CONTAINED exactly as a notification is. */
	const tell = (listener: (progress: HostProgress) => void, progress: HostProgress): void => {
		try {
			listener(progress);
		} catch (error) {
			namedLogger.error(`a cross-tab onProgress listener threw`, error);
		}
	};

	channel.addEventListener('message', (event: MessageEvent) => {
		// HEARD, and only from a message that is OURS. A channel carries whatever
		// anybody on this origin posts to its name, and somebody else's traffic is not
		// a notification about this store.
		if (isStateMoved(event.data)) {
			if (listeners.size === 0) return;
			const moved = event.data.value;
			for (const listener of [...listeners]) {
				try {
					listener(moved);
				} catch (error) {
					// CONTAINED, exactly as the producer contains one: a listener is somebody
					// else's code, and letting it break delivery would make one reader's
					// correctness depend on another's.
					namedLogger.error(`a cross-tab onStateMoved listener threw`, error);
				}
			}
			return;
		}
		if (isProgress(event.data)) {
			const progress = event.data.value;
			// NO NEWS IS NOT DELIVERED, which is the rule the host follows on the port and
			// is what makes several tabs asking at once cost one render. Compared field by
			// field by the ONE function that decides what "the same report" means.
			if (lastHeard && sameProgress(lastHeard, progress)) return;
			lastHeard = progress;
			for (const listener of [...progressListeners]) tell(listener, progress);
			return;
		}
		if (isProgressAsk(event.data)) {
			// A TAB OPENED AND HAS NOTHING TO RENDER. Answered with what this tab's own
			// host last said, or not at all: an ask nobody can answer is silence and not a
			// failure, and every tab that hears the answer drops it as a repeat unless it
			// is news to that tab.
			if (closed || !lastPublished) return;
			post({protocol: STATE_MOVED_CHANNEL_PROTOCOL, kind: 'progress', value: lastPublished}, `the fold's progress`);
		}
	});

	return {
		channelName,
		publish(moved: StateMoved): void {
			if (closed) {
				// A TAB GOING AWAY, not a failure: the ordinary cause is a teardown that let
				// this go before the subscription feeding it. Noted so that a channel closed
				// by mistake is findable, and never raised at a fold that has already applied
				// its block.
				namedLogger.info(
					`this cross-tab state-moved channel is closed, so a notification about block ` +
						`${moved.kind === 'applied' ? moved.block : moved.forkPoint} was not posted to the other tabs.`,
				);
				return;
			}
			const message: StateMovedMessage = {
				protocol: STATE_MOVED_CHANNEL_PROTOCOL,
				kind: 'stateMoved',
				value: moved,
			};
			try {
				channel.postMessage(message);
			} catch (error) {
				// The signal is plain data by construction, so nothing a fold produces is
				// refused here. A failure is the CHANNEL being gone, which is a tab going
				// away -- reported, and never raised at a fold that has already applied its
				// block.
				namedLogger.error(`the state-moved signal could not be posted to the other tabs`, error);
			}
		},
		onStateMoved(listener: StateMovedHandler): StateMovedDetach {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		publishProgress(progress: HostProgress): void {
			if (closed) {
				// A TAB GOING AWAY, not a failure -- the same reading `publish` gives it, and
				// for the same reason: the ordinary cause is a teardown that let this go before
				// the port subscription feeding it.
				namedLogger.info(
					`this cross-tab state-moved channel is closed, so a report of a fold at block ` +
						`${progress.lastToBlock ?? 'nowhere yet'} was not posted to the other tabs.`,
				);
				return;
			}
			// HELD so a tab that opens later can ASK. By reference and replaced wholesale:
			// this is a view of the host's last report and never a second source of truth.
			lastPublished = progress;
			post({protocol: STATE_MOVED_CHANNEL_PROTOCOL, kind: 'progress', value: progress}, `the fold's progress`);
		},
		onProgress(listener: (progress: HostProgress) => void): () => void {
			progressListeners.add(listener);
			const held = lastHeard;
			if (held) {
				// ON A MICROTASK, so a listener is never called before the caller holds the
				// detach this returns -- and skipped if it let go in between.
				queueMicrotask(() => {
					if (progressListeners.has(listener)) tell(listener, held);
				});
			} else if (!closed) {
				// NOTHING TO RENDER AND NOTHING COMING: a host at the tip pushes nothing, so
				// this asks rather than waiting on a chain that may not move for hours.
				post({protocol: STATE_MOVED_CHANNEL_PROTOCOL, kind: 'progressAsk'}, `an ask for the fold's progress`);
			}
			return () => {
				progressListeners.delete(listener);
			};
		},
		close(): void {
			if (closed) return;
			closed = true;
			listeners.clear();
			progressListeners.clear();
			lastHeard = undefined;
			lastPublished = undefined;
			channel.close();
		},
	};
}
