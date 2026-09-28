import type {Accessor} from '@etherfold/accessor';
import {execute, GraphQLError, type DocumentNode, type ExecutionResult, type GraphQLSchema} from 'graphql';
import {prepareDocument, type DocumentCache} from './documents.js';
import {formatQueryError, QUERY_ERROR_CODES, QueryRefusal, refusalJSON, UNEXPECTED_ERROR_MESSAGE} from './errors.js';
import type {QueryExecutor, QueryRequest, QueryResult} from './executor.js';
import {OperationReads} from './operation.js';

/**
 * What an operation is answered from: the accessor the resolvers read
 * through, which generation it reads, and where that generation's state stands.
 */
export type QueryContext = {
	/** The accessor seam over the store the generation folds into (ADR-0099). */
	readonly accessor: Accessor;
	/**
	 * The generation digest (`generationDigestOf` in `@etherfold/core`), reported
	 * in every answer's `extensions` so a reader can compare it across
	 * deployments without parsing it.
	 */
	readonly generation: string;
	/**
	 * The TIP: the highest block the store holds, or `undefined` before the
	 * first. Read at the start of every operation (its pin) and again at the end
	 * (the reorg guard). The host supplies it because the seam keeps the sync
	 * cursor opaque (ADR-0027) and a store's recorded blocks are a backend's own.
	 */
	tip(): Promise<number | undefined>;
	/**
	 * Whether the store answers as-of reads: its `StateStoreCapabilities.asOf`,
	 * read off the store the accessor reads. When it does, the pin is PASSED to
	 * every read, so a block applied mid-operation changes nothing the operation
	 * reads. When it does not (a `revert-only` store), every read is at the tip
	 * and ANY move of the tip during the operation is a tear: it is retried once,
	 * then refused.
	 *
	 * REQUIRED, with no default: a default of `true` made a host over a
	 * `revert-only` store that left it out pin the tip and pass it to every read,
	 * which that store refuses, so EVERY query was refused
	 * (`block-not-retained`), even one asking no `block`. A host copies the
	 * store's claim instead, which is one line.
	 */
	readonly asOf: boolean;
};

/**
 * A context, or a function answering one per OPERATION: a host whose canonical
 * pointer can move passes the function, so each operation resolves the pointer
 * once and holds it, and a query cannot straddle a promotion.
 */
export type QueryContextSource = QueryContext | (() => QueryContext | Promise<QueryContext>);

/**
 * THE IN-PROCESS EXECUTOR: the schema run against a context in this process,
 * for tests and for any host that holds the store itself. It is `executeQuery`
 * as a `QueryExecutor`, so it answers exactly what every other executor must.
 */
export function localExecutor(
	schema: GraphQLSchema,
	context: QueryContextSource,
	options: ExecuteQueryOptions = {},
): QueryExecutor {
	return (request) => executeQuery(schema, context, request, options);
}

/** What `executeQuery` may be handed beside the request. */
export type ExecuteQueryOptions = {
	/**
	 * Where parsed and validated documents are kept, so a repeated document is
	 * not parsed again. Absent, every request is parsed and validated afresh.
	 */
	readonly documents?: DocumentCache;
};

/** How many times an operation is ATTEMPTED: once, and once more if the tip moved under it. */
const ATTEMPTS = 2;

/**
 * Run one operation, pinned to one block, and answer it as every executor does.
 *
 * ## One block per operation, guarded optimistically (ADR-0099)
 *
 * The tip is read when the operation begins, and that block is the PIN: every
 * field is read as of it (a root field's own `block` may ask for an earlier
 * one), so a block applied while the resolvers run changes nothing the
 * operation reads, and the answer reports the pin in `extensions.block`.
 *
 * A reorg is the one thing a pin cannot absorb: it REPLACES the pinned block,
 * so reads before and after it answer from two branches. The tip is read again
 * at the end, and if it went BELOW the pin the operation is run once more,
 * pinned afresh; if it moves backwards on that retry too, the operation is
 * refused (`tip-moved-during-operation`) rather than answered from a mix.
 * Deliberately not by pinning below finality: serving the unconfirmed tip is
 * the point. (A reorg that takes the tip below the pin and back above it
 * between the two reads is not seen by this guard; the ADR accepts that.)
 *
 * Never rejects: a failure of the context itself is an `internal-error` result.
 */
export async function executeQuery(
	schema: GraphQLSchema,
	source: QueryContextSource,
	request: QueryRequest,
	options: ExecuteQueryOptions = {},
): Promise<QueryResult> {
	let context: QueryContext;
	try {
		context = typeof source === 'function' ? await source() : source;
	} catch {
		return {errors: [{message: UNEXPECTED_ERROR_MESSAGE, extensions: {code: QUERY_ERROR_CODES.internalError}}]};
	}
	const {generation} = context;
	const unpinned = (errors: readonly GraphQLError[]): QueryResult => ({
		errors: errors.map(formatQueryError),
		extensions: {generation, block: null},
	});

	const prepared =
		options.documents && typeof request.query === 'string'
			? options.documents.prepare(schema, request.query)
			: prepareDocument(schema, request.query);
	if (prepared.errors) return unpinned(prepared.errors);
	const document: DocumentNode = prepared.document;

	const {asOf} = context;
	try {
		let started: number | undefined;
		let ended: number | undefined;
		for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
			started = await context.tip();
			const executed: ExecutionResult = await execute({
				schema,
				document,
				variableValues: request.variables ?? undefined,
				operationName: request.operationName ?? undefined,
				contextValue: new OperationReads(context.accessor, started, asOf),
			});
			ended = await context.tip();
			if (!tornBetween(started, ended, asOf)) return answered(executed, generation, started);
		}
		const refusal = new QueryRefusal(
			QUERY_ERROR_CODES.tipMovedDuringOperation,
			`the tip moved under this operation twice (on the retry, from ${describe(started)} to ${describe(ended)}), ` +
				`so it was not answered from a mix of two branches. Ask again.`,
			{started: started ?? null, ended: ended ?? null},
		);
		return {errors: [refusalJSON(refusal)], extensions: {generation, block: null}};
	} catch {
		return {
			errors: [{message: UNEXPECTED_ERROR_MESSAGE, extensions: {code: QUERY_ERROR_CODES.internalError}}],
			extensions: {generation, block: null},
		};
	}
}

/**
 * Whether the tip moved in a way the operation's reads could not absorb.
 * Pinned by block, only a move BELOW the pin (a reorg) tears it; read at the
 * tip (no as-of reads, or no block to pin yet), any move does.
 */
function tornBetween(started: number | undefined, ended: number | undefined, asOf: boolean): boolean {
	if (asOf && started !== undefined) return ended === undefined || ended < started;
	return ended !== started;
}

function answered(executed: ExecutionResult, generation: string, block: number | undefined): QueryResult {
	const result: {-readonly [K in keyof QueryResult]: QueryResult[K]} = {};
	if ('data' in executed) result.data = (executed.data ?? null) as Record<string, unknown> | null;
	if (executed.errors && executed.errors.length > 0) result.errors = executed.errors.map(formatQueryError);
	// a result is JSON: graphql-js builds `data` from null-prototype objects
	if (result.data) result.data = JSON.parse(JSON.stringify(result.data));
	result.extensions = {generation, block: block ?? null};
	return result;
}

function describe(block: number | undefined): string {
	return block === undefined ? 'no block' : `block ${block}`;
}
