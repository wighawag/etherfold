import type {Accessor} from '@etherfold/accessor';
import {
	execute,
	GraphQLError,
	parse,
	validate,
	type DocumentNode,
	type ExecutionResult,
	type GraphQLSchema,
} from 'graphql';
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
	 * Whether the store answers as-of reads (`StateStoreCapabilities.asOf`),
	 * `true` when absent. When it does, the pin is PASSED to every read, so a
	 * block applied mid-operation changes nothing the operation reads. When it
	 * does not (a `revert-only` store), every read is at the tip and ANY move of
	 * the tip during the operation is a tear: it is retried once, then refused.
	 */
	readonly asOf?: boolean;
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
export function localExecutor(schema: GraphQLSchema, context: QueryContextSource): QueryExecutor {
	return (request) => executeQuery(schema, context, request);
}

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

	let document: DocumentNode;
	try {
		document = parse(request.query);
	} catch (error) {
		if (error instanceof GraphQLError) return unpinned([error]);
		return unpinned([new GraphQLError(String((error as Error)?.message ?? error))]);
	}
	const invalid = validate(schema, document);
	if (invalid.length > 0) return unpinned(invalid);

	const asOf = context.asOf ?? true;
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
