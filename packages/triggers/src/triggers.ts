import type {RemoteSQL} from 'remote-sql';
import {decodeEventLog, toEventSelector, type AbiEvent} from 'viem';
import type {MatchContext, Matcher} from './consumer.js';
import type {CanonicalEntry} from './feed.js';
import {journalStatement} from './journal.js';
import type {NewDelivery} from './outbox.js';
import {setupDatabase} from './schema.js';

// ---------------------------------------------------------------------------
// TRIGGERS: conditions are data, predicates and actions are code (etherfold
// ADR-0013), in its two archetypes.
// ---------------------------------------------------------------------------
// The operator declares what can be decoded (EVENTS), what a user may register
// (SUBSCRIPTION KINDS) and what fires on its own (GLOBAL RULES). A user only
// ever registers DATA: a kind's name and values for the arguments that kind lets
// them filter on, compared against the log's DECODED arguments through the
// inverted index `(kind, arg, value) -> subscription`.
// ---------------------------------------------------------------------------

/** An event the service can decode: where it is emitted and its ABI. */
export type EventDefinition = {address: string; abi: AbiEvent};

/** A log decoded against its event definition, as triggers see it. */
export type DecodedLog = {
	/** The key of its event definition. */
	event: string;
	/** Decoded arguments, by name (viem's decoding: addresses checksummed, integers as bigint). */
	args: Record<string, unknown>;
	entry: CanonicalEntry;
	chainId: string;
};

/** What a user may register: a subscription trigger's shape, the operator's. */
export type SubscriptionKind = {
	event: string;
	/** Arguments a registration may constrain to a value (equality on the decoded value). */
	filterable?: string[];
	/** The argument naming who caused the log: a subscriber is not told of their own (S2-3). */
	notFrom?: string;
	/** The action type delivering it. */
	action: string;
	/** The frozen payload (operator code, never the user's). */
	render: (log: DecodedLog, recipient: string) => unknown;
	/** How long a registration lives unless renewed (etherfold ADR-0012); 90 days when absent. */
	ttlMs?: number;
};

/** One rule over every log of an event, whose recipient is computed. */
export type GlobalRule = {
	event: string;
	/** Who it is for: an address, several, or nobody. */
	recipients: (log: DecodedLog) => string | string[] | undefined;
	/** Whether it fires for that recipient (level-triggered: the key absorbs repeats). */
	predicate?: (log: DecodedLog, recipient: string) => boolean | Promise<boolean>;
	action: string;
	/** The SEMANTIC idempotency key (ADR-0009); the log's position and the recipient when absent. */
	key?: (log: DecodedLog, recipient: string) => string;
	render: (log: DecodedLog, recipient: string) => unknown;
};

export type TriggerDefinitions = {
	events: Record<string, EventDefinition>;
	subscriptions?: Record<string, SubscriptionKind>;
	rules?: Record<string, GlobalRule>;
};

/** Checks a set of definitions once, at startup, so a typo fails there and not on the first log. */
export function defineTriggers<T extends TriggerDefinitions>(definitions: T): T {
	const {events, subscriptions = {}, rules = {}} = definitions;
	for (const [name, event] of Object.entries(events)) {
		if (event.abi.type !== 'event') throw new Error(`event "${name}": its abi is not an event`);
	}
	const argsOf = (event: string, owner: string): Set<string> => {
		const definition = events[event];
		if (!definition) throw new Error(`${owner}: names the event "${event}", which is not declared`);
		return new Set(definition.abi.inputs.map((input) => input.name ?? ''));
	};
	for (const [name, kind] of Object.entries(subscriptions)) {
		const args = argsOf(kind.event, `subscription kind "${name}"`);
		for (const arg of [...(kind.filterable ?? []), ...(kind.notFrom ? [kind.notFrom] : [])]) {
			if (!args.has(arg))
				throw new Error(`subscription kind "${name}": "${arg}" is not an argument of "${kind.event}"`);
		}
	}
	for (const [name, rule] of Object.entries(rules)) argsOf(rule.event, `rule "${name}"`);
	return definitions;
}

/** A registration refused, with a code an HTTP surface can map. */
export class RegistrationError extends Error {
	constructor(
		readonly code: 'unknown-kind' | 'invalid-filter' | 'quota-exceeded',
		message: string,
	) {
		super(message);
		this.name = 'RegistrationError';
	}
}

