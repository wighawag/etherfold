import type {RemoteSQL, SQLPreparedStatement} from 'remote-sql';

export type JournalKind =
	| 'rewind'
	| 'paused'
	| 'resumed'
	| 'expired'
	| 'dead-lettered'
	| 'requeued'
	/** following the feed failed (the feed, or a predicate's state read): the consumer is held at its page */
	| 'stalled'
	/** following the feed succeeded again after a `stalled` */
	| 'recovered';

/** One recorded entry, named by the app whose consumer, deliverer or registry recorded it. */
export type JournalEntry = {id: number; app: string; at: number; kind: JournalKind; detail: Record<string, unknown>};

/** The statement that records one entry for an app, so it can join the batch whose effect it records. */
export function journalStatement(
	db: RemoteSQL,
	app: string,
	at: number,
	kind: JournalKind,
	detail: Record<string, unknown>,
): SQLPreparedStatement {
	return db
		.prepare(`INSERT INTO journal (app, at, kind, detail) VALUES (?, ?, ?, ?)`)
		.bind(app, at, kind, JSON.stringify(detail));
}

/** Everything recorded for one app, oldest first. */
export async function readJournal(
	db: RemoteSQL,
	app: string,
	options: {kind?: JournalKind} = {},
): Promise<JournalEntry[]> {
	const statement =
		options.kind === undefined
			? db.prepare(`SELECT id, app, at, kind, detail FROM journal WHERE app = ? ORDER BY id`).bind(app)
			: db
					.prepare(`SELECT id, app, at, kind, detail FROM journal WHERE app = ? AND kind = ? ORDER BY id`)
					.bind(app, options.kind);
	const {results} = await statement.all<{id: number; app: string; at: number; kind: JournalKind; detail: string}>();
	return results.map((row) => ({
		id: Number(row.id),
		app: row.app,
		at: Number(row.at),
		kind: row.kind,
		detail: JSON.parse(row.detail) as Record<string, unknown>,
	}));
}
