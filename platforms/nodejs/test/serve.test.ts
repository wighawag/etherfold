import {describe, it, expect, afterEach} from 'vitest';
import {REORG_COUNTER_KEY, REORG_LAST_KEY} from '@etherfold/core';
import {readSchemaState} from '@etherfold/server';
import {createNodeDB, startServer, type RunningServer, type StartOptions} from '../src/index.js';
import type {RemoteSQL} from 'remote-sql';

/**
 * Count a revert the way the OWNER of a store does, which is deliberately not
 * something this adapter or the server package can do for us.
 *
 * A concluded reorg is counted once, inside `StreamBuilder.receive`, through a
 * recorder the process that opened the database supplies (ADR-0050) -- in this
 * repository that is `etherfold`'s `recordReorg`, which no platform adapter may
 * depend on. What the two ends share is the KEY, from `@etherfold/core`, which
 * is why this can write a row the server will read back without either of them
 * spelling the name twice.
 */
async function countAReorgOutsideTheServer(db: RemoteSQL, blockNumber: number): Promise<void> {
	await db.batch([
		db.prepare(`INSERT INTO _meta (key, value) VALUES (?1, '1')`).bind(REORG_COUNTER_KEY.absence),
		db
			.prepare(`INSERT INTO _meta (key, value) VALUES (?1, ?2)`)
			.bind(REORG_LAST_KEY, JSON.stringify({cause: 'absence', blockNumber, blockHash: '0xdead', at: 'now'})),
	]);
}

let running: RunningServer | undefined;

const TOKEN = 'a-shared-secret';

/** The NAMED INDEXER this adapter is given, and the first segment of every ingest route. */
const INDEXER = 'alpha';

/**
 * One of the LIVE WIRE CONTEXTS inside the registry entry this adapter passes
 * through, as the adapter sees it.
 *
 * Spelled through `StartOptions` rather than imported from `@etherfold/core`,
 * because this package depends on no engine and no store and the test must not
 * be the thing that adds one.
 */
type Ingestion = Awaited<
	ReturnType<NonNullable<ReturnType<NonNullable<StartOptions['getIndexer']>>>['liveIngestions']>
>[number];

/** A stand-in for a stream-builder: it records what reached it and nothing else. */
function fakeIngestion(expected: number) {
	const received: {fromBlock: number; toBlock: number}[] = [];
	const ingestion: Ingestion = {
		context: {source: [{startBlock: 100, hash: '0xsource'}], config: '{}'},
		// WHICH stream this folds, which is what the server keys the stored emission
		// stream on. A fixed string here: this adapter routes batches and stores none.
		streamDigest: '0123456789abcdef0123456789abcdef',
		// and WHICH GENERATION it is, which the feed advertises. Fixed here for the
		// same reason: this adapter routes batches and folds nothing.
		generation: {stream: '0123456789abcdef0123456789abcdef', processor: '1.0.0-fake'},
		expectedFromBlock: async () => expected,
		receive: async (batch) => {
			received.push({fromBlock: batch.fromBlock, toBlock: batch.toBlock});
			return {applied: 1, retracted: 0, emissions: [], expectedFromBlock: batch.toBlock + 1};
		},
	};
	return {ingestion, received};
}

afterEach(async () => {
	await running?.close();
	running = undefined;
});

