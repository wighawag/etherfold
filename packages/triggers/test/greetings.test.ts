import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {RemoteSQL} from 'remote-sql';
import {
	canonicalFeed,
	createTriggerService,
	DEFAULT_LEASE_MS,
	defineTriggers,
	delegatedIdentityVerifier,
	listDeliveries,
	pushAction,
	readJournal,
	rewardAction,
	stateReader,
	type DecodedLog,
	type PushPayload,
	type TriggerService,
} from '../src/index.js';
import {greetingsProcessor} from './fixtures/greetings-processor.js';
import {
	GREETINGS_REGISTRY,
	greetingsRegistryAbi,
	messageChanged,
	type GreetingsRegistryABI,
} from './fixtures/greetings-registry.js';
import {diskDB} from './utils/db.js';
import {BASE_URL, CHAIN_ID, blockHash, startEtherfold, type Etherfold} from './utils/etherfold.js';
import {appIdentity, signedPost, type AppIdentity} from './utils/identity.js';
import {PUSH_API, startPushServer, type PushServer} from './utils/push-server.js';
import {recordingTarget, type Answer, type RecordedRequest} from './utils/target.js';

// ---------------------------------------------------------------------------
// THE TRIGGER SERVICE END TO END ON THE GREETINGS (step S2b's "Done when"),
// port-free. jolly-roger's greetings processor (F1a's, copied in `fixtures/`)
// folded by an in-process etherfold server; push-notification-server's
// Node.js platform in process, its Web Push recorded per device; users with
// real wallets and delegate keys, who register a device with the push server
// and a trigger with this service under the SAME delegated-identity proof;
// the service on a database on disk, so a restart is real; and a recording
// reward target for the operator's reward service.
// ---------------------------------------------------------------------------

const DOMAIN = 'greetings.test';
const PUSH_TOKEN = 'the-greetings-push-token';
const TRIGGERS_ORIGIN = 'https://triggers.test';
const INDEXER = 'greetings';
const DAY = 24 * 60 * 60 * 1000;

/** F1a's question, one account: its greeting count as of a block. */
const GREETINGS_OF = `query GreetingsOf($block: BlockAddress!, $account: String!) {
	greeter(where: {account: {eq: $account}}, first: 1, block: $block) { greetings }
}`;

let etherfold: Etherfold<GreetingsRegistryABI>;
let pushServer: PushServer;
let disk: ReturnType<typeof diskDB>;
let now: number;
let rewardAnswer: (request: RecordedRequest, index: number) => Answer;
let reward: ReturnType<typeof recordingTarget>;
let alice: AppIdentity;
let bob: AppIdentity;
let carol: AppIdentity;

beforeEach(async () => {
	etherfold = await startEtherfold({
		indexer: INDEXER,
		abi: greetingsRegistryAbi,
		address: GREETINGS_REGISTRY,
		processor: greetingsProcessor,
		marker: 'the-greetings-fold',
	});
	pushServer = await startPushServer({[DOMAIN]: PUSH_TOKEN});
	disk = diskDB();
	now = 1_800_000_000_000;
	rewardAnswer = () => ({status: 200});
	reward = recordingTarget((request, index) => rewardAnswer(request, index));
	[alice, bob, carol] = await Promise.all([appIdentity(DOMAIN), appIdentity(DOMAIN), appIdentity(DOMAIN)]);
});
afterEach(() => disk.remove());

/** The operator's config: what can be subscribed to, the rule, and where each action goes. */
function definitions() {
	const state = stateReader({url: BASE_URL, fetch: etherfold.fetch});
	const greetingsOf = async (log: DecodedLog, account: string) => {
		const data = await state.query<{greeter: {greetings: number}[]}>(GREETINGS_OF, log, {account});
		return Number(data.greeter[0]?.greetings ?? 0);
	};
	return defineTriggers({
		events: {greeting: {address: GREETINGS_REGISTRY, abi: greetingsRegistryAbi[0]}},
		subscriptions: {
			'new-greeting': {
				event: 'greeting',
				notFrom: 'user',
				action: 'push',
				ttlMs: 30 * DAY,
				render: (log): PushPayload => ({
					message: {
						web_push: 8030,
						notification: {title: 'A new greeting', body: String(log.args['message']), navigate: '/demo/'},
					},
					topic: 'new-greeting',
				}),
			},
		},
		rules: {
			// "every account's third greeting": the event carries no count, the fold's state does
			'third-greeting': {
				event: 'greeting',
				recipients: (log) => log.args['user'] as string,
				predicate: async (log, account) => (await greetingsOf(log, account)) >= 3,
				action: 'reward',
				key: (_log, account) => `third-greeting:${account}`,
				render: (_log, account) => ({achievement: 'third-greeting', account}),
			},
		},
	});
}