export type SubscriptionStatus = 'active' | 'expired' | 'cancelled';

export type Subscription = {
	id: number;
	kind: string;
	recipient: string;
	filter: Record<string, string>;
	status: SubscriptionStatus;
	createdAt: number;
	renewedAt: number;
	expiresAt: number;
};

export type TriggerRegistry = {
	setup(): Promise<void>;
	/** Register, or renew when the same `(kind, recipient, filter)` exists: never a second one. */
	subscribe(request: {recipient: string; kind: string; filter?: Record<string, string>}): Promise<Subscription>;
	/** Renew every live or expired registration of a recipient (ADR-0012: renewal is per subscriber). */
	renewAll(recipient: string): Promise<number>;
	unsubscribe(request: {recipient: string; kind: string; filter?: Record<string, string>}): Promise<boolean>;
	list(recipient: string): Promise<Subscription[]>;
	/** Mark what is past its expiry as expired, one journal entry each (never a quiet DELETE). */
	expire(): Promise<number>;
	/** The consumer's matcher over both archetypes. */
	matcher(options?: {onUndecodable?: (entry: CanonicalEntry, error: unknown) => void}): Matcher;
};

const DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_QUOTA = 100;

/** A decoded value as the index stores it: lowercase hex, decimal integers. */
export function normaliseValue(value: unknown): string {
	if (typeof value === 'string') return /^0x[0-9a-fA-F]*$/.test(value) ? value.toLowerCase() : value;
	if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') return String(value);
	return JSON.stringify(value);
}

function canonicalFilter(filter: Record<string, string>): string {
	return JSON.stringify(Object.fromEntries(Object.entries(filter).sort(([a], [b]) => (a < b ? -1 : 1))));
}

type SubscriptionRow = {
	id: number;
	kind: string;
	recipient: string;
	filter: string;
	status: SubscriptionStatus;
	created_at: number;
	renewed_at: number;
	expires_at: number;
};

function subscriptionFromRow(row: SubscriptionRow): Subscription {
	return {
		id: Number(row.id),
		kind: row.kind,
		recipient: row.recipient,
		filter: JSON.parse(row.filter) as Record<string, string>,
		status: row.status,
		createdAt: Number(row.created_at),
		renewedAt: Number(row.renewed_at),
		expiresAt: Number(row.expires_at),
	};
}

