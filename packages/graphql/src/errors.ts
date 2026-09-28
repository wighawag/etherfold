import {ROWS_EXAMINED_BOUND} from '@etherfold/accessor';
import type {GraphQLError} from 'graphql';
import type {QueryErrorJSON} from './executor.js';

/**
 * ## One set of codes, and one formatter (ADR-0099)
 *
 * Every executor formats errors through `formatQueryError`, so a refusal reads
 * the same whichever transport carried it, and an app handles a code once. A
 * capability a deployment cannot serve is a coded REFUSAL, never a different
 * schema and never an ignored argument.
 *
 * The codes are kebab-case because the accessor's own refusal already is
 * (`rows-examined-bound`), and it is carried through unchanged rather than
 * renamed, so the code an app sees is the one the seam documents.
 */
export const QUERY_ERROR_CODES = Object.freeze({
	/**
	 * The request itself is wrong: a document that does not parse or validate
	 * against the schema, a variable of the wrong type (a `U256` that is negative),
	 * an operation name the document does not hold, or an argument the schema
	 * admits and the query refuses (`first` below 1, a `null` where a predicate
	 * was expected). Asking again does not help; fixing the query does.
	 */
	invalidQuery: 'invalid-query',
	/**
	 * A `block` outside what the store retains (the seam's
	 * `BlockNotRetainedError`), or any `block` on a store that answers no as-of
	 * read. Never answered from the tip. Carries `requested`.
	 */
	blockNotRetained: 'block-not-retained',
	/**
	 * A `block` above the one the operation pinned: the store has not indexed it
	 * yet, and answering it from the tip would be a plausible wrong answer for a
	 * block that may still change state. Carries `requested` and `pinned`.
	 */
	blockNotYetIndexed: 'block-not-yet-indexed',
	/** The accessor's refusal past its rows-examined bound, unchanged. Carries `entity` and `bound`. */
	rowsExaminedBound: ROWS_EXAMINED_BOUND,
	/**
	 * The tip moved under the operation in a way its pin cannot absorb (a reorg
	 * took it BELOW the pinned block), and did again on the one retry. Carries
	 * `started` and `ended`, the tip at each end of the retry.
	 */
	tipMovedDuringOperation: 'tip-moved-during-operation',
	/** Anything unexpected. The message is masked, so nothing internal leaks through a transport. */
	internalError: 'internal-error',
	/** The transport failed (`transportFailure`); nothing answered. */
	transportFailure: 'transport-failure',
} as const);

export type QueryErrorCode = (typeof QUERY_ERROR_CODES)[keyof typeof QUERY_ERROR_CODES];

/** The message an unexpected error is masked to. */
export const UNEXPECTED_ERROR_MESSAGE = 'Unexpected error.';

/**
 * A refusal the query layer raises itself, with its code. Thrown from a
 * resolver; `formatQueryError` reads it off the error graphql-js wraps it in.
 *
 * `name` and `code` are plain fields, as the accessor's own refusal pins them,
 * because a class does not survive a structured clone and a code is what a
 * caller acts on.
 */
export class QueryRefusal extends Error {
	readonly name = 'QueryRefusal';

	constructor(
		readonly code: QueryErrorCode,
		message: string,
		/** Extra `extensions` the formatter carries beside the code. */
		readonly details: Readonly<Record<string, unknown>> = {},
	) {
		super(message);
	}
}

/**
 * Format one GraphQL error the way every executor serialises it.
 *
 * - A refusal with a code (the query layer's own, the seam's
 *   `BlockNotRetainedError`, the accessor's `RowsExaminedBoundError`) keeps its
 *   message and gains its code.
 * - An error with no `path` came from parsing, validating or coercing the
 *   REQUEST before any field ran, so it is the caller's: `invalid-query`, with
 *   graphql-js's message, which names what is wrong.
 * - Anything else was thrown while resolving a field and is not a refusal, so
 *   its message is MASKED (`internal-error`): an unexpected error's text is
 *   whatever the storage said, and a transport must not carry that out.
 */
export function formatQueryError(error: GraphQLError): QueryErrorJSON {
	const refusal = refusalOf(error.originalError);
	if (refusal) return shaped(error, refusal.message, {code: refusal.code, ...refusal.details});
	if (error.path === undefined) return shaped(error, error.message, {code: QUERY_ERROR_CODES.invalidQuery});
	return shaped(error, UNEXPECTED_ERROR_MESSAGE, {code: QUERY_ERROR_CODES.internalError});
}

/** A refusal the query layer builds itself, outside any field (the tip moved twice). */
export function refusalJSON(refusal: QueryRefusal): QueryErrorJSON {
	return {message: refusal.message, extensions: {code: refusal.code, ...refusal.details}};
}

type Refusal = {code: QueryErrorCode; message: string; details: Record<string, unknown>};

/**
 * The coded refusal an error is, if it is one. Read STRUCTURALLY (`name`,
 * `code`) rather than by `instanceof`, so a refusal that crossed a port and
 * lost its class is still recognised.
 */
function refusalOf(error: unknown): Refusal | undefined {
	if (!(error instanceof Error)) return undefined;
	const fields = error as Error & Record<string, unknown>;
	if (error instanceof QueryRefusal) return {code: error.code, message: error.message, details: {...error.details}};
	if (fields.name === 'BlockNotRetainedError') {
		return {
			code: QUERY_ERROR_CODES.blockNotRetained,
			message: error.message,
			details: {requested: fields.requested},
		};
	}
	if (fields.code === ROWS_EXAMINED_BOUND) {
		return {
			code: QUERY_ERROR_CODES.rowsExaminedBound,
			message: error.message,
			details: {entity: fields.entity, bound: fields.bound},
		};
	}
	return undefined;
}

function shaped(error: GraphQLError, message: string, extensions: QueryErrorJSON['extensions']): QueryErrorJSON {
	const json: {-readonly [K in keyof QueryErrorJSON]: QueryErrorJSON[K]} = {message, extensions};
	if (error.locations !== undefined) json.locations = error.locations.map(({line, column}) => ({line, column}));
	if (error.path !== undefined) json.path = [...error.path];
	// key order is part of "byte for byte": message, locations, path, extensions
	const {extensions: last, ...rest} = json;
	return {...rest, extensions: last};
}
