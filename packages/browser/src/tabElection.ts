import type {Abi, GenerationContext, IndexingSource, ProvidedIndexerConfig} from '@etherfold/core';
import {resolveStreamConfig, streamDigestOf} from '@etherfold/core';
import type {StateStore} from '@etherfold/state-store';
import {logs} from 'named-logs';
import type {HostProgress} from './host/envelope.js';
import {arriveFromBundle, type InstantiatedProcessorBundle, type ProcessorBundleSource} from './processorBundle.js';

const namedLogger = logs('@etherfold/browser');

/**
 * ## ONE TAB INDEXES AND THE OTHERS READ (ADR-0097)
 *
 * Every tab of an app used to build its own indexer: they all fetched the chain,
 * the newest writer claim won (ADR-0075, ADR-0077) and the older tabs demoted to
 * readers (ADR-0078). Correct, and N times the RPC calls. This module is the
 * agreement about WHO does the work, and it is deliberately only that: the writer
 * claim underneath stays the correctness guarantee, so an election that fails
 * (two tabs both believing they lead, a runtime without the primitive) costs RPC
 * calls and never a wrong answer.
 *
 * The mechanism is ONE Web Lock (`navigator.locks`) per APP, named by the app
 * (D1): acquisition is atomic and the browser releases the lock when the holder's
 * tab or worker dies, so there is no heartbeat, no stale threshold and no timeout
 * to tune. The tab that holds it indexes; every other tab is built from the
 * app's READER FACTORY (`BrowserGenerationSpec.openState`, D2), follows the
 * state-moved signal and the leader's progress over a `BroadcastChannel`, and
 * queues for the lock. When the browser releases it, the next tab in the queue
 * becomes the writer through ADR-0078's recovery path: a fresh start through
 * `createState`, taking the claim, indexing forward from the stored cursor.
 *
 * A lock alone cannot tell a throttled or frozen leader from a busy one, so the
 * FOREGROUND TAKEOVER (D4 as amended) adds the one thing it lacks: a leader
 * publishes its tab's visibility beside its progress, and a reader whose tab has
 * stayed visible past a settle time while the leader is hidden (or silent) takes
 * the lock with `steal`. The leader it displaced learns it from its own rejected
 * lock request, stops, and reads.
 */

/**
 * THE ELECTION AN APP OPTS INTO: the name of the one lock its tabs contend for.
 *
 * Named by the APP, exactly as a SharedWorker's `name` is, and not derived from a
 * store's storage identity: the election decides which TAB indexes, and one host
 * holds several generations with a store each, so a lock per store would have one
 * tab holding the canonical generation's lock and not its successor's. Two apps on
 * one origin supply two names and never contend.
 *
 * The election is ON only when the app supplies this AND a reader factory
 * (`openState`), and only where `navigator.locks` exists. Anywhere else a host
 * behaves exactly as it did before this existed (D3).
 */
export type TabElection = {
	/** The app's election name. Tabs that give the same name elect ONE indexing tab among themselves. */
	readonly name: string;
	/**
	 * A VISIBLE TAB TAKES THE LEASE FROM A BACKGROUNDED LEADER (ADR-0097, D4 as
	 * amended). ON by default whenever the election is on; `false` keeps the first
	 * cut's behaviour, where the tab that indexes keeps the lock until it closes.
	 *
	 * A browser throttles a tab nobody is looking at and freezes one hidden for
	 * long, and the lock does not notice: without this, the tab the user IS looking
	 * at is a reader whose data falls behind a leader that indexes slowly or not at
	 * all. With it, a READER whose tab has stayed visible for `settleMs` while the
	 * leader is hidden (or has never been heard, which is what a FROZEN leader
	 * looks like) takes the lock with `steal`, and the leader it displaced stops,
	 * abandons its in-flight batch and goes back to reading. A visible leader is
	 * never displaced, and a quick switch between tabs moves nothing.
	 */
	readonly foregroundTakeover?: boolean | ForegroundTakeover;
};

/** How a visible tab takes the lease from a backgrounded leader. See `TabElection.foregroundTakeover`. */
export type ForegroundTakeover = {
	/**
	 * HOW LONG the handover condition (this tab visible, the leader hidden or
	 * unheard) must have held without a break before this tab takes the lease, in
	 * milliseconds. Defaults to `DEFAULT_FOREGROUND_SETTLE_MS`.
	 */
	readonly settleMs?: number;
};

