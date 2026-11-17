import type {RemoteSQL} from 'remote-sql';

// ---------------------------------------------------------------------------
// THE SERVICE'S OWN DATABASE (etherfold ADR-0005: each consumer owns its own).
// ---------------------------------------------------------------------------
// Plain SQLite through `remote-sql`, so the same statements run on libSQL (the
// nodejs platform) and on D1. Every statement is idempotent: `setup` runs on
// every start.
// ---------------------------------------------------------------------------

const STATEMENTS = [
	// ONE row per consumer: where it is, which stream and fold it was following,
	// and why it is paused, if it is.
	`CREATE TABLE IF NOT EXISTS consumers (
		name TEXT PRIMARY KEY,
		cursor TEXT,
		stream TEXT,
		generation TEXT,
		paused TEXT,
		updated_at INTEGER NOT NULL
	)`,
	// THE OUTBOX. A row is written in the same batch as the cursor advance that
	// implies it, and ends in a recorded terminal state, never a DELETE.
	`CREATE TABLE IF NOT EXISTS deliveries (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		consumer TEXT NOT NULL,
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
	// A key is unique among the rows that still stand: a RETRACTED row frees its
	// key, so the same meaning arriving again on the new branch is delivered.
	`CREATE UNIQUE INDEX IF NOT EXISTS deliveries_by_key ON deliveries (action, key) WHERE status != 'retracted'`,
	`CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries (status, next_attempt_at)`,
	`CREATE INDEX IF NOT EXISTS deliveries_by_block ON deliveries (consumer, block_number)`,
	// What happened that an operator must be able to see afterwards: a rewind, a
	// pause, an expiry, a dead letter (etherfold ADR-0012: never a quiet DELETE).
	`CREATE TABLE IF NOT EXISTS journal (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		at INTEGER NOT NULL,
		kind TEXT NOT NULL,
		detail TEXT NOT NULL
	)`,
	// SUBSCRIPTION TRIGGERS: registered by a user for themself, expiring unless
	// renewed (etherfold ADR-0012). A cancelled or expired one stays, for "why did
	// I stop getting notifications?".
	`CREATE TABLE IF NOT EXISTS subscriptions (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		kind TEXT NOT NULL,
		recipient TEXT NOT NULL,
		filter TEXT NOT NULL,
		condition_count INTEGER NOT NULL,
		status TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		renewed_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		UNIQUE (kind, recipient, filter)
	)`,
	`CREATE INDEX IF NOT EXISTS subscriptions_live ON subscriptions (kind, condition_count, status, expires_at)`,
	`CREATE INDEX IF NOT EXISTS subscriptions_by_recipient ON subscriptions (recipient, status)`,
	// The inverted index of etherfold ADR-0013: (kind, argument, value) -> subscription,
	// so matching one log against every subscriber is an indexed lookup.
	`CREATE TABLE IF NOT EXISTS subscription_conditions (
		subscription_id INTEGER NOT NULL,
		kind TEXT NOT NULL,
		arg TEXT NOT NULL,
		value TEXT NOT NULL,
		PRIMARY KEY (subscription_id, arg)
	)`,
	`CREATE INDEX IF NOT EXISTS subscription_conditions_lookup ON subscription_conditions (kind, arg, value)`,
];

/** Create every table and index this service uses. Idempotent. */
export async function setupDatabase(db: RemoteSQL): Promise<void> {
	await db.batch(STATEMENTS.map((sql) => db.prepare(sql)));
}
