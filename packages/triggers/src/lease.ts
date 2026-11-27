import type {RemoteSQL} from 'remote-sql';

// ---------------------------------------------------------------------------
// THE LEASE (etherfold ADR-0101): one ticker of an app at a time.
// ---------------------------------------------------------------------------
// Two tickers of one app over one database (two processes, a rolling deploy's
// overlap, overlapping Cron Triggers) would both deliver the same due rows. So
// a tick works only under the app's lease, held in the app's `consumers` row
// (`lease_owner`, `lease_expires`), whatever drives the ticks: the core still
// owns no timer, a host calls `tick()`.
//
// The fencing is twofold. By DEADLINE: before each call the core makes (the
// gate, a feed read, a predicate, a delivery) the ticker reads its clock,
// renews under half the lease, and stops under the FENCE MARGIN (the per-call
// timeout plus a commit and a clock-skew allowance), so every call it starts
// ends inside its lease. By the COMMIT: every statement a tick commits or
// settles carries the lease predicate, so a stale holder changes nothing even
// when its deadline was wrong (a clock that drifted past the skew allowance).
//
// The renewal writes ONLY the lease, never the cursor, stream, generation or
// pause: it can neither undo an operator's `resume` nor move a cursor backwards
// after a takeover. Delivery stays at-least-once (ADR-0009): the lease removes
// the systematic double delivery of concurrent tickers, not the rare retry
// after a crash, which the idempotency key absorbs.
//
// CLOCK ASSUMPTION: the tickers of one app agree on the time within the skew
// allowance (NTP-synchronised hosts; the platform clock on Workers).
// ---------------------------------------------------------------------------

/** How long a lease lasts, in ms, when no other is given. */
export const DEFAULT_LEASE_MS = 60_000;
/** The time the fence leaves a step's commit after its last call. */
export const LEASE_COMMIT_ALLOWANCE_MS = 5_000;
/** How far apart the clocks of one app's tickers may be. */
export const LEASE_CLOCK_SKEW_ALLOWANCE_MS = 5_000;

/** A tick stopped because it no longer holds its app's lease, or has too little of it left for the next call. */
export class LeaseLostError extends Error {
	readonly code = 'lease-lost';
	constructor(
		message: string,
		/** The feed's failure earlier in the same round, which the lost lease kept out of the journal. */
		readonly followFailure?: {error: string; code?: string},
	) {
		super(message);
		this.name = 'LeaseLostError';
	}
}

/** The lease predicate a guarded statement carries: `sql` is an `EXISTS (...)` expression, `args` its bindings. */
export type LeaseGuard = {sql: string; args: unknown[]};

/** What a consumer's state read returns of the lease. */
export type LeaseColumns = {lease_owner: string | null; lease_expires: number | null};

export type Lease = {
	/** This ticker's id (`crypto.randomUUID()`), the `lease_owner` it writes. */
	owner: string;
	durationMs: number;
	/** The time left on the lease under which a call is not started: the per-call timeout plus the allowances. */
	marginMs: number;
	/**
	 * At a tick's start: `true` when the lease is held. Writes only when this
	 * ticker holds no lease or its known expiry is under half the lease away;
	 * creates the app's `consumers` row on its first tick.
	 */
	acquire(): Promise<boolean>;
	/**
	 * Before each call: renew under half the lease, and throw a `LeaseLostError`
	 * when the lease is not held or less than the margin is left.
	 */
	fence(): Promise<void>;
	/** Check the lease columns a state read returned: a `LeaseLostError` when another owner holds the row. */
	observe(row: LeaseColumns | undefined): void;
	/** The predicate every committed or settled statement carries, as of now. */
	guard(): LeaseGuard;
	/**
	 * A guarded write found the lease gone: forget the expiry held in memory, so
	 * the next `acquire()` asks the database, and return the error to throw.
	 */
	lost(message: string): LeaseLostError;
	/** Give the lease up (`lease_expires = 0`), so another ticker may take it at once. A no-op when not held. */
	release(): Promise<void>;
};

