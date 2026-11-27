import type {RemoteSQL} from 'remote-sql';
import {createConsumer, type Consumer, type Gate, type Lane} from './consumer.js';
import {
	assertActionsFitLane,
	createDeliverer,
	type ActionAdapter,
	type Deliverer,
	type DeliveryReport,
} from './delivery.js';
import type {CanonicalFeed} from './feed.js';
import {journalStatement} from './journal.js';
import {createLease, LeaseLostError, type Lease} from './lease.js';
import {createRegistrationAPI, type RegistrationVerifier} from './registration.js';
import {callTimeoutOf} from './timeout.js';
import {createTriggerRegistry, defineTriggers, type TriggerDefinitions, type TriggerRegistry} from './triggers.js';

// ---------------------------------------------------------------------------
// THE TRIGGER SERVICE, composed for ONE app: one consumer over one named
// indexer, its trigger registry, its deliverer, and (when a verifier is given)
// the registration API. Each of them is keyed by the app (etherfold ADR-0101),
// so several services, one per app, may share one database. A platform (the nodejs CLI) adds a database, a gate and a
// server around it; nothing here opens a port or reads the environment.
// ---------------------------------------------------------------------------

export type TriggerServiceOptions = {
	db: RemoteSQL;
	/**
	 * The APP this service serves, an operator-chosen slug (etherfold ADR-0101):
	 * its consumer's name, and the key of every row it writes and every query it
	 * makes, so apps sharing a database never cross.
	 */
	app: string;
	chainId: string;
	feed: CanonicalFeed;
	gate: Gate;
	definitions: TriggerDefinitions;
	actions: Record<string, ActionAdapter>;
	/** Without one, nobody can register: only global rules fire. */
	verifier?: RegistrationVerifier;
	lane?: Lane;
	limit?: number;
	maxSubscriptionsPerRecipient?: number;
	clock?: () => number;
	/**
	 * The bound, in ms, on EACH call the core makes to the outside (etherfold
	 * ADR-0101): the gate, each feed read, each predicate invocation (with the
	 * state reads it makes) and each delivery; 10 s when absent. Each gets a
	 * `signal` that aborts at it, and the core gives up then whether or not the
	 * callee honours it: a timed-out gate, feed read or predicate fails the round
	 * as a stall (`gate-timeout`, `feed-timeout`, `predicate-timeout`), a
	 * timed-out delivery is retried like a `5xx`.
	 */
	callTimeoutMs?: number;
	/**
	 * How long the app's lease lasts, in ms (etherfold ADR-0101): 60 s when
	 * absent. A tick works only under it, renews it under half of it, and starts
	 * no call with less than the fence margin left (the per-call timeout plus
	 * 5 s for the commit and 5 s for clock skew), which must be under half the
	 * lease: a service whose timeout does not fit is refused, naming both.
	 */
	leaseMs?: number;
	/**
	 * The most pages of the feed ONE round reads (etherfold ADR-0101): 100 when
	 * absent. A round that reaches it returns normally with `hasMore` set and is
	 * not a stall; the next round goes on from there, and `run` starts it at once.
	 */
	maxPagesPerRound?: number;
	/**
	 * The most due deliveries ONE round takes, oldest first (the deliverer's
	 * batch, etherfold ADR-0101): 100 when absent. The rest wait for the next
	 * round, so one app's backlog bounds its own round and nobody else's.
	 */
	maxDeliveriesPerRound?: number;
};

/** The default bound on a round's feed pages, and on its deliveries. */
export const DEFAULT_MAX_PAGES_PER_ROUND = 100;
export const DEFAULT_MAX_DELIVERIES_PER_ROUND = 100;

/** What a round did, under the lease. */
export type RoundReport = {
	expired: number;
	consumed: number;
	matched: number;
	paused: boolean;
	/** The round stopped at `maxPagesPerRound` with more of the feed below the gate. */
	hasMore: boolean;
	delivery: DeliveryReport;
};

