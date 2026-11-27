import {describe, expect, it} from 'vitest';
import {pushAction, rewardAction, type DeliveryRecord} from '../src/index.js';
import {recordingTarget} from './utils/target.js';

// ---------------------------------------------------------------------------
// THE TWO ACTION ADAPTERS: an authenticated HTTP call carrying the delivery's
// idempotency key (etherfold ADR-0009), and how each target's answer maps to
// delivered, retry later, or dead for good.
// ---------------------------------------------------------------------------

const delivery: DeliveryRecord = {
	id: 7,
	app: 'board',
	action: 'push',
	key: '31337:0xa101:0:0xalice',
	recipient: '0xalice',
	payload: {
		message: {web_push: 8030, notification: {title: 'A new post', navigate: 'https://app.test/'}},
		topic: 'posts',
	},
	trigger: 'subscription:1',
	blockNumber: 101,
	blockHash: '0xa101',
	logIndex: 0,
	transactionHash: '0x01',
	status: 'pending',
	attempts: 0,
	createdAt: 0,
	nextAttemptAt: 0,
};

describe('the push adapter (push-notification-server, S1-1 and S1-4)', () => {
	it('POSTs /push with the domain token and the idempotency key', async () => {
		const target = recordingTarget(() => ({status: 200, body: {success: true, successfullPush: 2}}));
		const push = pushAction({url: 'https://push.test/api/', domain: 'app.test', token: 's3cret', fetch: target.fetch});
		expect(await push.deliver(delivery)).toEqual({kind: 'delivered'});
		expect(target.requests).toEqual([
			{
				url: 'https://push.test/api/push',
				method: 'POST',
				headers: expect.objectContaining({
					authorization: 'Bearer s3cret',
					'idempotency-key': 'board:31337:0xa101:0:0xalice',
					'content-type': 'application/json',
				}),
				body: {
					address: '0xalice',
					domain: 'app.test',
					message: {web_push: 8030, notification: {title: 'A new post', navigate: 'https://app.test/'}},
					topic: 'posts',
				},
			},
		]);
	});

	it('retries a failed send, the same key still sending, a 429 and a network error; dead-letters a refusal', async () => {
		const answers = [
			{status: 502, body: {success: false, delivered: 1, failed: 1}},
			{status: 409, body: {success: false, inFlight: 1}},
			{status: 429, headers: {'retry-after': '120'}},
			'network-error' as const,
			{status: 401, body: {success: false}},
			{status: 403, body: {success: false}},
			{status: 400},
		];
		const target = recordingTarget((_, index) => answers[index]!);
		const push = pushAction({url: 'https://push.test', domain: 'app.test', token: 't', fetch: target.fetch});
		const outcomes = [];
		for (let i = 0; i < answers.length; i++) outcomes.push(await push.deliver(delivery));
		expect(outcomes.map((o) => o.kind)).toEqual(['retry', 'retry', 'retry', 'retry', 'dead', 'dead', 'dead']);
		expect(outcomes[2]).toMatchObject({retryAfterMs: 120_000});
	});

	it('expires by default, and may fire from either lane', () => {
		const push = pushAction({url: 'https://push.test', domain: 'd', token: 't'});
		expect(push.policy.ttlMs).toBeGreaterThan(0);
		expect(push.lanes).toBeUndefined();
	});
});

describe('the reward adapter (an operator reward service, S2-6)', () => {
	it('POSTs the reward with its token, the key and the log it came from', async () => {
		const target = recordingTarget(() => ({status: 201}));
		const reward = rewardAction({url: 'https://rewards.test/award', token: 'r', fetch: target.fetch});
		const award = {...delivery, action: 'reward', key: 'third-post:0xalice', payload: {achievement: 'third-post'}};
		expect(await reward.deliver(award)).toEqual({kind: 'delivered'});
		expect(target.requests[0]).toMatchObject({
			url: 'https://rewards.test/award',
			headers: {authorization: 'Bearer r', 'idempotency-key': 'board:third-post:0xalice'},
			body: {
				key: 'board:third-post:0xalice',
				recipient: '0xalice',
				reward: {achievement: 'third-post'},
				trigger: 'subscription:1',
				log: {app: 'board', blockNumber: 101, blockHash: '0xa101', logIndex: 0, transactionHash: '0x01'},
			},
		});
	});

	it('sends a key prefixed by the app, so two apps sharing one reward service never absorb each other', async () => {
		const target = recordingTarget(() => ({status: 201}));
		const reward = rewardAction({url: 'https://rewards.test/award', token: 'r', fetch: target.fetch});
		const award = {...delivery, action: 'reward', key: 'third-post:0xalice', payload: {achievement: 'third-post'}};
		await reward.deliver(award);
		await reward.deliver({...award, app: 'forum'});
		expect(target.requests.map((r) => r.headers['idempotency-key'])).toEqual([
			'board:third-post:0xalice',
			'forum:third-post:0xalice',
		]);
		expect(target.requests.map((r) => (r.body as {key: string}).key)).toEqual([
			'board:third-post:0xalice',
			'forum:third-post:0xalice',
		]);
	});

	it('fires from the safe lane only, never expires, and retries for days', () => {
		const reward = rewardAction({url: 'https://rewards.test', token: 'r'});
		expect(reward.lanes).toEqual(['safe']);
		expect(reward.policy.ttlMs).toBeUndefined();
		const {maxAttempts, backoff} = reward.policy;
		let total = 0;
		for (let attempt = 1; attempt < maxAttempts; attempt++) {
			total += Math.min(backoff.maxMs, backoff.initialMs * (backoff.factor ?? 2) ** (attempt - 1));
		}
		expect(total).toBeGreaterThan(3 * 24 * 60 * 60 * 1000);
	});

	it('retries a 409 (the same key in flight) and a 5xx, dead-letters any other refusal', async () => {
		const answers = [{status: 409}, {status: 500}, {status: 403}];
		const target = recordingTarget((_, index) => answers[index]!);
		const reward = rewardAction({url: 'https://rewards.test', token: 'r', fetch: target.fetch});
		const outcomes = [];
		for (let i = 0; i < answers.length; i++) outcomes.push((await reward.deliver(delivery)).kind);
		expect(outcomes).toEqual(['retry', 'retry', 'dead']);
	});
});
