import {beforeEach, describe, expect, it} from 'vitest';
import type {RemoteSQL, SQLPreparedStatement} from 'remote-sql';
import {toEventSelector, type AbiEvent} from 'viem';
import {
	createConsumer,
	createTriggerService,
	listDeliveries,
	readJournal,
	setupDatabase,
	type CanonicalEntry,
	type CanonicalFeed,
	type CanonicalPage,
	type DeliveryRecord,
	type Matcher,
} from '../src/index.js';
import {memoryDB} from './utils/db.js';

// ---------------------------------------------------------------------------
// AN IDLE ROUND WRITES NOTHING (etherfold ADR-0101), the lease renewal aside.
// ---------------------------------------------------------------------------
// The canonical view hands back a cursor on every page, an empty one included,
// and that cursor carries the stream's high-water `since` mark, so it differs
// from the last one even when the POSITION has not moved. Rewriting it every
// round would cost a metered host one write per app per interval for nothing:
// an empty page is not committed, the older cursor kept, and the next guarded
// commit (a non-empty page, a rewind, a pause) writes the newest one. Writes
// are counted at the `remote-sql` seam.
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

/**
 * A feed shaped like the canonical view: a cursor is `p{position}@{mark}`, the
 * read goes on from the position only, and the mark rises on every read, so an
 * empty page still hands back a cursor that differs from the one presented.
 */
function canonicalLike() {
	const feed = {
		entries: [] as CanonicalEntry[],
		stream: 's',
		generation: 'g',
		mark: 0,
		/** The cursor of every read, and what it returned. */
		reads: [] as {cursor: string | undefined; entries: number}[],
		async read(query: {cursor?: string}): Promise<CanonicalPage> {
			const at = query.cursor === undefined ? 0 : Number(query.cursor.slice(1, query.cursor.indexOf('@')));
			const entries = feed.entries.slice(at);
			feed.mark++;
			feed.reads.push({cursor: query.cursor, entries: entries.length});
			return {
				kind: 'page',
				stream: feed.stream,
				generation: feed.generation,
				entries,
				cursor: `p${at + entries.length}@${feed.mark}`,
				hasMore: false,
			};
		},
	};
	return feed;
}

/** A database that counts what it writes: every `batch`, and every statement run alone that is not a read. */
function counting(db: RemoteSQL): {db: RemoteSQL; writes: string[]} {
	const writes: string[] = [];
	type Wrapped = SQLPreparedStatement & {sql: string; inner: SQLPreparedStatement};
	const wrap = (sql: string, inner: SQLPreparedStatement): Wrapped => ({
		sql,
		inner,
		bind: (...values) => wrap(sql, inner.bind(...values)),
		all: () => {
			if (!/^\s*SELECT\b/i.test(sql)) writes.push(sql);
			return inner.all();
		},
	});
	return {
		writes,
		db: {
			prepare: (sql) => wrap(sql, db.prepare(sql)),
			batch: (list) => {
				const statements = list as Wrapped[];
				writes.push(`batch: ${statements.map((statement) => statement.sql.trim().split(/\s+/)[0]).join(', ')}`);
				return db.batch(statements.map((statement) => statement.inner));
			},
		},
	};
}

let base: RemoteSQL;
let now: number;
beforeEach(async () => {
	base = memoryDB();
	now = T0;
	await setupDatabase(base);
});

async function consumerRow() {
	const {results} = await base
		.prepare(`SELECT cursor, stream, generation, paused FROM consumers WHERE app = 'a'`)
		.all<Record<string, unknown>>();
	return results[0];
}

/** One app's service, one rule firing for every log, over a counting database. */
function service(feed: CanonicalFeed) {
	const counted = counting(base);
	const delivered: DeliveryRecord[] = [];
	const triggers = createTriggerService({
		db: counted.db,
		app: 'a',
		chainId: '1',
		feed,
		gate: async () => 1000,
		clock: () => now,
		definitions: {
			events: {any: {address: ADDRESS, abi: ANY}},
			rules: {
				every: {
					event: 'any',
					recipients: () => '0x01',
					action: 'act',
					key: (log) => `${log.entry.blockNumber}`,
					render: () => ({}),
				},
			},
		},
		actions: {
			act: {
				policy: {maxAttempts: 3, backoff: {initialMs: 1, maxMs: 1}},
				async deliver(delivery) {
					delivered.push(delivery);
					return {kind: 'delivered'};
				},
			},
		},
	});
	return {triggers, writes: counted.writes, delivered};
}