/**
 * The lease of one app. Refuses, naming both values, a per-call timeout whose
 * fence margin is not under half the lease: a ticker would then renew before
 * every call and still not be sure to finish one inside it.
 */
export function createLease(options: {
	db: RemoteSQL;
	app: string;
	clock?: () => number;
	/** 60 s when absent. */
	durationMs?: number;
	/** The per-call timeout the fence margin is sized from. */
	callTimeoutMs: number;
}): Lease {
	const {db, app, callTimeoutMs} = options;
	const clock = options.clock ?? Date.now;
	const durationMs = options.durationMs ?? DEFAULT_LEASE_MS;
	if (!Number.isFinite(durationMs) || durationMs <= 0) {
		throw new Error(`the lease must be a positive number of milliseconds, not ${durationMs}`);
	}
	const marginMs = callTimeoutMs + LEASE_COMMIT_ALLOWANCE_MS + LEASE_CLOCK_SKEW_ALLOWANCE_MS;
	if (!(marginMs < durationMs / 2)) {
		throw new Error(
			`the per-call timeout (${callTimeoutMs} ms) is too long for the lease (${durationMs} ms): the fence margin, the timeout plus ${LEASE_COMMIT_ALLOWANCE_MS} ms for the commit and ${LEASE_CLOCK_SKEW_ALLOWANCE_MS} ms for clock skew (${marginMs} ms), must be under half the lease; shorten the timeout or lengthen the lease`,
		);
	}
	const owner = crypto.randomUUID();
	/** The expiry this ticker last wrote or read for itself; absent when it holds no lease. */
	let expires: number | undefined;

	const left = () => (expires === undefined ? -Infinity : expires - clock());

	async function write(): Promise<boolean> {
		const now = clock();
		const until = now + durationMs;
		// creates the row on the app's first tick; otherwise takes over a lapsed lease or renews its
		// own, and writes nothing but the lease (a false DO UPDATE WHERE writes and returns nothing)
		const {results} = await db
			.prepare(
				`INSERT INTO consumers (app, updated_at, lease_owner, lease_expires) VALUES (?, ?, ?, ?)
				ON CONFLICT (app) DO UPDATE SET lease_owner = excluded.lease_owner, lease_expires = excluded.lease_expires
				WHERE consumers.lease_owner = excluded.lease_owner OR consumers.lease_expires < ?
				RETURNING lease_expires`,
			)
			.bind(app, now, owner, until, now)
			.all<{lease_expires: number}>();
		expires = results.length === 0 ? undefined : Number(results[0]!.lease_expires);
		return expires !== undefined;
	}

	return {
		owner,
		durationMs,
		marginMs,
		async acquire() {
			if (left() >= durationMs / 2) return true;
			return write();
		},
		async fence() {
			if (expires === undefined) throw new LeaseLostError(`the app "${app}" holds no lease`);
			if (left() < durationMs / 2) await write();
			if (expires === undefined) {
				throw new LeaseLostError(`the lease of the app "${app}" was taken by another ticker`);
			}
			if (left() < marginMs) {
				expires = undefined;
				throw new LeaseLostError(
					`the lease of the app "${app}" has less than its ${marginMs} ms margin left: no call is started`,
				);
			}
		},
		observe(row) {
			if (!row || row.lease_owner !== owner) {
				expires = undefined;
				throw new LeaseLostError(`the lease of the app "${app}" is held by another ticker`);
			}
			expires = Number(row.lease_expires);
		},
		lost(message) {
			expires = undefined;
			return new LeaseLostError(message);
		},
		guard() {
			return {
				sql: `EXISTS (SELECT 1 FROM consumers WHERE app = ? AND lease_owner = ? AND lease_expires > ?)`,
				args: [app, owner, clock()],
			};
		},
		async release() {
			if (expires === undefined) return;
			expires = undefined;
			await db
				.prepare(`UPDATE consumers SET lease_expires = 0 WHERE app = ? AND lease_owner = ?`)
				.bind(app, owner)
				.all();
		},
	};
}
