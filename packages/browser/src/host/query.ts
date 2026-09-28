import type {StateStore} from '@etherfold/state-store';

/**
 * THE GENERIC QUERY CASE (ADR-0099): what a host hands the query handler an app
 * injected, and the handler's own shape.
 *
 * This package carries the CASE and never the query language. The worker
 * executor of `@etherfold/graphql` (its `./worker` subpath) needs the schema and
 * the `graphql` runtime where the store is, which is the host; but an app that
 * reads a few entities by id through `createPortReadSurface` must not pay for a
 * GraphQL runtime in its worker bundle. So the host only carries an opaque
 * request to a handler the app's worker entry PASSED (`query` on the spec of
 * `hostIndexerInThisWorker` / `hostIndexerInThisSharedWorker`, or on
 * `mainThreadHost({query})`), and answers what the handler answered. An entry
 * that passes none imports nothing of GraphQL, and a `query` asked of its host is
 * refused, naming the missing handler.
 *
 * ```ts
 * import {graphqlQueryHandler} from '@etherfold/graphql/worker';
 * hostIndexerInThisWorker({createState, createProcessor, query: graphqlQueryHandler()});
 * ```
 */

/**
 * WHAT A QUERY IS ANSWERED FROM, resolved by the host PER OPERATION: the store
 * its canonical generation folds into (or, for a reader under the tab election,
 * the shared store it opened for reading), and which generation that is.
 *
 * Resolved per operation and not captured, because the canonical pointer moves:
 * one operation holds ONE context, so it cannot straddle a promotion.
 */
export type HostQueryContext = {
	/**
	 * The store a read is answered from, exactly the one the four reads use. A
	 * handler reads it through whatever the backend offers beyond the seam (the
	 * IndexedDB store's `accessor()` and `tip()`, which a claimed handle forwards).
	 */
	readonly store: StateStore;
	/**
	 * WHICH generation answers: its digest (`generationDigestOf` in
	 * `@etherfold/core`), opaque, reported in every answer so an app can compare it
	 * across deployments.
	 *
	 * For a READER under the tab election (ADR-0097), which holds no container, it
	 * is the generation the leader last named on the state-moved signal it relays,
	 * or, before the leader has said anything, the one this host's own spec names
	 * (its bundle's identity, or `processorIdentity`, over the stream a reader
	 * opens). A reader that can name neither rejects the context rather than
	 * inventing one.
	 */
	readonly generation: string;
};

/**
 * THE HANDLER an app's worker entry injects: an opaque request in, a
 * structured-clone-safe answer out.
 *
 * `context` resolves the store and generation for THIS operation; a handler calls
 * it once per request. It may reject (no store yet on a host that stopped, a
 * reader that cannot name its generation), and a handler that promises never to
 * reject (as `graphqlQueryHandler` does) turns that into an answer of its own.
 * A rejection that does escape is refused to the tab as any case's refusal is.
 */
export type HostQueryHandler = (request: unknown, context: () => Promise<HostQueryContext>) => Promise<unknown>;

/** What a host serves the query case WITH: the handler, where the entry passed one. */
export type HostQueryOptions = {
	/** The query handler, or absent for a host that answers no query (and bundles no query language). */
	readonly query?: HostQueryHandler;
};
