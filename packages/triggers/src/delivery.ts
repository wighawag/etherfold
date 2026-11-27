import type {RemoteSQL} from 'remote-sql';
import type {Lane} from './consumer.js';
import {journalStatement} from './journal.js';
import {LeaseLostError, type Lease} from './lease.js';
import {deliveryFromRow, type DeliveryRecord} from './outbox.js';
import {callTimeoutOf, withTimeout} from './timeout.js';
import type {TriggerDefinitions} from './triggers.js';

// ---------------------------------------------------------------------------
// THE ACTION SEAM AND ITS DELIVERY POLICY (etherfold ADR-0009).
// ---------------------------------------------------------------------------
// An action is ONE primitive: an authenticated HTTP call carrying a semantic
// idempotency key. An adapter turns a frozen payload into that call and says
// what the answer means; the deliverer owns everything else, the same for every
// action type: when to try, how often, and the recorded state each row ends in.
// ---------------------------------------------------------------------------

export type DeliveryPolicy = {
	/** After this long a delivery is not worth sending and EXPIRES (a push); absent, never. */
	ttlMs?: number;
	/** Attempts before a DEAD LETTER. */
	maxAttempts: number;
	/** Wait after the n-th failed attempt: `min(maxMs, initialMs * factor^(n-1))`. */
	backoff: {initialMs: number; maxMs: number; factor?: number};
};

/** What one attempt came to. */
export type DeliveryOutcome =
	| {kind: 'delivered'}
	/** Worth trying again (a 5xx, a timeout, a partial failure). */
	| {kind: 'retry'; error: string; retryAfterMs?: number}
	/** Never worth trying again as configured (a refusal): dead-lettered at once, requeueable by an operator. */
	| {kind: 'dead'; error: string};

/** The code behind the action seam for one action type. */
export type ActionAdapter = {
	policy: DeliveryPolicy;
	/** The lanes a trigger using this action may fire from (etherfold ADR-0007); absent, any. */
	lanes?: readonly Lane[];
	/**
	 * One attempt. A throw is a transport failure and is retried. The deliverer
	 * passes a `signal` that aborts at its per-call timeout (etherfold ADR-0101),
	 * and counts an attempt that has not answered by then as a retry whether or
	 * not it honours the signal; the target's idempotency key absorbs one that
	 * still lands.
	 */
	deliver(delivery: DeliveryRecord, options?: {signal?: AbortSignal}): Promise<DeliveryOutcome>;
};

/**
 * Refuse, at startup, a trigger whose action has no adapter, or may not fire
 * from the lane the consumer reads (a reward must never be sent from the fast
 * lane: an achievement must never be wrong, and can wait).
 */
export function assertActionsFitLane(
	definitions: TriggerDefinitions,
	actions: Record<string, ActionAdapter>,
	lane: Lane,
): void {
	const uses = [
		...Object.entries(definitions.subscriptions ?? {}).map(([name, kind]) => [
			`subscription kind "${name}"`,
			kind.action,
		]),
		...Object.entries(definitions.rules ?? {}).map(([name, rule]) => [`rule "${name}"`, rule.action]),
	];
	for (const [owner, action] of uses as [string, string][]) {
		const adapter = actions[action];
		if (!adapter) throw new Error(`${owner}: no adapter is configured for the action "${action}"`);
		if (adapter.lanes && !adapter.lanes.includes(lane)) {
			throw new Error(
				`${owner}: the action "${action}" fires from the ${adapter.lanes.join(' or ')} lane only, and this consumer reads the ${lane} lane`,
			);
		}
	}
}

export type DeliveryReport = {attempted: number; delivered: number; retried: number; expired: number; dead: number};

export type Deliverer = {
	/** Attempt every pending delivery of its app that is due, oldest first, up to `batchSize`. */
	deliverDue(): Promise<DeliveryReport>;
	/** An operator's decision: a dead letter of its app back to pending, its attempts reset. */
	requeue(id: number): Promise<boolean>;
};

function backoffOf(policy: DeliveryPolicy, attempts: number): number {
	const {initialMs, maxMs, factor = 2} = policy.backoff;
	return Math.min(maxMs, initialMs * factor ** (attempts - 1));
}

