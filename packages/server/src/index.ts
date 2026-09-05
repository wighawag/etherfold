import {Hono} from 'hono';
import {cors} from 'hono/cors';
import {hc} from 'hono/client';
import {HTTPException} from 'hono/http-exception';
import type {ServerOptions} from './types.js';
import type {Env} from './env.js';
import {getStatusAPI, recordError} from './api/status.js';
import {getIngestAPI} from './api/ingest.js';
import {getFeedAPI} from './api/feed.js';

export type {Env, ServerOptions};
export type {CursorReporter} from './types.js';
export {indexerRegistry} from './registry.js';
export type {IndexerRegistryEntry, IndexerResolver} from './registry.js';
export type {CursorReport, StatusCursor} from './cursor.js';
export {SCHEMA_VERSION, applySchema, readSchemaState} from './schema.js';
export type {SchemaState} from './schema.js';
export type {Config} from './setup.js';
/**
 * The counters are READ here and written nowhere in this package: a reorg is
 * concluded by the fold, so the process that owns the store counts it through
 * `ReorgRecorder` (`@etherfold/core`, ADR-0050). This server is one of the
 * READERS, including on a read tier that owns no store at all.
 */
export {readReorgCounters} from './reorgs.js';
export type {RecordedReorg, ReorgCounters} from './reorgs.js';
/**
 * THE STORED EMISSION STREAM (ADR-0006): append-only, retractions included,
 * superseded rows flagged rather than deleted.
 *
 * The WRITE lives here because this package OWNS the table -- its DDL is in
 * `schema/sql/db.sql`, both of ADR-0006's views read it, and the append and the
 * high-water read have to agree about what a position in it means. It is
 * EXPORTED because whoever owns the STORE is who calls it: `emissionAppenderFor`
 * binds it to a database and a named indexer, and the result is handed to a
 * `StreamBuilder`, which appends every batch it folds BEFORE it folds it
 * (ADR-0052). The ingest route is a caller of that path and writes nothing.
 */
export {appendEmissions, emissionAppenderFor, EMISSION_STREAM_TABLE} from './emissions.js';
export type {EmissionAppend} from './emissions.js';
/**
 * PAIR-COMPACTION (ADR-0006): the one thing that ever DELETES from that stream,
 * and a call the HOST SCHEDULES rather than something an append does on its way
 * past (ADR-0022).
 *
 * Exported as a verb and a resolver, and wired to no route and no timer: OFF BY
 * DEFAULT is not a flag this package reads, it is nobody calling this. A host
 * that wants it validates its configured depth at startup with
 * `resolvePairCompaction` and schedules `compactEmissionPairs` on the cadence it
 * chooses -- a browser tab, a backfilling CLI and a long-running server want
 * three different ones, and this package must not pick for them.
 */
export {compactEmissionPairs, resolvePairCompaction, COMPACTION_OFF, DEFAULT_MAX_PAIRS} from './compaction.js';
export type {
	PairCompaction,
	PairCompactionOptions,
	PairCompactionQuery,
	PairCompactionReport,
	PairCompactionSetting,
} from './compaction.js';
/**
 * THE TWO VIEWS' entry shapes, exported because a consumer written in
 * TypeScript reads these and the type is what it reads them as.
 *
 * Two types and not one, because the difference is real: the retraction-aware
 * feed's `FeedEntry` carries the fold's `removed` VERDICT, and the canonical
 * view's `CanonicalEntry` does not, because that view never serves a retraction
 * and a flag that is false on every entry invites reorg handling that can never
 * fire.
 *
 * The CURSOR CODEC is deliberately NOT exported. The cursor is opaque
 * (ADR-0027): publishing a decoder would make the encoding a contract by the
 * back door, which is the exact outcome opacity exists to prevent. It stays
 * inside this package, where the two views share it.
 */
export type {CanonicalEntry, FeedEntry} from './feed/entries.js';

const corsSetup = cors({
	origin: '*',
	allowHeaders: ['Content-Type', 'Upgrade-Insecure-Requests'],
	allowMethods: ['POST', 'GET', 'HEAD', 'OPTIONS'],
	exposeHeaders: ['Content-Length'],
	maxAge: 600,
	credentials: true,
});

/**
 * The indexer-server, minus any host.
 *
 * It knows `RemoteSQL` and nothing else: no Node built-ins, no Cloudflare types,
 * no D1. Everything host-shaped arrives through `getDB` / `getEnv`, which is what
 * lets `platforms/*` supply a libSQL file on Node and a D1 binding on Workers
 * without this package changing.
 */
export function createServer<CustomEnv extends Env>(options: ServerOptions<CustomEnv>) {
	const app = new Hono<{Bindings: CustomEnv}>();

	return app
		.use('/*', corsSetup)
		.route('/', getStatusAPI(options))
		.route('/', getIngestAPI(options))
		.route('/', getFeedAPI(options))
		.onError((err, c) => {
			const env = c.get('config')?.env || {};
			recordError(err);

			if (err instanceof HTTPException && err.res) {
				return err.getResponse();
			}

			return c.json(
				{
					success: false,
					errors: [
						{
							name: 'name' in err ? err.name : undefined,
							code: 'code' in err ? (err as {code?: number}).code : 5000,
							message: err.message,
							cause: env.DEV ? err.cause : undefined,
							stack: env.DEV ? err.stack : undefined,
						},
					],
				},
				500,
			);
		});
}

export type App = ReturnType<typeof createServer>;

// computes the client type at compile time, as in the house template
const client = hc<App>('');
export type Client = typeof client;
export const createClient = (...args: Parameters<typeof hc>): Client => hc<App>(...args);
