import {REQUEST_SIGNATURE_HEADER, requestMessage} from 'delegated-identity';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
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
import {appIdentity, identityFields, signedPost, type AppIdentity} from './utils/identity.js';

// ---------------------------------------------------------------------------
// THE REAL REGISTRATION PROOF (S1-3's, step S2b): delegated-identity's, the one
// push-notification-server checks at `/register`. The wallet signed once for
// the app's origin and a key set (the ownership proof and the key set in the
// body), the key set's Ed25519 signing key signs each request (the SIGNATURE
// header, naming its key), and the routes act for the account both proofs
// recover. Run through the registration API, so the request is checked
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
	registry = createTriggerRegistry({db: memoryDB(), app: 'app', definitions});
	await registry.setup();
	app = createRegistrationAPI({
		registry,
		verifier: delegatedIdentityVerifier({serverOrigin: SERVER_ORIGIN, domain: DOMAIN}),
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
		const noKeys = await subscribe(alice);
		const keyless = JSON.parse(noKeys.body as string) as Record<string, unknown>;
		delete keyless['keySet'];
		expect(await send('/subscriptions', {...noKeys, body: JSON.stringify(keyless)})).toMatchObject({
			status: 401,
			body: {error: 'invalid-proof', message: expect.stringContaining('keySet')},
		});
		expect(await registry.list(alice.address)).toEqual([]);
	});

	it('refuses another key set: one the wallet did not authorize, or the right one with another key signing', async () => {
		// Bob's key set, signed by Bob's key, under Alice's ownership proof: the proof is for Alice's key set
		expect((await send('/subscriptions', await subscribe(alice, {keySet: bob.keySet, signer: bob}))).status).toBe(401);
		// Bob's key set named, Alice's key signing: the header names a key the body does not
		expect((await send('/subscriptions', await subscribe(alice, {keySet: bob.keySet}))).status).toBe(401);
		// a malformed key
		const bad = {signing: {publicKey: '0x1234' as const}, encryption: alice.keySet.encryption};
		expect(await send('/subscriptions', await subscribe(alice, {keySet: bad}))).toMatchObject({
			status: 401,
			body: {message: 'malformed'},
		});
		expect(await registry.list(alice.address)).toEqual([]);
		expect(await registry.list(bob.address)).toEqual([]);
	});

	it("refuses delegated-identity 0.1's proof: a secp256k1 request signature and a single origin key", async () => {
		// 0.1's SIGNATURE header was `<timestamp>:<65-byte secp256k1 signature>`, recovered rather than named
		const delegate = privateKeyToAccount(generatePrivateKey());
		const body = JSON.stringify({...identityFields(alice), kind: 'new-post'});
		const timestamp = Date.now();
		const signed = await requestMessage({
			serverOrigin: SERVER_ORIGIN,
			method: 'POST',
			path: '/subscriptions',
			body,
			timestamp,
		});
		const old = `${timestamp}:${await delegate.signMessage({message: signed})}`;
		const answer = await send('/subscriptions', {
			method: 'POST',
			headers: {'Content-Type': 'application/json', [REQUEST_SIGNATURE_HEADER]: old},
			body,
		});
		expect(answer).toMatchObject({status: 401, body: {error: 'invalid-proof', message: 'malformed'}});
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
			verifier: delegatedIdentityVerifier({serverOrigin: 'http://localhost:8787', domain: 'localhost:5173'}),
		});
		const dev = await appIdentity('localhost:5173');
		const init = await signedPost(dev, {
			serverOrigin: 'http://localhost:8787',
			path: '/subscriptions',
			fields: {kind: 'new-post'},
		});
		expect((await local.request('http://localhost:8787/subscriptions', init)).status).toBe(200);
	});

	it('serves ONE app, its configured domain normalised to its origin, and refuses a domain that names no origin', async () => {
		// a trailing slash or capitals in the operator's config must not refuse every proof
		const lenient = createRegistrationAPI({
			registry,
			verifier: delegatedIdentityVerifier({serverOrigin: `${SERVER_ORIGIN}/`, domain: 'HTTPS://Game.Test/'}),
		});
		expect((await lenient.request(`${SERVER_ORIGIN}/subscriptions`, await subscribe(alice))).status).toBe(200);

		expect(() => delegatedIdentityVerifier({serverOrigin: SERVER_ORIGIN, domain: 'https://'})).toThrow(/domain/);
	});

	it('accepts a signed request once: a replay is refused, so a captured registration cannot undo a cancel', async () => {
		const registration = await subscribe(alice);
		expect((await send('/subscriptions', registration)).status).toBe(200);
		const cancel = await signedPost(alice, {
			serverOrigin: SERVER_ORIGIN,
			path: '/subscriptions/cancel',
			fields: {kind: 'new-post'},
		});
		expect((await send('/subscriptions/cancel', cancel)).status).toBe(200);

		const replayed = await send('/subscriptions', registration);
		expect(replayed).toMatchObject({status: 401, body: {error: 'invalid-proof', message: 'replayed'}});
		expect((await registry.list(alice.address)).map((s) => s.status)).toEqual(['cancelled']);
		// the same intent signed afresh (a later timestamp) is a new request
		expect((await send('/subscriptions', await subscribe(alice, {timestamp: Date.now() + 5}))).status).toBe(200);
	});

	it('names a request by the envelope its key signed, so another spelling of the header is the same request', async () => {
		const registration = await subscribe(alice);
		expect((await send('/subscriptions', registration)).status).toBe(200);
		// the header in upper-case hex: parsed to the same key and signature, it signs the same envelope
		const headers = registration.headers as Record<string, string>;
		const respelled = {
			...registration,
			headers: {...headers, [REQUEST_SIGNATURE_HEADER]: headers[REQUEST_SIGNATURE_HEADER]!.toUpperCase()},
		};
		expect(await send('/subscriptions', respelled)).toMatchObject({status: 401, body: {message: 'replayed'}});
	});

	it('refuses a server origin with a path: the API is reached at the origin root, the path a client signs', async () => {
		expect(() => delegatedIdentityVerifier({serverOrigin: `${SERVER_ORIGIN}/triggers`, domain: DOMAIN})).toThrow(
			/origin root/,
		);
		expect(() => delegatedIdentityVerifier({serverOrigin: 'not a url', domain: DOMAIN})).toThrow(/serverOrigin/);
	});
});
