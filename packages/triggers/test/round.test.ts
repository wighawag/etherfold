import {beforeEach, describe, expect, it} from 'vitest';
import type {RemoteSQL} from 'remote-sql';
import {
	createConsumer,
	createTriggerService,
	listDeliveries,
	readJournal,
	type ActionAdapter,
	type CanonicalEntry,
	type CanonicalFeed,
	type CanonicalPage,
	type DeliveryRecord,
} from '../src/index.js';
import {insertDeliveryStatement} from '../src/outbox.js';
import {memoryDB} from './utils/db.js';

// ---------------------------------------------------------------------------
// A ROUND IS BOUNDED (etherfold ADR-0101): one app's round reads at most
// `maxPagesPerRound` pages of its feed and takes at most
// `maxDeliveriesPerRound` due deliveries, so one app's backlog holds that app's
// round for a bounded time and its next round goes on from there. A round that
// reaches the page bound returns normally, says more remains, and is not a
// stall.
// ---------------------------------------------------------------------------

const ADDRESS = '0x00000000000000000000000000000000000000b0';

function entry(n: number): CanonicalEntry {
	return {
		blockNumber: 100 + n,
		blockHash: `0x${(0xa100 + n).toString(16)}`,
		logIndex: 0,
		transactionHash: `0x${n.toString(16).padStart(2, '0')}`,
		transactionIndex: 0,
		address: ADDRESS,
		topics: ['0x00'],
		data: '0x',
	};
}

/** A feed of `pages` pages of one entry each, each answering the cursor of the page before. */
function pagedFeed(pages: number): CanonicalFeed & {reads: number} {
	const feed = {
		reads: 0,
		async read(query: {cursor?: string}): Promise<CanonicalPage> {
			feed.reads++;
			const at = query.cursor === undefined ? 0 : Number(query.cursor.slice(1));
			return {
				kind: 'page',
				stream: 's',
				generation: 'g',
				entries: at < pages ? [entry(at)] : [],
				cursor: `c${Math.min(at + 1, pages)}`,
				hasMore: at + 1 < pages,
			};
		},
	};
	return feed;
}

/** A feed that always says more remains: what the unbounded guard exists for. */
const endlessFeed: CanonicalFeed = {
	async read(query) {
		const at = query.cursor === undefined ? 0 : Number(query.cursor.slice(1));
		return {kind: 'page', stream: 's', generation: 'g', entries: [], cursor: `c${at + 1}`, hasMore: true};
	},
};

let db: RemoteSQL;
beforeEach(() => {
	db = memoryDB();
});

describe("a consumer's catch-up", () => {
	it('stops at `maxPages`, saying more remains, and the next one goes on from there', async () => {
		const feed = pagedFeed(5);
		const consumer = createConsumer({db, app: 'a', chainId: '1', feed, gate: async () => 1000, match: async () => []});
		await consumer.setup();

		const first = await consumer.catchUp({maxPages: 2});
		expect(first).toMatchObject({steps: 2, entries: 2, hasMore: true});
		expect(feed.reads).toBe(2);
		expect((await consumer.status()).cursor).toBe('c2');

		const second = await consumer.catchUp({maxPages: 2});
		expect(second).toMatchObject({steps: 2, entries: 2, hasMore: true});
		const third = await consumer.catchUp({maxPages: 2});
		expect(third).toMatchObject({steps: 1, entries: 1, hasMore: false});
	});

	it('unbounded, still refuses a feed that never says it is done', async () => {
		const consumer = createConsumer({
			db,
			app: 'a',
			chainId: '1',
			feed: endlessFeed,
			gate: async () => 1000,
			match: async () => [],
		});
		await consumer.setup();
		await expect(consumer.catchUp()).rejects.toThrow(/never reported itself caught up/);
		// and bounded, the same feed is no failure at all
		await expect(consumer.catchUp({maxPages: 3})).resolves.toMatchObject({steps: 3, hasMore: true});
	});
});

describe("a service's round", () => {
	function service(options: {feed: CanonicalFeed; maxPagesPerRound?: number; maxDeliveriesPerRound?: number}) {
		const delivered: DeliveryRecord[] = [];
		const action: ActionAdapter = {
			policy: {maxAttempts: 3, backoff: {initialMs: 1, maxMs: 1}},
			async deliver(delivery) {
				delivered.push(delivery);
				return {kind: 'delivered'};
			},
		};
		const triggers = createTriggerService({
			db,
			app: 'a',
			chainId: '1',
			feed: options.feed,
			gate: async () => 1000,
			definitions: {
				events: {
					any: {
						address: ADDRESS,
						abi: {type: 'event', name: 'Any', inputs: []},
					},
				},
			},
			actions: {act: action},
			...(options.maxPagesPerRound === undefined ? {} : {maxPagesPerRound: options.maxPagesPerRound}),
			...(options.maxDeliveriesPerRound === undefined ? {} : {maxDeliveriesPerRound: options.maxDeliveriesPerRound}),
		});
		return {triggers, delivered};
	}

	it('reads at most `maxPagesPerRound` pages, reports that more remain, and journals no stall', async () => {
		const feed = pagedFeed(5);
		const {triggers} = service({feed, maxPagesPerRound: 2});
		await triggers.setup();
		expect(await triggers.tick()).toMatchObject({consumed: 2, hasMore: true});
		expect(await triggers.tick()).toMatchObject({consumed: 2, hasMore: true});
		expect(await triggers.tick()).toMatchObject({consumed: 1, hasMore: false});
		expect(await readJournal(db, 'a', {kind: 'stalled'})).toEqual([]);
	});

	it('a feed that never says it is done is followed round after round, never journalled as a stall', async () => {
		const {triggers} = service({feed: endlessFeed, maxPagesPerRound: 4});
		await triggers.setup();
		for (let round = 0; round < 3; round++) await expect(triggers.tick()).resolves.toMatchObject({hasMore: true});
		expect(await readJournal(db, 'a', {kind: 'stalled'})).toEqual([]);
		expect((await triggers.consumer.status()).cursor).toBe('c12');
	});

	it('takes at most `maxDeliveriesPerRound` due deliveries and leaves the rest for its next round', async () => {
		const {triggers, delivered} = service({feed: pagedFeed(0), maxDeliveriesPerRound: 2});
		await triggers.setup();
		const now = Date.now();
		await db.batch(
			[0, 1, 2, 3, 4].map((n) =>
				insertDeliveryStatement(
					db,
					'a',
					now,
					{blockNumber: 100 + n, blockHash: '0xa1', logIndex: 0, transactionHash: '0x01'},
					{action: 'act', key: `k${n}`, recipient: '0x01', payload: {}, trigger: 't'},
				),
			),
		);
		expect((await triggers.tick()).delivery).toMatchObject({attempted: 2, delivered: 2});
		expect((await listDeliveries(db, 'a', {status: 'pending'})).length).toBe(3);
		expect((await triggers.tick()).delivery).toMatchObject({attempted: 2, delivered: 2});
		expect((await triggers.tick()).delivery).toMatchObject({attempted: 1, delivered: 1});
		expect(delivered.map((d) => d.key)).toEqual(['k0', 'k1', 'k2', 'k3', 'k4']);
	});
});
