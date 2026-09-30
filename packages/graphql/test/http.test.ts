import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterEach, describe, expect, it} from 'vitest';
import {
	buildQuerySchema,
	executorToFetch,
	httpExecutor,
	isTransportFailure,
	localExecutor,
	QUERY_ERROR_CODES,
	type FetchFunction,
	type QueryExecutor,
	type QueryResult,
} from '../src/index.js';
import {block, DECLARATIONS, GENERATION, pool, sqliteSubject} from './fixtures.js';
import {hashOf} from '../src/conformance/fixtures.js';

/**
 * THE HTTP EXECUTOR AND THE FETCH SHIM (ADR-0099), over a REAL socket where a
 * transport failure is the point: a server that answers 500, one that answers a
 * body that is not JSON, and a port nothing listens on. Each must RESOLVE with
 * the one transport-failure shape the executor contract defines, never reject.
 *
 * That `httpExecutor` against `/graphql` passes the query conformance suite byte
 * for byte is asserted where the server is (`@etherfold/server`, `etherfold`);
 * here it is asserted against the shim (`conformance.test.ts`).
 */

const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** A real HTTP server answering every request with `handler`, and the URL it listens on. */
async function listening(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
}

/** A URL on a port nothing listens on: bound once, then closed. */
async function nothingListening(): Promise<string> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const {port} = server.address() as AddressInfo;
	await new Promise((resolve) => server.close(resolve));
	return `http://127.0.0.1:${port}/graphql`;
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let text = '';
		request.on('data', (chunk) => (text += chunk));
		request.on('end', () => resolve(text));
	});
}

const QUERY = {query: `{ pool(first: 1) { pool } }`};

/** The one shape, as the conformance suite's transport chapter holds every executor to it. */
function expectTransportFailure(result: QueryResult, reason: string, status?: number): void {
	expect(isTransportFailure(result)).toBe(true);
	expect(Object.keys(result)).toEqual(['errors']);
	const [error] = result.errors!;
	expect(Object.keys(error!)).toEqual(['message', 'extensions']);
	expect(error!.extensions).toEqual({
		code: QUERY_ERROR_CODES.transportFailure,
		reason,
		...(status === undefined ? {} : {status}),
	});
}

describe('httpExecutor', () => {
	it('POSTs the request as JSON and hands back the answer exactly as the server wrote it', async () => {
		let received: {method?: string; type?: string; accept?: string; body?: string} = {};
		const written = '{"data":{"pool":[{"pool":"a"}]},"extensions":{"generation":"g","block":7}}';
		const url = await listening(async (request, response) => {
			received = {
				method: request.method,
				type: request.headers['content-type'],
				accept: request.headers.accept,
				body: await readBody(request),
			};
			response.writeHead(200, {'content-type': 'application/json'}).end(written);
		});
		const result = await httpExecutor(url)({
			query: 'query Q($x: U256) { pool(first: 1) { pool } }',
			variables: {x: '1'},
			operationName: 'Q',
		});
		expect(received).toEqual({
			method: 'POST',
			type: 'application/json',
			accept: 'application/json',
			body: '{"query":"query Q($x: U256) { pool(first: 1) { pool } }","variables":{"x":"1"},"operationName":"Q"}',
		});
		expect(JSON.stringify(result)).toBe(written);
	});

	it('hands back an answer carrying errors as an answer, not as a transport failure', async () => {
		const written =
			'{"errors":[{"message":"no","extensions":{"code":"invalid-query"}}],"extensions":{"generation":"g","block":null}}';
		const url = await listening((_request, response) => response.writeHead(200).end(written));
		const result = await httpExecutor(url)(QUERY);
		expect(isTransportFailure(result)).toBe(false);
		expect(JSON.stringify(result)).toBe(written);
	});

	it('a 500 resolves as the transport-failure shape, reason http-status, carrying the status', async () => {
		const url = await listening((_request, response) =>
			response.writeHead(500, {'content-type': 'application/json'}).end('{"success":false}'),
		);
		expectTransportFailure(await httpExecutor(url)(QUERY), 'http-status', 500);
	});

	it('a non-2xx carrying a GraphQL-looking body is still http-status: the status is not a GraphQL answer', async () => {
		const url = await listening((_request, response) =>
			response.writeHead(503).end('{"errors":[{"message":"not yet"}]}'),
		);
		expectTransportFailure(await httpExecutor(url)(QUERY), 'http-status', 503);
	});

	it('a body that is not JSON resolves as the transport-failure shape, reason invalid-body', async () => {
		const url = await listening((_request, response) =>
			response.writeHead(200, {'content-type': 'text/html'}).end('<html>a captive portal</html>'),
		);
		expectTransportFailure(await httpExecutor(url)(QUERY), 'invalid-body');
	});

	it('JSON that is not a GraphQL result is invalid-body too', async () => {
		for (const written of ['[1,2]', '{"success":true}', '{"data":[1]}', '{"errors":"no"}', 'null']) {
			const url = await listening((_request, response) => response.writeHead(200).end(written));
			expectTransportFailure(await httpExecutor(url)(QUERY), 'invalid-body');
		}
	});

	it('a network error (nothing listening) resolves as the transport-failure shape, reason network', async () => {
		expectTransportFailure(await httpExecutor(await nothingListening())(QUERY), 'network');
	});

	it('a fetch that throws, or rejects, is a network failure and never a rejection', async () => {
		const throwing: FetchFunction = () => {
			throw new TypeError('synchronously');
		};
		expectTransportFailure(await httpExecutor('http://x/graphql', {fetch: throwing})(QUERY), 'network');
		const rejecting: FetchFunction = () => Promise.reject(new TypeError('fetch failed'));
		expectTransportFailure(await httpExecutor('http://x/graphql', {fetch: rejecting})(QUERY), 'network');
	});

	it('sends the headers it is given', async () => {
		let authorization: string | undefined;
		const url = await listening((request, response) => {
			authorization = request.headers.authorization;
			response.writeHead(200).end('{"data":{}}');
		});
		await httpExecutor(url, {headers: {authorization: 'Bearer t'}})(QUERY);
		expect(authorization).toBe('Bearer t');
	});
});

