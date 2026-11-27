import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {RemoteSQL} from 'remote-sql';
import {
	canonicalFeed,
	createTriggerService,
	DEFAULT_LEASE_MS,
	defineTriggers,
	listDeliveries,
	pushAction,
	readJournal,
	rewardAction,
	type PushPayload,
	type TriggerService,
} from '../src/index.js';
import {diskDB} from './utils/db.js';
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
import {recordingTarget, type Answer, type RecordedRequest} from './utils/target.js';
import {proofFor, testVerifier} from './utils/verifier.js';

// ---------------------------------------------------------------------------
// THE SERVICE END TO END (step S2a's "Done when"), port-free: the repo's own
// board contract folded by an in-process etherfold server, the service on a
// database on disk so a restart is real, and recording targets standing for
// push-notification-server and an operator's reward service.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const DAVE = '0x00000000000000000000000000000000000000d4';

const definitions = defineTriggers({
	events: {posted: {address: BOARD, abi: boardAbi[0]}},
	subscriptions: {
		'new-post': {
			event: 'posted',
			notFrom: 'author',
			action: 'push',
			ttlMs: 30 * DAY,
			render: (log): PushPayload => ({
				message: {web_push: 8030, notification: {title: 'A new post', body: String(log.args['text']), navigate: '/'}},
				topic: 'new-post',
			}),
		},
	},
	rules: {
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
let disk: ReturnType<typeof diskDB>;
let now: number;
let pushAnswer: (request: RecordedRequest, index: number) => Answer;
let rewardAnswer: (request: RecordedRequest, index: number) => Answer;
let push: ReturnType<typeof recordingTarget>;
let reward: ReturnType<typeof recordingTarget>;

beforeEach(async () => {
	etherfold = await startEtherfold();
	disk = diskDB();
	now = 1_800_000_000_000;
	pushAnswer = () => ({status: 200, body: {success: true}});
	rewardAnswer = () => ({status: 200});
	push = recordingTarget((request, index) => pushAnswer(request, index));
	reward = recordingTarget((request, index) => rewardAnswer(request, index));
});
afterEach(() => disk.remove());

/** The service as a process starts it: on the database on disk, opened afresh. */
async function start(db: RemoteSQL = disk.open(), lane: 'safe' | 'fast' = 'safe'): Promise<TriggerService> {
	const service = createTriggerService({
		db,
		app: INDEXER,
		chainId: CHAIN_ID,
		feed: canonicalFeed({url: BASE_URL, indexer: INDEXER, fetch: etherfold.fetch}),
		gate: async () => 1000,
		definitions,
		actions: {
			push: pushAction({url: 'https://push.test/api', domain: 'board.test', token: 'push-token', fetch: push.fetch}),
			reward: rewardAction({
				url: 'https://rewards.test/award',
				token: 'reward-token',
				fetch: reward.fetch,
				policy: {maxAttempts: 3, backoff: {initialMs: 1000, maxMs: 1000}},
			}),
		},
		verifier: testVerifier,
		lane,
		limit: 1,
		clock: () => now,
	});
	await service.setup();
	return service;
}

async function register(service: TriggerService, address: string) {
	const response = await service.api!.request('/subscriptions', {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({kind: 'new-post', proof: proofFor(address, '/subscriptions')}),
	});
	expect(response.status).toBe(200);
}

/** The keys a target was sent, once per call. */
const keysOf = (target: ReturnType<typeof recordingTarget>) => target.requests.map((r) => r.headers['idempotency-key']);

describe('a subscription trigger, end to end', () => {
	it('one push per subscribed other account, keyed by the log and the recipient, across a restart and a retried target', async () => {
		let service = await start();
		for (const address of [ALICE, BOB, CAROL]) await register(service, address);

		await etherfold.ingest(100, 110, [
			posted({block: 101, hash: '0xa101', author: BOB, count: 1n, text: 'from bob'}),
			posted({block: 102, hash: '0xa102', author: ALICE, count: 1n, text: 'from alice'}),
		]);

		// the first push the target is sent fails; everything after it succeeds
		pushAnswer = (_, index) => (index === 0 ? {status: 503} : {status: 200, body: {success: true}});
		// one page under the app's lease, then the process stops
		await service.lease.acquire();
		await service.consumer.step();
		await service.deliverer.deliverDue();
		disk.close();

		// it crashed: its lease lapses before the restarted process may tick
		now += DEFAULT_LEASE_MS + 1;
		service = await start();
		await service.tick();
		now += 10_000; // past the retry's backoff
		await service.tick();

		const expected = [
			`${CHAIN_ID}:0xa101:0:${ALICE.toLowerCase()}`,
			`${CHAIN_ID}:0xa101:0:${CAROL.toLowerCase()}`,
			`${CHAIN_ID}:0xa102:0:${BOB.toLowerCase()}`,
			`${CHAIN_ID}:0xa102:0:${CAROL.toLowerCase()}`,
		];
		const delivered = await listDeliveries(disk.open(), INDEXER, {action: 'push', status: 'delivered'});
		expect(delivered.map((d) => d.key).sort()).toEqual(expected.sort());
		// the target was called once per delivery, plus the one retry, which carried the same key
		const calls = keysOf(push);
		expect(calls).toHaveLength(5);
		// the key sent is the delivery's, prefixed by its app
		expect([...new Set(calls)].sort()).toEqual(expected.map((key) => `${INDEXER}:${key}`).sort());
		expect(calls.filter((key) => key === calls[0])).toHaveLength(2);
		expect(push.requests[1]).toMatchObject({
			url: 'https://push.test/api/push',
			headers: {authorization: 'Bearer push-token'},
			body: {domain: 'board.test', topic: 'new-post'},
		});
	});

	it('an expired subscription produces nothing', async () => {
		const service = await start();
		await register(service, DAVE);
		now += 31 * DAY;
		await register(service, ALICE);

		await etherfold.ingest(100, 110, [posted({block: 101, hash: '0xa101', author: BOB, count: 1n})]);
		await service.tick();

		expect(push.requests.map((r) => (r.body as {address: string}).address)).toEqual([ALICE.toLowerCase()]);
		expect(await readJournal(disk.open(), INDEXER, {kind: 'expired'})).toEqual([
			expect.objectContaining({detail: expect.objectContaining({recipient: DAVE.toLowerCase()})}),
		]);
	});
});

describe('a global rule, end to end', () => {
	it('calls the reward target exactly once per qualifying account, with its idempotency key', async () => {
		const service = await start();
		await etherfold.ingest(100, 120, [
			posted({block: 101, hash: '0xa101', author: ALICE, count: 1n}),
			posted({block: 102, hash: '0xa102', author: BOB, count: 1n}),
			posted({block: 103, hash: '0xa103', author: ALICE, count: 2n}),
			posted({block: 104, hash: '0xa104', author: ALICE, count: 3n}),
			posted({block: 105, hash: '0xa105', author: BOB, count: 2n}),
			posted({block: 106, hash: '0xa106', author: ALICE, count: 4n}),
		]);
		await service.tick();
		// a graceful stop releases the lease
		await service.lease.release();
		// a restart replays nothing: the cursor and the outbox were committed together
		const again = await start();
		expect(await again.tick()).toMatchObject({lease: 'held', consumed: 0, matched: 0});

		expect(keysOf(reward)).toEqual([`${INDEXER}:third-post:${ALICE.toLowerCase()}`]);
		expect(reward.requests[0]).toMatchObject({
			headers: {authorization: 'Bearer reward-token'},
			body: {recipient: ALICE.toLowerCase(), reward: {achievement: 'third-post'}, log: {blockNumber: 104}},
		});
	});

	it('only from the safe lane', async () => {
		await expect(start(disk.open(), 'fast')).rejects.toThrow(/"reward" fires from the safe lane only/);
	});

	it('a target failing past its budget ends dead-lettered, and inspectable', async () => {
		rewardAnswer = () => ({status: 500, body: {error: 'the mint queue is down'}});
		const service = await start();
		await etherfold.ingest(100, 110, [posted({block: 101, hash: '0xa101', author: CAROL, count: 3n})]);
		for (let round = 0; round < 4; round++) {
			await service.tick();
			now += 1000;
		}

		expect(reward.requests).toHaveLength(3);
		const [dead] = await listDeliveries(disk.open(), INDEXER, {status: 'dead'});
		expect(dead).toMatchObject({action: 'reward', key: `third-post:${CAROL.toLowerCase()}`, attempts: 3});
		expect(dead?.lastError).toMatch(/^500: .*mint queue is down/);
		expect(await readJournal(disk.open(), INDEXER, {kind: 'dead-lettered'})).toHaveLength(1);
	});
});

describe('a rewind, end to end', () => {
	it('rolls back what was not sent and sends the new branch instead', async () => {
		pushAnswer = () => ({status: 503});
		const service = await start();
		await register(service, ALICE);
		await etherfold.ingest(100, 105, [
			posted({block: 101, hash: '0xa101', author: BOB, count: 1n}),
			posted({block: 104, hash: '0xa104', author: BOB, count: 2n}),
		]);
		await service.tick(); // the target is down: both stay pending

		await etherfold.ingest(102, 106, [posted({block: 104, hash: '0xb104', author: CAROL, count: 1n})]);
		pushAnswer = () => ({status: 200, body: {success: true}});
		now += 10_000;
		await service.tick(); // the rewind, then the new branch
		now += 10_000;
		await service.tick();

		const db = disk.open();
		expect((await listDeliveries(db, INDEXER, {status: 'retracted'})).map((d) => d.blockHash)).toEqual(['0xa104']);
		expect((await listDeliveries(db, INDEXER, {status: 'delivered'})).map((d) => d.blockHash).sort()).toEqual([
			'0xa101',
			'0xb104',
		]);
		const sent = new Set(push.requests.filter((r, i) => i >= 2).map((r) => r.headers['idempotency-key']));
		expect(sent).not.toContain(`${CHAIN_ID}:0xa104:0:${ALICE.toLowerCase()}`);
	});
});
