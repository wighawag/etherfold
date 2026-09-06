import {describe, it, expect, beforeEach} from 'vitest';
import {createClient} from '@libsql/client';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL} from 'remote-sql';
import {createServer, SCHEMA_VERSION, type CursorReporter} from '../src/index.js';
import {clearLastError} from '../src/api/status.js';

type TestEnv = {DEV?: string};

function serverOn(db: RemoteSQL, getCursorReport?: CursorReporter<TestEnv>) {
	return createServer<TestEnv>({getDB: () => db, getEnv: () => ({DEV: 'true'}), getCursorReport});
}

function freshDB(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

describe('the server runs with no platform adapter', () => {
	beforeEach(() => clearLastError());

	it('reports unhealthy on a database whose schema was never applied', async () => {
		const res = await serverOn(freshDB()).request('/status');
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.healthy).toBe(false);
		expect(body.database.reachable).toBe(true);
		expect(body.schema.applied).toBe(false);
	});

	it('reports healthy once the schema is applied', async () => {
		const app = serverOn(freshDB());
		const setup = await app.request('/admin/setup', {method: 'POST'});
		expect(setup.status).toBe(200);
		expect(await setup.json()).toEqual({success: true, version: SCHEMA_VERSION});

		const res = await app.request('/status');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({
			healthy: true,
			database: {reachable: true},
			schema: {applied: true, version: SCHEMA_VERSION, expected: SCHEMA_VERSION, matches: true},
		});
	});

	it('applying the schema twice is idempotent, so a restart is not a migration', async () => {
		const app = serverOn(freshDB());
		await app.request('/admin/setup', {method: 'POST'});
		const second = await app.request('/admin/setup', {method: 'POST'});
		expect(second.status).toBe(200);
		expect((await (await app.request('/status')).json()).healthy).toBe(true);
	});

	it('distinguishes an unreachable database from a merely unmigrated one', async () => {
		const broken: RemoteSQL = {
			prepare: () => {
				throw new Error('connection refused');
			},
		} as unknown as RemoteSQL;

		const res = await serverOn(broken).request('/status');
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.database.reachable).toBe(false);
		expect(body.database.error).toContain('connection refused');
		// and the failure is retained, which is what tells a wedged server from an idle one
		expect(body.lastError.message).toContain('connection refused');
	});

	it('reports a schema written by a different version as unhealthy rather than pretending', async () => {
		const db = freshDB();
		const app = serverOn(db);
		await app.request('/admin/setup', {method: 'POST'});
		await db.prepare(`UPDATE _meta SET value = ?1 WHERE key = ?2`).bind('999', 'schemaVersion').all();

		const res = await app.request('/status');
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.healthy).toBe(false);
		expect(body.schema).toMatchObject({applied: true, version: 999, expected: SCHEMA_VERSION, matches: false});
	});

	it('injects per request, so two requests can hit two different databases', async () => {
		// this is the property that lets one app serve a D1 binding that only
		// exists per-request on Workers
		const a = freshDB();
		const b = freshDB();
		let current = a;
		const app = createServer<TestEnv>({getDB: () => current, getEnv: () => ({})});

		await app.request('/admin/setup', {method: 'POST'});
		expect((await (await app.request('/status')).json()).healthy).toBe(true);

		current = b;
		expect((await (await app.request('/status')).json()).schema.applied).toBe(false);
	});
});

