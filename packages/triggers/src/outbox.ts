import type {RemoteSQL, SQLPreparedStatement} from 'remote-sql';

// ---------------------------------------------------------------------------
// THE OUTBOX: one row per delivery a match implies (etherfold ADR-0005, 0009).
// ---------------------------------------------------------------------------

/** Where a delivery stands. Every row ends in one of the last four, recorded. */
export type DeliveryStatus = 'pending' | 'delivered' | 'expired' | 'dead' | 'retracted';

/** What a match asks the outbox to deliver. */
export type NewDelivery = {
	/** The action type, which names the adapter and its delivery policy. */
	action: string;
	/** The semantic idempotency key: unique per app and action among the rows that stand. */
	key: string;
	recipient: string;
	/** Frozen at match time: a retry sends exactly these bytes. */
	payload: unknown;
	/** What produced it, for "why did I get this?" (`subscription:<id>`, `rule:<name>`). */
	trigger: string;
	/** When it is no longer worth sending, in ms since the epoch; absent, never. */
	expiresAt?: number;
};

/** The log a delivery came from. */
export type LogPosition = {
	blockNumber: number;
	blockHash: string;
	logIndex: number;
	transactionHash: string;
};

export type DeliveryRecord = NewDelivery &
	LogPosition & {
		id: number;
		/** The app whose consumer wrote it, and whose adapters alone deliver it (etherfold ADR-0101). */
		app: string;
		status: DeliveryStatus;
		attempts: number;
		createdAt: number;
		nextAttemptAt: number;
		settledAt?: number;
		lastError?: string;
		/** Set on a row a rewind took back AFTER it had been sent: it cannot be unsent. */
		retractedAt?: number;
	};

/**
 * The statement that writes one delivery, or nothing when a standing row holds
 * its key already (a replayed page, a level-triggered rule firing again).
 */
export function insertDeliveryStatement(
	db: RemoteSQL,
	app: string,
	at: number,
	position: LogPosition,
	delivery: NewDelivery,
): SQLPreparedStatement {
	return db
		.prepare(
			`INSERT INTO deliveries (app, action, key, recipient, payload, trigger, block_number, block_hash, log_index,
				transaction_hash, status, attempts, created_at, next_attempt_at, expires_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
			ON CONFLICT DO NOTHING`,
		)
		.bind(
			app,
			delivery.action,
			delivery.key,
			delivery.recipient,
			JSON.stringify(delivery.payload ?? null),
			delivery.trigger,
			position.blockNumber,
			position.blockHash,
			position.logIndex,
			position.transactionHash,
			at,
			at,
			delivery.expiresAt ?? null,
		);
}

type Row = {
	id: number;
	app: string;
	action: string;
	key: string;
	recipient: string;
	payload: string;
	trigger: string;
	block_number: number;
	block_hash: string;
	log_index: number;
	transaction_hash: string;
	status: DeliveryStatus;
	attempts: number;
	created_at: number;
	next_attempt_at: number;
	expires_at: number | null;
	settled_at: number | null;
	last_error: string | null;
	retracted_at: number | null;
};

export function deliveryFromRow(row: Row): DeliveryRecord {
	return {
		id: Number(row.id),
		app: row.app,
		action: row.action,
		key: row.key,
		recipient: row.recipient,
		payload: JSON.parse(row.payload) as unknown,
		trigger: row.trigger,
		blockNumber: Number(row.block_number),
		blockHash: row.block_hash,
		logIndex: Number(row.log_index),
		transactionHash: row.transaction_hash,
		status: row.status,
		attempts: Number(row.attempts),
		createdAt: Number(row.created_at),
		nextAttemptAt: Number(row.next_attempt_at),
		...(row.expires_at === null ? {} : {expiresAt: Number(row.expires_at)}),
		...(row.settled_at === null ? {} : {settledAt: Number(row.settled_at)}),
		...(row.last_error === null ? {} : {lastError: row.last_error}),
		...(row.retracted_at === null ? {} : {retractedAt: Number(row.retracted_at)}),
	};
}

/** One app's outbox, oldest first: what an operator inspects (dead letters, what a rewind took back). */
export async function listDeliveries(
	db: RemoteSQL,
	app: string,
	filter: {status?: DeliveryStatus; action?: string; recipient?: string} = {},
): Promise<DeliveryRecord[]> {
	const clauses: string[] = ['app = ?'];
	const args: unknown[] = [app];
	if (filter.status !== undefined) (clauses.push('status = ?'), args.push(filter.status));
	if (filter.action !== undefined) (clauses.push('action = ?'), args.push(filter.action));
	if (filter.recipient !== undefined) (clauses.push('recipient = ?'), args.push(filter.recipient));
	const {results} = await db
		.prepare(`SELECT * FROM deliveries WHERE ${clauses.join(' AND ')} ORDER BY id`)
		.bind(...args)
		.all<Row>();
	return results.map(deliveryFromRow);
}
