import {createClient} from '@libsql/client';
import {generationDigestOf, type GenerationId} from '@etherfold/core';
import {
	executorToFetch,
	httpExecutor,
	isTransportFailure,
	QUERY_ERROR_CODES,
	type FetchFunction,
	type QueryResult,
} from '@etherfold/graphql';
import {
	describeQueryConformance,
	HISTORY,
	QUERY_ENTITIES,
	subjectWith,
	type QueryExecutorFactory,
	type QuerySubject,
} from '@etherfold/graphql/conformance';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {describe, expect, it} from 'vitest';
import {applySchema, createServer, openGenerationRegistryOnSQL, type Env, type GraphQLServing} from '../src/index.js';

// ---------------------------------------------------------------------------------------------------
// THE SERVER ANSWERS GRAPHQL OVER HTTP (ADR-0099)
// ---------------------------------------------------------------------------------------------------
// `POST /graphql` on the real app (`createServer`, Hono and Yoga), over a real
// libSQL database holding a canonical generation, asked through `httpExecutor`:
// the query conformance suite must answer the same BYTES it answers in process,
// once per retention claim the FOLDING process can make (a `revert-only` served
// database included), and every way this transport breaks must reach the client
// as the one transport-failure shape.
//
// The request goes through the app's own `fetch` rather than a socket: the
// socket is the Node adapter's, and `etherfold serve` asks the suite over one.
// ---------------------------------------------------------------------------------------------------

const INDEXER = 'pools';
const GENERATION: GenerationId = {stream: 'stream-digest', processor: 'sha256:processor'};

type Retention = Pick<GraphQLServing, 'retention' | 'finalityDepth'>;

/** A database a folding command could have written: the fixed tables and one canonical generation. */
async function aDatabase(): Promise<RemoteSQL> {
	const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
	await applySchema(db);
	const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: {maxGenerations: 4, maxStreams: 4}});
	await registry.create(GENERATION);
	await registry.moveCanonicalTo(GENERATION);
	return db;
}

/** How a subject's transport is broken: the database the app reads, or the fetch between client and app. */
type Faults = {db?: RemoteSQL; fetch?: FetchFunction};
const faultsOf = new WeakMap<QuerySubject, Faults>();

/**
 * The factory the suite is asked of: a fresh database per subject, the store the
 * suite WRITES through folding into the canonical generation's namespace (as a
 * folding process does), and `httpExecutor` against the app's `/graphql`, which
 * resolves that generation from the rows and reads it through its own store.
 */
function overHttp(retention: Retention = {}): QueryExecutorFactory {
	return async (declarations) => {
		const db = await aDatabase();
		const store = new VersionedStateStore(db, declarations, {
			tableNamespace: generationDigestOf(GENERATION),
			...retention,
		});
		const faults: Faults = {};
		const app = createServer<Env>({
			getDB: () => faults.db ?? db,
			getEnv: () => ({}),
			graphql: {declarationsOf: async () => declarations, ...retention},
		});
		const served: FetchFunction = async (input, init) => app.fetch(new Request(input, init));
		const subject: QuerySubject = {
			store,
			generation: generationDigestOf(GENERATION),
			executor: httpExecutor('http://etherfold.test/graphql', {
				fetch: (input, init) => (faults.fetch ?? served)(input, init),
			}),
		};
		faultsOf.set(subject, faults);
		return subject;
	};
}

/** A database whose every statement fails, as one the server lost its connection to does. */
const UNREACHABLE = {
	prepare() {
		throw new Error('the database is unreachable');
	},
	batch() {
		throw new Error('the database is unreachable');
	},
} as unknown as RemoteSQL;

const TRANSPORT_FAILURES = {
	// the server itself fails: the app's error handler answers a 500
	'http-status': (subject: QuerySubject) => {
		faultsOf.get(subject)!.db = UNREACHABLE;
	},
	// something in front of it answers a page that is not GraphQL
	'invalid-body': (subject: QuerySubject) => {
		faultsOf.get(subject)!.fetch = async () =>
			new Response('<html>a captive portal</html>', {status: 200, headers: {'content-type': 'text/html'}});
	},
	// nothing answers at all
	network: (subject: QuerySubject) => {
		faultsOf.get(subject)!.fetch = () => Promise.reject(new TypeError('fetch failed'));
	},
} as const;

await describeQueryConformance('httpExecutor against /graphql, keeping everything', overHttp(), {
	transportFailures: TRANSPORT_FAILURES,
});

await describeQueryConformance(
	'httpExecutor against /graphql, the folding process claiming a 60-block window',
	overHttp({retention: {blocks: 60}, finalityDepth: 60}),
);

await describeQueryConformance(
	'httpExecutor against /graphql, over a revert-only served database',
	overHttp({retention: 'revert-only', finalityDepth: 12}),
);

/** A raw request to `/graphql` on an app over `db`, for what `httpExecutor` never sends. */
function appOver(db: RemoteSQL, graphql?: GraphQLServing) {
	return createServer<Env>({getDB: () => db, getEnv: () => ({}), ...(graphql === undefined ? {} : {graphql})});
}

const serving: GraphQLServing = {declarationsOf: async () => QUERY_ENTITIES};