async function start(db: RemoteSQL = disk.open(), lane: 'safe' | 'fast' = 'safe'): Promise<TriggerService> {
	const service = createTriggerService({
		db,
		app: INDEXER,
		chainId: CHAIN_ID,
		feed: canonicalFeed({url: BASE_URL, indexer: INDEXER, fetch: etherfold.fetch}),
		gate: async () => 1000,
		definitions: definitions(),
		actions: {
			push: pushAction({url: PUSH_API, domain: DOMAIN, token: PUSH_TOKEN, fetch: pushServer.fetch}),
			reward: rewardAction({
				url: 'https://rewards.test/award',
				token: 'reward-token',
				fetch: reward.fetch,
				policy: {maxAttempts: 3, backoff: {initialMs: 1000, maxMs: 1000}},
			}),
		},
		verifier: delegatedIdentityVerifier({serverOrigin: TRIGGERS_ORIGIN, domain: DOMAIN}),
		lane,
		limit: 1,
		clock: () => now,
	});
	await service.setup();
	return service;
}

/** What the app does for a user who turns notifications on: a device at the push server, a trigger here. */
async function subscribe(service: TriggerService, user: AppIdentity): Promise<string> {
	const device = await pushServer.register(user);
	const response = await service.api!.request(
		`${TRIGGERS_ORIGIN}/subscriptions`,
		await signedPost(user, {serverOrigin: TRIGGERS_ORIGIN, path: '/subscriptions', fields: {kind: 'new-greeting'}}),
	);
	expect(response.status).toBe(200);
	return device.endpoint;
}

const greeting = (block: number, user: AppIdentity, message: string, branch = 'a') =>
	messageChanged({block, hash: blockHash(block, branch), user: user.address, message});

/** What each device received, by endpoint. */
const receivedBy = (endpoint: string) =>
	pushServer.sent
		.filter((s) => s.endpoint === endpoint)
		.map((s) => (s.payload as {notification: {body: string}}).notification.body);

describe('a subscription trigger on the greetings, through the real push server', () => {
	it('one push per subscribed other account, keyed by the log and the recipient, across a restart and a retried push', async () => {
		let service = await start();
		const devices = {
			alice: await subscribe(service, alice),
			bob: await subscribe(service, bob),
			carol: await subscribe(service, carol),
		};
		// Carol's push service fails her first push: the push server answers 502, and the retry
		// (same key) reaches only her device
		pushServer.script(devices.carol, [500]);

		await etherfold.ingest(100, 110, [greeting(101, bob, 'hello from bob'), greeting(102, alice, 'hello from alice')]);
		// one page, its deliveries attempted under the app's lease, then the process stops
		await service.lease.acquire();
		await service.consumer.step();
		await service.deliverer.deliverDue();
		disk.close();

		// it crashed: its lease lapses before the restarted process may tick
		now += DEFAULT_LEASE_MS + 1;
		service = await start();
		// the restarted consumer resumes from the committed cursor: it reads only the second page
		expect((await service.consumer.status()).cursor).toBeDefined();
		expect(await service.tick()).toMatchObject({lease: 'held', consumed: 1});
		now += 10_000; // past the push's backoff
		await service.tick();

		expect(receivedBy(devices.alice)).toEqual(['hello from bob']);
		expect(receivedBy(devices.bob)).toEqual(['hello from alice']);
		// her retried push arrives after Alice's greeting's
		expect(receivedBy(devices.carol).sort()).toEqual(['hello from alice', 'hello from bob']);
		expect(pushServer.sent).toHaveLength(4);

		const delivered = await listDeliveries(disk.open(), INDEXER, {action: 'push', status: 'delivered'});
		expect(delivered.map((d) => d.key).sort()).toEqual(
			[
				`${CHAIN_ID}:${blockHash(101)}:0:${alice.address}`,
				`${CHAIN_ID}:${blockHash(101)}:0:${carol.address}`,
				`${CHAIN_ID}:${blockHash(102)}:0:${bob.address}`,
				`${CHAIN_ID}:${blockHash(102)}:0:${carol.address}`,
			].sort(),
		);
		expect(delivered.find((d) => d.recipient === carol.address && d.blockNumber === 101)?.attempts).toBe(2);
	});

	it('an expired subscription produces nothing', async () => {
		const service = await start();
		const carolsDevice = await subscribe(service, carol);
		now += 31 * DAY;
		const alicesDevice = await subscribe(service, alice);

		await etherfold.ingest(100, 110, [greeting(101, bob, 'hello')]);
		await service.tick();

		expect(receivedBy(alicesDevice)).toEqual(['hello']);
		expect(receivedBy(carolsDevice)).toEqual([]);
		expect(await readJournal(disk.open(), INDEXER, {kind: 'expired'})).toEqual([
			expect.objectContaining({detail: expect.objectContaining({recipient: carol.address})}),
		]);
	});
});

