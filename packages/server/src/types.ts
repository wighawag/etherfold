import type {Context} from 'hono';
import type {Bindings} from 'hono/types';
import type {RemoteSQL} from 'remote-sql';
import type {CursorReport} from './cursor.js';
import type {IndexerResolver} from './registry.js';

/**
 * How a host tells `/status` where its pipeline has got to.
 *
 * Async because reading a cursor is a STORE read (`StateStore.readCursor`),
 * unlike `getDB` / `getEnv` / `getIndexer`, which hand back handles a host
 * already holds.
 */
export type CursorReporter<Env extends Bindings = Bindings> = (
	c: Context<{Bindings: Env}>,
) => CursorReport | undefined | Promise<CursorReport | undefined>;

export type ServerOptions<Env extends Bindings = Bindings> = {
	/**
	 * The HOST-LEVEL database: what `/status` reports on and what `/admin/setup`
	 * migrates.
	 *
	 * It answers per REQUEST and knows no NAME, and that is right for exactly those
	 * two surfaces, which are facts about this DEPLOYMENT. It is deliberately NOT
	 * what a route acting on one named indexer reads: a named indexer IS a database
	 * (ADR-0053), so that handle is part of what its name resolves to
	 * (`IndexerRegistryEntry.db`). A host holding ONE named indexer ordinarily
	 * passes the same handle in both places -- `run` and `index` share one -- and a
	 * host holding several passes each name its own.
	 */
	getDB: (c: Context<{Bindings: Env}>) => RemoteSQL;
	getEnv: (c: Context<{Bindings: Env}>) => Env;
	/**
	 * The NAME-KEYED REGISTRY of the named indexers this deployment hosts.
	 *
	 * Injected exactly like the database, and for the same reason: WHICH processor
	 * runs, against WHICH source, under WHICH name, is a deployment's choice, and a
	 * server package that constructed one would have to know how to load a processor
	 * module, which is the CLI's job and not an HTTP app's. The resolved `{db, env}`
	 * is on the context by the time this is called (`c.get('config')`), so a host can
	 * build its processors from the same database the rest of the app uses.
	 *
	 * It resolves an ENTRY rather than a bare `LogIngestion` so that what a name
	 * holds can grow without every host's resolver changing shape; see
	 * `IndexerRegistryEntry`. What it holds now includes the DATABASE that name
	 * owns, which is what makes a host with several of them a set of isolated
	 * tenants rather than a set of labels over one keyspace.
	 *
	 * OPTIONAL, because an indexer-server is useful before it ingests anything:
	 * `/status` and `/admin/setup` answer on a server with no processor at all,
	 * and a read tier is built exactly that way. When it is absent the ingestion
	 * routes answer `501` under EVERY name, which says "this server does not do
	 * that" rather than pretending the route is missing. That is deliberately a
	 * different answer from a registry that does not hold the name asked for, which
	 * is a `404`: one is a capability this host lacks, the other is a tenant it was
	 * not built with.
	 */
	getIndexer?: IndexerResolver<Env>;
	/**
	 * Where this deployment's pipeline has got to, if this deployment can say.
	 *
	 * Injected exactly like the ingestion, and for the same reason: only the
	 * process that OWNS the store can read a cursor, and this package has no store
	 * dependency at all (it knows one storage abstraction and nothing else). The
	 * cursor is also an OPAQUE STRING behind the storage seam (ADR-0027) -- only the
	 * processor knows what one means -- so a server that read and parsed one would
	 * have taken on both a dependency and a meaning that are not its.
	 *
	 * OPTIONAL, because a host with no store has no cursor to report rather than a
	 * misconfiguration: the Workers host builds the app with a database binding and
	 * an environment and nothing else, and its `/status` simply carries no `cursor`
	 * field. Nothing is invented in its place.
	 *
	 * ## What a reporter OWES the server
	 *
	 * A SMALL, JSON-serialisable summary of where the pipeline has got to, and
	 * NEVER the store's raw serialized cursor. That value is a serialized
	 * `LastSync` carrying an unconfirmed window of DECODED EVENTS, so a host that
	 * handed it over whole would put an unbounded blob on the one page an operator
	 * refreshes while something is wrong. The constraint has to live here, on the
	 * seam, because `/status` reports what this returns VERBATIM: the server does
	 * not parse it, so it cannot bound it afterwards either.
	 *
	 * Failing is safe and is the reporter's own business: a reporter that throws,
	 * rejects, or returns `undefined` because it cannot read right now yields a
	 * cursor that is absent-with-a-reason. It never fails the request and never
	 * changes `healthy`.
	 */
	getCursorReport?: CursorReporter<Env>;
};
