import {generationDigestOf, type GenerationId} from '@etherfold/core';
import {
	buildQuerySchema,
	executeQuery,
	formatQueryError,
	QUERY_ERROR_CODES,
	UNEXPECTED_ERROR_MESSAGE,
	type QueryContext,
	type QueryErrorJSON,
	type QueryResult,
} from '@etherfold/graphql';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import type {GraphQLError, GraphQLSchema} from 'graphql';
import {createYoga, type Plugin} from 'graphql-yoga';
import {Hono, type Context} from 'hono';
import {logs} from 'named-logs';
import type {RemoteSQL} from 'remote-sql';
import type {Env} from '../env.js';
import {readHeldGenerations} from '../generations.js';
import {setup} from '../setup.js';
import type {GraphQLServing, ServerOptions} from '../types.js';

const logger = logs('@etherfold/server');

/** The path the query surface answers on (ADR-0099). */
export const GRAPHQL_PATH = '/graphql';

/** One generation, ready to answer: its schema, and the context its operations read through. */
type ServedGeneration = {
	readonly digest: string;
	readonly schema: GraphQLSchema;
	readonly context: QueryContext;
};

/** What each request hands Yoga: the generation that answers it. */
type ServedContext = {readonly served: ServedGeneration};

/**
 * The mark on a result `executeQuery` answered, so the result processor tells it
 * from Yoga's own. It rides in `extensions.http`, which Yoga reads the status
 * from and strips before the body is written, so it never reaches a client;
 * an object identity would not do, since Yoga may hand the processor a copy.
 */
const ANSWERED = 'etherfold-answered';

/**
 * THE QUERY SURFACE (ADR-0099): `GET` and `POST /graphql`, GraphQL over HTTP,
 * answered from the CANONICAL generation of the host's database through the
 * SQLite accessor, by the ONE schema module every executor shares.
 *
 * ## Yoga speaks HTTP; `executeQuery` answers
 *
 * GraphQL Yoga (on Hono, as the research decided) does what is HTTP about a
 * request: reading a `GET` or a `POST`, JSON or form, negotiating the response
 * type. It does NOT parse, validate or execute: a plugin hands the request's
 * `{query, variables, operationName}` to `executeQuery` (`@etherfold/graphql`)
 * and sets its answer as the result, so the pin to one block, the reorg guard,
 * the formatter and the codes are the in-process executor's, byte for byte,
 * rather than a second pipeline that would have to be kept in step with it.
 * Yoga's own masking never sees an error of ours, and a request Yoga refuses
 * itself (a body that is not JSON, no `query`) is reformatted through the same
 * formatter (`formatQueryError`), so no error leaves this route in a shape the
 * executor contract does not define.
 *
 * Every GraphQL answer, errors and all, is a `200`: a result is the answer
 * (`httpExecutor` reads any other status as a transport failure).
 *
 * ## Three refusals BEFORE GraphQL, as HTTP statuses
 *
 * - `501 graphql-not-configured`: the host injected no `graphql` capability,
 *   so it cannot say which declarations a generation's tables were made from.
 * - `501 several-named-indexers`: the database holds several named indexers,
 *   and an unnamed `/graphql` would be picking a tenant for the caller.
 * - `503 no-canonical-generation`: nothing answers reads yet (ADR-0058: refused
 *   rather than answered as empty lists, which would read as "there is
 *   nothing"). `503 no-declarations` likewise, when the canonical generation's
 *   declarations cannot be had.
 *
 * A client using `httpExecutor` meets each as the one transport-failure shape
 * (`http-status`), since nothing GraphQL answered.
 */
