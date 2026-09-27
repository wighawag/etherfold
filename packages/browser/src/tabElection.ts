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
};

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
		options: {ifAvailable?: boolean; signal?: AbortSignal},
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
	/** Leave the election: give the lock back if held, leave the queue if waiting. Idempotent. */
	resign(): void;
};

/**
 * STAND FOR ELECTION: ask for the lock at once, and queue for it if it is held.
 *
 * `onTakeover` is called when a QUEUED host is granted the lock, which is the
 * browser saying the previous holder's tab or worker is gone. The lock is then
 * held until `resign()` or the death of this scope, which is what makes a crash a
 * handover rather than a stall: nothing here beats, expires or times out.
 *
 * Nothing is stolen (`steal` is never used): a foreground tab taking the lease
 * from a backgrounded one is deliberately out of this first cut (D4).
 */
export function standForElection(election: TabElection, onTakeover: () => void): Candidacy {
	const locks = locksHere();
	if (!locks) throw new Error(`standForElection needs navigator.locks; check electionFor first.`);
	const name = tabElectionName(election);
	const leaving = new AbortController();
	let giveBack!: () => void;
	const held = new Promise<void>((resolve) => {
		giveBack = resolve;
	});
	let resigned = false;
	let answer!: (atOnce: boolean) => void;
	const atOnce = new Promise<boolean>((resolve) => {
		answer = resolve;
	});
	let elected = false;

	const queue = () => {
		if (resigned) return;
		locks
			.request(name, {signal: leaving.signal}, async () => {
				if (resigned) return;
				elected = true;
				try {
					onTakeover();
				} catch (error) {
					namedLogger.error(`taking over as the indexing tab failed`, error);
				}
				await held;
			})
			// An abort while queued is `resign()` doing its job.
			.catch(() => undefined);
	};

	locks
		.request(name, {ifAvailable: true}, async (lock) => {
			if (!lock || resigned) {
				answer(false);
				return;
			}
			elected = true;
			answer(true);
			await held;
		})
		.then(
			() => {
				if (!elected) queue();
			},
			(error) => {
				namedLogger.error(`the tab election could not ask for its lock`, error);
				answer(false);
			},
		);

	return {
		atOnce,
		resign() {
			if (resigned) return;
			resigned = true;
			leaving.abort();
			giveBack();
			answer(false);
		},
	};
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
