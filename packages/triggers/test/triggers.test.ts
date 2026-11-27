import {beforeEach, describe, expect, it} from 'vitest';
import {
	canonicalFeed,
	createConsumer,
	createTriggerRegistry,
	defineTriggers,
	listDeliveries,
	readJournal,
	type TriggerRegistry,
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
} from './utils/etherfold.js';

// ---------------------------------------------------------------------------
// THE TRIGGER REGISTRY: both archetypes of etherfold ADR-0013
// ---------------------------------------------------------------------------
// SUBSCRIPTION triggers are data a user registers for themself, of a kind the
// operator declared; their recipient is the registrant, and they expire unless
// renewed (ADR-0012). GLOBAL RULES are the operator's code over every log of an
// event; their recipient is computed. Both match over DECODED arguments.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

const definitions = defineTriggers({
	events: {
		posted: {address: BOARD, abi: boardAbi[0]},
	},
	subscriptions: {
		// "a log of this event at this contract, from anyone but me" (S2-3)
		'new-post': {
			event: 'posted',
			notFrom: 'author',
			filterable: ['author'],
			action: 'push',
			ttlMs: 30 * DAY,
			render: (log) => ({title: 'A new post', body: String(log.args['text'])}),
		},
	},
	rules: {
		// "every account's third post", the global rule of the step (S2-5)
		'third-post': {
			event: 'posted',
			recipients: (log) => log.args['author'] as string,
			predicate: (log) => (log.args['count'] as bigint) >= 3n,
			action: 'reward',
			key: (_log, recipient) => `third-post:${recipient}`,
			render: (_log, recipient) => ({achievement: 'third-post', account: recipient}),
		},
	},
});

let etherfold: Etherfold;
let db: ReturnType<typeof memoryDB>;
let now: number;
let registry: TriggerRegistry;

beforeEach(async () => {
	etherfold = await startEtherfold();
	db = memoryDB();
	now = 1_800_000_000_000;
	registry = createTriggerRegistry({db, app: INDEXER, definitions, clock: () => now, maxSubscriptionsPerRecipient: 3});
	await registry.setup();
});

function consumer() {
	return createConsumer({
		db,
		app: INDEXER,
		chainId: CHAIN_ID,
		feed: canonicalFeed({url: BASE_URL, indexer: INDEXER, fetch: etherfold.fetch}),
		gate: async () => 1000,
		match: registry.matcher(),
		clock: () => now,
	});
}

async function run(...posts: Parameters<typeof posted>[0][]) {
	await etherfold.ingest(100, 120, posts.map(posted));
	const c = consumer();
	await c.setup();
	await c.catchUp();
}

