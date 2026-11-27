import {beforeEach, describe, expect, it} from 'vitest';
import type {RemoteSQL} from 'remote-sql';
import {
	canonicalFeed,
	createConsumer,
	createTriggerService,
	defineTriggers,
	listDeliveries,
	pushAction,
	readJournal,
	setupDatabase,
	type CanonicalFeed,
	type CanonicalPage,
	type PushPayload,
	type TriggerService,
} from '../src/index.js';
import {memoryDB} from './utils/db.js';
import {
	ALICE,
	BASE_URL,
	BOARD,
	BOB,
	CAROL,
	CHAIN_ID,
	INDEXER,
	boardAbi,
	posted,
	startEtherfold,
	type Etherfold,
	type Post,
} from './utils/etherfold.js';
import {recordingTarget, type Answer} from './utils/target.js';
import {proofFor, testVerifier} from './utils/verifier.js';

// ---------------------------------------------------------------------------
// TWO APPS ON ONE DATABASE (etherfold ADR-0101): the schema is keyed by the app,
// so two trigger services sharing a database, each following its own in-process
// indexer, with the SAME action name, the SAME subscription kind and the SAME
// rule key, never cross: not a delivery, not a subscription, not a replay
// record, not a journal row.
// ---------------------------------------------------------------------------

const definitions = defineTriggers({
	events: {posted: {address: BOARD, abi: boardAbi[0]}},
	subscriptions: {
		'new-post': {
			event: 'posted',
			notFrom: 'author',
			action: 'push',
			render: (log): PushPayload => ({message: {text: String(log.args['text'])}}),
		},
	},
	rules: {
		'third-post': {
			event: 'posted',
			recipients: (log) => log.args['author'] as string,
			predicate: (log) => (log.args['count'] as bigint) >= 3n,
			action: 'push',
			key: (_log, recipient) => `third-post:${recipient}`,
			render: (): PushPayload => ({message: {text: 'your third post'}}),
		},
	},
});

type App = {
	name: string;
	etherfold: Etherfold;
	push: ReturnType<typeof recordingTarget>;
	answer: () => Answer;
	service: TriggerService;
};

let db: RemoteSQL;
let now: number;
let a: App;
let b: App;

async function app(name: string): Promise<App> {
	const etherfold = await startEtherfold();
	const self: Partial<App> = {name, etherfold, answer: () => ({status: 200, body: {success: true}})};
	self.push = recordingTarget(() => self.answer!());
	self.service = createTriggerService({
		db,
		app: name,
		chainId: CHAIN_ID,
		feed: canonicalFeed({url: BASE_URL, indexer: INDEXER, fetch: etherfold.fetch}),
		gate: async () => 1000,
		definitions,
		actions: {
			push: pushAction({url: 'https://push.test/api', domain: `${name}.test`, token: name, fetch: self.push.fetch}),
		},
		verifier: testVerifier,
		maxSubscriptionsPerRecipient: 1,
		clock: () => now,
	});
	await self.service.setup();
	return self as App;
}

beforeEach(async () => {
	db = memoryDB();
	now = 1_800_000_000_000;
	a = await app('a');
	b = await app('b');
});

async function call(target: App, path: string, address: string, body: Record<string, unknown> = {}) {
	const response = await target.service.api!.request(path, {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({...body, proof: proofFor(address, path)}),
	});
	return {status: response.status, body: (await response.json()) as Record<string, unknown>};
}

/** The same logs, at the same block hashes, folded by both apps' indexers: every positional key collides. */
async function ingestBoth(fromBlock: number, toBlock: number, posts: Post[]) {
	for (const target of [a, b]) await target.etherfold.ingest(fromBlock, toBlock, posts.map(posted));
}

const domainsOf = (target: App) => target.push.requests.map((r) => (r.body as {domain: string}).domain);