/**
 * THE SETTLE TIME, two seconds: longer than a sweep across tabs with the keyboard
 * or the mouse (a tab passed over for a few hundred milliseconds must not pull the
 * lease), and short beside what it fixes, since a hidden tab's timers are clamped
 * to once a second or once a minute and a tab hidden for minutes is frozen. It is
 * also the bound on displacing a FROZEN leader, which never answers.
 */
export const DEFAULT_FOREGROUND_SETTLE_MS = 2000;

/** Whether a host's tab is on screen: `document.visibilityState`, reduced to the two states that decide anything. */
export type TabVisibility = 'visible' | 'hidden';

/**
 * WHY a host became the writer after waiting behind another tab: the holder went
 * away (closed, crashed, killed, or gave the lock back), or it was BACKGROUNDED
 * and this visible tab took the lease from it.
 */
export type TakeoverReason = 'leader-gone' | 'leader-backgrounded';

/** WHICH seat this host holds: waiting for the lock and reading, or holding it and writing. */
export type TabElectionRole = 'reader' | 'writer';

/**
 * WHAT THE ELECTION HAS MADE OF THIS HOST, reported beside the progress an app
 * already renders (`HostProgress.election` on a port, `SyncingState.election` on
 * the main-thread hook).
 *
 * ABSENT where the election is off, so an app that never opted in sees nothing new.
 */
export type TabElectionState = {
	/** The election this host stood in (`TabElection.name`). */
	readonly name: string;
	/**
	 * `reader` while another tab holds the lock: this host fetches nothing, claims
	 * nothing, answers reads from the shared store and reports the LEADER's
	 * progress. `writer` once it holds the lock and indexes.
	 */
	readonly role: TabElectionRole;
	/**
	 * Whether this host TOOK OVER: it became the writer after having waited behind
	 * another tab that held the lock (which closed, crashed or was killed). `false`
	 * for a host that found the lock free and led from the start.
	 */
	readonly tookOver: boolean;
	/** WHY this host took over, present exactly when `tookOver` is. */
	readonly takeoverReason?: TakeoverReason;
	/**
	 * `true` on a READER that was the writer until a visible tab took the lease from
	 * it (`foregroundTakeover`): it stopped, abandoned its in-flight batch, and reads.
	 */
	readonly displaced?: boolean;
	/**
	 * WHAT THIS HOST KNOWS OF ITS TAB'S VISIBILITY, which a leader publishes so a
	 * visible reader can tell whether to take the lease. ABSENT where the host does
	 * not take part in the foreground takeover (turned off, a SharedWorker host, or
	 * a worker no tab has reported to), and a leader that publishes none is never
	 * displaced.
	 */
	readonly visibility?: TabVisibility;
};

/**
 * WHAT A TAB THAT DOES NOT HOLD THE LOCK IS BUILT FROM (D2): the shared store,
 * opened for READING, and the read handle over it.
 *
 * `store` is what a port's reads answer from; `state` is what the main-thread
 * hook publishes on `state`, the same kind of handle a processor's `state` is
 * (`new EntityStateView(store)` for an entity processor). No claim is taken, no
 * processor is built and nothing is fetched, so a reader cannot demote the tab
 * that is writing.
 */
export type ReaderState<ProcessResultType> = {
	readonly store: StateStore;
	readonly state: ProcessResultType;
};

/** The prefix every name this module composes wears, so it cannot collide with an app's own. */
export const TAB_ELECTION_PROTOCOL = 'etherfold/tab-election';

/**
 * THE LOCK (and the channel) AN ELECTION IS HELD ON, composed from the app's name
 * and nothing else. A lock name and a `BroadcastChannel` name live in two
 * different namespaces, so one string serves both.
 */
export function tabElectionName(election: TabElection): string {
	return `${TAB_ELECTION_PROTOCOL}/${election.name}`;
}

/** The part of `LockManager` this module uses, typed here so a runtime without it is a value and not a type error. */
type Locks = {
	request(
		name: string,
		options: {ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal},
		callback: (lock: unknown) => Promise<unknown> | unknown,
	): Promise<unknown>;
};

function locksHere(): Locks | undefined {
	const locks = (globalThis as {navigator?: {locks?: Locks}}).navigator?.locks;
	return locks && typeof locks.request === 'function' ? locks : undefined;
}