/**
 * One tick (etherfold ADR-0101): a round under the app's lease (`held`); nothing
 * at all because another ticker holds it (`not-leased`); or a round stopped at
 * a fence (`lost`) because the lease was taken, or too little of it was left to
 * start the next call, what it committed before staying committed.
 */
export type TickReport =
	| ({lease: 'held'} & RoundReport)
	| {lease: 'not-leased'}
	| {
			lease: 'lost';
			reason: string;
			/** The feed's failure earlier in the same round, when there was one. */
			followFailure?: {error: string; code?: string};
	  };

export type TriggerService = {
	/** The app it serves: what an operator read of the outbox or the journal is scoped to. */
	app: string;
	consumer: Consumer;
	registry: TriggerRegistry;
	deliverer: Deliverer;
	/**
	 * The app's lease, as this service holds it (etherfold ADR-0101). A one-shot
	 * host calls `lease.release()` after its tick, so the next ticker need not
	 * wait for it to lapse; `run` releases it when its signal aborts.
	 */
	lease: Lease;
	/** The registration API (a Hono app), when a verifier was given. */
	api: ReturnType<typeof createRegistrationAPI> | undefined;
	setup(): Promise<void>;
	/**
	 * One round, under the app's lease: expire what is due, follow the feed to
	 * the gate (at most `maxPagesPerRound` pages), attempt what is due (at most
	 * `maxDeliveriesPerRound`). Without the lease, nothing (`not-leased`).
	 */
	tick(): Promise<TickReport>;
	/**
	 * Tick until the signal aborts, waiting `intervalMs` between rounds, except
	 * after a round that stopped at its page bound (`hasMore`), whose next round
	 * starts at once; a failed round is reported and retried. Releases the lease
	 * once the signal aborts (a graceful stop).
	 */
	run(options: {signal?: AbortSignal; intervalMs?: number; onError?: (error: unknown) => void}): Promise<void>;
};

