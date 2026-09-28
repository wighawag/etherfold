import {QUERY_ERROR_CODES} from './errors.js';
import {transportFailure, type QueryExecutor, type QueryRequest, type QueryResult} from './executor.js';

/**
 * The `fetch` an executor sends through, or the one a shim stands in for: the
 * WHATWG signature, and no more of it than a request and its init.
 */
export type FetchFunction = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** How `httpExecutor` reaches its server, beyond the URL. */
export type HttpExecutorOptions = {
	/**
	 * The `fetch` to send through. Defaults to the global one, read when each
	 * request is sent (so a runtime that installs it late is still found). A test
	 * or a host with a fetch of its own (a Worker's service binding, a Hono app's
	 * `fetch`) passes it here.
	 */
	readonly fetch?: FetchFunction;
	/** Extra request headers, e.g. a credential a proxy in front of the server checks. */
	readonly headers?: Readonly<Record<string, string>>;
};

/**
 * THE HTTP EXECUTOR (ADR-0099): a remote indexer's `/graphql` as a
 * `QueryExecutor`, so an app injects it where it would inject the worker
 * executor and changes nothing else.
 *
 * The request is a `POST` of `{query, variables, operationName}` as JSON,
 * asking for `application/json`, which is the GraphQL-over-HTTP form every
 * server speaks: a GraphQL answer, errors and all, comes back as a `200`.
 *
 * Whatever the TRANSPORT meets is normalised to the one shape the executor
 * contract defines (`transportFailure`), and the promise RESOLVES with it,
 * never rejects:
 *
 * - `network`: nothing answered (a refused connection, DNS, an abort, a body
 *   cut off while it was read);
 * - `http-status`: something answered with a status that is not a GraphQL
 *   answer (a 500, a 502 from a proxy, a 503 from a server with no generation
 *   to answer from yet), with `status` carried beside it;
 * - `invalid-body`: something answered `2xx` with a body that is not a GraphQL
 *   result (not JSON at all, or JSON of another shape: a captive portal, a
 *   misrouted proxy).
 *
 * An answer is handed back AS PARSED, so its key order is the server's and the
 * bytes are the ones the server wrote: the executor adds nothing to them and
 * takes nothing away, which is what lets it pass the query conformance suite
 * byte for byte.
 */
export function httpExecutor(url: string | URL, options: HttpExecutorOptions = {}): QueryExecutor {
	const target = String(url);
	return async (request) => {
		const send = options.fetch ?? (globalThis.fetch as FetchFunction | undefined);
		if (send === undefined) {
			return transportFailure('network', `there is no fetch in this runtime to reach ${target} with`);
		}
		let response: Response;
		try {
			response = await send(target, {
				method: 'POST',
				headers: {
					...options.headers,
					'content-type': 'application/json',
					accept: 'application/json',
				},
				body: JSON.stringify(bodyOf(request)),
			});
		} catch (error) {
			return transportFailure('network', `${target} could not be reached: ${messageOf(error)}`);
		}

		if (!response.ok) {
			await discard(response);
			return transportFailure(
				'http-status',
				`${target} answered HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}, which is not a GraphQL answer`,
				{status: response.status},
			);
		}

		let text: string;
		try {
			text = await response.text();
		} catch (error) {
			return transportFailure('network', `the answer from ${target} was cut off: ${messageOf(error)}`);
		}
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			return transportFailure('invalid-body', `${target} answered with a body that is not JSON`);
		}
		if (!isQueryResult(body)) {
			return transportFailure('invalid-body', `${target} answered with JSON that is not a GraphQL result`);
		}
		return body;
	};
}

/**
 * THE `fetch` SHIM (ADR-0099): any executor as a `fetch`, for a GraphQL client
 * library that only takes one (urql's `fetch` option, Apollo's `HttpLink`,
 * graphql-request's `fetch`). The client believes it is talking to a server; the
 * request never leaves the process, or goes wherever the executor sends it (a
 * worker port, another server).
 *
 * It reads the request as a GraphQL-over-HTTP server does: a `POST` with a JSON
 * body `{query, variables, operationName}`, or a `GET` with those three as
 * query parameters (`variables` as JSON). It answers the executor's result as
 * `application/json` with a `200`, WHATEVER the result is, a transport failure
 * included: the result is the answer, and a client library reads a `200` body
 * with errors as errors, where a non-`2xx` would make it discard the body and
 * report a network error of its own, losing the one shape the contract defines.
 *
 * A request it cannot read as GraphQL at all (a body that is not JSON, no
 * `query`) never reaches the executor: it is answered `400` with one
 * `invalid-query` error, as a server answers a malformed request. Like every
 * executor, the shim never rejects.
 */
