import {beforeEach, describe, expect, it} from 'vitest';
import {
	createRegistrationAPI,
	createTriggerRegistry,
	defineTriggers,
	delegatedIdentityVerifier,
	type TriggerRegistry,
} from '../src/index.js';
import {memoryDB} from './utils/db.js';
import {BOARD, boardAbi} from './utils/etherfold.js';
import {appIdentity, signedPost, type AppIdentity} from './utils/identity.js';

// ---------------------------------------------------------------------------
// THE REAL REGISTRATION PROOF (S1-3's, step S2b): delegated-identity's, the one
// push-notification-server checks at `/register`. The wallet signed once for
// the app's origin (the ownership proof in the body), the delegate key signs
// each request (the SIGNATURE header), and the routes act for the account both
// proofs recover. Run through the registration API, so the request is checked
// as it was sent: method, path and the raw body.
// ---------------------------------------------------------------------------

const SERVER_ORIGIN = 'https://triggers.test';
const DOMAIN = 'game.test';

const definitions = defineTriggers({
	events: {posted: {address: BOARD, abi: boardAbi[0]}},
	subscriptions: {'new-post': {event: 'posted', notFrom: 'author', action: 'push', render: () => ({})}},
});

let registry: TriggerRegistry;
let app: ReturnType<typeof createRegistrationAPI>;
let alice: AppIdentity;
let bob: AppIdentity;

beforeEach(async () => {
	registry = createTriggerRegistry({db: memoryDB(), definitions});
	await registry.setup();
	app = createRegistrationAPI({
		registry,
		verifier: delegatedIdentityVerifier({serverOrigin: SERVER_ORIGIN, domains: [DOMAIN]}),
	});
	alice = await appIdentity(DOMAIN);
	bob = await appIdentity(DOMAIN);
});

async function send(path: string, init: RequestInit) {
	const response = await app.request(`${SERVER_ORIGIN}${path}`, init);
	return {status: response.status, body: (await response.json()) as Record<string, unknown>};
}

const subscribe = (identity: AppIdentity, options?: Parameters<typeof signedPost>[2]) =>
	signedPost(identity, {serverOrigin: SERVER_ORIGIN, path: '/subscriptions', fields: {kind: 'new-post'}}, options);

describe('delegatedIdentityVerifier', () => {
	it('registers for the account both proofs recover, and every route acts for it', async () => {
		const answer = await send('/subscriptions', await subscribe(alice));
		expect(answer).toMatchObject({status: 200, body: {success: true, subscription: {recipient: alice.address}}});

		const listed = await send(
			'/subscriptions/list',
			await signedPost(alice, {serverOrigin: SERVER_ORIGIN, path: '/subscriptions/list'}),
		);
		expect(listed.status).toBe(200);
		expect(listed.body['subscriptions']).toHaveLength(1);
		expect(await registry.list(bob.address)).toEqual([]);
	});

	it('refuses a request without the SIGNATURE header, or without the proof in the body', async () => {
		expect((await send('/subscriptions', await subscribe(alice, {noSignature: true}))).status).toBe(401);
		const bare = await subscribe(alice);
		const body = JSON.parse(bare.body as string) as Record<string, unknown>;
		delete body['ownershipSignature'];
		expect((await send('/subscriptions', {...bare, body: JSON.stringify(body)})).status).toBe(401);
		expect(await registry.list(alice.address)).toEqual([]);
	});

	it("refuses another account's name, another account's key, and a changed body", async () => {
		// Alice's proofs, naming Bob: the proofs recover Alice, so they do not speak for Bob
		expect((await send('/subscriptions', await subscribe(alice, {address: bob.address}))).status).toBe(401);
		// Alice's ownership proof, the request signed by Bob's delegate key
		expect((await send('/subscriptions', await subscribe(alice, {signer: bob}))).status).toBe(401);
		// signed, then changed in transit
		const tampered = await subscribe(alice, {tamper: (body) => body.replace('new-post', 'new-pots')});
		expect((await send('/subscriptions', tampered)).status).toBe(401);
		expect(await registry.list(alice.address)).toEqual([]);
		expect(await registry.list(bob.address)).toEqual([]);
	});

	it('refuses a request signed for another route or another server, and one signed too long ago', async () => {
		expect((await send('/subscriptions', await subscribe(alice, {signedPath: '/subscriptions/cancel'}))).status).toBe(
			401,
		);
		expect(
			(await send('/subscriptions', await subscribe(alice, {signedServerOrigin: 'https://push.test'}))).status,
		).toBe(401);
		const answer = await send('/subscriptions', await subscribe(alice, {timestamp: Date.now() - 5 * 60 * 1000}));
		expect(answer).toMatchObject({status: 401, body: {error: 'invalid-proof', message: 'expired'}});
		expect(await registry.list(alice.address)).toEqual([]);
	});

	it('refuses an app it does not serve, and a proof the wallet signed for another app', async () => {
		const elsewhere = await appIdentity('other.test');
		expect((await send('/subscriptions', await subscribe(elsewhere))).status).toBe(401);
		// a proof signed for other.test, presented as game.test's
		const misfiled = await appIdentity(DOMAIN, {signedForDomain: 'other.test'});
		expect((await send('/subscriptions', await subscribe(misfiled))).status).toBe(401);
		expect(await registry.list(elsewhere.address)).toEqual([]);
		expect(await registry.list(misfiled.address)).toEqual([]);
	});

	it('takes the domain in either spelling push-notification-server takes, a bare host or its origin', async () => {
		const spelled = await appIdentity(`https://${DOMAIN}`);
		expect((await send('/subscriptions', await subscribe(spelled))).status).toBe(200);
		const local = createRegistrationAPI({
			registry,
			verifier: delegatedIdentityVerifier({serverOrigin: 'http://localhost:8787', domains: ['localhost:5173']}),
		});
		const dev = await appIdentity('localhost:5173');
		const init = await signedPost(dev, {
			serverOrigin: 'http://localhost:8787',
			path: '/subscriptions',
			fields: {kind: 'new-post'},
		});
		expect((await local.request('http://localhost:8787/subscriptions', init)).status).toBe(200);
	});
});
