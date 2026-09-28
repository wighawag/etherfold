/**
 * THE TAB'S HALF of the worker executor (ADR-0099): `workerExecutor`, in a
 * module of its own that imports only the executor contract, so a tab that
 * imports it from `@etherfold/graphql/worker` bundles no `graphql` runtime and
 * no schema (asserted). The host's half, `graphqlQueryHandler`, is beside it in
 * `./index.ts`, which re-exports this.
 */
import {transportFailure, type QueryExecutor, type QueryRequest, type QueryResult} from '../executor.js';

/** What `workerExecutor` needs of a port: its `query`, and nothing else. */
export type PortWithQuery = {query(request: unknown): Promise<unknown>};

/**
 * THE WORKER EXECUTOR: a `QueryExecutor` over a port to a host whose entry
 * passed `graphqlQueryHandler()`.
 *
 * It answers what the host answered, unchanged, and it never rejects: a CLOSED
 * port (`IndexerPortClosedError`, this tab let go) is the transport failure
 * `port-closed`, a host that DIED under the call or before it
 * (`IndexerHostDiedError`) is `host-gone`, and anything else the host answered
 * that is not a GraphQL result (a refusal: a host whose entry passed no handler,
 * say) is `invalid-body`, since something answered and it was not an answer.
 */
export function workerExecutor(port: PortWithQuery): QueryExecutor {
	return async (request) => {
		const asked: {query: string; variables?: QueryRequest['variables']; operationName?: string | null} = {
			query: request.query,
		};
		if (request.variables !== undefined) asked.variables = request.variables;
		if (request.operationName !== undefined) asked.operationName = request.operationName;
		let answered: unknown;
		try {
			answered = await port.query(asked);
		} catch (error) {
			const name = (error as {name?: unknown})?.name;
			const message = String((error as Error)?.message ?? error);
			if (name === 'IndexerPortClosedError') return transportFailure('port-closed', message);
			if (name === 'IndexerHostDiedError') return transportFailure('host-gone', message);
			return transportFailure('invalid-body', `the indexer host refused the query: ${message}`);
		}
		if (!isResult(answered)) {
			return transportFailure('invalid-body', `the indexer host answered something that is not a GraphQL result`);
		}
		return answered;
	};
}

function isResult(value: unknown): value is QueryResult {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const result = value as Record<string, unknown>;
	return 'data' in result || Array.isArray(result.errors);
}