export function getGraphQLAPI<CustomEnv extends Env>(options: ServerOptions<CustomEnv>) {
	const serving = options.graphql;
	const generations = new WeakMap<RemoteSQL, Map<string, {digest: string; ready: Promise<ServedGeneration>}>>();

	const yoga = createYoga<ServedContext>({
		graphqlEndpoint: GRAPHQL_PATH,
		// NO schema: Yoga never parses, validates or executes here (the plugin below
		// answers every request), so it is never handed one. That also keeps Yoga's
		// copy of graphql-js from ever meeting a schema another copy built, which it
		// refuses ("from another module or realm").
		// CORS is the app's (`createServer`), for every route alike
		cors: false,
		graphiql: false,
		landingPage: false,
		// nothing of ours reaches Yoga's masking, and what Yoga raises itself is
		// reformatted by the one formatter (`onResultProcess` below)
		maskedErrors: false,
		batching: false,
		logging: {
			debug: (...args) => logger.debug(...args),
			info: (...args) => logger.info(...args),
			warn: (...args) => logger.warn(...args),
			error: (...args) => logger.error(...args),
		},
		plugins: [answeredByExecuteQuery()],
	});

	return new Hono<{Bindings: CustomEnv}>()
		.use(GRAPHQL_PATH, setup({serverOptions: options}))
		.on(['GET', 'POST'], GRAPHQL_PATH, async (c) => {
			if (!serving) {
				return c.json(
					{
						success: false,
						error: 'graphql-not-configured',
						message:
							`this server was built with no \`graphql\` capability, so it cannot tell which entity declarations ` +
							`a generation's tables were made from, and answers no GraphQL (ADR-0099).`,
					} as const,
					501,
				);
			}
			const {db} = c.get('config');
			const canonical = await canonicalOf(db);
			if (!canonical.ok) return c.json(canonical.body, canonical.status);

			let served: ServedGeneration;
			try {
				served = await generationFor(db, canonical.indexer, canonical.id, serving, c);
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				logger.error(`graphql: the declarations of the canonical generation could not be had: ${reason}`);
				return c.json(
					{
						success: false,
						error: 'no-declarations',
						indexer: canonical.indexer,
						generation: generationDigestOf(canonical.id),
						message:
							`the entity declarations of the canonical generation could not be had, so there is no schema to ` +
							`answer with: ${reason}`,
					} as const,
					503,
				);
			}
			return yoga.fetch(c.req.raw, {served});
		});

	/**
	 * The generation that answers, built once per canonical generation and kept
	 * while it stays canonical: loading its declarations may instantiate a stored
	 * bundle, which is not a per-request cost. Keyed by the database handle, so a
	 * host whose handle changes per request (a Worker's binding) never reads
	 * through another request's handle; a failure is not kept, so the next request
	 * tries again.
	 */
	function generationFor(
		db: RemoteSQL,
		indexer: string,
		id: GenerationId,
		serving: GraphQLServing<CustomEnv>,
		c: Context,
	): Promise<ServedGeneration> {
		const digest = generationDigestOf(id);
		let perIndexer = generations.get(db);
		if (!perIndexer) {
			perIndexer = new Map();
			generations.set(db, perIndexer);
		}
		const held = perIndexer.get(indexer);
		if (held && held.digest === digest) return held.ready;

		const ready = (async (): Promise<ServedGeneration> => {
			const declarations = [...(await serving.declarationsOf({id, indexer, db}, c as never))];
			const store = new VersionedStateStore(db, declarations, {
				tableNamespace: digest,
				...(serving.retention === undefined ? {} : {retention: serving.retention}),
				...(serving.finalityDepth === undefined ? {} : {finalityDepth: serving.finalityDepth}),
			});
			const accessor = store.accessor();
			return {
				digest,
				schema: buildQuerySchema(declarations),
				context: {
					accessor,
					generation: digest,
					tip: async () => (await store.getBlockAtOrBelow(Number.MAX_SAFE_INTEGER))?.number,
					// the store's own claim: a `revert-only` store answers every read at the tip
					asOf: store.capabilities.asOf,
				},
			};
		})();
		const entry = {digest, ready};
		perIndexer.set(indexer, entry);
		ready.catch(() => {
			if (perIndexer.get(indexer) === entry) perIndexer.delete(indexer);
		});
		return ready;
	}
}

/**
 * THE Yoga PLUGIN that makes this route an executor like any other: every
 * request is answered by `executeQuery`, and every result Yoga produced on its
 * own is reformatted through the one formatter.
 */
