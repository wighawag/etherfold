import type {RemoteSQL, SQLPreparedStatement} from 'remote-sql';
import type {CanonicalEntry, CanonicalFeed} from './feed.js';
import {journalStatement} from './journal.js';
import {LeaseLostError, type Lease, type LeaseGuard} from './lease.js';
import {insertDeliveryStatement, type NewDelivery} from './outbox.js';
import {setupDatabase} from './schema.js';
import {callTimeoutOf, withTimeout} from './timeout.js';

// ---------------------------------------------------------------------------
// THE CONSUMER: the canonical view in, the outbox out (etherfold ADR-0005).
// ---------------------------------------------------------------------------
// Each step reads ONE page at or below the gate, matches every entry, and
// commits the page's deliveries together with the cursor that page handed back,
// in one batch. So a crash between the read and the commit re-reads the page,
// and the unique key absorbs anything matched twice: nothing is lost and
// nothing is sent twice.
//
// It acts on the safe lane only (ADR-0007): the canonical view at a gate the
// caller computes, which at finality never rewinds. A rewind can still come
// (a gate set above the chain's real finality); the consumer then retracts what
// it has not sent from the fork block on and resumes from the rewind cursor.
// ---------------------------------------------------------------------------

/** The lanes of etherfold ADR-0007. Only `safe` is built. */
export type Lane = 'safe' | 'fast';

/** What a match is told besides the entry itself: `app` is the app the consumer follows the feed for. */
export type MatchContext = {chainId: string; lane: Lane; app: string};

/** Turns one canonical entry into the deliveries it implies (the trigger engine, or a test's). */
export type Matcher = (entry: CanonicalEntry, context: MatchContext) => Promise<NewDelivery[]>;

/** Why a consumer stopped acting until an operator resumes it. */
export type PauseReason =
	/** The fold answering the feed changed: what was already sent cannot be unsent, so a human decides. */
	| {kind: 'generation-changed'; from: string; to: string}
	/** The view refused the cursor (a stream mismatch carries a `startCursor` in `body`). */
	| {kind: 'refused'; error: string; status: number; body: Record<string, unknown>};

export type StepResult =
	| {kind: 'advanced'; entries: number; deliveries: number; hasMore: boolean}
	| {kind: 'rewound'; forkBlock: number; retracted: number}
	| {kind: 'paused'; reason: PauseReason};

export type ConsumerStatus = {
	app: string;
	cursor?: string;
	stream?: string;
	generation?: string;
	paused?: PauseReason;
};

export type ConsumerOptions = {
	db: RemoteSQL;
	/**
	 * The APP the consumer follows the feed for (etherfold ADR-0101): its one row
	 * of state, the `app` of every delivery it writes and of every journal row.
	 */
	app: string;
	chainId: string;
	feed: CanonicalFeed;
	/**
	 * The highest block to act on (ADR-0007: the consumer's decision, never the
	 * server's). Bounded by `callTimeoutMs`: its `signal` aborts at the timeout.
	 */
	gate: Gate;
	match: Matcher;
	lane?: Lane;
	/** Entries per page (the server's default when absent). */
	limit?: number;
	/** ms since the epoch. */
	clock?: () => number;
	/**
	 * The bound on each gate and feed read, in ms (etherfold ADR-0101): 10 s when
	 * absent. A call that has not answered by then fails the step with a
	 * `CallTimeoutError` (`gate-timeout`, `feed-timeout`), whether or not it
	 * honours its signal; nothing is committed for that page.
	 */
	callTimeoutMs?: number;
	/**
	 * The app's lease (etherfold ADR-0101), which `createTriggerService` always
	 * gives. With it, a step checks the lease on the state row it reads, fences
	 * the gate and each feed read (`lease.fence()`), and guards every statement
	 * of its commit, so a ticker that does not hold it writes nothing (a step
	 * that finds so throws a `LeaseLostError`). Without it, the consumer is
	 * unfenced: for a database it alone ticks.
	 */
	lease?: Lease;
};

/** The safe lane's gate: the highest block to act on, given a signal that aborts at the per-call timeout. */
export type Gate = (context: {signal: AbortSignal}) => Promise<number>;

export type Consumer = {
	/** Create the database's tables. Idempotent. */
	setup(): Promise<void>;
	/**
	 * Read, match and commit ONE page (or act on the view's refusal). An idle page
	 * (no entry, the stream and generation unchanged) commits nothing.
	 */
	step(): Promise<StepResult>;
	/**
	 * Step until the view says there is no more below the gate, or until it
	 * rewinds or pauses, or (given `maxPages`) until it has read that many pages:
	 * a bounded catch-up that reaches its bound returns normally with `hasMore`
	 * set, and the next one goes on from there (etherfold ADR-0101's bounded
	 * round). Unbounded, a view that never says it is done fails it after 10 000
	 * pages.
	 */
	catchUp(options?: {maxPages?: number}): Promise<CatchUpReport>;
	status(): Promise<ConsumerStatus>;
	/** An operator's decision after a pause: follow the new generation, or start the new stream from its start. */
	resume(): Promise<void>;
};