/**
 * WHETHER THE ELECTION RUNS for a host configured this way: a name, a reader
 * factory, and `navigator.locks` in the scope the host runs in. Anything short of
 * all three is today's behaviour (D3), and a runtime without the primitive is
 * said once in the log rather than refused: the election is an optimisation.
 */
export function electionFor(election: TabElection | undefined, hasReaderFactory: boolean): TabElection | undefined {
	if (!election || !hasReaderFactory) return undefined;
	if (!locksHere()) {
		namedLogger.info(
			`tab election "${election.name}" is OFF: this runtime has no navigator.locks, so this host indexes as every ` +
				`tab did before the election existed. The writer claim keeps the store correct either way.`,
		);
		return undefined;
	}
	return election;
}

/** A HOST'S PLACE IN THE ELECTION: whether it won at once, and how to leave. */
export type Candidacy = {
	/**
	 * `true` when the lock was FREE and this host holds it from the start (it then
	 * behaves exactly as a host with no election); `false` when another tab holds it
	 * and this host is queued as a reader.
	 */
	readonly atOnce: Promise<boolean>;
	/** Whether this host holds the lock right now. */
	readonly holding: boolean;
	/**
	 * TAKE THE LEASE FROM A BACKGROUNDED LEADER: leave the queue and ask for the lock
	 * with `steal`, which the browser grants at once, releasing it from its holder.
	 * `onTakeover('leader-backgrounded')` follows. A no-op while holding or resigned,
	 * or while a steal is already under way.
	 */
	takeFromBackgroundedLeader(): void;
	/** Leave the election: give the lock back if held, leave the queue if waiting. Idempotent. */
	resign(): void;
};

/** What a candidacy tells its host. */
export type CandidacyEvents = {
	/**
	 * A QUEUED host was granted the lock: the previous holder went away
	 * (`leader-gone`), or this host stole it from a backgrounded one
	 * (`leader-backgrounded`).
	 */
	onTakeover(reason: TakeoverReason): void;
	/**
	 * THE LOCK WAS TAKEN FROM THIS HOST by a visible tab (`steal`). The host must
	 * stop writing and read; the candidacy has already queued for the lock again, so
	 * this host takes over once more when the tab that took it goes away.
	 */
	onDisplaced?(): void;
};

/**
 * STAND FOR ELECTION: ask for the lock at once, and queue for it if it is held.
 *
 * `onTakeover` is called when a QUEUED host is granted the lock, which is the
 * browser saying the previous holder's tab or worker is gone, or when this host
 * took it from a backgrounded leader. The lock is then held until `resign()`, the
 * death of this scope, or a STEAL by a visible tab (`onDisplaced`), which is what
 * makes a crash a handover rather than a stall: nothing here beats or expires.
 *
 * `steal` is used by exactly one caller, `takeFromBackgroundedLeader`, and only
 * once the tab asking has stayed visible past the settle time while the leader is
 * hidden or silent (ADR-0097, D4 as amended). A FROZEN leader cannot answer
 * anything, which is why the lease is taken rather than asked for; the writer
 * claim is what keeps a leader that thaws mid-write from corrupting the store.
 */
