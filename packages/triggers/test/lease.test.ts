import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {RemoteSQL, SQLPreparedStatement} from 'remote-sql';
import {toEventSelector, type AbiEvent} from 'viem';
import {
	createConsumer,
	createDeliverer,
	createLease,
	createTriggerService,
	DEFAULT_LEASE_MS,
	LeaseLostError,
	listDeliveries,
	readJournal,
	setupDatabase,
	type ActionAdapter,
	type CanonicalEntry,
	type CanonicalFeed,
	type CanonicalPage,
	type DeliveryOutcome,
	type DeliveryRecord,
	type GlobalRule,
	type Matcher,
} from '../src/index.js';
import {NO_LEASE_MESSAGE} from '../src/schema.js';
import {memoryDB} from './utils/db.js';

// ---------------------------------------------------------------------------
// TWO TICKERS OF ONE APP NEVER WORK AT ONCE (etherfold ADR-0101): a tick works
// only under the app's lease, held in its `consumers` row. The fence is twofold:
// a deadline checked before each call (renewing under half the lease, stopping
// under the margin), and a lease predicate on every statement a tick commits or
// settles, so a stale holder changes nothing. The clock is injected throughout.
// ---------------------------------------------------------------------------

const ADDRESS = '0x00000000000000000000000000000000000000b0';
const T0 = 1_800_000_000_000;
const ANY: AbiEvent = {type: 'event', name: 'Any', inputs: []};

function entry(n: number): CanonicalEntry {
	return {
		blockNumber: 100 + n,
		blockHash: `0x${(0xa100 + n).toString(16)}`,
		logIndex: 0,
		transactionHash: `0x${n.toString(16).padStart(2, '0')}`,
		transactionIndex: 0,
		address: ADDRESS,
		topics: [toEventSelector(ANY)],
		data: '0x',
	};
}

/** A feed whose pages each hold `perPage` entries; it records the cursor of every read. */
function pagedFeed(pages: number, perPage = 1): CanonicalFeed & {cursors: (string | undefined)[]} {
	const feed = {
		cursors: [] as (string | undefined)[],
		async read(query: {cursor?: string}): Promise<CanonicalPage> {
			feed.cursors.push(query.cursor);
			const at = query.cursor === undefined ? 0 : Number(query.cursor.slice(1));
			const entries = at < pages ? Array.from({length: perPage}, (_, i) => entry(at * perPage + i)) : [];
			return {
				kind: 'page',
				stream: 's',
				generation: 'g',
				entries,
				cursor: `c${Math.min(at + 1, pages)}`,
				hasMore: false,
			};
		},
	};
	return feed;
}

/**
 * A database that counts the statements it runs whose SQL matches (alone or in a batch), and the
 * most parameters any statement bound.
 */
function counting(db: RemoteSQL, pattern: RegExp): {db: RemoteSQL; count: () => number; maxParams: () => number} {
	let count = 0;
	let maxParams = 0;
	type Wrapped = SQLPreparedStatement & {sql: string; inner: SQLPreparedStatement};
	const wrap = (sql: string, inner: SQLPreparedStatement): Wrapped => ({
		sql,
		inner,
		bind: (...values) => {
			maxParams = Math.max(maxParams, values.length);
			return wrap(sql, inner.bind(...values));
		},
		all: () => {
			if (pattern.test(sql)) count++;
			return inner.all();
		},
	});
	return {
		count: () => count,
		maxParams: () => maxParams,
		db: {
			prepare: (sql) => wrap(sql, db.prepare(sql)),
			batch: (list) => {
				const statements = list as Wrapped[];
				count += statements.filter((statement) => pattern.test(statement.sql)).length;
				return db.batch(statements.map((statement) => statement.inner));
			},
		},
	};
}

const ACQUIRE = /excluded\.lease_owner/;

let db: RemoteSQL;
let now: number;
beforeEach(async () => {
	db = memoryDB();
	now = T0;
	await setupDatabase(db);
});

