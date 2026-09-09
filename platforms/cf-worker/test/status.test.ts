import {describe, it, expect} from 'vitest';
import {fetchWorker} from './utils.js';

describe('the worker host serves the same app as the node host', () => {
	it('reports healthy against a migrated D1', async () => {
		const res = await fetchWorker('/status');
		expect(res.status).toBe(200);
		const body = (await res.json()) as {healthy: boolean; database: {reachable: boolean}; schema: {applied: boolean}};
		expect(body.healthy).toBe(true);
		expect(body.database.reachable).toBe(true);
		expect(body.schema.applied).toBe(true);
	});

	it('reports no cursor, because this host owns no store to read one from', async () => {
		// the absent case exercised by a REAL host rather than by a test double: this
		// worker builds the app with a D1 binding and an environment and nothing else,
		// so it injects no cursor reporter and `/status` invents no field in its place
		const body = (await (await fetchWorker('/status')).json()) as Record<string, unknown>;
		expect(body).not.toHaveProperty('cursor');
		expect(body.healthy).toBe(true);
	});

	it('serves the same status shape the node adapter serves', async () => {
		const body = (await (await fetchWorker('/status')).json()) as Record<string, unknown>;

		// Asserted in TWO directions, because they fail differently and an earlier version
		// of this test could only catch one. It compared the body's keys against a list
		// `.filter((k) => k in body)`, which derives the expectation FROM the body: a field
		// the host stopped reporting vanished from both sides and the test stayed green.
		// (An ADDED key did fail it, so the hole was one-directional.)
		//
		// The contract cannot simply be an equality either, because `/status` OMITS a field
		// it has no wiring for rather than sending a null: `reorgs`, `cursor` and `fetcher`
		// depend on what the host injected, and `lastError` appears only once something has
		// failed. This worker injects none of them, which is what the case above pins.
		const CONTRACT = ['cursor', 'database', 'fetcher', 'healthy', 'lastError', 'reorgs', 'schema'];
		const ALWAYS = ['database', 'healthy', 'schema'];

		// nothing outside the contract: a host may not invent a field
		expect(Object.keys(body).filter((k) => !CONTRACT.includes(k))).toEqual([]);
		// and nothing unconditional missing: this is the direction that used to slip through
		expect(ALWAYS.filter((k) => !(k in body))).toEqual([]);

		expect(body).toHaveProperty('schema.expected');
	});
});