describe('two apps on one database', () => {
	it('each delivers exactly its own deliveries through its own adapters, whatever their keys share', async () => {
		for (const target of [a, b])
			expect((await call(target, '/subscriptions', ALICE, {kind: 'new-post'})).status).toBe(200);
		await ingestBoth(100, 110, [{block: 101, hash: '0xa101', author: BOB, count: 3n, text: 'from bob'}]);

		// both outboxes hold their rows before either app delivers (each under its own app's lease)
		for (const target of [a, b]) await target.service.lease.acquire();
		await a.service.consumer.catchUp();
		await b.service.consumer.catchUp();
		await a.service.tick();
		await b.service.tick();

		for (const target of [a, b]) {
			const delivered = await listDeliveries(db, target.name, {status: 'delivered'});
			// the subscription's push to alice and the rule's to bob, in each app, under the same keys
			expect(delivered.map((d) => d.key).sort()).toEqual(
				[`${CHAIN_ID}:0xa101:0:${ALICE.toLowerCase()}`, `third-post:${BOB.toLowerCase()}`].sort(),
			);
			expect(delivered.every((d) => d.app === target.name)).toBe(true);
			// sent through this app's adapter only, under this app's domain
			expect(domainsOf(target)).toEqual([`${target.name}.test`, `${target.name}.test`]);
		}
	});

	it('a rewind in one app retracts only the pending deliveries of that app', async () => {
		for (const target of [a, b]) {
			await call(target, '/subscriptions', ALICE, {kind: 'new-post'});
			target.answer = () => ({status: 503});
		}
		await ingestBoth(100, 105, [{block: 104, hash: '0xa104', author: BOB, count: 1n}]);
		await a.service.tick();
		await b.service.tick();

		// only a's indexer reorganises
		await a.etherfold.ingest(102, 106, [posted({block: 104, hash: '0xb104', author: CAROL, count: 1n})]);
		await a.service.tick();

		expect((await listDeliveries(db, 'a', {status: 'retracted'})).map((d) => d.blockHash)).toEqual(['0xa104']);
		expect(await listDeliveries(db, 'b', {status: 'retracted'})).toEqual([]);
		expect((await listDeliveries(db, 'b', {status: 'pending'})).map((d) => d.blockHash)).toEqual(['0xa104']);
		expect((await readJournal(db, 'b', {kind: 'rewind'})).length).toBe(0);
		expect(await readJournal(db, 'a', {kind: 'rewind'})).toEqual([expect.objectContaining({app: 'a'})]);
	});
});

describe('one recipient in two apps', () => {
	it('holds two independent subscriptions: renew, list, cancel and the quota of one never see the other', async () => {
		expect((await call(a, '/subscriptions', ALICE, {kind: 'new-post'})).status).toBe(200);
		// the quota is one per recipient, and a's does not count against b's
		expect((await call(b, '/subscriptions', ALICE, {kind: 'new-post'})).status).toBe(200);

		const listed = async (target: App) =>
			(await call(target, '/subscriptions/list', ALICE)).body['subscriptions'] as {status: string; renewedAt: number}[];
		expect(await listed(a)).toHaveLength(1);
		expect(await listed(b)).toHaveLength(1);

		now += 1000;
		expect((await call(a, '/subscriptions/renew', ALICE)).body['renewed']).toBe(1);
		// renewing one (subscribing again) touches its own only
		now += 1000;
		await call(a, '/subscriptions', ALICE, {kind: 'new-post'});
		expect((await listed(a))[0]?.renewedAt).toBe(now);
		expect((await listed(b))[0]?.renewedAt).toBe(now - 2000);

		expect((await call(a, '/subscriptions/cancel', ALICE, {kind: 'new-post'})).body['cancelled']).toBe(true);
		expect((await listed(a))[0]?.status).toBe('cancelled');
		expect((await listed(b))[0]?.status).toBe('active');
		// a cancelled subscription is not renewed by a renew-all, and b's is not a's to renew
		expect((await call(a, '/subscriptions/renew', ALICE)).body['renewed']).toBe(0);
	});

	it('a signed request accepted for one app is not a replay for the other', async () => {
		const until = now + 60_000;
		expect(await a.service.registry.acceptOnce('the-signed-request', until)).toBe(true);
		expect(await b.service.registry.acceptOnce('the-signed-request', until)).toBe(true);
		expect(await a.service.registry.acceptOnce('the-signed-request', until)).toBe(false);
		expect(await b.service.registry.acceptOnce('the-signed-request', until)).toBe(false);
	});
});

