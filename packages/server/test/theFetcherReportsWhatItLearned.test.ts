import {createClient} from '@libsql/client';
import type {FetcherLimits} from '@etherfold/core';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL} from 'remote-sql';
import {describe, expect, it} from 'vitest';
import {createServer, type FetcherLimitsReporter} from '../src/index.js';

// ---------------------------------------------------------------------------------------------------
// WHAT THE FETCHER BELIEVES ABOUT THE PROVIDER, ON THE PAGE AN OPERATOR ALREADY WATCHES
// ---------------------------------------------------------------------------------------------------
// The range fetcher adapts by being refused, and what it has learned used to be
// visible only in timings. It is now a field on `/status`, beside the reorg
// counters and the cursor envelope -- reported by a host that HOLDS a fetcher,
// and ABSENT on one that does not (ADR-0074).
//
// Absent rather than empty is the whole of the shape: a receiving host (`index`)
// and a read tier (`serve`) make no chain call at all, so they have nothing to
// believe about a provider, and an invented `{}` would read as a fetcher that
// has learned nothing.
//
// It is a TYPED field rather than the opaque value the cursor is, because the
// server knows exactly what this one means: it is `@etherfold/core`'s, a package
// this one already depends on, and unlike a sync cursor it hides behind no
// storage seam (ADR-0027 is why `cursor` is opaque and this is not).
// ---------------------------------------------------------------------------------------------------

type TestEnv = {DEV?: string};

const LEARNED: FetcherLimits = {
	learnedRange: {ceiling: 2000, safeSpan: 1999, nextSize: 1999},
	suspectResultCount: {count: 10000, source: 'reported'},
};

function freshDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

async function statusOf(getFetcherLimits?: FetcherLimitsReporter<TestEnv>) {
	// ONE handle for both requests: `getDB` answers per REQUEST, and a fresh
	// database on every call would migrate one and read another
	const db = freshDatabase();
	const app = createServer<TestEnv>({
		getDB: () => db,
		getEnv: () => ({DEV: 'true'}),
		...(getFetcherLimits ? {getFetcherLimits} : {}),
	});
	await app.request('/admin/setup', {method: 'POST'});
	const res = await app.request('/status');
	return {status: res.status, body: (await res.json()) as Record<string, any>};
}

describe('/status reports what the fetcher has learned about the provider', () => {
	it('carries the learned range and the suspect count, beside the counters already there', async () => {
		const {status, body} = await statusOf(() => LEARNED);

		expect(status).toBe(200);
		expect(body.healthy).toBe(true);
		expect(body.fetcher).toEqual({
			reported: true,
			learnedRange: {ceiling: 2000, safeSpan: 1999, nextSize: 1999},
			suspectResultCount: {count: 10000, source: 'reported'},
		});
		// the numbers an operator hands back to the next run as `LEARNED_RANGE`, which
		// is the whole reason they are reported rather than logged once
		expect(body.reorgs).toBeDefined();
	});

	it('reports a fetcher that has learned nothing yet without inventing a ceiling', async () => {
		// A fresh process, before the first refusal. `nextSize` is the only thing it
		// knows, and a zero ceiling would read as "this provider serves nothing".
		const {body} = await statusOf(() => ({
			learnedRange: {nextSize: 50},
			suspectResultCount: {count: 10000, source: 'default'},
		}));

		expect(body.fetcher).toEqual({
			reported: true,
			learnedRange: {nextSize: 50},
			suspectResultCount: {count: 10000, source: 'default'},
		});
	});

	it('carries no fetcher field at all on a host that holds no fetcher', async () => {
		// `index` and `serve` are exactly this: the receiving half makes no chain call,
		// so there is no provider to have learned anything about. Same rule the cursor
		// follows on a host that injects no reporter -- nothing is invented in its place.
		const {status, body} = await statusOf();

		expect(status).toBe(200);
		expect('fetcher' in body).toBe(false);
	});

	it('degrades to a reason rather than failing the page when the reporter throws', async () => {
		const {status, body} = await statusOf(() => {
			throw new Error('the host has not built its fetcher yet');
		});

		expect(status).toBe(200);
		// unchanged: an operational read that could take the health page down would be
		// worse than no operational read
		expect(body.healthy).toBe(true);
		expect(body.fetcher).toEqual({
			reported: false,
			reason: expect.stringContaining('the host has not built its fetcher yet'),
		});
	});

	it('degrades when a reporter has nothing to report, rather than omitting the field', async () => {
		// The distinction the field exists to make: "this deployment runs no fetcher"
		// (no field) is not "this deployment's fetcher cannot be read right now".
		const {body} = await statusOf(() => undefined);

		expect(body.fetcher.reported).toBe(false);
		expect(typeof body.fetcher.reason).toBe('string');
	});
});