export function standForElection(election: TabElection, events: CandidacyEvents): Candidacy {
	const locks = locksHere();
	if (!locks) throw new Error(`standForElection needs navigator.locks; check electionFor first.`);
	const name = tabElectionName(election);
	/** Resolves the tenure this host holds now, which ends it (the callback returns and the lock is given back). */
	let giveBack: (() => void) | undefined;
	/** The queued request, aborted to leave the queue (a resign, or before a steal). */
	let queued: AbortController | undefined;
	let resigned = false;
	let holding = false;
	let stealing = false;
	let answer!: (atOnce: boolean) => void;
	const atOnce = new Promise<boolean>((resolve) => {
		answer = resolve;
	});

	/** HOLD the lock until given back: the body of every granted request. */
	function hold(): Promise<void> {
		holding = true;
		return new Promise<void>((resolve) => {
			giveBack = resolve;
		});
	}

	/**
	 * A REQUEST THAT WAS GRANTED HAS SETTLED. Resolved: this host gave the lock back
	 * (a resign). Rejected with an `AbortError` while holding: a visible tab STOLE
	 * it, so this host is told, and queues again.
	 */
	function tenureEnded(granted: Promise<unknown>, tenure: () => boolean): void {
		granted.then(
			() => undefined,
			(error) => {
				if (!tenure() || resigned) return;
				holding = false;
				giveBack = undefined;
				if ((error as Error | undefined)?.name !== 'AbortError') {
					namedLogger.error(`the tab election lost its lock`, error);
				}
				try {
					events.onDisplaced?.();
				} catch (displacing) {
					namedLogger.error(`stepping down as the indexing tab failed`, displacing);
				}
				queue();
			},
		);
	}

	function takeOver(reason: TakeoverReason): void {
		try {
			events.onTakeover(reason);
		} catch (error) {
			namedLogger.error(`taking over as the indexing tab failed`, error);
		}
	}

	function queue(): void {
		if (resigned) return;
		const leaving = new AbortController();
		queued = leaving;
		let mine = false;
		const request = locks!.request(name, {signal: leaving.signal}, async () => {
			if (resigned || queued !== leaving) return;
			queued = undefined;
			mine = true;
			const held = hold();
			takeOver('leader-gone');
			await held;
		});
		// An abort while queued is `resign()` or a steal doing its job, and is swallowed.
		request.catch(() => undefined);
		tenureEnded(request, () => mine);
	}

	locks
		.request(name, {ifAvailable: true}, async (lock) => {
			if (!lock || resigned) {
				answer(false);
				return;
			}
			const held = hold();
			answer(true);
			await held;
		})
		.then(
			() => {
				if (!holding) queue();
			},
			(error) => {
				// Stolen from the tab that found it free, or a failure to ask at all.
				if (holding && !resigned) {
					holding = false;
					giveBack = undefined;
					try {
						events.onDisplaced?.();
					} catch (displacing) {
						namedLogger.error(`stepping down as the indexing tab failed`, displacing);
					}
					queue();
					return;
				}
				namedLogger.error(`the tab election could not ask for its lock`, error);
				answer(false);
			},
		);

	return {
		atOnce,
		get holding() {
			return holding;
		},
		takeFromBackgroundedLeader() {
			if (resigned || holding || stealing) return;
			stealing = true;
			queued?.abort();
			queued = undefined;
			let mine = false;
			const request = locks!.request(name, {steal: true}, async () => {
				stealing = false;
				if (resigned) return;
				mine = true;
				const held = hold();
				namedLogger.info(`this tab took the lease of election "${election.name}" from a backgrounded leader`);
				takeOver('leader-backgrounded');
				await held;
			});
			request.catch(() => {
				stealing = false;
			});
			tenureEnded(request, () => mine);
		},
		resign() {
			if (resigned) return;
			resigned = true;
			queued?.abort();
			queued = undefined;
			holding = false;
			giveBack?.();
			giveBack = undefined;
			answer(false);
		},
	};
}

/** The settle time a host runs with, or `undefined` where the foreground takeover is off. */
export function foregroundTakeoverOf(election: TabElection | undefined): {readonly settleMs: number} | undefined {
	if (!election || election.foregroundTakeover === false) return undefined;
	const settleMs = typeof election.foregroundTakeover === 'object' ? election.foregroundTakeover.settleMs : undefined;
	return {settleMs: settleMs ?? DEFAULT_FOREGROUND_SETTLE_MS};
}

/**
 * MAY A VISIBLE READER TAKE THE LEASE from the leader it last heard from?
 *
 * Yes when the leader said it is HIDDEN, and yes when it has said NOTHING: a
 * reader asks for the leader's progress as it is seated, a live leader answers at
 * once, and a frozen one cannot, so silence past the settle time is what a frozen
 * leader looks like. No when it said it is visible, and no when it publishes no
 * visibility at all (a leader that does not take part: turned off, a SharedWorker
 * host), which is what keeps the opt-out exactly the first cut's behaviour.
 */
export function leaderIsDisplaceable(leader: HostProgress | undefined): boolean {
	if (!leader) return true;
	return leader.election?.visibility === 'hidden';
}

/**
 * THE SETTLE TIMER: take the lease once `eligible()` has held, without a break,
 * for `settleMs`. A host calls `reconsider()` whenever anything `eligible` reads
 * changed (its own visibility, a report from the leader, its seat).
 */
export function watchForBackgroundedLeader(options: {readonly settleMs: number; eligible(): boolean; take(): void}): {
	reconsider(): void;
	stop(): void;
} {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	const disarm = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};
	return {
		reconsider() {
			if (stopped) return;
			if (!options.eligible()) {
				disarm();
				return;
			}
			if (timer !== undefined) return;
			timer = setTimeout(() => {
				timer = undefined;
				if (!stopped && options.eligible()) options.take();
			}, options.settleMs);
		},
		stop() {
			stopped = true;
			disarm();
		},
	};
}