describe('a subscription trigger', () => {
	it('notifies every subscriber but the author, once, keyed by the log and the recipient', async () => {
		for (const recipient of [ALICE, BOB, CAROL]) await registry.subscribe({recipient, kind: 'new-post'});

		await run({block: 101, hash: '0xa101', author: BOB, count: 1n, text: 'hi all'});

		const pushes = await listDeliveries(db, INDEXER, {action: 'push'});
		expect(pushes.map((d) => d.recipient).sort()).toEqual([ALICE, CAROL].map((a) => a.toLowerCase()).sort());
		expect(pushes[0]?.key).toBe(`${CHAIN_ID}:0xa101:0:${pushes[0]?.recipient}`);
		expect(pushes[0]?.payload).toEqual({title: 'A new post', body: 'hi all'});
		expect(pushes[0]?.trigger).toMatch(/^subscription:\d+$/);
	});

	it('filters on a declared argument, compared as decoded', async () => {
		await registry.subscribe({
			recipient: CAROL,
			kind: 'new-post',
			filter: {author: ALICE.toUpperCase().replace('0X', '0x')},
		});

		await run(
			{block: 101, hash: '0xa101', author: BOB, count: 1n},
			{block: 102, hash: '0xa102', author: ALICE, count: 1n},
		);

		expect((await listDeliveries(db, INDEXER, {action: 'push'})).map((d) => d.blockNumber)).toEqual([102]);
	});

	it('refuses a kind nobody declared, an argument the kind does not let a user filter on, and past the quota', async () => {
		await expect(registry.subscribe({recipient: ALICE, kind: 'nope'})).rejects.toMatchObject({code: 'unknown-kind'});
		await expect(registry.subscribe({recipient: ALICE, kind: 'new-post', filter: {count: '3'}})).rejects.toMatchObject({
			code: 'invalid-filter',
		});

		await registry.subscribe({recipient: ALICE, kind: 'new-post'});
		await registry.subscribe({recipient: ALICE, kind: 'new-post', filter: {author: BOB}});
		await registry.subscribe({recipient: ALICE, kind: 'new-post', filter: {author: CAROL}});
		await expect(
			registry.subscribe({recipient: ALICE, kind: 'new-post', filter: {author: ALICE}}),
		).rejects.toMatchObject({code: 'quota-exceeded'});
		// registering the same trigger again is a renewal, never a second one
		await registry.subscribe({recipient: ALICE, kind: 'new-post', filter: {author: BOB}});
		expect(await registry.list(ALICE)).toHaveLength(3);
	});

	it('produces nothing once expired, says so in the journal, and comes back when renewed', async () => {
		const {expiresAt} = await registry.subscribe({recipient: ALICE, kind: 'new-post'});
		expect(expiresAt).toBe(now + 30 * DAY);

		now = expiresAt + 1;
		expect(await registry.expire()).toBe(1);
		expect(await readJournal(db, INDEXER, {kind: 'expired'})).toHaveLength(1);
		expect((await registry.list(ALICE))[0]?.status).toBe('expired');

		await run({block: 101, hash: '0xa101', author: BOB, count: 1n});
		expect(await listDeliveries(db, INDEXER, {action: 'push'})).toEqual([]);

		expect(await registry.renewAll(ALICE)).toBe(1);
		expect((await registry.list(ALICE))[0]).toMatchObject({status: 'active', expiresAt: now + 30 * DAY});
	});

	it('produces nothing past its expiry even before the sweep has marked it', async () => {
		const {expiresAt} = await registry.subscribe({recipient: ALICE, kind: 'new-post'});
		now = expiresAt + 1;
		await run({block: 101, hash: '0xa101', author: BOB, count: 1n});
		expect(await listDeliveries(db, INDEXER, {action: 'push'})).toEqual([]);
	});

	it('is gone for good once cancelled', async () => {
		await registry.subscribe({recipient: ALICE, kind: 'new-post'});
		expect(await registry.unsubscribe({recipient: ALICE, kind: 'new-post'})).toBe(true);
		await run({block: 101, hash: '0xa101', author: BOB, count: 1n});
		expect(await listDeliveries(db, INDEXER, {action: 'push'})).toEqual([]);
		expect((await registry.list(ALICE))[0]?.status).toBe('cancelled');
	});
});

describe('a global rule', () => {
	it('computes its recipient, asks its predicate, and is absorbed by its semantic key when it fires again', async () => {
		await run(
			{block: 101, hash: '0xa101', author: ALICE, count: 1n},
			{block: 102, hash: '0xa102', author: ALICE, count: 2n},
			{block: 103, hash: '0xa103', author: BOB, count: 1n},
			{block: 104, hash: '0xa104', author: ALICE, count: 3n},
			// level-triggered: the fourth post qualifies too, and the key absorbs it
			{block: 105, hash: '0xa105', author: ALICE, count: 4n},
		);

		const rewards = await listDeliveries(db, INDEXER, {action: 'reward'});
		expect(rewards).toHaveLength(1);
		expect(rewards[0]).toMatchObject({
			recipient: ALICE.toLowerCase(),
			key: `third-post:${ALICE.toLowerCase()}`,
			blockNumber: 104,
			trigger: 'rule:third-post',
			payload: {achievement: 'third-post', account: ALICE.toLowerCase()},
		});
	});
});