describe("a global rule on the greetings: every account's third greeting", () => {
	it('reads the count from the state as of the log, and calls the reward target once per qualifying account', async () => {
		const service = await start();
		await etherfold.ingest(100, 120, [
			greeting(101, bob, 'one'),
			greeting(102, alice, 'one'),
			greeting(103, bob, 'two'),
			greeting(104, alice, 'two'),
			greeting(105, bob, 'three'),
			greeting(106, bob, 'four'),
		]);
		await service.tick();
		// a graceful stop releases the lease
		await service.lease.release();
		// a restart replays nothing: the cursor and the outbox were committed together
		const restarted = await (await start()).tick();
		expect(restarted).toMatchObject({consumed: 0, matched: 0});

		expect(reward.requests.map((r) => r.headers['idempotency-key'])).toEqual([`third-greeting:${bob.address}`]);
		expect(reward.requests[0]).toMatchObject({
			headers: {authorization: 'Bearer reward-token'},
			body: {
				recipient: bob.address,
				reward: {achievement: 'third-greeting'},
				log: {blockNumber: 105, blockHash: blockHash(105)},
			},
		});
	});

	it('only from the safe lane', async () => {
		await expect(start(disk.open(), 'fast')).rejects.toThrow(/"reward" fires from the safe lane only/);
	});

	it('a reward target failing past its budget ends dead-lettered, and inspectable', async () => {
		rewardAnswer = () => ({status: 500, body: {error: 'the mint queue is down'}});
		const service = await start();
		await etherfold.ingest(100, 110, [greeting(101, carol, '1'), greeting(102, carol, '2'), greeting(103, carol, '3')]);
		for (let round = 0; round < 6; round++) {
			await service.tick();
			now += 1000;
		}

		expect(reward.requests).toHaveLength(3);
		const [dead] = await listDeliveries(disk.open(), INDEXER, {status: 'dead'});
		expect(dead).toMatchObject({action: 'reward', key: `third-greeting:${carol.address}`, attempts: 3});
		expect(dead?.lastError).toMatch(/^500: .*mint queue is down/);
		expect(await readJournal(disk.open(), INDEXER, {kind: 'dead-lettered'})).toHaveLength(1);
	});
});

describe('a rewind on the greetings', () => {
	it('rolls back what was not sent, a reward included, and acts on the new branch instead', async () => {
		rewardAnswer = () => ({status: 503});
		const service = await start();
		const alicesDevice = await subscribe(service, alice);
		pushServer.script(alicesDevice, [500, 500, 500]);
		await etherfold.ingest(100, 106, [
			greeting(101, bob, 'first'),
			greeting(102, bob, 'second'),
			greeting(105, bob, 'third, on a branch that loses'),
		]);
		await service.tick(); // both targets fail: every delivery stays pending

		await etherfold.ingest(103, 107, [greeting(105, carol, 'on the branch that wins', 'b')]);
		rewardAnswer = () => ({status: 200});
		for (let round = 0; round < 3; round++) {
			now += 10_000;
			await service.tick();
		}

		const db = disk.open();
		const retracted = await listDeliveries(db, INDEXER, {status: 'retracted'});
		expect(retracted.map((d) => [d.action, d.blockHash]).sort()).toEqual([
			['push', blockHash(105)],
			['reward', blockHash(105)],
		]);
		// bob has two greetings on the winning branch: no reward was due, and none was sent
		expect(reward.requests.length).toBeGreaterThan(0);
		expect(reward.requests.every((r) => (r.body as {log: {blockHash: string}}).log.blockHash === blockHash(105))).toBe(
			true,
		);
		expect(await listDeliveries(db, INDEXER, {action: 'reward', status: 'delivered'})).toEqual([]);
		expect(receivedBy(alicesDevice).sort()).toEqual(['first', 'on the branch that wins', 'second']);
	});
});