/** The part of `Document` the main-thread host reads its visibility from. */
type VisibilityDocument = {
	readonly visibilityState?: string;
	addEventListener(type: 'visibilitychange', listener: () => void): void;
	removeEventListener(type: 'visibilitychange', listener: () => void): void;
};

/**
 * FOLLOW THIS DOCUMENT'S VISIBILITY, where there is a document: the current value
 * at once, then every `visibilitychange`. Returns the detach, or `undefined` in a
 * scope with no document (a worker), whose visibility is its tab's to report.
 */
export function followDocumentVisibility(onChange: (visibility: TabVisibility) => void): (() => void) | undefined {
	const document = (globalThis as {document?: VisibilityDocument}).document;
	if (!document || typeof document.addEventListener !== 'function') return undefined;
	const read = (): TabVisibility => (document.visibilityState === 'hidden' ? 'hidden' : 'visible');
	const listener = () => onChange(read());
	document.addEventListener('visibilitychange', listener);
	onChange(read());
	return () => document.removeEventListener('visibilitychange', listener);
}

/**
 * WHAT A LEADER PUBLISHES BEFORE IT HAS A FOLD TO REPORT: its seat and nothing
 * else, the moment it holds the lock, so a visible reader hears that a leader
 * exists (and whether it is visible) during the leader's fresh start rather than
 * mistaking the silence for a frozen tab.
 */
export function leaderAnnouncement(
	own: {readonly host: HostProgress['host']; readonly scope: string},
	election: TabElectionState,
): HostProgress {
	return {host: own.host, scope: own.scope, indexing: false, phase: 'waiting', election};
}

/**
 * THE CONTEXT A READER OPENS ITS STATE FOR: the same `{stream}` the container
 * hands `createState`, computed the same way (`streamDigestOf` over the resolved
 * stream config), so a reader and the writer address the same storage.
 */
export function readerContextOf<ABI extends Abi>(
	source: IndexingSource<ABI>,
	config: ProvidedIndexerConfig<ABI> | undefined,
): GenerationContext {
	return {stream: streamDigestOf(source, resolveStreamConfig(config?.stream))};
}

/**
 * BUILD THE READER: the bundle first where the spec runs one (so the store is
 * declared from the entities the bundle declares), then the app's `openState`.
 */
export async function openReader<ProcessResultType>(
	openState: (
		context: GenerationContext,
		bundle?: InstantiatedProcessorBundle,
	) => ReaderState<ProcessResultType> | Promise<ReaderState<ProcessResultType>>,
	context: GenerationContext,
	processorBundle: ProcessorBundleSource | undefined,
): Promise<ReaderState<ProcessResultType>> {
	const bundle = processorBundle ? await arriveFromBundle(processorBundle) : undefined;
	return openState(context, bundle);
}

/**
 * WHAT A READER REPORTS: its own `host`, `scope` and driver flag, the LEADER's
 * phase and block figures (a leader publishes; it is not polled), and its seat.
 *
 * Only the figures a progress bar binds cross from the leader. The leader's
 * `failure`, `publication`, `streamSeed` and `hotUpdate` describe the LEADER's
 * host and would read, on a reader's port, as things that happened to it.
 * Before the leader has been heard, the phase is `waiting` and no figure is
 * given, which is the honest report of a tab that knows nothing yet.
 */
export function readerProgress(
	own: {readonly host: HostProgress['host']; readonly scope: string; readonly indexing: boolean},
	leader: HostProgress | undefined,
	election: TabElectionState,
): HostProgress {
	return {
		host: own.host,
		scope: own.scope,
		indexing: own.indexing,
		phase: leader?.phase ?? 'waiting',
		...(leader?.lastToBlock !== undefined ? {lastToBlock: leader.lastToBlock} : {}),
		...(leader?.latestBlock !== undefined ? {latestBlock: leader.latestBlock} : {}),
		...(leader?.blocksBehindTip !== undefined ? {blocksBehindTip: leader.blocksBehindTip} : {}),
		...(leader?.numBlocksProcessedSoFar !== undefined ? {numBlocksProcessedSoFar: leader.numBlocksProcessedSoFar} : {}),
		...(leader?.syncPercentage !== undefined ? {syncPercentage: leader.syncPercentage} : {}),
		election,
	};
}