describe('the node adapter serves the app over real HTTP', () => {
	it('starts, applies the schema, and reports healthy', async () => {
		running = await startServer({db: ':memory:', port: 0});

		const res = await fetch(`${running.url}/status`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {healthy: boolean; schema: {applied: boolean}};
		expect(body.healthy).toBe(true);
		expect(body.schema.applied).toBe(true);
	});

	it('honours autoSetup: false, so an operator can own migration', async () => {
		running = await startServer({db: ':memory:', port: 0, autoSetup: false});

		const before = await fetch(`${running.url}/status`);
		expect(before.status).toBe(503);
		expect(((await before.json()) as {schema: {applied: boolean}}).schema.applied).toBe(false);

		const setup = await fetch(`${running.url}/admin/setup`, {method: 'POST'});
		expect(setup.status).toBe(200);

		const after = await fetch(`${running.url}/status`);
		expect(after.status).toBe(200);
	});

	it('binds a real port when asked for 0, and reports which one', async () => {
		running = await startServer({db: ':memory:', port: 0});
		expect(running.port).toBeGreaterThan(0);
		expect(running.url).toContain(String(running.port));
	});
});

describe('the adapter starts on a database handle its caller built', () => {
	it('serves on the given handle, and hands back that very handle', async () => {
		const db = createNodeDB(':memory:');
		running = await startServer({db, port: 0});

		const res = await fetch(`${running.url}/status`);
		expect(res.status).toBe(200);
		expect(((await res.json()) as {schema: {applied: boolean}}).schema.applied).toBe(true);
		expect(running.db).toBe(db);
	});

	it('shares it: a write made outside the server is visible to a read the server answers', async () => {
		const db = createNodeDB(':memory:');
		running = await startServer({db, port: 0});

		// the assertion below cannot pass by accident, and this is why: a SECOND
		// connection to `:memory:` is a different database entirely, so it does not
		// even carry the schema the server just applied through the handle it was given
		expect((await readSchemaState(createNodeDB(':memory:'))).applied).toBe(false);

		await countAReorgOutsideTheServer(db, 4242);

		const body = (await (await fetch(`${running.url}/status`)).json()) as {
			reorgs: {absence: number; contradiction: number; last?: {blockNumber: number}};
		};
		expect(body.reorgs.absence).toBe(1);
		expect(body.reorgs.last?.blockNumber).toBe(4242);
	});

	it('auto-sets the schema up on the given handle, so both forms start usable', async () => {
		const db = createNodeDB(':memory:');
		expect((await readSchemaState(db)).applied).toBe(false);

		running = await startServer({db, port: 0});

		expect((await readSchemaState(db)).applied).toBe(true);
	});

	it('honours autoSetup: false on the given handle too', async () => {
		const db = createNodeDB(':memory:');
		running = await startServer({db, port: 0, autoSetup: false});

		expect((await readSchemaState(db)).applied).toBe(false);
		expect((await fetch(`${running.url}/status`)).status).toBe(503);

		expect((await fetch(`${running.url}/admin/setup`, {method: 'POST'})).status).toBe(200);
		expect((await fetch(`${running.url}/status`)).status).toBe(200);
		expect((await readSchemaState(db)).applied).toBe(true);
	});
});

describe('the adapter carries the host-supplied capabilities through to the app', () => {
	it('reports the cursor a supplied reporter returns, verbatim', async () => {
		const report = {lastToBlock: 4242, latestBlock: 4250};
		running = await startServer({db: ':memory:', port: 0, getCursorReport: () => report});

		const body = (await (await fetch(`${running.url}/status`)).json()) as {cursor: unknown};
		expect(body.cursor).toEqual({reported: true, value: report});
	});

	it('invents no cursor when no reporter is supplied, as the read tier starts today', async () => {
		running = await startServer({db: ':memory:', port: 0});

		const body = (await (await fetch(`${running.url}/status`)).json()) as Record<string, unknown>;
		expect('cursor' in body).toBe(false);
	});

	it('lets a supplied ingestion receive logs, so a process on Node can host a processor', async () => {
		const {ingestion, received} = fakeIngestion(105);
		// the handle is built HERE rather than from a URL, because a named indexer
		// resolves to the database it owns (ADR-0053) and this host holds one name: the
		// same handle the adapter answers `/status` over is the one that name owns
		const db = createNodeDB(':memory:');
		running = await startServer({
			db,
			port: 0,
			env: {INGEST_TOKEN: TOKEN},
			// the registry this host was built with: ONE named indexer, resolved per
			// request and refusing every other name
			getIndexer: (_c, name) =>
				name === INDEXER
					? {db, liveIngestions: async () => [ingestion], canonicalGeneration: async () => ingestion.generation}
					: undefined,
		});

		const asked = await fetch(`${running.url}/${INDEXER}/ingest/expected-from-block`, {
			method: 'POST',
			headers: {Authorization: `Bearer ${TOKEN}`},
		});
		expect(asked.status).toBe(200);
		// ONE PAIR PER LIVE WIRE CONTEXT: this adapter passes one through, so the list
		// has one entry in it
		expect((await asked.json()) as unknown).toEqual({
			success: true,
			contexts: [{context: ingestion.context, expectedFromBlock: 105}],
		});

		const pushed = await fetch(`${running.url}/${INDEXER}/ingest`, {
			method: 'POST',
			headers: {Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json'},
			body: JSON.stringify({fromBlock: 105, toBlock: 110, latestBlock: 110, logs: [], context: ingestion.context}),
		});
		expect(pushed.status).toBe(200);
		expect(((await pushed.json()) as {applied: number}).applied).toBe(1);
		expect(received).toEqual([{fromBlock: 105, toBlock: 110}]);

		// and a name this host was NOT built with is refused rather than served by
		// the one it holds
		const elsewhere = await fetch(`${running.url}/beta/ingest/expected-from-block`, {
			method: 'POST',
			headers: {Authorization: `Bearer ${TOKEN}`},
		});
		expect(elsewhere.status).toBe(404);
		expect(((await elsewhere.json()) as {error: string}).error).toBe('unknown-indexer');
	});

	it('answers 501 to an AUTHENTICATED caller when no ingestion is supplied, exactly as today', async () => {
		running = await startServer({db: ':memory:', port: 0, env: {INGEST_TOKEN: TOKEN}});

		const res = await fetch(`${running.url}/${INDEXER}/ingest/expected-from-block`, {
			method: 'POST',
			headers: {Authorization: `Bearer ${TOKEN}`},
		});
		expect(res.status).toBe(501);
		expect(((await res.json()) as {error: string}).error).toBe('ingestion-not-configured');
	});

	it('answers 401 to an unauthenticated caller, so the absence of a processor is not a probe', async () => {
		running = await startServer({db: ':memory:', port: 0, env: {INGEST_TOKEN: TOKEN}});

		expect((await fetch(`${running.url}/${INDEXER}/ingest`, {method: 'POST', body: '{}'})).status).toBe(401);
		expect((await fetch(`${running.url}/${INDEXER}/ingest/expected-from-block`, {method: 'POST'})).status).toBe(401);
	});
});

// ---------------------------------------------------------------------------------------------------
// THIS IS THE READ TIER, AND IT REFUSES TO WRITE
// ---------------------------------------------------------------------------------------------------
// `etherfold serve` starts a server exactly this way: `{getDB, getEnv}` and no
// `getIndexer` (`src/index.ts`). So it holds no processor, receives no logs,
// and answers queries over a database something else writes -- which is what
// `CONTEXT.md` reserves the word `serve` for.
//
// The routes are MOUNTED either way, so what separates a read tier from a wire
// receiver is a CAPABILITY and not a route table. Two things are asserted
// together, because either alone would be misleading:
//
//   - an AUTHENTICATED caller gets `501 ingestion-not-configured`. It has to be
//     authenticated: the token guard is registered on the PATH
//     (`/:indexer/ingest` and `/:indexer/ingest/*`) AHEAD of the capability
//     lookup and fails closed, exactly as
//     `packages/server/test/ingest.test.ts` drives it;
//   - an UNAUTHENTICATED one still gets `401`, and must keep doing so. Moving
//     the capability check in front of the guard would make the prose literal at
//     the cost of telling an anonymous caller whether a server hosts a processor.
//
// The database is named explicitly (`:memory:`), so running the suite never
// lands on the adapter's `file:./etherfold.db` convenience default and never
// leaves a stray database behind.
// ---------------------------------------------------------------------------------------------------

const AUTHENTICATED = {Authorization: `Bearer ${TOKEN}`};

describe('the tier `serve` starts holds no processor', () => {
	it('answers 501 on the ingestion routes, while /status still answers', async () => {
		running = await startServer({db: ':memory:', port: 0, env: {INGEST_TOKEN: TOKEN}});

		const cursor = await fetch(`${running.url}/${INDEXER}/ingest/expected-from-block`, {
			method: 'POST',
			headers: AUTHENTICATED,
		});
		expect(cursor.status).toBe(501);
		expect(((await cursor.json()) as {error: string}).error).toBe('ingestion-not-configured');

		const pushed = await fetch(`${running.url}/${INDEXER}/ingest`, {
			method: 'POST',
			headers: AUTHENTICATED,
			body: JSON.stringify({fromBlock: 100, toBlock: 105, latestBlock: 105, logs: []}),
		});
		expect(pushed.status).toBe(501);
		expect(((await pushed.json()) as {error: string}).error).toBe('ingestion-not-configured');

		// the read half is untouched by the refusal of the write half
		const status = await fetch(`${running.url}/status`);
		expect(status.status).toBe(200);
		expect(((await status.json()) as {healthy: boolean}).healthy).toBe(true);
	});

	it('refuses an unauthenticated caller first, so the absence is not a probe', async () => {
		running = await startServer({db: ':memory:', port: 0, env: {INGEST_TOKEN: TOKEN}});

		const cursor = await fetch(`${running.url}/${INDEXER}/ingest/expected-from-block`, {method: 'POST'});
		expect(cursor.status).toBe(401);

		const pushed = await fetch(`${running.url}/${INDEXER}/ingest`, {method: 'POST', body: '{}'});
		expect(pushed.status).toBe(401);
	});
});
