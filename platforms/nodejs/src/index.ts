import {serve} from '@hono/node-server';
import {createClient} from '@libsql/client';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL} from 'remote-sql';
import {createServer, applySchema, readSchemaState, type Env, type ServerOptions} from '@etherfold/server';
import {logs} from 'named-logs';

const logger = logs('@etherfold/platform-nodejs');

export type NodeEnv = Env & {
	/** libSQL URL. A path like `file:./data/etherfold.db`, or `:memory:`. Ignored when a handle is passed. */
	DB: string;
	/** Port to listen on, when not passed explicitly. */
	PORT?: string;
};

export type StartOptions = {
	/**
	 * The database, as a libSQL URL or as a handle the caller already built.
	 *
	 * ONE option with two forms, because a host has one database and the question
	 * is only who OPENED it. A URL is the standalone case: this adapter builds the
	 * handle with `createNodeDB` and defaults to `DB` in the environment, else
	 * `file:./etherfold.db`. A `RemoteSQL` is the shared case: a process that
	 * already folds a processor into a store hands the SAME handle here, so the
	 * store and the server see one database rather than two connections with two
	 * views of it (against `:memory:` they would not even be the same database) and
	 * two schema-setup races.
	 *
	 * A handle this adapter was GIVEN is not its to close: `close()` shuts the HTTP
	 * listener down and leaves the database alone, so stopping the server never
	 * takes a store's connection with it. Whoever built the handle closes it, which
	 * for the URL form is whoever holds the returned `db`.
	 */
	db?: string | RemoteSQL;
	port?: number;
	hostname?: string;
	/**
	 * Apply the fixed-table schema at startup if it is not already there.
	 *
	 * On by default, because the Node host is the single-operator case: there is
	 * one process, it owns its database file, and making a user POST to an admin
	 * route before the server is usable is ceremony with no safety payoff. The
	 * multi-instance case (Workers) deliberately does NOT get this, since several
	 * instances racing to migrate one database is a different problem.
	 */
	autoSetup?: boolean;
	env?: Partial<NodeEnv>;
	/**
	 * The NAMED INDEXERS this process hosts, if it hosts any, handed to the app
	 * unchanged.
	 *
	 * Passthrough, in the server's own shape (a resolver from a NAME to a registry
	 * entry, called per REQUEST, since that is what the Workers model forces on the
	 * app and one server that runs unmodified on both hosts is worth a closure call
	 * on Node). This adapter builds no processor and knows nothing about one: what
	 * it decides is what the app's database, environment, registry and reporter ARE.
	 * `indexerRegistry` (`@etherfold/server`) builds one from a plain record of names
	 * for a host that knows them all up front.
	 *
	 * Absent by default, and that absence is what the read tier is: the ingestion
	 * routes then answer `501` to an authenticated caller under every name, exactly
	 * as a server started with a URL and nothing else does today.
	 */
	getIndexer?: ServerOptions<NodeEnv>['getIndexer'];
	/**
	 * Where this process's pipeline has got to, if this process can say, handed to
	 * the app unchanged.
	 *
	 * Passthrough, same as the ingestion and for the same reason: only the process
	 * that OWNS the store can read a cursor, and this adapter owns no store. What a
	 * reporter owes the server (a SMALL, JSON-serialisable summary, never the
	 * store's raw serialized cursor) is stated on `ServerOptions.getCursorReport`,
	 * which is the seam that has to carry it; nothing is added or checked here.
	 *
	 * Absent by default, and then `/status` carries no `cursor` field rather than
	 * an invented one.
	 */
	getCursorReport?: ServerOptions<NodeEnv>['getCursorReport'];
	/**
	 * What this process's log-fetcher has learned about the node it reads, if this
	 * process HOLDS one, handed to the app unchanged.
	 *
	 * Passthrough for the third time, and absent on almost every host: only the
	 * COMBINED shape (`etherfold run`) holds both halves of ADR-0003 in one process,
	 * so a receiving or read-only server injects none and `/status` carries no
	 * `fetcher` field rather than an invented one (ADR-0074).
	 */
	getFetcherLimits?: ServerOptions<NodeEnv>['getFetcherLimits'];
};

export type RunningServer = {
	port: number;
	url: string;
	/** The handle the app reads through: the one that was given, or the one built from the URL. */
	db: RemoteSQL;
	/** Stops listening. It does NOT close `db`, which the server may not own. */
	close: () => Promise<void>;
};

/** Build the RemoteSQL a Node host uses. Exposed so tests and the CLI can share it. */
export function createNodeDB(url: string): RemoteSQL {
	return new RemoteLibSQL(createClient({url}));
}

/**
 * Apply the fixed-table schema if the database does not already carry it.
 *
 * Exposed for the same reason `createNodeDB` is: it is what a Node host does to
 * a libSQL database before anything uses it, and `etherfold build` needs it
 * WITHOUT starting a server. The one-shot binds no port, so nothing else would
 * ever create the `_meta` table -- and a database it emitted would then be a
 * publishable artifact that has lost its provenance the moment it becomes an
 * input to another process (no schema version, no reorg counters). The fixed
 * tables belong to the ARTIFACT rather than to whichever process happens to be
 * serving it.
 *
 * Idempotent: the DDL is `IF NOT EXISTS` and the version row is an upsert, so
 * `startServer`'s own auto-setup and a one-shot that already ran cost nothing.
 *
 * @returns whether it had to apply anything.
 */
export async function ensureFixedSchema(db: RemoteSQL, describedAs?: string): Promise<boolean> {
	const state = await readSchemaState(db);
	if (state.applied) return false;
	logger.info(`applying fixed-table schema to ${describedAs ?? 'the database handle this process holds'}`);
	await applySchema(db);
	return true;
}

/**
 * Start the indexer-server on Node.
 *
 * This is the whole adapter: it decides what `getDB`, `getEnv`, `getIndexer`,
 * `getCursorReport` and `getFetcherLimits` return and hands them to the
 * platform-agnostic app. No route, no chain logic and no storage decision lives
 * here, and the capabilities are carried through untouched because only a HOST
 * can build them and only this file can reach the app on Node.
 */
export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
	const processEnv = process.env as Partial<NodeEnv>;
	const env = {...processEnv, ...options.env} as NodeEnv;
	const port = options.port ?? (env.PORT ? Number(env.PORT) : 2000);
	const hostname = options.hostname;

	// a string (or nothing) is a URL to open; anything else is a handle the caller
	// already opened, still owns, and shares with whatever else reads it
	const given = options.db;
	let db: RemoteSQL;
	let dbURL: string | undefined;
	if (given !== undefined && typeof given !== 'string') {
		db = given;
	} else {
		dbURL = given ?? env.DB ?? 'file:./etherfold.db';
		db = createNodeDB(dbURL);
	}

	if (options.autoSetup !== false) {
		await ensureFixedSchema(db, dbURL ?? 'the database handle this server was given');
	}

	const app = createServer<NodeEnv>({
		getDB: () => db,
		getEnv: () => env,
		getIndexer: options.getIndexer,
		getCursorReport: options.getCursorReport,
		getFetcherLimits: options.getFetcherLimits,
	});

	const server = serve({fetch: app.fetch, port, hostname});

	// port 0 means "any free port", and the caller cannot know which one it got
	// unless we read it back off the listening socket
	const address = server.address();
	const boundPort = typeof address === 'object' && address ? address.port : port;

	return {
		port: boundPort,
		url: `http://${hostname ?? 'localhost'}:${boundPort}`,
		db,
		close: () => new Promise<void>((resolve, reject) => server.close((err?: Error) => (err ? reject(err) : resolve()))),
	};
}