describe('/status reports the cursor a host injects, and nothing when none is', () => {
	beforeEach(() => clearLastError());

	async function migratedServer(getCursorReport?: CursorReporter<TestEnv>) {
		const app = serverOn(freshDB(), getCursorReport);
		await app.request('/admin/setup', {method: 'POST'});
		return app;
	}

	it('reports what the reporter returned, verbatim and inside an object', async () => {
		const report = {lastToBlock: 4242, latestBlock: 4250, unconfirmedBlocks: 3};
		const app = await migratedServer(() => ({value: report}));

		const res = await app.request('/status');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.cursor).toEqual({reported: true, value: report});
		expect(body.healthy).toBe(true);
	});

	it('passes a nested report through untouched, because the server does not parse it', async () => {
		// deliberately a shape this package knows nothing about: only the processor
		// knows what a cursor means (ADR-0027), so the server may not normalise it
		// note the `generations` key INSIDE the value: the envelope carries one of its
		// own beside `value`, and a host is still free to use the word in a report the
		// server does not parse. The two never meet, which is why the reporter names
		// the two slots explicitly rather than being sniffed for which it meant.
		const report = {
			generations: [{id: 'a', lastToBlock: 10, context: {source: {chainId: '1'}}}],
			nested: {deep: [1, 'two', true, null]},
		};
		const app = await migratedServer(() => ({value: report}));

		const body = await (await app.request('/status')).json();
		expect(body.cursor.value).toEqual(report);
		expect('generations' in body.cursor).toBe(false);
	});

	it('awaits a reporter that reads asynchronously, which is what reading a store is', async () => {
		const app = await migratedServer(async () => ({value: {lastToBlock: 7}}));

		const body = await (await app.request('/status')).json();
		expect(body.cursor).toEqual({reported: true, value: {lastToBlock: 7}});
	});

	it('invents no cursor field on a host that injected no reporter', async () => {
		const app = await migratedServer();

		const res = await app.request('/status');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect('cursor' in body).toBe(false);
		// and every other status assertion is unchanged by the option existing
		expect(body).toMatchObject({healthy: true, database: {reachable: true}, schema: {applied: true}});
	});

	it('degrades to absent-with-a-reason when the reporter throws, without failing the route', async () => {
		const app = await migratedServer(() => {
			throw new Error('the cursor table is locked');
		});

		const res = await app.request('/status');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.healthy).toBe(true); // a broken reporter is not a broken server
		expect(body.cursor.reported).toBe(false);
		expect(body.cursor.reason).toContain('the cursor table is locked');
	});

	it('degrades the same way when the reporter rejects', async () => {
		const app = await migratedServer(async () => {
			throw new Error('database unreachable from the reporter');
		});

		const body = await (await app.request('/status')).json();
		expect(body.cursor.reported).toBe(false);
		expect(body.cursor.reason).toContain('database unreachable from the reporter');
	});

	it('degrades when the reporter says it has nothing to report', async () => {
		const app = await migratedServer(() => undefined);

		const res = await app.request('/status');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.cursor.reported).toBe(false);
		expect(typeof body.cursor.reason).toBe('string');
	});

	it('degrades on a report that cannot be serialised, rather than taking the page down', async () => {
		// a bigint does not compile against the option's type, and a host can still
		// build one at runtime; `/status` is the page an operator watches while
		// something is wrong, so it must survive that
		const app = await migratedServer(() => ({value: {lastToBlock: 10n}}) as never);

		const res = await app.request('/status');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.healthy).toBe(true);
		expect(body.cursor.reported).toBe(false);
	});

	it('does not flip healthy or the status code on an unhealthy server either', async () => {
		const app = serverOn(freshDB(), () => ({value: {lastToBlock: 1}}));

		const res = await app.request('/status');
		expect(res.status).toBe(503); // unmigrated, exactly as before
		const body = await res.json();
		expect(body.healthy).toBe(false);
		expect(body.cursor).toEqual({reported: true, value: {lastToBlock: 1}});
	});
});

describe('the SQL and the code agree about the schema version', () => {
	it('SCHEMA_VERSION matches the row db.sql actually inserts', async () => {
		// The version row is written by the SQL, because wrangler's D1 migrations
		// run the SQL and never call applySchema. This test is what keeps the
		// TypeScript constant honest about what the SQL does.
		const {default: sql} = await import('../src/schema/ts/db.sql.js');
		const match = /INSERT INTO _meta \(key, value\) VALUES \('schemaVersion', '(\d+)'\)/.exec(sql);
		expect(match, 'db.sql must insert a schemaVersion row').toBeTruthy();
		expect(Number(match![1])).toBe(SCHEMA_VERSION);
	});
});
