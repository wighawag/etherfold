import {beforeEach, describe, expect, it} from 'vitest';
import {pushAction, type ActionAdapter, type DeliveryRecord} from '../src/index.js';
import {appIdentity, type AppIdentity} from './utils/identity.js';
import {PUSH_API, startPushServer, type PushServer} from './utils/push-server.js';

// ---------------------------------------------------------------------------
// THE PUSH ADAPTER AGAINST THE REAL SERVER (step S2b): push-notification-
// server's Node.js platform in this process. A user registers a device there
// with the same delegated-identity proof this service takes, and the adapter
// pushes to the WALLET address with the domain's token and the delivery's key
// (S1-1, S1-2, S1-4): a retry under that key reaches only the devices not yet
// reached, and a token for another domain is refused for good.
// ---------------------------------------------------------------------------

const DOMAIN = 'game.test';
const OTHER = 'other.test';
const TOKENS = {[DOMAIN]: 'the-game-token', [OTHER]: 'the-other-token'};

let server: PushServer;
let alice: AppIdentity;
let push: ActionAdapter;

function deliveryTo(recipient: string, key: string): DeliveryRecord {
	return {
		id: 1,
		consumer: 'greetings',
		action: 'push',
		key,
		recipient,
		payload: {
			message: {web_push: 8030, notification: {title: 'A new greeting', body: 'hello', navigate: '/'}},
			topic: 'greetings',
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
}

beforeEach(async () => {
	server = await startPushServer(TOKENS);
	alice = await appIdentity(DOMAIN);
	push = pushAction({url: PUSH_API, domain: DOMAIN, token: TOKENS[DOMAIN], fetch: server.fetch});
});

describe('pushAction against push-notification-server', () => {
	it('reaches every device the wallet registered, once, and a retried key reaches none twice', async () => {
		const phone = await server.register(alice);
		const laptop = await server.register(alice);

		expect(await push.deliver(deliveryTo(alice.address, 'k1'))).toEqual({kind: 'delivered'});
		expect(server.sent.map((s) => s.endpoint).sort()).toEqual([phone.endpoint, laptop.endpoint].sort());
		expect(server.sent[0]).toMatchObject({
			payload: {web_push: 8030, notification: {title: 'A new greeting'}},
			topic: 'greetings',
		});

		expect(await push.deliver(deliveryTo(alice.address, 'k1'))).toEqual({kind: 'delivered'});
		expect(server.sent).toHaveLength(2);
	});

	it('retries a partial failure under the same key, which then reaches only the device that missed it', async () => {
		const phone = await server.register(alice);
		const laptop = await server.register(alice);
		server.script(laptop.endpoint, [500]);

		const first = await push.deliver(deliveryTo(alice.address, 'k2'));
		expect(first.kind).toBe('retry');
		expect(server.sent.map((s) => s.endpoint)).toEqual([phone.endpoint]);

		expect(await push.deliver(deliveryTo(alice.address, 'k2'))).toEqual({kind: 'delivered'});
		expect(server.sent.map((s) => s.endpoint)).toEqual([phone.endpoint, laptop.endpoint]);
	});

	it("delivers nothing, successfully, to a wallet with no device; dead-letters another domain's token", async () => {
		expect(await push.deliver(deliveryTo(alice.address, 'k3'))).toEqual({kind: 'delivered'});

		await server.register(alice);
		const wrongDomain = pushAction({url: PUSH_API, domain: DOMAIN, token: TOKENS[OTHER], fetch: server.fetch});
		expect((await wrongDomain.deliver(deliveryTo(alice.address, 'k4'))).kind).toBe('dead');
		const noToken = pushAction({url: PUSH_API, domain: DOMAIN, token: 'not-a-token', fetch: server.fetch});
		expect((await noToken.deliver(deliveryTo(alice.address, 'k5'))).kind).toBe('dead');
		expect(server.sent).toEqual([]);
	});
});