/** One app's service: one rule firing for every log, its deliveries recorded in `delivered`. */
function service(
	options: {
		feed?: CanonicalFeed;
		db?: RemoteSQL;
		clock?: () => number;
		delivered?: DeliveryRecord[];
		predicate?: GlobalRule['predicate'];
		deliver?: (delivery: DeliveryRecord) => Promise<DeliveryOutcome>;
		gate?: () => Promise<number>;
		leaseMs?: number;
		callTimeoutMs?: number;
	} = {},
) {
	const delivered = options.delivered ?? [];
	const action: ActionAdapter = {
		policy: {maxAttempts: 3, backoff: {initialMs: 1, maxMs: 1}},
		async deliver(delivery) {
			delivered.push(delivery);
			return options.deliver ? options.deliver(delivery) : {kind: 'delivered'};
		},
	};
	const triggers = createTriggerService({
		db: options.db ?? db,
		app: 'a',
		chainId: '1',
		feed: options.feed ?? pagedFeed(1, 3),
		gate: options.gate ?? (async () => 1000),
		clock: options.clock ?? (() => now),
		definitions: {
			events: {any: {address: ADDRESS, abi: ANY}},
			rules: {
				every: {
					event: 'any',
					recipients: () => '0x01',
					...(options.predicate ? {predicate: options.predicate} : {}),
					action: 'act',
					key: (log) => `${log.entry.blockNumber}`,
					render: () => ({}),
				},
			},
		},
		actions: {act: action},
		...(options.leaseMs === undefined ? {} : {leaseMs: options.leaseMs}),
		...(options.callTimeoutMs === undefined ? {} : {callTimeoutMs: options.callTimeoutMs}),
	});
	return {triggers, delivered};
}

async function consumerRow() {
	const {results} = await db
		.prepare(`SELECT cursor, stream, generation, paused, lease_owner, lease_expires FROM consumers WHERE app = 'a'`)
		.all<Record<string, unknown>>();
	return results[0];
}

/** Every row a tick may write, the lease columns aside: what a stale holder must leave unchanged. */
async function snapshot() {
	const [deliveries, journal, consumers, subscriptions] = await db.batch([
		db.prepare(`SELECT * FROM deliveries ORDER BY id`),
		db.prepare(`SELECT * FROM journal ORDER BY id`),
		db.prepare(`SELECT app, cursor, stream, generation, paused, updated_at FROM consumers ORDER BY app`),
		db.prepare(`SELECT * FROM subscriptions ORDER BY id`),
	]);
	return {deliveries, journal, consumers, subscriptions};
}

