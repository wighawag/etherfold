import type {Context} from 'hono';
import {logs} from 'named-logs';
import type {Env} from '../env.js';
import type {IndexerRegistryEntry} from '../registry.js';
import type {ServerOptions} from '../types.js';

const logger = logs('@etherfold/server');

/**
 * The named indexer a request addressed, or the refusal to send back.
 *
 * ONE place, because both surfaces that take a `/{indexer}` segment -- the
 * fetcher's private INGEST routes and the public FEED -- have to answer the same
 * two questions the same way, and two copies would drift into two contracts.
 *
 * TWO refusals, and keeping them apart is the point of doing this here:
 *
 * - **`501`, no registry at all.** This host was built with no named indexers --
 *   a read tier, or a combined process whose ingestion is the in-process direct
 *   wire -- so there is no name it could answer under, in either direction. It is
 *   a CAPABILITY statement, and it is what the ingest routes have always said
 *   when nothing was injected.
 * - **`404`, a name this host was not built with.** A ROUTING refusal, matching
 *   what the name IS: a route segment. It is deliberately not a `400`, because
 *   ADR-0004's `400` family is about the PAYLOAD (a foreign `{source, config}`,
 *   a malformed range) and nothing is wrong with this payload; and deliberately
 *   not a `409`, because no block number makes it right. A sender must not retry
 *   either of them, which is what `createHttpIngestion` does with the whole 4xx
 *   family bar the `409`.
 *
 * What it is NEVER is a default. Falling back to "the only indexer this host
 * has" would make a typo in a fetcher's configuration land another tenant's logs
 * in a database that will never be able to tell, and would let a consumer follow
 * a feed it did not ask for.
 */
export function resolveIndexer<CustomEnv extends Env>(
	options: ServerOptions<CustomEnv>,
	c: Context<{Bindings: Env}>,
	surface: string,
): {ok: true; entry: IndexerRegistryEntry; name: string} | {ok: false; response: Response} {
	const name = c.req.param('indexer') as string;
	if (!options.getIndexer) {
		return {
			ok: false,
			response: c.json(
				{
					success: false,
					error: 'ingestion-not-configured',
					message: `this server hosts no named indexer: pass getIndexer to createServer to accept and serve logs`,
				} as const,
				501,
			),
		};
	}
	const entry = options.getIndexer(c as never, name);
	if (!entry) {
		logger.error(`${surface}: a request arrived for ${JSON.stringify(name)}, which this host was not built with`);
		return {
			ok: false,
			response: c.json(
				{
					success: false,
					error: 'unknown-indexer',
					indexer: name,
					message:
						`this server hosts no named indexer called ${JSON.stringify(name)}. A host registers the names it ` +
						`was built with, and no name is ever defaulted: check the name this caller was deployed with.`,
				} as const,
				404,
			),
		};
	}
	// the NAME travels back beside the entry, because it is not merely how the entry
	// was found: it is a DISCRIMINATOR every read and write keys on, and this
	// request's segment is the one source of its value. The OTHER half of that
	// discriminator is on the entry itself (`entry.db`, ADR-0053): a named indexer
	// is a database, so a route acting on one reads through the handle that name
	// owns and never through the host's `getDB`
	return {ok: true, entry, name};
}