export function createTriggerRegistry(options: {
	db: RemoteSQL;
	definitions: TriggerDefinitions;
	clock?: () => number;
	maxSubscriptionsPerRecipient?: number;
}): TriggerRegistry {
	const {db, definitions} = options;
	const kinds = definitions.subscriptions ?? {};
	const rules = definitions.rules ?? {};
	const clock = options.clock ?? Date.now;
	const quota = options.maxSubscriptionsPerRecipient ?? DEFAULT_QUOTA;

	// (address, topic0) -> the event's key, for decoding
	const byLog = new Map<string, {name: string; definition: EventDefinition}>();
	for (const [name, definition] of Object.entries(definitions.events)) {
		byLog.set(`${definition.address.toLowerCase()}:${toEventSelector(definition.abi)}`, {name, definition});
	}
	const kindsOf = new Map<string, [string, SubscriptionKind][]>();
	const rulesOf = new Map<string, [string, GlobalRule][]>();
	for (const entry of Object.entries(kinds))
		kindsOf.set(entry[1].event, [...(kindsOf.get(entry[1].event) ?? []), entry]);
	for (const entry of Object.entries(rules))
		rulesOf.set(entry[1].event, [...(rulesOf.get(entry[1].event) ?? []), entry]);

	function validated(request: {recipient: string; kind: string; filter?: Record<string, string>}) {
		const kind = kinds[request.kind];
		if (!kind) throw new RegistrationError('unknown-kind', `no subscription kind is named "${request.kind}"`);
		const allowed = new Set(kind.filterable ?? []);
		const filter: Record<string, string> = {};
		for (const [arg, value] of Object.entries(request.filter ?? {})) {
			if (!allowed.has(arg)) {
				throw new RegistrationError(
					'invalid-filter',
					`"${request.kind}" does not let a registration filter on "${arg}"`,
				);
			}
			if (typeof value !== 'string')
				throw new RegistrationError('invalid-filter', `the value for "${arg}" is not a string`);
			filter[arg] = normaliseValue(value);
		}
		return {kind, recipient: request.recipient.toLowerCase(), filter, filterKey: canonicalFilter(filter)};
	}

	async function find(kind: string, recipient: string, filterKey: string): Promise<Subscription | undefined> {
		const {results} = await db
			.prepare(`SELECT * FROM subscriptions WHERE kind = ? AND recipient = ? AND filter = ?`)
			.bind(kind, recipient, filterKey)
			.all<SubscriptionRow>();
		return results[0] && subscriptionFromRow(results[0]);
	}

	async function matchSubscriptions(log: DecodedLog, context: MatchContext): Promise<NewDelivery[]> {
		const deliveries: NewDelivery[] = [];
		const now = clock();
		for (const [kindName, kind] of kindsOf.get(log.event) ?? []) {
			const conditions = (kind.filterable ?? []).map((arg) => [arg, normaliseValue(log.args[arg])] as const);
			const live = `s.status = 'active' AND s.expires_at > ?`;
			const unfiltered = db
				.prepare(`SELECT s.id, s.recipient FROM subscriptions s WHERE s.kind = ? AND s.condition_count = 0 AND ${live}`)
				.bind(kindName, now);
			const found = (await unfiltered.all<{id: number; recipient: string}>()).results;
			if (conditions.length > 0) {
				const any = conditions.map(() => `(c.arg = ? AND c.value = ?)`).join(' OR ');
				const filtered = db
					.prepare(
						`SELECT s.id, s.recipient FROM subscription_conditions c JOIN subscriptions s ON s.id = c.subscription_id
						WHERE c.kind = ? AND (${any}) AND ${live}
						GROUP BY s.id HAVING COUNT(*) = s.condition_count`,
					)
					.bind(kindName, ...conditions.flat(), now);
				found.push(...(await filtered.all<{id: number; recipient: string}>()).results);
			}
			const sender = kind.notFrom === undefined ? undefined : normaliseValue(log.args[kind.notFrom]);
			for (const {id, recipient} of found) {
				if (recipient === sender) continue;
				deliveries.push({
					action: kind.action,
					// S2-3's key. Positional, which etherfold ADR-0007 warns against, and right on the
					// safe lane only: at finality a log is never re-mined at other coordinates.
					key: `${context.chainId}:${log.entry.blockHash}:${log.entry.logIndex}:${recipient}`,
					recipient,
					payload: kind.render(log, recipient),
					trigger: `subscription:${id}`,
				});
			}
		}
		return deliveries;
	}

	async function matchRules(log: DecodedLog, context: MatchContext): Promise<NewDelivery[]> {
		const deliveries: NewDelivery[] = [];
		for (const [ruleName, rule] of rulesOf.get(log.event) ?? []) {
			const computed = rule.recipients(log);
			const recipients = computed === undefined ? [] : Array.isArray(computed) ? computed : [computed];
			for (const raw of recipients) {
				const recipient = raw.toLowerCase();
				if (rule.predicate && !(await rule.predicate(log, recipient))) continue;
				deliveries.push({
					action: rule.action,
					key:
						rule.key?.(log, recipient) ??
						`rule:${ruleName}:${context.chainId}:${log.entry.blockHash}:${log.entry.logIndex}:${recipient}`,
					recipient,
					payload: rule.render(log, recipient),
					trigger: `rule:${ruleName}`,
				});
			}
		}
		return deliveries;
	}

	return {
		setup: () => setupDatabase(db),

		async subscribe(request) {
			const {kind, recipient, filter, filterKey} = validated(request);
			const existing = await find(request.kind, recipient, filterKey);
			if (!existing || existing.status !== 'active') {
				const {results} = await db
					.prepare(`SELECT COUNT(*) AS n FROM subscriptions WHERE recipient = ? AND status = 'active'`)
					.bind(recipient)
					.all<{n: number}>();
				if (Number(results[0]?.n ?? 0) >= quota) {
					throw new RegistrationError('quota-exceeded', `${recipient} already has ${quota} live subscriptions`);
				}
			}
			const now = clock();
			const expiresAt = now + (kind.ttlMs ?? DEFAULT_TTL_MS);
			const conditions = Object.entries(filter);
			await db.batch([
				db
					.prepare(
						`INSERT INTO subscriptions (kind, recipient, filter, condition_count, status, created_at, renewed_at, expires_at)
						VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
						ON CONFLICT (kind, recipient, filter) DO UPDATE SET status = 'active', renewed_at = excluded.renewed_at,
							expires_at = excluded.expires_at`,
					)
					.bind(request.kind, recipient, filterKey, conditions.length, now, now, expiresAt),
				...conditions.map(([arg, value]) =>
					db
						.prepare(
							`INSERT INTO subscription_conditions (subscription_id, kind, arg, value)
							SELECT id, kind, ?, ? FROM subscriptions WHERE kind = ? AND recipient = ? AND filter = ?
							ON CONFLICT DO NOTHING`,
						)
						.bind(arg, value, request.kind, recipient, filterKey),
				),
			]);
			return (await find(request.kind, recipient, filterKey)) as Subscription;
		},

		async renewAll(recipient) {
			const owner = recipient.toLowerCase();
			const now = clock();
			const renewable = (
				await db
					.prepare(`SELECT * FROM subscriptions WHERE recipient = ? AND status != 'cancelled'`)
					.bind(owner)
					.all<SubscriptionRow>()
			).results;
			if (renewable.length === 0) return 0;
			await db.batch(
				renewable.map((row) =>
					db
						.prepare(`UPDATE subscriptions SET status = 'active', renewed_at = ?, expires_at = ? WHERE id = ?`)
						.bind(now, now + (kinds[row.kind]?.ttlMs ?? DEFAULT_TTL_MS), row.id),
				),
			);
			return renewable.length;
		},

		async unsubscribe(request) {
			const {recipient, filterKey} = validated(request);
			const existing = await find(request.kind, recipient, filterKey);
			if (!existing || existing.status === 'cancelled') return false;
			await db
				.prepare(`UPDATE subscriptions SET status = 'cancelled', renewed_at = ? WHERE id = ?`)
				.bind(clock(), existing.id)
				.all();
			return true;
		},

		async list(recipient) {
			const {results} = await db
				.prepare(`SELECT * FROM subscriptions WHERE recipient = ? ORDER BY id`)
				.bind(recipient.toLowerCase())
				.all<SubscriptionRow>();
			return results.map(subscriptionFromRow);
		},

		async expire() {
			const now = clock();
			const due = (
				await db
					.prepare(`SELECT * FROM subscriptions WHERE status = 'active' AND expires_at <= ?`)
					.bind(now)
					.all<SubscriptionRow>()
			).results;
			if (due.length === 0) return 0;
			await db.batch(
				due.flatMap((row) => [
					db.prepare(`UPDATE subscriptions SET status = 'expired' WHERE id = ? AND status = 'active'`).bind(row.id),
					journalStatement(db, now, 'expired', {
						subscription: Number(row.id),
						kind: row.kind,
						recipient: row.recipient,
						expiresAt: Number(row.expires_at),
					}),
				]),
			);
			return due.length;
		},

		matcher(matcherOptions = {}) {
			const onUndecodable =
				matcherOptions.onUndecodable ??
				((entry: CanonicalEntry, error: unknown) =>
					console.error(`undecodable log ${entry.blockHash}:${entry.logIndex}`, error));
			return async (entry, context) => {
				const known = byLog.get(`${entry.address.toLowerCase()}:${entry.topics[0]?.toLowerCase()}`);
				if (!known) return [];
				let args: Record<string, unknown>;
				try {
					const decoded = decodeEventLog({
						abi: [known.definition.abi],
						topics: entry.topics as [`0x${string}`, ...`0x${string}`[]],
						data: entry.data as `0x${string}`,
						strict: true,
					});
					args = (decoded.args ?? {}) as Record<string, unknown>;
				} catch (error) {
					onUndecodable(entry, error);
					return [];
				}
				const log: DecodedLog = {event: known.name, args, entry, chainId: context.chainId};
				return [...(await matchSubscriptions(log, context)), ...(await matchRules(log, context))];
			};
		},
	};
}
