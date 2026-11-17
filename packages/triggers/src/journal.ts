import type {RemoteSQL, SQLPreparedStatement} from 'remote-sql';

export type JournalKind = 'rewind' | 'paused' | 'resumed' | 'expired' | 'dead-lettered' | 'requeued';

export type JournalEntry = {id: number; at: number; kind: JournalKind; detail: Record<string, unknown>};

/** The statement that records one entry, so it can join the batch whose effect it records. */
export function journalStatement(
	db: RemoteSQL,
	at: number,
	kind: JournalKind,
	detail: Record<string, unknown>,
): SQLPreparedStatement {
	return db.prepare(`INSERT INTO journal (at, kind, detail) VALUES (?, ?, ?)`).bind(at, kind, JSON.stringify(detail));
}

/** Everything recorded, oldest first. */
export async function readJournal(db: RemoteSQL, options: {kind?: JournalKind} = {}): Promise<JournalEntry[]> {
	const statement =
		options.kind === undefined
			? db.prepare(`SELECT id, at, kind, detail FROM journal ORDER BY id`)
			: db.prepare(`SELECT id, at, kind, detail FROM journal WHERE kind = ? ORDER BY id`).bind(options.kind);
	const {results} = await statement.all<{id: number; at: number; kind: JournalKind; detail: string}>();
	return results.map((row) => ({
		id: Number(row.id),
		at: Number(row.at),
		kind: row.kind,
		detail: JSON.parse(row.detail) as Record<string, unknown>,
	}));
}
