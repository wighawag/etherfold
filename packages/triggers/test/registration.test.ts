import {beforeEach, describe, expect, it} from 'vitest';
import {createRegistrationAPI, createTriggerRegistry, defineTriggers, type TriggerRegistry} from '../src/index.js';
import {memoryDB} from './utils/db.js';
import {ALICE, BOARD, BOB, boardAbi} from './utils/etherfold.js';
import {proofFor, testVerifier} from './utils/verifier.js';

// ---------------------------------------------------------------------------
// REGISTRATION over HTTP: a user registers DATA for themself, and proves who
// they are. The proof is a seam (`RegistrationVerifier`): the recipient is
// always the address the proof recovers, never one the body names.
// ---------------------------------------------------------------------------

const definitions = defineTriggers({
	events: {posted: {address: BOARD, abi: boardAbi[0]}},
	subscriptions: {
		'new-post': {event: 'posted', notFrom: 'author', filterable: ['author'], action: 'push', render: () => ({})},
	},
});

let registry: TriggerRegistry;
let app: ReturnType<typeof createRegistrationAPI>;
beforeEach(async () => {
	registry = createTriggerRegistry({db: memoryDB(), app: 'app', definitions, maxSubscriptionsPerRecipient: 1});
	await registry.setup();
	app = createRegistrationAPI({registry, verifier: testVerifier});
});

async function post(path: string, body: unknown) {
	const response = await app.request(path, {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify(body),
	});
	return {status: response.status, body: (await response.json()) as Record<string, unknown>};
}

describe('the registration API', () => {
	it('registers a subscription for the address the proof recovers', async () => {
		const answer = await post('/subscriptions', {kind: 'new-post', proof: proofFor(ALICE, '/subscriptions')});
		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({
			success: true,
			subscription: {kind: 'new-post', recipient: ALICE.toLowerCase()},
		});
		expect(typeof (answer.body['subscription'] as {expiresAt: number}).expiresAt).toBe('number');
		expect(await registry.list(ALICE)).toHaveLength(1);
	});

	it('refuses without a proof, with a bad one, and with one minted for another route', async () => {
		expect((await post('/subscriptions', {kind: 'new-post'})).status).toBe(401);
		expect((await post('/subscriptions', {kind: 'new-post', proof: {address: ALICE, signature: 'x'}})).status).toBe(
			401,
		);
		expect(
			(await post('/subscriptions', {kind: 'new-post', proof: proofFor(ALICE, '/subscriptions/cancel')})).status,
		).toBe(401);
		expect(await registry.list(ALICE)).toEqual([]);
	});

	it('answers a refused registration with its code', async () => {
		const unknown = await post('/subscriptions', {kind: 'nope', proof: proofFor(ALICE, '/subscriptions')});
		expect(unknown).toMatchObject({status: 400, body: {success: false, error: 'unknown-kind'}});
		const filter = await post('/subscriptions', {
			kind: 'new-post',
			filter: {count: '1'},
			proof: proofFor(ALICE, '/subscriptions'),
		});
		expect(filter).toMatchObject({status: 400, body: {error: 'invalid-filter'}});
		await post('/subscriptions', {kind: 'new-post', proof: proofFor(ALICE, '/subscriptions')});
		const quota = await post('/subscriptions', {
			kind: 'new-post',
			filter: {author: BOB},
			proof: proofFor(ALICE, '/subscriptions'),
		});
		expect(quota).toMatchObject({status: 429, body: {error: 'quota-exceeded'}});
		expect((await post('/subscriptions', {proof: proofFor(ALICE, '/subscriptions')})).status).toBe(400);
	});

	it('renews, lists and cancels only the prover own subscriptions', async () => {
		await post('/subscriptions', {kind: 'new-post', proof: proofFor(ALICE, '/subscriptions')});
		await post('/subscriptions', {kind: 'new-post', proof: proofFor(BOB, '/subscriptions')});

		expect(await post('/subscriptions/renew', {proof: proofFor(ALICE, '/subscriptions/renew')})).toMatchObject({
			status: 200,
			body: {renewed: 1},
		});
		const listed = await post('/subscriptions/list', {proof: proofFor(ALICE, '/subscriptions/list')});
		expect((listed.body['subscriptions'] as unknown[]).length).toBe(1);

		expect(
			await post('/subscriptions/cancel', {kind: 'new-post', proof: proofFor(ALICE, '/subscriptions/cancel')}),
		).toMatchObject({status: 200, body: {cancelled: true}});
		expect((await registry.list(ALICE))[0]?.status).toBe('cancelled');
		expect((await registry.list(BOB))[0]?.status).toBe('active');
	});
});
