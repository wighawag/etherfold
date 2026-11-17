import type {RemoteSQL, SQLPreparedStatement} from 'remote-sql';
import type {CanonicalEntry, CanonicalFeed} from './feed.js';
import {journalStatement} from './journal.js';
import {insertDeliveryStatement, type NewDelivery} from './outbox.js';
import {setupDatabase} from './schema.js';

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

/** What a match is told besides the entry itself. */
export type MatchContext = {chainId: string; lane: Lane; consumer: string};

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
	name: string;
	cursor?: string;
	stream?: string;
	generation?: string;
	paused?: PauseReason;
};

export type ConsumerOptions = {
	db: RemoteSQL;
	/** The consumer's name: one row of state, and the `consumer` of every delivery it writes. */
	name: string;
	chainId: string;
	feed: CanonicalFeed;
	/** The highest block to act on (ADR-0007: the consumer's decision, never the server's). */
	gate: () => Promise<number>;
	match: Matcher;
	lane?: Lane;
	/** Entries per page (the server's default when absent). */
	limit?: number;
	/** ms since the epoch. */
	clock?: () => number;
};

export type Consumer = {
	/** Create the database's tables. Idempotent. */
	setup(): Promise<void>;
	/** Read, match and commit ONE page (or act on the view's refusal). */
	step(): Promise<StepResult>;
	/** Step until the view says there is no more below the gate, or until it rewinds or pauses. */
	catchUp(): Promise<{steps: number; entries: number; deliveries: number; last: StepResult}>;
	status(): Promise<ConsumerStatus>;
	/** An operator's decision after a pause: follow the new generation, or start the new stream from its start. */
	resume(): Promise<void>;
};

type StateRow = {
	cursor: string | null;
	stream: string | null;
	generation: string | null;
	paused: string | null;
};

export function createConsumer(options: ConsumerOptions): Consumer {
	const {db, name, feed, match} = options;
	const lane = options.lane ?? 'safe';
	if (lane !== 'safe') throw new Error(`the ${lane} lane is not built: only the safe lane (etherfold ADR-0007) is`);
	const clock = options.clock ?? Date.now;
	const context: MatchContext = {chainId: options.chainId, lane, consumer: name};

	async function readState(): Promise<StateRow | undefined> {
		const {results} = await db
			.prepare(`SELECT cursor, stream, generation, paused FROM consumers WHERE name = ?`)
			.bind(name)
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
				`INSERT INTO consumers (name, cursor, stream, generation, paused, updated_at) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT (name) DO UPDATE SET cursor = excluded.cursor, stream = excluded.stream,
					generation = excluded.generation, paused = excluded.paused, updated_at = excluded.updated_at`,
			)
			.bind(
				name,
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
			journalStatement(db, now, 'paused', {consumer: name, reason}),
		]);
		return {kind: 'paused', reason};
	}

	async function step(): Promise<StepResult> {
		const state = await readState();
		if (state?.paused) return {kind: 'paused', reason: JSON.parse(state.paused) as PauseReason};

		const gate = await options.gate();
		const page = await feed.read({
			gate,
			...(state?.cursor ? {cursor: state.cursor} : {}),
			...(options.limit === undefined ? {} : {limit: options.limit}),
		});

		if (page.kind === 'refused') {
			return pause(state, {kind: 'refused', error: page.error, status: page.status, body: page.body});
		}

		if (page.kind === 'rewind') {
			const now = clock();
			const {results} = await db
				.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE consumer = ? AND block_number >= ? AND status = 'pending'`)
				.bind(name, page.forkBlock)
				.all<{n: number}>();
			const retracted = Number(results[0]?.n ?? 0);
			await db.batch([
				// what was not sent is taken back, and frees its key for the new branch
				db
					.prepare(
						`UPDATE deliveries SET status = 'retracted', settled_at = ?
						WHERE consumer = ? AND block_number >= ? AND status = 'pending'`,
					)
					.bind(now, name, page.forkBlock),
				// what was already sent (or expired, or dead-lettered) is marked, never rewritten
				db
					.prepare(
						`UPDATE deliveries SET retracted_at = ?
						WHERE consumer = ? AND block_number >= ? AND status != 'retracted' AND retracted_at IS NULL`,
					)
					.bind(now, name, page.forkBlock),
				writeState({
					cursor: page.rewindCursor,
					stream: page.stream ?? state?.stream ?? null,
					generation: state?.generation ?? null,
					paused: null,
				}),
				journalStatement(db, now, 'rewind', {consumer: name, forkBlock: page.forkBlock, retracted}),
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
				statements.push(insertDeliveryStatement(db, name, now, entry, delivery));
			}
		}
		statements.push(writeState({cursor: page.cursor, stream: page.stream, generation: page.generation, paused: null}));
		await db.batch(statements);
		return {kind: 'advanced', entries: page.entries.length, deliveries: statements.length - 1, hasMore: page.hasMore};
	}

	return {
		setup: () => setupDatabase(db),
		step,
		async catchUp() {
			let steps = 0;
			let entries = 0;
			let deliveries = 0;
			// bounded so a feed that never says it is done fails loudly rather than spinning
			for (let guard = 0; guard < 10_000; guard++) {
				const last = await step();
				steps++;
				if (last.kind !== 'advanced') return {steps, entries, deliveries, last};
				entries += last.entries;
				deliveries += last.deliveries;
				if (!last.hasMore) return {steps, entries, deliveries, last};
			}
			throw new Error(`the canonical view never reported itself caught up after 10000 pages`);
		},
		async status() {
			const state = await readState();
			return {
				name,
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
			await db.batch([
				writeState({...next, paused: null}),
				journalStatement(db, now, 'resumed', {consumer: name, after: reason}),
			]);
		},
	};
}