export function createDeliverer(options: {
	db: RemoteSQL;
	/** The app whose deliveries it attempts, through its own adapters only (etherfold ADR-0101). */
	app: string;
	actions: Record<string, ActionAdapter>;
	clock?: () => number;
	batchSize?: number;
	/** The bound on each attempt, in ms: 10 s when absent. An attempt past it is a retry (`delivery-timeout`). */
	callTimeoutMs?: number;
	/**
	 * The app's lease (etherfold ADR-0101), which `createTriggerService` always
	 * gives: each attempt is fenced (`lease.fence()`) and every settle guarded,
	 * so a ticker that does not hold it settles nothing (`deliverDue` then throws
	 * a `LeaseLostError`). `requeue`, an operator's action, is not.
	 */
	lease?: Lease;
}): Deliverer {
	const {db, app, actions, lease} = options;
	const clock = options.clock ?? Date.now;
	const callTimeoutMs = callTimeoutOf(options.callTimeoutMs);
	const batchSize = options.batchSize ?? 100;

	async function settle(
		delivery: DeliveryRecord,
		status: 'delivered' | 'expired' | 'dead',
		now: number,
		attempts: number,
		error?: string,
	) {
		const guard = lease?.guard();
		const [settled] = await db.batch([
			db
				.prepare(
					`UPDATE deliveries SET status = ?, attempts = ?, settled_at = ?, last_error = COALESCE(?, last_error)
					WHERE id = ?${guard ? ` AND ${guard.sql}` : ''} RETURNING id`,
				)
				.bind(status, attempts, now, error ?? null, delivery.id, ...(guard?.args ?? [])),
			...(status === 'delivered'
				? []
				: [
						journalStatement(
							db,
							app,
							now,
							status === 'dead' ? 'dead-lettered' : 'expired',
							{
								delivery: delivery.id,
								action: delivery.action,
								key: delivery.key,
								recipient: delivery.recipient,
								attempts,
								...(error === undefined ? {} : {error}),
							},
							guard,
						),
					]),
		]);
		assertSettled(settled?.results);
	}

	/** Under the lease, a settle that wrote nothing was a stale holder's: the round stops. */
	function assertSettled(written: unknown[] | undefined) {
		if (lease && (written?.length ?? 0) === 0) {
			throw new LeaseLostError(`the lease of the app "${app}" was lost before a settle: nothing was written`);
		}
	}

	return {
		async deliverDue() {
			const report: DeliveryReport = {attempted: 0, delivered: 0, retried: 0, expired: 0, dead: 0};
			const {results} = await db
				.prepare(
					`SELECT * FROM deliveries WHERE app = ? AND status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?`,
				)
				.bind(app, clock(), batchSize)
				.all();
			for (const delivery of results.map(deliveryFromRow)) {
				const adapter = actions[delivery.action];
				let now = clock();
				if (!adapter) {
					await settle(
						delivery,
						'dead',
						now,
						delivery.attempts,
						`no adapter is configured for the action "${delivery.action}"`,
					);
					report.dead++;
					continue;
				}
				const expiresAt =
					delivery.expiresAt ??
					(adapter.policy.ttlMs === undefined ? undefined : delivery.createdAt + adapter.policy.ttlMs);
				if (expiresAt !== undefined && now >= expiresAt) {
					await settle(delivery, 'expired', now, delivery.attempts);
					report.expired++;
					continue;
				}

				// the attempt is the call the fence covers: started only with the margin left on the lease
				await lease?.fence();
				report.attempted++;
				let outcome: DeliveryOutcome;
				try {
					outcome = await withTimeout('delivery', callTimeoutMs, (signal) => adapter.deliver(delivery, {signal}));
				} catch (error) {
					outcome = {kind: 'retry', error: error instanceof Error ? error.message : String(error)};
				}
				now = clock();
				const attempts = delivery.attempts + 1;
				if (outcome.kind === 'delivered') {
					await settle(delivery, 'delivered', now, attempts);
					report.delivered++;
				} else if (outcome.kind === 'dead' || attempts >= adapter.policy.maxAttempts) {
					await settle(delivery, 'dead', now, attempts, outcome.error);
					report.dead++;
				} else {
					const wait = outcome.retryAfterMs ?? backoffOf(adapter.policy, attempts);
					const guard = lease?.guard();
					const {results: retried} = await db
						.prepare(
							`UPDATE deliveries SET attempts = ?, next_attempt_at = ?, last_error = ?
							WHERE id = ?${guard ? ` AND ${guard.sql}` : ''} RETURNING id`,
						)
						.bind(attempts, now + wait, outcome.error, delivery.id, ...(guard?.args ?? []))
						.all();
					assertSettled(retried);
					report.retried++;
				}
			}
			return report;
		},

		async requeue(id) {
			const {results} = await db.prepare(`SELECT * FROM deliveries WHERE app = ? AND id = ?`).bind(app, id).all();
			const row = results[0];
			if (!row) return false;
			const delivery = deliveryFromRow(row as never);
			if (delivery.status !== 'dead') return false;
			const now = clock();
			await db.batch([
				db
					.prepare(
						`UPDATE deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, settled_at = NULL WHERE id = ?`,
					)
					.bind(now, id),
				journalStatement(db, app, now, 'requeued', {delivery: id, action: delivery.action, key: delivery.key}),
			]);
			return true;
		},
	};
}
