import type {UsedPromotionConfig} from '@etherfold/core';
import {createClient} from '@libsql/client';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {describe, expect, it} from 'vitest';
import {createServer, type PromotionReporter} from '../src/index.js';

// ---------------------------------------------------------------------------------------------------
// WHEN THIS DEPLOYMENT TAKES A SUCCESSOR OVER, ON THE PAGE AN OPERATOR ALREADY WATCHES
// ---------------------------------------------------------------------------------------------------
// The promotion policy decides WHEN the canonical pointer moves on its own, and
// it is otherwise observable only as BEHAVIOUR: an operator watching a successor
// catch up on `/status` would have to WAIT to find out whether it is going to
// take over by itself, at once, or never. So it is a field beside the cursor
// envelope and the fetcher field, reported by a host that HOLDS a generation
// container and ABSENT on one that does not.
//
// Absent rather than empty is the same shape the fetcher field has, for the same
// reason: a read tier (`serve`) READS a pointer that something else moves, so it
// decides nothing about promotion, and an invented `{policy: 'on-catch-up'}`
// there would be a claim about a decision that host does not make.
//
// It is a TYPED field rather than the opaque value the cursor is, for the fetcher
// field's reason: it is `@etherfold/core`'s `UsedPromotionConfig`, from a package
// this one already depends on, and it hides behind no storage seam.
// ---------------------------------------------------------------------------------------------------

type TestEnv = {DEV?: string};

function freshDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

async function statusOf(getPromotionPolicy?: PromotionReporter<TestEnv>) {
	// ONE handle for both requests: `getDB` answers per REQUEST, and a fresh
	// database on every call would migrate one and read another
	const db = freshDatabase();
	const app = createServer<TestEnv>({
		getDB: () => db,
		getEnv: () => ({DEV: 'true'}),
		...(getPromotionPolicy ? {getPromotionPolicy} : {}),
	});
	await app.request('/admin/setup', {method: 'POST'});
	const res = await app.request('/status');
	return {status: res.status, body: (await res.json()) as Record<string, any>};
}

describe('/status reports WHEN this deployment moves its canonical pointer', () => {
	it('carries the RESOLVED policy and the drop setting, beside the fields already there', async () => {
		const resolved: UsedPromotionConfig = {policy: 'immediate', dropOnPromotion: false};
		const {status, body} = await statusOf(() => resolved);

		expect(status).toBe(200);
		expect(body.healthy).toBe(true);
		// RESOLVED and not as-configured: an operator reads what will actually happen,
		// including the half they never mentioned
		expect(body.promotion).toEqual({reported: true, policy: 'immediate', dropOnPromotion: false});
	});

	it('reports the default as a value rather than as an absence', async () => {
		// The commonest deployment configured nothing at all, and "nothing was said" is
		// exactly the case an operator cannot tell from behaviour without waiting for a
		// reconfigure. The container resolves it, so the page states it.
		const {body} = await statusOf(() => ({policy: 'on-catch-up', dropOnPromotion: false}));

		expect(body.promotion).toEqual({reported: true, policy: 'on-catch-up', dropOnPromotion: false});
	});

	it('carries no promotion field at all on a host that decides no promotion', async () => {
		// `serve` is exactly this: a read tier folds nothing and promotes nothing, it
		// reads the pointer whatever wrote the database moves. Same rule the cursor and
		// the fetcher follow -- nothing is invented in place of a capability not held.
		const {status, body} = await statusOf();

		expect(status).toBe(200);
		expect('promotion' in body).toBe(false);
	});

	it('degrades to a reason rather than failing the page when the reporter throws', async () => {
		const {status, body} = await statusOf(() => {
			throw new Error('the host has not opened its container yet');
		});

		expect(status).toBe(200);
		// unchanged: an operational read that could take the health page down would be
		// worse than no operational read
		expect(body.healthy).toBe(true);
		expect(body.promotion).toEqual({
			reported: false,
			reason: expect.stringContaining('the host has not opened its container yet'),
		});
	});

	it('degrades when a reporter has nothing to report, rather than omitting the field', async () => {
		// The distinction the field exists to make: "this deployment decides no
		// promotion" (no field) is not "this deployment's policy cannot be read".
		const {body} = await statusOf(() => undefined);

		expect(body.promotion.reported).toBe(false);
		expect(typeof body.promotion.reason).toBe('string');
	});
});