export function executorToFetch(executor: QueryExecutor): FetchFunction {
	return async (input, init) => {
		let request: QueryRequest;
		try {
			request = await requestOf(input, init);
		} catch (error) {
			return json({errors: [{message: messageOf(error), extensions: {code: QUERY_ERROR_CODES.invalidQuery}}]}, 400);
		}
		let result: QueryResult;
		try {
			result = await executor(request);
		} catch (error) {
			// an executor never rejects; one that does broke its contract, and the shim
			// still answers in the one shape rather than rejecting on its behalf
			result = transportFailure('network', `the executor behind this fetch rejected: ${messageOf(error)}`);
		}
		return json(result, 200);
	};
}

function bodyOf(request: QueryRequest): QueryRequest {
	const body: {query: string; variables?: QueryRequest['variables']; operationName?: string | null} = {
		query: request.query,
	};
	if (request.variables != null) body.variables = request.variables;
	if (request.operationName != null) body.operationName = request.operationName;
	return body;
}

/** Whether a parsed body is a GraphQL result: an object with `data` or `errors`, each of the right kind. */
function isQueryResult(body: unknown): body is QueryResult {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
	const result = body as Record<string, unknown>;
	if (!('data' in result) && !('errors' in result)) return false;
	if ('data' in result && result.data !== null && (typeof result.data !== 'object' || Array.isArray(result.data))) {
		return false;
	}
	if ('errors' in result) {
		const errors = result.errors;
		if (!Array.isArray(errors)) return false;
		for (const error of errors) {
			if (typeof error !== 'object' || error === null || typeof (error as {message?: unknown}).message !== 'string') {
				return false;
			}
		}
	}
	if ('extensions' in result && (typeof result.extensions !== 'object' || result.extensions === null)) return false;
	return true;
}

/** The GraphQL request a `fetch` call carries, or a throw saying why it carries none. */
async function requestOf(input: string | URL | Request, init: RequestInit | undefined): Promise<QueryRequest> {
	const isRequest = typeof Request !== 'undefined' && input instanceof Request;
	const method = (init?.method ?? (isRequest ? (input as Request).method : 'GET')).toUpperCase();
	if (method === 'GET') {
		const url = new URL(isRequest ? (input as Request).url : String(input), 'http://executor.invalid');
		const query = url.searchParams.get('query');
		const variables = url.searchParams.get('variables');
		const operationName = url.searchParams.get('operationName');
		return shaped({
			query,
			...(variables === null || variables === '' ? {} : {variables: parsed(variables, 'the variables parameter')}),
			...(operationName === null || operationName === '' ? {} : {operationName}),
		});
	}
	if (method !== 'POST') throw new Error(`a GraphQL request is a GET or a POST, not a ${method}`);
	const text =
		init?.body !== undefined && init.body !== null
			? await new Response(init.body).text()
			: isRequest
				? await (input as Request).text()
				: '';
	return shaped(parsed(text, 'the request body'));
}

function parsed(text: string, what: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`${what} is not JSON`);
	}
}

function shaped(body: unknown): QueryRequest {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		throw new Error('a GraphQL request is an object {query, variables, operationName}');
	}
	const {query, variables, operationName} = body as Record<string, unknown>;
	if (typeof query !== 'string') throw new Error('a GraphQL request carries its document as a string `query`');
	if (variables != null && (typeof variables !== 'object' || Array.isArray(variables))) {
		throw new Error('the variables of a GraphQL request are an object');
	}
	if (operationName != null && typeof operationName !== 'string') {
		throw new Error('the operationName of a GraphQL request is a string');
	}
	return {
		query,
		...(variables == null ? {} : {variables: variables as Record<string, unknown>}),
		...(operationName == null ? {} : {operationName}),
	};
}

function json(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json; charset=utf-8'}});
}

async function discard(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// nothing to do: the status already said everything this executor reports
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