export function createTriggerService(options: TriggerServiceOptions): TriggerService {
	const lane = options.lane ?? 'safe';
	const definitions = defineTriggers(options.definitions);
	assertActionsFitLane(definitions, options.actions, lane);
	const clock = options.clock ?? Date.now;
	const callTimeoutMs = callTimeoutOf(options.callTimeoutMs);
	const maxPagesPerRound = positiveInteger('maxPagesPerRound', options.maxPagesPerRound, DEFAULT_MAX_PAGES_PER_ROUND);
	const maxDeliveriesPerRound = positiveInteger(
		'maxDeliveriesPerRound',
		options.maxDeliveriesPerRound,
		DEFAULT_MAX_DELIVERIES_PER_ROUND,
	);

	const {app} = options;
	// first, so a timeout too long for the lease is refused before anything else is built
	const lease = createLease({
		db: options.db,
		app,
		clock,
		callTimeoutMs,
		...(options.leaseMs === undefined ? {} : {durationMs: options.leaseMs}),
	});
	const registry = createTriggerRegistry({
		db: options.db,
		app,
		definitions,
		clock,
		...(options.maxSubscriptionsPerRecipient === undefined
			? {}
			: {maxSubscriptionsPerRecipient: options.maxSubscriptionsPerRecipient}),
	});
	const consumer = createConsumer({
		db: options.db,
		app,
		chainId: options.chainId,
		feed: options.feed,
		gate: options.gate,
		match: registry.matcher({callTimeoutMs, fence: () => lease.fence()}),
		lane,
		clock,
		callTimeoutMs,
		lease,
		...(options.limit === undefined ? {} : {limit: options.limit}),
	});
	const deliverer = createDeliverer({
		db: options.db,
		app,
		actions: options.actions,
		clock,
		callTimeoutMs,
		batchSize: maxDeliveriesPerRound,
		lease,
	});
	const api = options.verifier ? createRegistrationAPI({registry, verifier: options.verifier}) : undefined;

	// The failure the journal last recorded, so a consumer held at one page journals it once
	// rather than every round; in memory, so a restart records it once more.
	let stalledOn: string | undefined;

	/** Journal a failure to follow the feed when it differs from the last one, and the recovery. */
	async function recordFollowing(failure: unknown): Promise<void> {
		if (failure === undefined) {
			if (stalledOn === undefined) return;
			stalledOn = undefined;
			await options.db.batch([journalStatement(options.db, app, clock(), 'recovered', {}, lease.guard())]);
			return;
		}
		const error = failure instanceof Error ? failure.message : String(failure);
		const code = (failure as {code?: unknown} | undefined)?.code;
		const signature = `${typeof code === 'string' ? code : ''}:${error}`;
		if (signature === stalledOn) return;
		stalledOn = signature;
		await options.db.batch([
			journalStatement(
				options.db,
				app,
				clock(),
				'stalled',
				{
					error,
					...(typeof code === 'string' ? {code} : {}),
				},
				lease.guard(),
			),
		]);
	}

	async function tick(): Promise<TickReport> {
		// another ticker holds the lease: no expiry, no feed, no delivery
		if (!(await lease.acquire())) return {lease: 'not-leased'};
		try {
			return {lease: 'held', ...(await round())};
		} catch (error) {
			if (error instanceof LeaseLostError) {
				return {
					lease: 'lost',
					reason: error.message,
					...(error.followFailure ? {followFailure: error.followFailure} : {}),
				};
			}
			throw error;
		}
	}

	async function round(): Promise<RoundReport> {
		const expired = await registry.expire({lease});
		// a feed that is down must not hold back what is already in the outbox: deliver either way,
		// then report the feed's failure
		let followed: Awaited<ReturnType<Consumer['catchUp']>> | undefined;
		let failure: unknown;
		try {
			followed = await consumer.catchUp({maxPages: maxPagesPerRound});
		} catch (error) {
			// a round that lost its lease stops: the next ticker delivers
			if (error instanceof LeaseLostError) throw error;
			failure = error;
		}
		// a consumer that cannot follow (a feed down, a predicate whose read keeps failing) halts at
		// its page rather than dropping it; the journal says so, for an operator after the fact, while
		// the lease is still held (a delivery that then loses it must not swallow the failure)
		await recordFollowing(followed ? undefined : failure);
		let delivery: DeliveryReport;
		try {
			delivery = await deliverer.deliverDue();
		} catch (error) {
			if (error instanceof LeaseLostError && !followed) {
				const code = (failure as {code?: unknown} | undefined)?.code;
				throw new LeaseLostError(error.message, {
					error: failure instanceof Error ? failure.message : String(failure),
					...(typeof code === 'string' ? {code} : {}),
				});
			}
			throw error;
		}
		if (!followed) throw failure;
		return {
			expired,
			consumed: followed.entries,
			matched: followed.deliveries,
			paused: followed.last.kind === 'paused',
			hasMore: followed.hasMore,
			delivery,
		};
	}

	return {
		app,
		consumer,
		registry,
		deliverer,
		lease,
		api,
		setup: () => registry.setup(),
		tick,
		async run({
			signal,
			intervalMs = 5000,
			onError = (error) => console.error('trigger service: a round failed', error),
		}) {
			while (!signal?.aborted) {
				let hasMore = false;
				try {
					const report = await tick();
					hasMore = report.lease === 'held' && report.hasMore;
				} catch (error) {
					onError(error);
				}
				// a round that stopped at its page bound goes on at once (a timer of 0 still yields)
				const wait = hasMore ? 0 : intervalMs;
				await new Promise<void>((resolve) => {
					// the listener goes with the wait, so rounds in quick succession do not pile them up
					const onAbort = () => (clearTimeout(timer), resolve());
					const timer = setTimeout(() => (signal?.removeEventListener('abort', onAbort), resolve()), wait);
					signal?.addEventListener('abort', onAbort, {once: true});
				});
			}
			// a graceful stop: the next ticker need not wait for the lease to lapse
			try {
				await lease.release();
			} catch (error) {
				onError(error);
			}
		},
	};
}

function positiveInteger(name: string, value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`createTriggerService: ${name} must be a positive integer, not ${value}`);
	}
	return value;
}
