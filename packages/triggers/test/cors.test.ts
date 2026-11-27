import {REQUEST_SIGNATURE_HEADER} from 'delegated-identity';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
	createRegistrationAPI,
	createTriggerRegistry,
	defineTriggers,
	delegatedIdentityVerifier,
	type RegistrationVerifier,
	type TriggerRegistry,
} from '../src/index.js';
import {memoryDB} from './utils/db.js';
import {BOARD, boardAbi} from './utils/etherfold.js';
import {appIdentity, signedPost, type AppIdentity} from './utils/identity.js';
import {proofFor, testVerifier} from './utils/verifier.js';

// ---------------------------------------------------------------------------
// CORS FOR THE APP THE VERIFIER SERVES. A browser app on its own origin
// registers here directly, with a JSON body and the SIGNATURE header, so every
// call is preceded by a preflight. The verifier is built for ONE app, so that
// app's origin is the one the API answers CORS for, never `*`; every response
// carries it, refusals included, so the app can read why it was refused. A page
// elsewhere gets no allow-origin and the browser blocks it; the server's own
// proof checks do not change.
// ---------------------------------------------------------------------------

const SERVER_ORIGIN = 'https://triggers.test';
const DOMAIN = 'game.test';
const APP_ORIGIN = 'https://game.test';
const ROUTES = ['/subscriptions', '/subscriptions/renew', '/subscriptions/cancel', '/subscriptions/list'];

const definitions = defineTriggers({
	events: {posted: {address: BOARD, abi: boardAbi[0]}},
	subscriptions: {'new-post': {event: 'posted', notFrom: 'author', action: 'push', render: () => ({})}},
});

let registry: TriggerRegistry;
let app: ReturnType<typeof createRegistrationAPI>;
let alice: AppIdentity;

beforeEach(async () => {
	registry = createTriggerRegistry({db: memoryDB(), app: 'app', definitions});
	await registry.setup();
	app = createRegistrationAPI({
		registry,
		verifier: delegatedIdentityVerifier({serverOrigin: SERVER_ORIGIN, domain: DOMAIN}),
	});
	alice = await appIdentity(DOMAIN);
});

const preflight = (path: string, origin: string, api = app) =>
	api.request(`${SERVER_ORIGIN}${path}`, {
		method: 'OPTIONS',
		headers: {
			Origin: origin,
			'Access-Control-Request-Method': 'POST',
			'Access-Control-Request-Headers': `content-type,${REQUEST_SIGNATURE_HEADER.toLowerCase()}`,
		},
	});

/** A signed registration, as the app's page sends it: from its own origin. */
async function register(origin: string, options?: Parameters<typeof signedPost>[2]) {
	const init = await signedPost(
		alice,
		{serverOrigin: SERVER_ORIGIN, path: '/subscriptions', fields: {kind: 'new-post'}},
		options,
	);
	return app.request(`${SERVER_ORIGIN}/subscriptions`, {
		...init,
		headers: {...(init.headers as Record<string, string>), Origin: origin},
	});
}

const list = (value: string | null) => (value ?? '').split(',').map((entry) => entry.trim().toLowerCase());