describe('the lease', () => {
	it("is created with the app's consumer row on its first tick, and held", async () => {
		const {triggers} = service();
		expect(await consumerRow()).toBeUndefined();
		expect(await triggers.tick()).toMatchObject({lease: 'held', consumed: 3});
		expect(await consumerRow()).toMatchObject({
			lease_owner: triggers.lease.owner,
			lease_expires: T0 + DEFAULT_LEASE_MS,
		});
	});

	it('two services ticked concurrently deliver each due row once; the one without the lease does nothing', async () => {
		const delivered: DeliveryRecord[] = [];
		const feeds = [pagedFeed(1, 3), pagedFeed(1, 3)];
		const services = feeds.map((feed) => service({feed, delivered}).triggers);
		const spies = services.map((triggers) => ({
			expire: vi.spyOn(triggers.registry, 'expire'),
			deliverDue: vi.spyOn(triggers.deliverer, 'deliverDue'),
		}));

		const reports = await Promise.all(services.map((triggers) => triggers.tick()));
		const winner = reports.findIndex((report) => report.lease === 'held');
		const loser = 1 - winner;
		expect(winner).toBeGreaterThanOrEqual(0);
		expect(reports[loser]).toEqual({lease: 'not-leased'});
		expect(spies[loser]!.expire).not.toHaveBeenCalled();
		expect(spies[loser]!.deliverDue).not.toHaveBeenCalled();
		expect(feeds[loser]!.cursors).toEqual([]);

		// and again, for whatever the first round left: still one ticker
		await Promise.all(services.map((triggers) => triggers.tick()));
		expect(delivered.map((d) => d.key).sort()).toEqual(['100', '101', '102']);
		expect((await listDeliveries(db, 'a', {status: 'delivered'})).length).toBe(3);
	});

	it('is taken over by another ticker once the holder stops renewing and it lapses', async () => {
		const first = service().triggers;
		const second = service({feed: pagedFeed(2, 1)}).triggers;
		expect((await first.tick()).lease).toBe('held');

		now = T0 + DEFAULT_LEASE_MS / 2;
		expect(await second.tick()).toEqual({lease: 'not-leased'});
		now = T0 + DEFAULT_LEASE_MS; // not yet lapsed: it lasts until its expiry
		expect(await second.tick()).toEqual({lease: 'not-leased'});
		now = T0 + DEFAULT_LEASE_MS + 1;
		expect((await second.tick()).lease).toBe('held');
		expect((await consumerRow())?.['lease_owner']).toBe(second.lease.owner);
		// the first, ticking again, finds it taken
		expect(await first.tick()).toEqual({lease: 'not-leased'});
	});

	it('a released lease is taken at once, and a gracefully stopped `run` releases it', async () => {
		const first = service().triggers;
		const controller = new AbortController();
		const running = first.run({
			signal: controller.signal,
			intervalMs: 1,
			onError: (error) => {
				throw error;
			},
		});
		await vi.waitFor(async () => expect((await consumerRow())?.['lease_owner']).toBe(first.lease.owner));
		controller.abort();
		await running;
		expect((await consumerRow())?.['lease_expires']).toBe(0);

		const next = service().triggers;
		expect((await next.tick()).lease).toBe('held');
	});

	it('a `run` ticking every 5 s on a fresh lease writes it about once per half-lease, not once per tick', async () => {
		const counted = counting(db, ACQUIRE);
		const controller = new AbortController();
		let ticks = 0;
		const {triggers} = service({
			db: counted.db,
			feed: pagedFeed(0),
			// each round's gate is 5 s after the last
			gate: async () => {
				now += 5_000;
				if (++ticks === 24) controller.abort();
				return 1000;
			},
		});
		await triggers.run({
			signal: controller.signal,
			intervalMs: 1,
			onError: (error) => {
				throw error;
			},
		});
		expect(ticks).toBe(24);
		// two minutes of rounds: the first acquire, then a renewal each time under half the lease is left
		expect(counted.count()).toBeLessThanOrEqual(1 + Math.ceil((24 * 5_000) / (DEFAULT_LEASE_MS / 2)));
		expect(counted.count()).toBeGreaterThanOrEqual(2);
	});

	it('is renewed mid-page when a page of several predicates falls under half of it', async () => {
		const counted = counting(db, ACQUIRE);
		let invoked = 0;
		const {triggers, delivered} = service({
			db: counted.db,
			// three predicates of 20 s each: the third starts with 20 s of the 60 s left
			predicate: async () => {
				invoked++;
				now += 20_000;
				return true;
			},
		});
		const report = await triggers.tick();
		expect(report).toMatchObject({lease: 'held', consumed: 3, matched: 3});
		expect(invoked).toBe(3);
		expect(counted.count()).toBe(2); // the tick's acquire, and the renewal before the third predicate
		expect((await consumerRow())?.['lease_expires']).toBe(T0 + 40_000 + DEFAULT_LEASE_MS);
		expect(delivered).toHaveLength(3);
		// every statement fits D1's 100 bound parameters
		expect(counted.maxParams()).toBeLessThanOrEqual(100);
	});

	it('a tick under the margin stops before its next call, whether a predicate or a delivery', async () => {
		let invoked = 0;
		const rival = createLease({db, app: 'a', clock: () => now, callTimeoutMs: 10_000});
		const {triggers, delivered} = service({
			predicate: async () => {
				invoked++;
				// the predicate outlives the lease, and another ticker takes it
				now += DEFAULT_LEASE_MS + 1;
				expect(await rival.acquire()).toBe(true);
				return true;
			},
		});
		const report = await triggers.tick();
		expect(report).toMatchObject({lease: 'lost'});
		expect(invoked).toBe(1);
		expect(delivered).toEqual([]);
		expect(await listDeliveries(db, 'a')).toEqual([]);
		expect((await consumerRow())?.['cursor']).toBeNull();

		// a delivery: the attempt in flight outlives the lease, and the next is not started
		db = memoryDB();
		await setupDatabase(db);
		now = T0;
		const takeover = createLease({db, app: 'a', clock: () => now, callTimeoutMs: 10_000});
		const second = service({
			deliver: async () => {
				now += DEFAULT_LEASE_MS + 1;
				await takeover.acquire();
				return {kind: 'delivered'};
			},
		});
		expect(await second.triggers.tick()).toMatchObject({lease: 'lost'});
		expect(second.delivered).toHaveLength(1);
		// its settle wrote nothing: the new holder sends it again, which its idempotency key absorbs
		expect((await listDeliveries(db, 'a', {status: 'pending'})).length).toBe(3);
	});

	it('a stale holder changes nothing: not a page of deliveries, a rewind, a cursor, nor a settle', async () => {
		// the stale holder's clock is behind: its deadline never warns it, only the commit's guard can
		const staleClock = () => T0;
		const stale = createLease({db, app: 'a', clock: staleClock, callTimeoutMs: 10_000});
		const fresh = createLease({db, app: 'a', clock: () => T0 + DEFAULT_LEASE_MS + 1, callTimeoutMs: 10_000});
		const takeOver = async () => {
			expect(await fresh.acquire()).toBe(true);
		};
		const handover = async () => {
			// the fresh one hands the lease back, so the stale one starts its next step holding it
			await fresh.release();
			expect(await stale.acquire()).toBe(true);
		};

		let answer: CanonicalPage = {
			kind: 'page',
			stream: 's',
			generation: 'g',
			entries: [entry(0), entry(1)],
			cursor: 'c1',
			hasMore: false,
		};
		let duringGate: () => Promise<void> = async () => {};
		const everyLog: Matcher = async (log) => [
			{action: 'act', key: `${log.blockNumber}`, recipient: '0x01', payload: {}, trigger: 't'},
		];
		const consumer = createConsumer({
			db,
			app: 'a',
			chainId: '1',
			feed: {read: async () => answer},
			gate: async () => (await duringGate(), 1000),
			match: everyLog,
			clock: staleClock,
			lease: stale,
		});
		expect(await stale.acquire()).toBe(true);
		expect(await consumer.step()).toMatchObject({kind: 'advanced', deliveries: 2});

		// a page with deliveries and a cursor, taken over while the gate answers
		await handover();
		answer = {kind: 'page', stream: 's', generation: 'g', entries: [entry(2)], cursor: 'c2', hasMore: false};
		duringGate = takeOver;
		let before = await snapshot();
		await expect(consumer.step()).rejects.toBeInstanceOf(LeaseLostError);
		expect(await snapshot()).toEqual(before);

		// a rewind of both pending deliveries, taken over the same way
		await handover();
		answer = {kind: 'rewind', stream: 's', forkBlock: 100, rewindCursor: 'c0'};
		before = await snapshot();
		await expect(consumer.step()).rejects.toBeInstanceOf(LeaseLostError);
		expect(await snapshot()).toEqual(before);
		expect(await readJournal(db, 'a', {kind: 'rewind'})).toEqual([]);

		// a settle of a delivery, taken over while it is attempted
		await handover();
		const deliverer = createDeliverer({
			db,
			app: 'a',
			clock: staleClock,
			lease: stale,
			actions: {
				act: {
					policy: {maxAttempts: 3, backoff: {initialMs: 1, maxMs: 1}},
					deliver: async () => (await takeOver(), {kind: 'delivered'}),
				},
			},
		});
		before = await snapshot();
		await expect(deliverer.deliverDue()).rejects.toBeInstanceOf(LeaseLostError);
		expect(await snapshot()).toEqual(before);
		expect((await listDeliveries(db, 'a', {status: 'pending'})).map((d) => d.attempts)).toEqual([0, 0]);
	});

	it("an operator's `resume` to a new stream's start is not undone by the ticker's next renewal", async () => {
		const cursors: (string | undefined)[] = [];
		const feed: CanonicalFeed = {
			async read(query) {
				cursors.push(query.cursor);
				if (query.cursor === undefined) {
					return {kind: 'refused', status: 409, error: 'stream-mismatch', body: {startCursor: 'start'}};
				}
				return {kind: 'page', stream: 's2', generation: 'g', entries: [], cursor: query.cursor, hasMore: false};
			},
		};
		const ticker = service({feed}).triggers;
		expect(await ticker.tick()).toMatchObject({lease: 'held', paused: true});

		// the operator's process resumes it, with no lease (a person's row-level action)
		const operator = service({feed}).triggers;
		await operator.consumer.resume();
		expect((await consumerRow())?.['cursor']).toBe('start');

		// the ticker's next tick renews its lease first, and follows the operator's cursor
		now += DEFAULT_LEASE_MS / 2 + 1;
		expect(await ticker.tick()).toMatchObject({lease: 'held', paused: false});
		expect(await consumerRow()).toMatchObject({cursor: 'start', stream: 's2', lease_owner: ticker.lease.owner});
		expect(cursors).toEqual([undefined, 'start']);
	});

	it('refuses a per-call timeout whose fence margin is not under half the lease, naming both', () => {
		expect(() => service({callTimeoutMs: 20_000})).toThrow(/20000 ms.*60000 ms/);
		expect(() => service({leaseMs: 40_000})).toThrow(/10000 ms.*40000 ms/);
		expect(() => service({callTimeoutMs: 20_000, leaseMs: 61_000})).not.toThrow();
		expect(() => service({callTimeoutMs: 19_999})).not.toThrow();
	});

	it('refuses a database whose consumers table has no lease', async () => {
		const old = memoryDB();
		await old.batch([
			old.prepare(
				`CREATE TABLE consumers (app TEXT PRIMARY KEY, cursor TEXT, stream TEXT, generation TEXT, paused TEXT, updated_at INTEGER NOT NULL)`,
			),
		]);
		await expect(setupDatabase(old)).rejects.toThrow(NO_LEASE_MESSAGE);
	});
});
