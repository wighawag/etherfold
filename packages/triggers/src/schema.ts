import type {RemoteSQL} from 'remote-sql';

// ---------------------------------------------------------------------------
// THE SERVICE'S OWN DATABASE (etherfold ADR-0005: each consumer owns its own),
// KEYED BY APP (etherfold ADR-0101).
// ---------------------------------------------------------------------------
// Plain SQLite through `remote-sql`, so the same statements run on libSQL (the
// nodejs platform) and on D1. Every statement is idempotent: `setup` runs on
// every start.
//
// Every table carries the APP (the consumer's name: one slug, one column), and
// every unique and lookup index leads with it, so several apps can share one
// database and one database per app is the same schema. A query that forgets
// the app is a cross-app leak.
// ---------------------------------------------------------------------------

const STATEMENTS = [
	// ONE row per app's consumer: where it is, which stream and fold it was
	// following, why it is paused, if it is, and who holds the app's lease
	// until when (ms since the epoch; 0 once released, ADR-0101).
	`CREATE TABLE IF NOT EXISTS consumers (
		app TEXT PRIMARY KEY,
		cursor TEXT,
		stream TEXT,
		generation TEXT,
		paused TEXT,
		updated_at INTEGER NOT NULL,
		lease_owner TEXT,
		lease_expires INTEGER NOT NULL DEFAULT 0
	)`,
	// THE OUTBOX. A row is written in the same batch as the cursor advance that
	// implies it, and ends in a recorded terminal state, never a DELETE.
	`CREATE TABLE IF NOT EXISTS deliveries (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		app TEXT NOT NULL,
		action TEXT NOT NULL,
		key TEXT NOT NULL,
		recipient TEXT NOT NULL,
		payload TEXT NOT NULL,
		trigger TEXT NOT NULL,
		block_number INTEGER NOT NULL,
		block_hash TEXT NOT NULL,
		log_index INTEGER NOT NULL,
		transaction_hash TEXT NOT NULL,
		status TEXT NOT NULL,
		attempts INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		next_attempt_at INTEGER NOT NULL,
		expires_at INTEGER,
		settled_at INTEGER,
		last_error TEXT,
		retracted_at INTEGER
	)`,
	// A key is unique, within its app, among the rows that still stand: a
	// RETRACTED row frees its key, so the same meaning arriving again on the new
	// branch is delivered.
	`CREATE UNIQUE INDEX IF NOT EXISTS deliveries_by_key ON deliveries (app, action, key) WHERE status != 'retracted'`,
	`CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries (app, status, next_attempt_at)`,
	`CREATE INDEX IF NOT EXISTS deliveries_by_block ON deliveries (app, block_number)`,
	// What happened that an operator must be able to see afterwards: a rewind, a
	// pause, an expiry, a dead letter (etherfold ADR-0012: never a quiet DELETE).
	`CREATE TABLE IF NOT EXISTS journal (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		app TEXT NOT NULL,
		at INTEGER NOT NULL,
		kind TEXT NOT NULL,
		detail TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS journal_by_app ON journal (app, kind)`,
	// SUBSCRIPTION TRIGGERS: registered by a user for themself, expiring unless
	// renewed (etherfold ADR-0012). A cancelled or expired one stays, for "why did
	// I stop getting notifications?".
	`CREATE TABLE IF NOT EXISTS subscriptions (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		app TEXT NOT NULL,
		kind TEXT NOT NULL,
		recipient TEXT NOT NULL,
		filter TEXT NOT NULL,
		condition_count INTEGER NOT NULL,
		status TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		renewed_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		UNIQUE (app, kind, recipient, filter)
	)`,
	`CREATE INDEX IF NOT EXISTS subscriptions_live ON subscriptions (app, kind, condition_count, status, expires_at)`,
	`CREATE INDEX IF NOT EXISTS subscriptions_by_recipient ON subscriptions (app, recipient, status)`,
	// The inverted index of etherfold ADR-0013: (app, kind, argument, value) -> subscription,
	// so matching one log against every subscriber of its app is an indexed lookup.
	`CREATE TABLE IF NOT EXISTS subscription_conditions (
		subscription_id INTEGER NOT NULL,
		app TEXT NOT NULL,
		kind TEXT NOT NULL,
		arg TEXT NOT NULL,
		value TEXT NOT NULL,
		PRIMARY KEY (subscription_id, arg)
	)`,
	`CREATE INDEX IF NOT EXISTS subscription_conditions_lookup ON subscription_conditions (app, kind, arg, value)`,
	// The registration requests already accepted, each until its signature would expire anyway,
	// so a replayed request is refused (a captured registration must not undo a later cancel).
	// Per app: a request one app accepted is not a replay for another.
	`CREATE TABLE IF NOT EXISTS accepted_requests (
		app TEXT NOT NULL,
		key TEXT NOT NULL,
		until INTEGER NOT NULL,
		PRIMARY KEY (app, key)
	)`,
	`CREATE INDEX IF NOT EXISTS accepted_requests_until ON accepted_requests (app, until)`,
];

/** Every table of the schema: each carries an `app` column. */
const TABLES = [
	'consumers',
	'deliveries',
	'journal',
	'subscriptions',
	'subscription_conditions',
	'accepted_requests',
] as const;

/** What `setup` says over a database written before the schema was keyed by app (etherfold ADR-0101). */
export const OLD_LAYOUT_MESSAGE =
	"the trigger service's schema changed: every table is now keyed by app (etherfold ADR-0101), and there is no migration; start from an empty database";

/** What `setup` says over a database written before the consumer's row carried the app's lease (etherfold ADR-0101). */
export const NO_LEASE_MESSAGE =
	"the trigger service's schema changed: the consumers table now holds each app's lease (etherfold ADR-0101), and there is no migration; start from an empty database";

/**
 * Create every table and index this service uses. Idempotent. Refuses a
 * database in the layout before the schema was keyed by app (a table of the
 * schema without an `app` column), rather than writing app-keyed rows beside
 * rows that name no app, and one whose `consumers` table has no lease columns.
 */
export async function setupDatabase(db: RemoteSQL): Promise<void> {
	// `PRAGMA table_info` answers no row for a table that does not exist, on SQLite, libSQL and D1
	const columns = await db.batch(TABLES.map((table) => db.prepare(`PRAGMA table_info(${table})`)));
	TABLES.forEach((table, index) => {
		const names = ((columns[index]?.results ?? []) as {name: string}[]).map((column) => column.name);
		if (names.length > 0 && !names.includes('app')) {
			throw new Error(`${OLD_LAYOUT_MESSAGE} (the table "${table}" has no "app" column)`);
		}
		if (table === 'consumers' && names.length > 0 && !names.includes('lease_expires')) {
			throw new Error(NO_LEASE_MESSAGE);
		}
	});
	await db.batch(STATEMENTS.map((sql) => db.prepare(sql)));
}
