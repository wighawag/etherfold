/**
 * THE WORKER EXECUTOR (ADR-0099, ADR-0082): GraphQL answered by the host that
 * holds the store (a dedicated worker, a SharedWorker, or the main-thread host),
 * asked from the tab over the host's port.
 *
 * The resolvers need the store and the store is in the host, so the schema and
 * the `graphql` runtime live THERE: the app's worker entry passes
 * `graphqlQueryHandler()` as the host's `query` handler, and the tab holds
 * `workerExecutor(port)`. Opt-in on both ends, so a worker bundle that does not
 * pass the handler carries no GraphQL at all (asserted).
 *
 * ```ts
 * // indexer.worker.ts
 * import {graphqlQueryHandler} from '@etherfold/graphql/worker';
 * hostIndexerInThisWorker({createState, createProcessor, query: graphqlQueryHandler()});
 *
 * // the tab
 * import {workerExecutor} from '@etherfold/graphql/worker';
 * const execute = workerExecutor(connectToIndexerHost(dedicatedWorkerHost(worker)));
 * const {data, extensions} = await execute({query: `{ pool(first: 10) { pool amount } }`});
 * ```
 *
 * This subpath is the ONLY part of `@etherfold/graphql` that knows
 * `@etherfold/browser`, and it imports only its TYPES: the root entry stays
 * runtime-neutral, and a server importing `@etherfold/graphql` pulls in no
 * browser package.
 */
import type {Accessor} from '@etherfold/accessor';
import type {HostQueryContext, HostQueryHandler} from '@etherfold/browser';
import type {StateStore} from '@etherfold/state-store';
import type {GraphQLSchema} from 'graphql';
import {DocumentCache} from '../documents.js';
import {QUERY_ERROR_CODES, UNEXPECTED_ERROR_MESSAGE} from '../errors.js';
import {executeQuery} from '../execute.js';
import {transportFailure, type QueryExecutor, type QueryRequest, type QueryResult} from '../executor.js';
import {buildQuerySchema} from '../schema.js';

/** What `graphqlQueryHandler` may be told. */
export type GraphqlQueryHandlerOptions = {
	/**
	 * Handed to the store's `accessor(...)` (for IndexedDB, `rowsExaminedBound`:
	 * the rows one scan examines before the query is refused, default 25,000).
	 */
	readonly accessor?: Readonly<Record<string, unknown>>;
	/**
	 * Where parsed and validated documents are kept, or how many to keep (default
	 * 100 per schema). A repeated document is not parsed again.
	 */
	readonly documents?: DocumentCache | {readonly max?: number};
};

/**
 * A store the query layer can read: the seam, plus the two reads beyond it the
 * query layer needs, which the IndexedDB store has (and a claimed handle over it
 * forwards): its accessor, and its tip.
 */
type QueryableStore = StateStore & {
	accessor(options?: Readonly<Record<string, unknown>>): Accessor;
	tip(): Promise<number | undefined>;
};

function queryable(store: StateStore): QueryableStore {
	const candidate = store as Partial<QueryableStore>;
	if (typeof candidate.accessor !== 'function' || typeof candidate.tip !== 'function') {
		throw new Error(
			`the store this host reads from offers no accessor and tip (ADR-0099), so it cannot answer a query: ` +
				`the IndexedDB store does, and a store handed to \`openForWriting\` or \`openForReading\` keeps them.`,
		);
	}
	return candidate as QueryableStore;
}

/**
 * THE HOST'S QUERY HANDLER: pass it as `query` where the host is built.
 *
 * Per operation it resolves the host's context (the store the canonical
 * generation folds into, and that generation's digest), and answers through
 * `executeQuery`, the one pipeline every executor shares, so the pin to one
 * block, the reorg guard, the formatter and the codes are the in-process
 * executor's and the answer is the same bytes. The schema is built once per set
 * of declarations and the accessor once per store; parsed and validated
 * documents are cached.
 *
 * It never rejects: a context the host cannot supply (no store yet on a host
 * that stopped, a reader that cannot name its generation) is answered as an
 * `internal-error`, exactly as `executeQuery` answers a context that failed.
 */
export function graphqlQueryHandler(options: GraphqlQueryHandlerOptions = {}): HostQueryHandler {
	const documents =
		options.documents instanceof DocumentCache ? options.documents : new DocumentCache(options.documents);
	const schemas = new WeakMap<ReadonlyMap<string, unknown>, GraphQLSchema>();
	const accessors = new WeakMap<StateStore, Accessor>();

	return async (request: unknown, context: () => Promise<HostQueryContext>): Promise<QueryResult> => {
		let resolved: HostQueryContext;
		let store: QueryableStore;
		try {
			resolved = await context();
			store = queryable(resolved.store);
		} catch {
			return {errors: [{message: UNEXPECTED_ERROR_MESSAGE, extensions: {code: QUERY_ERROR_CODES.internalError}}]};
		}
		let schema = schemas.get(store.declarations);
		if (!schema) {
			schema = buildQuerySchema([...store.declarations.values()]);
			schemas.set(store.declarations, schema);
		}
		let accessor = accessors.get(store);
		if (!accessor) {
			accessor = store.accessor(options.accessor);
			accessors.set(store, accessor);
		}
		return executeQuery(
			schema,
			{
				accessor,
				generation: resolved.generation,
				tip: () => store.tip(),
				// the store's own claim: a `revert-only` store answers every read at the tip
				asOf: store.capabilities.asOf,
			},
			request as QueryRequest,
			{documents},
		);
	};
}

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
