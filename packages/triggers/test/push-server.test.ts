import {beforeEach, describe, expect, it} from 'vitest';
import {REQUEST_SIGNATURE_HEADER, signRequest} from 'delegated-identity';
import {
	createRegistrationAPI,
	createTriggerRegistry,
	defineTriggers,
	delegatedIdentityVerifier,
	pushAction,
	type ActionAdapter,
	type DeliveryRecord,
} from '../src/index.js';
import {memoryDB} from './utils/db.js';
import {BOARD, boardAbi} from './utils/etherfold.js';
import {appIdentity, identityFields, type AppIdentity} from './utils/identity.js';
import {PUSH_API, PUSH_ORIGIN, startPushServer, type PushServer} from './utils/push-server.js';

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
		app: 'greetings',
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

describe('one client body for both services', () => {
	it('registers at push-notification-server and at the trigger service: the same bytes, each signed for its server', async () => {
		const TRIGGERS_ORIGIN = 'https://triggers.test';
		const registry = createTriggerRegistry({
			db: memoryDB(),
			app: 'app',
			definitions: defineTriggers({
				events: {posted: {address: BOARD, abi: boardAbi[0]}},
				subscriptions: {'new-post': {event: 'posted', notFrom: 'author', action: 'push', render: () => ({})}},
			}),
		});
		await registry.setup();
		const triggers = createRegistrationAPI({
			registry,
			verifier: delegatedIdentityVerifier({serverOrigin: TRIGGERS_ORIGIN, domain: DOMAIN}),
		});
		// what the app sends: its identity `{address, domain, keySet, ownershipSignature}`, a
		// device for the push server, a kind for the trigger service; each ignores the other's
		const subscription = {
			endpoint: 'https://push-service.invalid/shared-body',
			expirationTime: null,
			keys: {p256dh: 'p256dh-shared', auth: 'auth-shared'},
		};
		const body = JSON.stringify({...identityFields(alice), subscription, kind: 'new-post'});
		const post = async (serverOrigin: string, path: string): Promise<RequestInit> => ({
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				[REQUEST_SIGNATURE_HEADER]: await signRequest(
					{serverOrigin, method: 'POST', path, body},
					alice.keySet.signing.privateKey,
				),
			},
			body,
		});

		const atPush = await server.fetch(`${PUSH_ORIGIN}/api/register`, await post(PUSH_ORIGIN, '/api/register'));
		expect(atPush.status, await atPush.clone().text()).toBe(200);
		const atTriggers = await triggers.request(
			`${TRIGGERS_ORIGIN}/subscriptions`,
			await post(TRIGGERS_ORIGIN, '/subscriptions'),
		);
		expect(atTriggers.status, await atTriggers.clone().text()).toBe(200);

		expect(await registry.list(alice.address)).toMatchObject([{recipient: alice.address, kind: 'new-post'}]);
		expect(await push.deliver(deliveryTo(alice.address, 'shared'))).toEqual({kind: 'delivered'});
		expect(server.sent.map((s) => s.endpoint)).toEqual([subscription.endpoint]);
	});
});