/**
 * A MINIMAL CLIENT, the way the fetch-taking GraphQL clients (urql, graphql-request,
 * Apollo's `HttpLink`) use the `fetch` they are handed: POST the operation as
 * JSON, read the JSON back, and treat a non-2xx as a network error.
 */
async function minimalClient(
	fetch: FetchFunction,
	url: string,
	query: string,
	variables?: Record<string, unknown>,
): Promise<QueryResult> {
	const response = await fetch(url, {
		method: 'POST',
		headers: {'content-type': 'application/json', accept: 'application/graphql-response+json, application/json'},
		body: JSON.stringify({query, variables}),
	});
	if (!response.ok) throw new Error(`network error: ${response.status}`);
	return (await response.json()) as QueryResult;
}

async function seededExecutor(): Promise<QueryExecutor> {
	const {store, context} = await sqliteSubject();
	await store.applyBlock(block(10), [pool('a', {label: 'alpha', amount: 9n}), pool('b', {label: 'beta', amount: 10n})]);
	return localExecutor(buildQuerySchema(DECLARATIONS), context());
}

describe('executorToFetch', () => {
	it('lets a fetch-taking client run a query against any executor, answering what the executor answers', async () => {
		const executor = await seededExecutor();
		const fetch = executorToFetch(executor);
		const query = `query ($min: U256) { pool(where: {amount: {gte: $min}}, orderBy: {field: amount, direction: desc}, first: 5) { pool amount } }`;
		const result = await minimalClient(fetch, '/graphql', query, {min: '9'});
		expect(result).toEqual({
			data: {
				pool: [
					{pool: 'b', amount: '10'},
					{pool: 'a', amount: '9'},
				],
			},
			extensions: {generation: GENERATION, block: 10, blockHash: hashOf(10)},
		});
		expect(JSON.stringify(result)).toBe(JSON.stringify(await executor({query, variables: {min: '9'}})));
	});

	it('reads a GET, with the variables as JSON, and a Request object', async () => {
		const fetch = executorToFetch(await seededExecutor());
		const params = new URLSearchParams({
			query: `query Q($id: String) { pool(where: {pool: {eq: $id}}, first: 1) { label } }`,
			variables: JSON.stringify({id: 'b'}),
			operationName: 'Q',
		});
		const got = await (await fetch(`/graphql?${params}`)).json();
		expect(got).toEqual({
			data: {pool: [{label: 'beta'}]},
			extensions: {generation: GENERATION, block: 10, blockHash: hashOf(10)},
		});

		const posted = await fetch(
			new Request('http://anywhere/graphql', {
				method: 'POST',
				body: JSON.stringify({query: `{ pool(first: 1) { pool } }`}),
			}),
		);
		expect(await posted.json()).toEqual({
			data: {pool: [{pool: 'a'}]},
			extensions: {generation: GENERATION, block: 10, blockHash: hashOf(10)},
		});
	});

	it('answers a transport failure as a 200 carrying the one shape, so a client reads it as errors', async () => {
		const fetch = executorToFetch(httpExecutor(await nothingListening()));
		const response = await fetch('/graphql', {method: 'POST', body: JSON.stringify(QUERY)});
		expect(response.status).toBe(200);
		expectTransportFailure((await response.json()) as QueryResult, 'network');
	});

	it('answers a request it cannot read as GraphQL with a 400 and one invalid-query error, never calling the executor', async () => {
		let called = 0;
		const fetch = executorToFetch(async () => {
			called++;
			return {data: {}};
		});
		for (const init of [
			{method: 'POST', body: 'not json'},
			{method: 'POST', body: '{"variables":{}}'},
			{method: 'POST', body: '{"query":"{ a }","variables":[1]}'},
			{method: 'PUT', body: '{"query":"{ a }"}'},
		]) {
			const response = await fetch('/graphql', init);
			expect(response.status).toBe(400);
			const body = (await response.json()) as QueryResult;
			expect(body.errors?.[0]?.extensions.code).toBe(QUERY_ERROR_CODES.invalidQuery);
		}
		expect(called).toBe(0);
	});

	it('and httpExecutor over the shim is the executor itself: nothing is lost across the round trip', async () => {
		const executor = await seededExecutor();
		const overHttp = httpExecutor('http://in-process/graphql', {fetch: executorToFetch(executor)});
		for (const request of [
			{query: `{ pool(orderBy: {field: amount}, first: 5) { pool label amount } }`},
			{query: `{ pool(`},
			{query: `{ pool(first: 0) { pool } }`},
		]) {
			expect(JSON.stringify(await overHttp(request))).toBe(JSON.stringify(await executor(request)));
		}
	});
});