describe('an idle round', () => {
	it('issues no write at all on an app holding a fresh lease', async () => {
		const feed = canonicalLike();
		feed.entries.push(entry(1));
		const {triggers, writes, delivered} = service(feed);
		expect(await triggers.tick()).toMatchObject({lease: 'held', consumed: 1, delivery: {delivered: 1}});
		expect(delivered).toHaveLength(1);
		expect(writes.length).toBeGreaterThan(0);

		// nothing new on the feed, nothing due, the lease fresh: the round reads and writes nothing
		writes.length = 0;
		now += 5_000;
		expect(await triggers.tick()).toMatchObject({lease: 'held', consumed: 0, matched: 0, delivery: {attempted: 0}});
		now += 5_000;
		expect(await triggers.tick()).toMatchObject({lease: 'held', consumed: 0});
		expect(writes).toEqual([]);
		// the feed was read each round all the same
		expect(feed.reads).toHaveLength(3);
	});

	it('keeps the older cursor of an empty page, from which the next read is empty, and the next page writes the newest', async () => {
		const feed = canonicalLike();
		feed.entries.push(entry(1));
		const {triggers, writes} = service(feed);
		await triggers.tick();
		const committed = (await consumerRow())?.cursor;
		expect(committed).toBe('p1@1');

		writes.length = 0;
		await triggers.tick();
		// the page handed back a cursor marked higher, at the same position: it is not written
		expect(feed.reads[1]).toEqual({cursor: 'p1@1', entries: 0});
		expect(writes).toEqual([]);
		expect((await consumerRow())?.cursor).toBe(committed);

		// the read from the older cursor still returns nothing
		await triggers.tick();
		expect(feed.reads[2]).toEqual({cursor: 'p1@1', entries: 0});
		expect(writes).toEqual([]);

		// the first non-empty page afterwards writes the newest cursor
		feed.entries.push(entry(2));
		expect(await triggers.tick()).toMatchObject({lease: 'held', consumed: 1});
		expect(feed.reads[3]).toEqual({cursor: 'p1@1', entries: 1});
		expect((await consumerRow())?.cursor).toBe('p2@4');
		expect(writes.length).toBeGreaterThan(0);
	});

	it('still writes the first page of an app, empty or not: it records the stream and generation followed', async () => {
		const feed = canonicalLike();
		const {triggers} = service(feed);
		await triggers.tick();
		expect(await consumerRow()).toMatchObject({cursor: 'p0@1', stream: 's', generation: 'g', paused: null});
	});
});

// ---------------------------------------------------------------------------
// What an empty page must still commit: a scripted feed, one page per read.
// ---------------------------------------------------------------------------

function scripted(pages: CanonicalPage[]): CanonicalFeed {
	return {
		async read() {
			const page = pages.shift();
			if (!page) throw new Error('the script ran out');
			return page;
		},
	};
}

const everyLog: Matcher = async (log) => [
	{action: 'record', key: `${log.blockHash}:${log.logIndex}`, recipient: '0x01', payload: {}, trigger: 'every-log'},
];

describe('an empty page that is not idle', () => {
	it('a stream change is written', async () => {
		const counted = counting(base);
		const consumer = createConsumer({
			db: counted.db,
			app: 'a',
			chainId: '1',
			feed: scripted([
				{kind: 'page', stream: 's', generation: 'g', entries: [entry(1)], cursor: 'c1', hasMore: false},
				{kind: 'page', stream: 's2', generation: 'g', entries: [], cursor: 'c2', hasMore: false},
			]),
			gate: async () => 1000,
			match: everyLog,
			clock: () => now,
		});
		await consumer.step();
		counted.writes.length = 0;
		expect(await consumer.step()).toMatchObject({kind: 'advanced', entries: 0});
		expect(counted.writes).toHaveLength(1);
		expect(await consumerRow()).toMatchObject({cursor: 'c2', stream: 's2', generation: 'g'});
	});

	it('a rewind is written, the pending deliveries above its fork retracted', async () => {
		const counted = counting(base);
		const consumer = createConsumer({
			db: counted.db,
			app: 'a',
			chainId: '1',
			feed: scripted([
				{kind: 'page', stream: 's', generation: 'g', entries: [entry(1), entry(3)], cursor: 'c1', hasMore: false},
				{kind: 'rewind', stream: 's', generation: 'g', forkBlock: 102, rewindCursor: 'r1'},
			]),
			gate: async () => 1000,
			match: everyLog,
			clock: () => now,
		});
		await consumer.step();
		counted.writes.length = 0;
		expect(await consumer.step()).toMatchObject({kind: 'rewound', forkBlock: 102, retracted: 1});
		expect(counted.writes).toHaveLength(1);
		expect((await consumerRow())?.cursor).toBe('r1');
		expect((await listDeliveries(base, 'a', {status: 'retracted'})).map((d) => d.blockNumber)).toEqual([103]);
		expect((await readJournal(base, 'a')).map((j) => j.kind)).toEqual(['rewind']);
	});

	it('an empty page that says it has more is written, so a round reading on does not read it again', async () => {
		const counted = counting(base);
		const consumer = createConsumer({
			db: counted.db,
			app: 'a',
			chainId: '1',
			feed: scripted([
				{kind: 'page', stream: 's', generation: 'g', entries: [entry(1)], cursor: 'c1', hasMore: false},
				{kind: 'page', stream: 's', generation: 'g', entries: [], cursor: 'c2', hasMore: true},
			]),
			gate: async () => 1000,
			match: everyLog,
			clock: () => now,
		});
		await consumer.step();
		counted.writes.length = 0;
		await consumer.step();
		expect(counted.writes).toHaveLength(1);
		expect((await consumerRow())?.cursor).toBe('c2');
	});
});
