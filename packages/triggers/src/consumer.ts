import type {RemoteSQL, SQLPreparedStatement} from 'remote-sql';
import type {CanonicalEntry, CanonicalFeed} from './feed.js';
import {journalStatement} from './journal.js';
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
};

/** The safe lane's gate: the highest block to act on, given a signal that aborts at the per-call timeout. */
export type Gate = (context: {signal: AbortSignal}) => Promise<number>;

export type Consumer = {
	/** Create the database's tables. Idempotent. */
	setup(): Promise<void>;
	/** Read, match and commit ONE page (or act on the view's refusal). */
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
};

export function createConsumer(options: ConsumerOptions): Consumer {
	const {db, app, feed, match} = options;
	const lane = options.lane ?? 'safe';
	if (lane !== 'safe') throw new Error(`the ${lane} lane is not built: only the safe lane (etherfold ADR-0007) is`);
	const clock = options.clock ?? Date.now;
	const callTimeoutMs = callTimeoutOf(options.callTimeoutMs);
	const context: MatchContext = {chainId: options.chainId, lane, app};

	async function readState(): Promise<StateRow | undefined> {
		const {results} = await db
			.prepare(`SELECT cursor, stream, generation, paused FROM consumers WHERE app = ?`)
			.bind(app)
			.all<StateRow>();
		return results[0];
	}

	function writeState(state: {
		cursor: string | null;
		stream: string | null;
		generation: string | null;
		paused: PauseReason | null;
	}): SQLPreparedStatement {
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
		await db.batch([
			writeState({
				cursor: state?.cursor ?? null,
				stream: state?.stream ?? null,
				generation: state?.generation ?? null,
				paused: reason,
			}),
			journalStatement(db, app, now, 'paused', {reason}),
		]);
		return {kind: 'paused', reason};
	}

	async function step(): Promise<StepResult> {
		const state = await readState();
		if (state?.paused) return {kind: 'paused', reason: JSON.parse(state.paused) as PauseReason};

		const gate = await withTimeout('gate', callTimeoutMs, (signal) => options.gate({signal}));
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
			await db.batch([
				// what was not sent is taken back, and frees its key for the new branch
				db
					.prepare(
						`UPDATE deliveries SET status = 'retracted', settled_at = ?
						WHERE app = ? AND block_number >= ? AND status = 'pending'`,
					)
					.bind(now, app, page.forkBlock),
				// what was already sent (or expired, or dead-lettered) is marked, never rewritten
				db
					.prepare(
						`UPDATE deliveries SET retracted_at = ?
						WHERE app = ? AND block_number >= ? AND status != 'retracted' AND retracted_at IS NULL`,
					)
					.bind(now, app, page.forkBlock),
				writeState({
					cursor: page.rewindCursor,
					stream: page.stream ?? state?.stream ?? null,
					generation: state?.generation ?? null,
					paused: null,
				}),
				journalStatement(db, app, now, 'rewind', {forkBlock: page.forkBlock, retracted}),
			]);
			return {kind: 'rewound', forkBlock: page.forkBlock, retracted};
		}

		if (state?.generation && page.generation !== state.generation) {
			return pause(state, {kind: 'generation-changed', from: state.generation, to: page.generation});
		}

		const now = clock();
		const statements: SQLPreparedStatement[] = [];
		for (const entry of page.entries) {
			for (const delivery of await match(entry, context)) {
				statements.push(insertDeliveryStatement(db, app, now, entry, delivery));
			}
		}
		statements.push(writeState({cursor: page.cursor, stream: page.stream, generation: page.generation, paused: null}));
		await db.batch(statements);
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