describe('/graphql', () => {
	it('answers a GET as it answers a POST, and a fetch-taking client through the shim reads the same bytes', async () => {
		const subject = await subjectWith(overHttp(), HISTORY);
		const query = `{ pool(orderBy: {field: amount}, first: 2) { pool amount } }`;
		const posted = await subject.executor({query});
		expect(posted.data).toEqual({
			pool: [
				{pool: 'a', amount: '9'},
				{pool: 'b', amount: '18446744073709551617'},
			],
		});

		const db = await aDatabase();
		const store = new VersionedStateStore(db, QUERY_ENTITIES, {tableNamespace: generationDigestOf(GENERATION)});
		await store.migrate();
		const app = appOver(db, serving);
		const got = await app.request(`/graphql?${new URLSearchParams({query})}`, {headers: {accept: 'application/json'}});
		expect(got.status).toBe(200);
		expect(await got.json()).toEqual({data: {pool: []}, extensions: {generation: subject.generation, block: null}});

		const shimmed = await executorToFetch(subject.executor)('/graphql', {
			method: 'POST',
			body: JSON.stringify({query}),
		});
		expect(await shimmed.text()).toBe(JSON.stringify(posted));
	});

	it('refuses a request Yoga cannot read with the one formatter: invalid-query, the status kept', async () => {
		const db = await aDatabase();
		const app = appOver(db, serving);
		for (const body of ['not json', '{"variables":{}}']) {
			const response = await app.request('/graphql', {
				method: 'POST',
				headers: {'content-type': 'application/json', accept: 'application/json'},
				body,
			});
			expect(response.status).toBe(400);
			const result = (await response.json()) as QueryResult;
			expect(Object.keys(result)).toEqual(['errors', 'extensions']);
			expect(result.errors!.map((error) => error.extensions.code)).toEqual(
				result.errors!.map(() => QUERY_ERROR_CODES.invalidQuery),
			);
			expect(result.extensions).toEqual({generation: generationDigestOf(GENERATION), block: null});
		}
	});

	it('refuses with 503 when no generation answers reads yet, rather than answering empty lists', async () => {
		const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
		await applySchema(db);
		const response = await appOver(db, serving).request('/graphql', {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify({query: '{ pool(first: 1) { pool } }'}),
		});
		expect(response.status).toBe(503);
		expect(((await response.json()) as {error: string}).error).toBe('no-canonical-generation');

		const result = await httpExecutor('http://etherfold.test/graphql', {
			fetch: async (input, init) => appOver(db, serving).fetch(new Request(input, init)),
		})({query: '{ pool(first: 1) { pool } }'});
		expect(isTransportFailure(result)).toBe(true);
		expect(result.errors![0]!.extensions).toEqual({
			code: QUERY_ERROR_CODES.transportFailure,
			reason: 'http-status',
			status: 503,
		});
	});

	it('answers 501 on a host that injected no graphql capability', async () => {
		const response = await appOver(await aDatabase()).request('/graphql', {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify({query: '{ pool(first: 1) { pool } }'}),
		});
		expect(response.status).toBe(501);
		expect(((await response.json()) as {error: string}).error).toBe('graphql-not-configured');
	});

	it('answers 503 when the declarations cannot be had, and asks again on the next request', async () => {
		let asked = 0;
		const app = appOver(await aDatabase(), {
			declarationsOf: async () => {
				asked++;
				if (asked === 1) throw new Error('no bundle stored');
				return QUERY_ENTITIES;
			},
		});
		const ask = () =>
			app.request('/graphql', {
				method: 'POST',
				headers: {'content-type': 'application/json'},
				body: JSON.stringify({query: '{ pool(first: 1) { pool } }'}),
			});
		const refused = await ask();
		expect(refused.status).toBe(503);
		expect(((await refused.json()) as {error: string}).error).toBe('no-declarations');
		expect((await ask()).status).toBe(200);
		expect((await ask()).status).toBe(200);
		expect(asked).toBe(2);
	});

	it('follows the canonical pointer: a promotion is answered from the next request on', async () => {
		const db = await aDatabase();
		const successor: GenerationId = {stream: 'stream-digest', processor: 'sha256:successor'};
		const registry = await openGenerationRegistryOnSQL(db, INDEXER, {caps: {maxGenerations: 4, maxStreams: 4}});
		await registry.create(successor);
		for (const [id, label] of [
			[GENERATION, 'incumbent'],
			[successor, 'successor'],
		] as const) {
			const store = new VersionedStateStore(db, QUERY_ENTITIES, {tableNamespace: generationDigestOf(id)});
			await store.migrate();
			await store.applyBlock({number: 5, hash: `0x${'5'.padStart(64, '0')}`, timestamp: 1}, [
				{type: 'upsert', entity: 'pool', id: {pool: 'a'}, values: {label}},
			]);
		}
		const app = appOver(db, serving);
		const executor = httpExecutor('http://etherfold.test/graphql', {
			fetch: async (input, init) => app.fetch(new Request(input, init)),
		});
		const query = {query: '{ pool(first: 1) { label } }'};
		expect(await executor(query)).toEqual({
			data: {pool: [{label: 'incumbent'}]},
			extensions: {generation: generationDigestOf(GENERATION), block: 5},
		});
		await registry.moveCanonicalTo(successor);
		expect(await executor(query)).toEqual({
			data: {pool: [{label: 'successor'}]},
			extensions: {generation: generationDigestOf(successor), block: 5},
		});
	});
});