export type CatchUpReport = {
	steps: number;
	entries: number;
	deliveries: number;
	last: StepResult;
	/** The view has more below the gate than this catch-up read: it stopped at its `maxPages`. */
	hasMore: boolean;
};

/** The pages an unbounded catch-up reads before it calls the view broken. */
const UNBOUNDED_CATCH_UP_GUARD = 10_000;

type StateRow = {
	cursor: string | null;
	stream: string | null;
	generation: string | null;
	paused: string | null;
	lease_owner: string | null;
	lease_expires: number | null;
};

type State = {
	cursor: string | null;
	stream: string | null;
	generation: string | null;
	paused: PauseReason | null;
};

export function createConsumer(options: ConsumerOptions): Consumer {
	const {db, app, feed, match, lease} = options;
	const lane = options.lane ?? 'safe';
	if (lane !== 'safe') throw new Error(`the ${lane} lane is not built: only the safe lane (etherfold ADR-0007) is`);
	const clock = options.clock ?? Date.now;
	const callTimeoutMs = callTimeoutOf(options.callTimeoutMs);
	const context: MatchContext = {chainId: options.chainId, lane, app};

	async function readState(): Promise<StateRow | undefined> {
		const {results} = await db
			// the lease comes with the state, so checking it costs a step no extra query
			.prepare(`SELECT cursor, stream, generation, paused, lease_owner, lease_expires FROM consumers WHERE app = ?`)
			.bind(app)
			.all<StateRow>();
		return results[0];
	}

	/**
	 * The state write of a step's commit: under the lease, an UPDATE of the row
	 * the lease created, guarded, returning the row only when it was written.
	 */
	function commitState(state: State, guard: LeaseGuard | undefined): SQLPreparedStatement {
		if (!guard) return writeState(state);
		return db
			.prepare(
				`UPDATE consumers SET cursor = ?, stream = ?, generation = ?, paused = ?, updated_at = ?
				WHERE app = ? AND ${guard.sql} RETURNING app`,
			)
			.bind(
				state.cursor,
				state.stream,
				state.generation,
				state.paused === null ? null : JSON.stringify(state.paused),
				clock(),
				app,
				...guard.args,
			);
	}

	/** Commit a step's batch, its state write last; under the lease, a batch that wrote no state was a stale holder's. */
	async function commit(statements: SQLPreparedStatement[]): Promise<void> {
		const results = await db.batch(statements);
		if (lease && (results[results.length - 1]?.results?.length ?? 0) === 0) {
			throw new LeaseLostError(`the lease of the app "${app}" was lost before its commit: nothing was written`);
		}
	}

	/** The unguarded state write: a consumer without a lease, and an operator's `resume`. */
	function writeState(state: State): SQLPreparedStatement {
		return db
			.prepare(
				`INSERT INTO consumers (app, cursor, stream, generation, paused, updated_at) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT (app) DO UPDATE SET cursor = excluded.cursor, stream = excluded.stream,
					generation = excluded.generation, paused = excluded.paused, updated_at = excluded.updated_at`,
			)
			.bind(
				app,
				state.cursor,
				state.stream,
				state.generation,
				state.paused === null ? null : JSON.stringify(state.paused),
				clock(),
			);
	}

	async function pause(state: StateRow | undefined, reason: PauseReason): Promise<StepResult> {
		const now = clock();
		const guard = lease?.guard();
		await commit([
			journalStatement(db, app, now, 'paused', {reason}, guard),
			commitState(
				{
					cursor: state?.cursor ?? null,
					stream: state?.stream ?? null,
					generation: state?.generation ?? null,
					paused: reason,
				},
				guard,
			),
		]);
		return {kind: 'paused', reason};
	}

	async function step(): Promise<StepResult> {
		const state = await readState();
		lease?.observe(state);
		if (state?.paused) return {kind: 'paused', reason: JSON.parse(state.paused) as PauseReason};

		await lease?.fence();
		const gate = await withTimeout('gate', callTimeoutMs, (signal) => options.gate({signal}));
		await lease?.fence();
		const page = await withTimeout('feed', callTimeoutMs, (signal) =>
			feed.read(
				{
					gate,
					...(state?.cursor ? {cursor: state.cursor} : {}),
					...(options.limit === undefined ? {} : {limit: options.limit}),
				},
				{signal},
			),
		);

		if (page.kind === 'refused') {
			return pause(state, {kind: 'refused', error: page.error, status: page.status, body: page.body});
		}

		if (page.kind === 'rewind') {
			const now = clock();
			const {results} = await db
				.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE app = ? AND block_number >= ? AND status = 'pending'`)
				.bind(app, page.forkBlock)
				.all<{n: number}>();
			const retracted = Number(results[0]?.n ?? 0);
			const guard = lease?.guard();
			const fenced = guard ? ` AND ${guard.sql}` : '';
			const fencedArgs = guard?.args ?? [];
			await commit([
				// what was not sent is taken back, and frees its key for the new branch
				db
					.prepare(
						`UPDATE deliveries SET status = 'retracted', settled_at = ?
						WHERE app = ? AND block_number >= ? AND status = 'pending'${fenced}`,
					)
					.bind(now, app, page.forkBlock, ...fencedArgs),
				// what was already sent (or expired, or dead-lettered) is marked, never rewritten
				db
					.prepare(
						`UPDATE deliveries SET retracted_at = ?
						WHERE app = ? AND block_number >= ? AND status != 'retracted' AND retracted_at IS NULL${fenced}`,
					)
					.bind(now, app, page.forkBlock, ...fencedArgs),
				journalStatement(db, app, now, 'rewind', {forkBlock: page.forkBlock, retracted}, guard),
				commitState(
					{
						cursor: page.rewindCursor,
						stream: page.stream ?? state?.stream ?? null,
						generation: state?.generation ?? null,
						paused: null,
					},
					guard,
				),
			]);
			return {kind: 'rewound', forkBlock: page.forkBlock, retracted};
		}

		if (state?.generation && page.generation !== state.generation) {
			return pause(state, {kind: 'generation-changed', from: state.generation, to: page.generation});
		}

		// AN IDLE ROUND WRITES NOTHING (etherfold ADR-0101), the lease renewal aside: a page that carried
		// no entry and left the stream and generation as they were is not committed. Its cursor may
		// differ (it carries the stream's newer high-water `since` mark), but its POSITION has not
		// moved, so keeping the older cursor is safe: an older mark only makes the fork check more
		// conservative, and the next guarded commit (a non-empty page, a rewind, a pause) writes the
		// newest one. An empty canonical page always says `hasMore: false`; one that did not would be
		// read again from the same cursor, so it is committed rather than trusted.
		if (
			page.entries.length === 0 &&
			!page.hasMore &&
			state !== undefined &&
			page.stream === state.stream &&
			page.generation === state.generation
		) {
			return {kind: 'advanced', entries: 0, deliveries: 0, hasMore: false};
		}

		const matched: {entry: CanonicalEntry; delivery: NewDelivery}[] = [];
		for (const entry of page.entries) {
			for (const delivery of await match(entry, context)) matched.push({entry, delivery});
		}
		// the guard is taken after the last call, so it holds the commit to the lease as of now
		const now = clock();
		const guard = lease?.guard();
		const statements = matched.map(({entry, delivery}) =>
			insertDeliveryStatement(db, app, now, entry, delivery, guard),
		);
		statements.push(
			commitState({cursor: page.cursor, stream: page.stream, generation: page.generation, paused: null}, guard),
		);
		await commit(statements);
		return {kind: 'advanced', entries: page.entries.length, deliveries: statements.length - 1, hasMore: page.hasMore};
	}

	return {
		setup: () => setupDatabase(db),
		step,
		async catchUp({maxPages} = {}) {
			if (maxPages !== undefined && !(Number.isInteger(maxPages) && maxPages > 0)) {
				throw new Error(`catchUp: maxPages must be a positive integer, not ${maxPages}`);
			}
			let steps = 0;
			let entries = 0;
			let deliveries = 0;
			// unbounded, guarded so a feed that never says it is done fails loudly rather than spinning;
			// bounded, reaching the bound is the round's normal end and the next round goes on
			for (let guard = 0; guard < (maxPages ?? UNBOUNDED_CATCH_UP_GUARD); guard++) {
				const last = await step();
				steps++;
				if (last.kind !== 'advanced') return {steps, entries, deliveries, last, hasMore: false};
				entries += last.entries;
				deliveries += last.deliveries;
				if (!last.hasMore || steps === maxPages) {
					return {steps, entries, deliveries, last, hasMore: last.hasMore};
				}
			}
			throw new Error(`the canonical view never reported itself caught up after ${UNBOUNDED_CATCH_UP_GUARD} pages`);
		},
		async status() {
			const state = await readState();
			return {
				app,
				...(state?.cursor ? {cursor: state.cursor} : {}),
				...(state?.stream ? {stream: state.stream} : {}),
				...(state?.generation ? {generation: state.generation} : {}),
				...(state?.paused ? {paused: JSON.parse(state.paused) as PauseReason} : {}),
			};
		},
		async resume() {
			const state = await readState();
			if (!state?.paused) return;
			const reason = JSON.parse(state.paused) as PauseReason;
			const now = clock();
			const next =
				reason.kind === 'generation-changed'
					? {cursor: state.cursor, stream: state.stream, generation: reason.to}
					: typeof reason.body['startCursor'] === 'string'
						? // a stream mismatch: re-subscribe deliberately, from where the new stream begins
							{cursor: reason.body['startCursor'], stream: null, generation: null}
						: {cursor: state.cursor, stream: state.stream, generation: state.generation};
			await db.batch([writeState({...next, paused: null}), journalStatement(db, app, now, 'resumed', {after: reason})]);
		},
	};
}