describe('CORS on the registration API', () => {
	it("allows a preflight from the served app's origin, on every route, with the headers a signed POST needs", async () => {
		for (const route of ROUTES) {
			const response = await preflight(route, APP_ORIGIN);
			expect(response.status).toBe(204);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
			expect(list(response.headers.get('Access-Control-Allow-Methods')).sort()).toEqual(['options', 'post']);
			expect(list(response.headers.get('Access-Control-Allow-Headers')).sort()).toEqual(
				['content-type', REQUEST_SIGNATURE_HEADER.toLowerCase()].sort(),
			);
			expect(Number(response.headers.get('Access-Control-Max-Age'))).toBeGreaterThan(0);
			expect(list(response.headers.get('Vary'))).toContain('origin');
			expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
		}
	});

	it('gives a preflight from another origin no allow-origin, so the browser blocks it', async () => {
		for (const origin of ['https://evil.test', 'http://game.test', 'https://game.test:8443']) {
			const response = await preflight('/subscriptions', origin);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
			expect(list(response.headers.get('Vary'))).toContain('origin');
		}
	});

	it('carries the allow-origin on a registration, which still verifies at the serverOrigin and path signed', async () => {
		const response = await register(APP_ORIGIN);
		expect(response.status).toBe(200);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
		expect(list(response.headers.get('Vary'))).toContain('origin');
		expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
		expect(await response.json()).toMatchObject({success: true, subscription: {recipient: alice.address}});
		expect(await registry.list(alice.address)).toHaveLength(1);
	});

	it('carries it on every refusal too, so the app can read the reason', async () => {
		const unsigned = await register(APP_ORIGIN, {noSignature: true});
		expect(unsigned.status).toBe(401);
		expect(unsigned.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
		expect(list(unsigned.headers.get('Vary'))).toContain('origin');
		expect(await unsigned.json()).toMatchObject({
			error: 'invalid-proof',
			message: `no ${REQUEST_SIGNATURE_HEADER} header`,
		});

		const notJSON = await app.request(`${SERVER_ORIGIN}/subscriptions`, {
			method: 'POST',
			headers: {Origin: APP_ORIGIN, 'Content-Type': 'application/json'},
			body: 'not json',
		});
		expect(notJSON.status).toBe(400);
		expect(notJSON.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);

		// refused by the registry (a thrown RegistrationError, answered by the error handler)
		const init = await signedPost(alice, {
			serverOrigin: SERVER_ORIGIN,
			path: '/subscriptions',
			fields: {kind: 'no-such-kind'},
		});
		const unknown = await app.request(`${SERVER_ORIGIN}/subscriptions`, {
			...init,
			headers: {...(init.headers as Record<string, string>), Origin: APP_ORIGIN},
		});
		expect(unknown.status).toBe(400);
		expect(unknown.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
		expect(list(unknown.headers.get('Vary'))).toContain('origin');
		expect(await unknown.json()).toMatchObject({error: 'unknown-kind'});
	});

	it('answers an unexpected failure as a JSON 500 that carries it too, and logs the error', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const failing = createRegistrationAPI({
				registry: {
					...registry,
					subscribe: async () => {
						throw new Error('the database is down');
					},
				},
				verifier: delegatedIdentityVerifier({serverOrigin: SERVER_ORIGIN, domain: DOMAIN}),
			});
			const init = await signedPost(alice, {
				serverOrigin: SERVER_ORIGIN,
				path: '/subscriptions',
				fields: {kind: 'new-post'},
			});
			const response = await failing.request(`${SERVER_ORIGIN}/subscriptions`, {
				...init,
				headers: {...(init.headers as Record<string, string>), Origin: APP_ORIGIN},
			});
			expect(response.status).toBe(500);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
			expect(list(response.headers.get('Vary'))).toContain('origin');
			const body = (await response.json()) as Record<string, unknown>;
			expect(body).toMatchObject({success: false, error: 'internal-error'});
			// the cause is the operator's to read, not the caller's
			expect(JSON.stringify(body)).not.toContain('database');
			expect(logged).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({message: 'the database is down'}),
			);
		} finally {
			logged.mockRestore();
		}
	});

	it("leaves the server's proof checks to themselves: a request from another origin gets no allow-origin and the same verdict", async () => {
		const response = await register('https://evil.test');
		expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
		expect(response.status).toBe(200);
	});

	it("takes the origin from the verifier's domain, normalised the way the verifier compares it", async () => {
		expect(delegatedIdentityVerifier({serverOrigin: SERVER_ORIGIN, domain: 'HTTPS://Game.Test/'}).appOrigin).toBe(
			APP_ORIGIN,
		);
		const local = createRegistrationAPI({
			registry,
			verifier: delegatedIdentityVerifier({serverOrigin: 'http://localhost:8787', domain: 'localhost:5173'}),
		});
		const response = await preflight('/subscriptions', 'http://localhost:5173', local);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
	});

	it('answers CORS for the origin any verifier names, and none for a verifier that names no app', async () => {
		const named: RegistrationVerifier = {...testVerifier, appOrigin: APP_ORIGIN};
		const withApp = createRegistrationAPI({registry, verifier: named});
		expect((await preflight('/subscriptions', APP_ORIGIN, withApp)).headers.get('Access-Control-Allow-Origin')).toBe(
			APP_ORIGIN,
		);

		const withoutApp = createRegistrationAPI({registry, verifier: testVerifier});
		expect(
			(await preflight('/subscriptions', APP_ORIGIN, withoutApp)).headers.get('Access-Control-Allow-Origin'),
		).toBeNull();
		const response = await withoutApp.request(`${SERVER_ORIGIN}/subscriptions`, {
			method: 'POST',
			headers: {Origin: APP_ORIGIN, 'Content-Type': 'application/json'},
			body: JSON.stringify({kind: 'new-post', proof: proofFor(alice.address, '/subscriptions')}),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();

		expect(() => createRegistrationAPI({registry, verifier: {...testVerifier, appOrigin: 'game.test'}})).toThrow(
			/not an origin/,
		);
	});
});