function answeredByExecuteQuery(): Plugin<Record<string, never>, ServedContext> {
	return {
		async onParams({params, setResult, context}) {
			// a request with no document is Yoga's to refuse, and is reformatted below
			if (typeof params.query !== 'string') return;
			const {served} = context;
			const result = await executeQuery(served.schema, served.context, {
				query: params.query,
				variables: params.variables ?? null,
				operationName: params.operationName ?? null,
			});
			setResult(withStatus(result, 200, true) as never);
		},
		onResultProcess({result, setResult, serverContext}) {
			if (Array.isArray(result) || !isResultObject(result)) return;
			if ((result.extensions?.http as Record<string, unknown> | undefined)?.[ANSWERED] === true) return;
			setResult(reformatted(result, serverContext.served?.digest) as never);
		},
	};
}

/**
 * A result Yoga produced itself: a request it refused before GraphQL ran (a body
 * that is not JSON, no `query`, a method it does not take). Each error becomes
 * what the one formatter makes of it: `invalid-query` for a refusal of the
 * REQUEST (a `4xx`), the masked `internal-error` for anything else. The status
 * Yoga chose is kept, since the request was refused before anything answered.
 */
function reformatted(
	result: {errors?: readonly unknown[]; extensions?: Record<string, unknown>},
	generation: string | undefined,
): QueryResult {
	let status = 200;
	const errors: QueryErrorJSON[] = (result.errors ?? []).map((error) => {
		const http = (error as GraphQLError).extensions?.http as {status?: number} | undefined;
		const own = http?.status ?? 500;
		status = Math.max(status, own);
		if (own < 500 && isGraphQLErrorLike(error)) {
			const {extensions, ...rest} = formatQueryError(error as GraphQLError);
			return {...rest, extensions: {...extensions, code: QUERY_ERROR_CODES.invalidQuery}};
		}
		return {message: UNEXPECTED_ERROR_MESSAGE, extensions: {code: QUERY_ERROR_CODES.internalError}};
	});
	const answer: QueryResult = {
		errors,
		...(generation === undefined ? {} : {extensions: {generation, block: null}}),
	};
	return withStatus(answer, status);
}

/**
 * The result with the status Yoga must answer it with, on the one key Yoga reads
 * it from and strips before writing the body (`extensions.http`), so the bytes
 * written are the result's own, key order included.
 */
function withStatus(result: QueryResult, status: number, ours = false): QueryResult {
	const http = ours ? {status, [ANSWERED]: true} : {status};
	return {...result, extensions: {...result.extensions, http}} as QueryResult;
}

function isResultObject(
	result: unknown,
): result is {errors?: readonly unknown[]; extensions?: Record<string, unknown>} {
	return typeof result === 'object' && result !== null && !(Symbol.asyncIterator in result);
}

function isGraphQLErrorLike(error: unknown): boolean {
	return typeof error === 'object' && error !== null && typeof (error as {message?: unknown}).message === 'string';
}

type CanonicalAnswer =
	| {ok: true; indexer: string; id: GenerationId}
	| {ok: false; status: 501 | 503; body: Record<string, unknown>};

/**
 * WHICH GENERATION ANSWERS, read from the rows of the host's database on every
 * request (so a promotion is seen by the next one), with no registry opened:
 * opening one sweeps, which is a write, and a read tier writes nothing.
 */
async function canonicalOf(db: RemoteSQL): Promise<CanonicalAnswer> {
	const held = await readHeldGenerations(db);
	if (held.length > 1) {
		return {
			ok: false,
			status: 501,
			body: {
				success: false,
				error: 'several-named-indexers',
				indexers: held.map((entry) => entry.indexer),
				message:
					`this database holds ${held.length} named indexers, each with a canonical pointer of its own, and ` +
					`/graphql names none: answering would be picking a tenant for the caller (ADR-0036).`,
			},
		};
	}
	const only = held[0];
	if (!only?.canonical) {
		return {
			ok: false,
			status: 503,
			body: {
				success: false,
				error: 'no-canonical-generation',
				...(only === undefined ? {} : {indexer: only.indexer}),
				message:
					`no generation answers reads in this database yet, so there is nothing to query. It is refused ` +
					`rather than answered with empty lists, which would read as "there is nothing" (ADR-0058); retry ` +
					`once a generation is canonical.`,
			},
		};
	}
	return {ok: true, indexer: only.indexer, id: only.canonical};
}
