import {QUERY_ERROR_CODES, type QueryErrorCode} from './errors.js';

/**
 * ## The executor contract (ADR-0099)
 *
 * The transport is a `QueryExecutor`, not a `fetch`: a function from a request
 * to a result. HTTP for a remote indexer, the worker port for a worker that
 * holds the store, in process for tests (`localExecutor`), and a `fetch` shim
 * derived from any of them for client libraries that only take one. An app
 * injects one at startup, so "runs locally" is a deployment choice rather than
 * a code change.
 *
 * Every executor owes the same four things, which is what makes "the same
 * query" true rather than aspirational:
 *
 * - it NEVER REJECTS: whatever happened is a `QueryResult`, so an app writes
 *   one error path and not one per transport;
 * - a result is JSON, byte for byte the same on every executor: a `u256` is a
 *   decimal string (`U256`), bytes are `0x` hex, and no executor is nicer
 *   locally by handing back a `bigint`;
 * - every error carries a code (`extensions.code`, one of `QUERY_ERROR_CODES`),
 *   formatted by the one formatter (`formatQueryError`);
 * - every ANSWER reports which generation answered and the block it answered
 *   as of (`extensions`).
 *
 * And the one thing a transport adds: when the transport itself failed (an HTTP
 * 500, a body that is not JSON, a network error, a closed port, a worker host
 * that died), the executor normalises it to ONE shape, `transportFailure`, so an
 * app does not write different handling for the mode that can return a 500 and
 * the mode that cannot.
 */
export type QueryExecutor = (request: QueryRequest) => Promise<QueryResult>;

/** What an executor is asked: a GraphQL document, its variables, and which operation in it to run. */
export type QueryRequest = {
	readonly query: string;
	readonly variables?: Readonly<Record<string, unknown>> | null;
	readonly operationName?: string | null;
};

/**
 * What an executor answers, always JSON.
 *
 * `data` is absent when the request was refused before anything was read (an
 * unparsable document, a variable of the wrong type, an operation interrupted
 * by a reorg twice, a transport failure), and `null` when a refusal while
 * reading nulled the root. `extensions` is absent ONLY on a transport failure,
 * where nothing answered and no generation can be named.
 */
export type QueryResult = {
	readonly data?: Record<string, unknown> | null;
	readonly errors?: readonly QueryErrorJSON[];
	readonly extensions?: QueryExtensions;
};

/**
 * What every answer reports beside its data (ADR-0099).
 *
 * `generation` is the opaque generation digest (`generationDigestOf` in
 * `@etherfold/core`): compare it, never parse it. `block` is the block the
 * operation PINNED and answered every field as of (a field asking for an
 * earlier `block` answers as of that one), or `null` when nothing was pinned:
 * the store held no block yet, or the operation was refused before it read.
 */
export type QueryExtensions = {
	readonly generation: string;
	readonly block: number | null;
};

/** One error as every executor serialises it. */
export type QueryErrorJSON = {
	readonly message: string;
	readonly locations?: readonly {readonly line: number; readonly column: number}[];
	readonly path?: readonly (string | number)[];
	readonly extensions: {readonly code: QueryErrorCode} & Readonly<Record<string, unknown>>;
};

/**
 * WHY a transport failed, as far as the executor can tell: the ones a transport
 * can meet, and no more. An HTTP executor meets the first three, a worker
 * executor the last two.
 *
 * - `http-status`: the server answered, with a status that is not a GraphQL
 *   answer (a 500, a 502 from a proxy); `status` carries it.
 * - `invalid-body`: something answered, and it was not a GraphQL result (not
 *   JSON, or JSON of another shape).
 * - `network`: nothing answered (a refused connection, DNS, an abort).
 * - `port-closed`: the port to a worker host is closed.
 * - `host-gone`: the worker host died or was terminated.
 */
export const TRANSPORT_FAILURE_REASONS = Object.freeze([
	'http-status',
	'invalid-body',
	'network',
	'port-closed',
	'host-gone',
] as const);

export type TransportFailureReason = (typeof TRANSPORT_FAILURE_REASONS)[number];

/** What a transport failure carries beside its reason. */
export type TransportFailureDetail = {
	/** The HTTP status, for `http-status`. */
	readonly status?: number;
};

/**
 * THE shape every executor normalises a transport failure to: a result with no
 * `data`, no `extensions` (nothing answered, so no generation can be named) and
 * ONE error, coded `transport-failure`, naming the `reason`.
 *
 * A result and not a rejection, because an executor never rejects: a client
 * library already handles a result with errors, and a GraphQL client that sees
 * a rejection surfaces it as something else entirely.
 */
export function transportFailure(
	reason: TransportFailureReason,
	message: string,
	detail: TransportFailureDetail = {},
): QueryResult {
	if (!TRANSPORT_FAILURE_REASONS.includes(reason)) {
		throw new Error(
			`a transport failure's reason is one of ${TRANSPORT_FAILURE_REASONS.join(', ')}, got ${JSON.stringify(reason)}`,
		);
	}
	const extensions: Record<string, unknown> = {code: QUERY_ERROR_CODES.transportFailure, reason};
	if (detail.status !== undefined) extensions.status = detail.status;
	return {errors: [{message, extensions: extensions as QueryErrorJSON['extensions']}]};
}

/** Whether a result is a transport failure rather than an answer (which may itself carry errors). */
export function isTransportFailure(result: QueryResult): boolean {
	return (
		result.extensions === undefined &&
		result.errors?.length === 1 &&
		result.errors[0]!.extensions.code === QUERY_ERROR_CODES.transportFailure
	);
}