describe('the journal names its app', () => {
	function scripted(pages: CanonicalPage[]): CanonicalFeed {
		return {
			async read() {
				const page = pages.shift();
				if (!page) throw new Error('the script ran out');
				return page;
			},
		};
	}
	const entry = {
		blockNumber: 101,
		blockHash: '0xa101',
		logIndex: 0,
		transactionHash: '0x01',
		transactionIndex: 0,
		address: '0x00',
		topics: ['0x00'],
		data: '0x',
	};

	it('on every row, including a pause on a generation change', async () => {
		// a third app on the same database, on a scripted feed: an in-process server cannot change its fold cheaply
		const consumer = createConsumer({
			db,
			app: 'c',
			chainId: '1',
			feed: scripted([
				{kind: 'page', stream: 's', generation: 'g1', entries: [entry], cursor: 'c1', hasMore: false},
				{kind: 'page', stream: 's', generation: 'g2', entries: [], cursor: 'c2', hasMore: false},
			]),
			gate: async () => 200,
			match: async () => [],
		});
		await consumer.step();
		expect(await consumer.step()).toMatchObject({kind: 'paused', reason: {kind: 'generation-changed'}});
		await consumer.resume();
		expect(await consumer.status()).toMatchObject({app: 'c', generation: 'g2'});
		expect(await readJournal(db, 'c')).toEqual([
			expect.objectContaining({app: 'c', kind: 'paused', detail: expect.objectContaining({reason: expect.anything()})}),
			expect.objectContaining({app: 'c', kind: 'resumed'}),
		]);

		// and a dead letter, its requeue and an expiry, through the service of app a
		a.answer = () => ({status: 400});
		await call(a, '/subscriptions', ALICE, {kind: 'new-post'});
		await a.etherfold.ingest(100, 110, [posted({block: 101, hash: '0xa101', author: BOB, count: 1n})]);
		await a.service.tick();
		const [dead] = await listDeliveries(db, 'a', {status: 'dead'});
		expect(await a.service.deliverer.requeue(dead!.id)).toBe(true);
		await a.service.tick();
		// b's deliverer cannot requeue a's dead letter
		const [deadAgain] = await listDeliveries(db, 'a', {status: 'dead'});
		expect(await b.service.deliverer.requeue(deadAgain!.id)).toBe(false);
		// and b's outbox does not hold it, by its id
		expect(await listDeliveries(db, 'a', {id: deadAgain!.id})).toEqual([deadAgain]);
		expect(await listDeliveries(db, 'b', {id: deadAgain!.id})).toEqual([]);
		now += 365 * 24 * 60 * 60 * 1000;
		await a.service.tick();

		const kinds = (await readJournal(db, 'a')).map((row) => row.kind);
		expect(kinds).toEqual(expect.arrayContaining(['dead-lettered', 'requeued', 'expired']));
		expect((await readJournal(db, 'a')).every((row) => row.app === 'a')).toBe(true);
		expect(await readJournal(db, 'b')).toEqual([]);
		const {results} = await db
			.prepare(`SELECT COUNT(*) AS n FROM journal WHERE app IS NULL OR app = ''`)
			.all<{n: number}>();
		expect(Number(results[0]?.n)).toBe(0);
	});
});

describe('a database in the old layout', () => {
	const REFUSAL = /the trigger service's schema changed.*start from an empty database/s;

	it('is refused when its consumers table is keyed by name', async () => {
		const old = memoryDB();
		await old.prepare(`CREATE TABLE consumers (name TEXT PRIMARY KEY, cursor TEXT, updated_at INTEGER NOT NULL)`).all();
		await expect(setupDatabase(old)).rejects.toThrow(REFUSAL);
	});

	it('is refused when its deliveries carry no app', async () => {
		const old = memoryDB();
		await old.prepare(`CREATE TABLE deliveries (id INTEGER PRIMARY KEY, consumer TEXT NOT NULL)`).all();
		await expect(setupDatabase(old)).rejects.toThrow(REFUSAL);
	});

	it('and a database already in the new layout is set up again without complaint', async () => {
		await expect(setupDatabase(db)).resolves.toBeUndefined();
	});
});
