import type {StateMoved, StateMovedDetach, StateMovedHandler} from '@etherfold/core';
import {DEFAULT_DATABASE_NAME} from '@etherfold/state-store-indexeddb';
import {logs} from 'named-logs';

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
 * THIS TAB'S END OF THE CROSS-TAB SIGNAL: what it says to the other tabs, and
 * what it is told by them.
 *
 * ONE object for both directions deliberately -- see `openStateMovedAcrossTabs`
 * on why that is what keeps a tab from hearing itself.
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
 *
 * // and, in a tab that holds a host, forward what that host tells it
 * indexer.onStateMoved(tabs.publish);
 * ```
 *
 * ## It is an ADAPTER and not a second semantics
 *
 * What is posted is the value the fold published, and a tab that receives it does
 * exactly what a tab receiving it over a port does. That is the claim ADR-0083
 * makes about every transport (`MessagePort`, `BroadcastChannel`, a server's
 * stream): the same notion, delivered over whichever one a deployment has, so an
 * app that later points at a remote indexer keeps its handler. Nothing here
 * composes, coalesces, filters or re-orders, and nothing here produces a
 * notification of its own.
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
			`this runtime has no BroadcastChannel, so the state-moved signal cannot cross between tabs here. ` +
				`A tab that holds a port to a host is told over that port (\`IndexerPort.onStateMoved\`) and needs none of ` +
				`this; what is unavailable is only the cross-tab hop. Nothing here falls back on its own: a poll invented ` +
				`at this boundary would be the interval ADR-0083 exists to replace.`,
		);
	}

	const channel = new BroadcastChannel(channelName);
	/**
	 * WHO IS LISTENING in this tab, and deliberately NO "last thing another tab
	 * said" beside them.
	 *
	 * The absence is the same decision the port makes: a notification is a thing
	 * that HAPPENED, so handing a late listener the previous one would have it
	 * invalidate for a block it may already have read.
	 */
	const listeners = new Set<StateMovedHandler>();
	let closed = false;

	channel.addEventListener('message', (event: MessageEvent) => {
		// HEARD, and only from a message that is OURS. A channel carries whatever
		// anybody on this origin posts to its name, and somebody else's traffic is not
		// a notification about this store.
		if (listeners.size === 0 || !isStateMoved(event.data)) return;
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
		close(): void {
			if (closed) return;
			closed = true;
			listeners.clear();
			channel.close();
		},
	};
}
