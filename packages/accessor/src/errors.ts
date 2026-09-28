/** The code `RowsExaminedBoundError` carries, for a caller that reads it structurally (across a port, say). */
export const ROWS_EXAMINED_BOUND = 'rows-examined-bound';

/**
 * Thrown by a BOUNDED accessor when answering a query would examine more rows
 * than its declared bound (ADR-0099).
 *
 * A refusal rather than a slower answer: the browser substrate has no query
 * planner, and an app whose list view gets slower every week as its data grows
 * has no error to act on, where this is one. The bound is ROWS EXAMINED, not
 * elapsed time, because time is a property of the device (a phone would refuse
 * what a laptop answers) and a deterministic bound refuses identically
 * everywhere, which is what makes it testable.
 *
 * The bound is a backend's own and not a parity rule: SQLite has a query planner
 * and declares none, so the same query that is refused in a browser is answered
 * by a server. That difference is DOCUMENTED and asserted per backend by the
 * conformance suite (`AccessorConformanceOptions.rowsExaminedBound`), never
 * hidden.
 *
 * Defined here, at the seam, because every bounded backend throws it and every
 * caller above catches it, and two classes of one name in two packages would
 * break `instanceof` across the boundary. `name` and `code` are pinned as plain
 * readonly fields because an error's class does not survive structured clone and
 * those are what a tab acts on.
 */
export class RowsExaminedBoundError extends Error {
	readonly name = 'RowsExaminedBoundError';
	readonly code = ROWS_EXAMINED_BOUND;
	/** Asking again examines the same rows: waiting cannot turn this into an answer. */
	readonly retryable = false;

	constructor(
		/** The entity the query read. */
		readonly entity: string,
		/** The declared bound: the most rows this backend examines for one query. */
		readonly bound: number,
		message?: string,
	) {
		super(
			message ??
				`the query on entity ${entity} was refused: answering it would examine more than ${bound} rows, ` +
					`which is this backend's declared rows-examined bound. Narrow the query (a predicate the backend can ` +
					`serve from a range, a smaller page), or raise the bound for this deployment.`,
		);
	}
}
