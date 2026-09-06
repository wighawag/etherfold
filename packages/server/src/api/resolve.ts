import {generationDigestOf, type GenerationId} from '@etherfold/core';
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

/**
 * WHICH GENERATION ANSWERS THIS READ -- or the refusal that says none does yet.
 *
 * ONE PLACE, below the routes, for the same reason `resolveIndexer` above is one:
 * every read that resolves the canonical pointer must decide the same way, and a
 * second copy beside the first would be a second answer to "who answers reads".
 * Both feed views resolve through here, and a surface added later inherits the
 * refusal rather than having to remember it -- which is what a read tier
 * (`serve`, answering over a database written elsewhere) needs, since it is the
 * shape most likely to meet an indexer that holds nothing yet.
 *
 * ## Why an indexer with no canonical generation REFUSES (ADR-0058)
 *
 * Because the alternative is a LIE that a consumer cannot detect. A feed read
 * against a name whose pointer names nothing would find no rows and answer `200`
 * with an empty page and `hasMore: false` -- byte-identical to "you are caught
 * up" -- so "there is nothing here" and "this is still being built" would arrive
 * in the same shape. That is exactly the distinction ADR-0015 refuses to lose on
 * the state side, and it is the same absence-versus-contradiction discipline the
 * reorg model and `SuspectedTruncationError` already keep.
 *
 * `503` and not one of this surface's other refusals: nothing about the REQUEST
 * is wrong, so it is not the `400` family; the name resolved, so it is not the
 * `404`; the host CAN serve feeds, so it is not the `501` a host with no registry
 * answers. What is true is that this indexer cannot answer YET, and a caller that
 * retries after the build has a generation will be served -- which is what `503`
 * means and none of the others do.
 *
 * ## What it does NOT refuse
 *
 * A canonical generation that has folded LITTLE, or nothing at all. The question
 * here is WHICH GENERATION ANSWERS and never how far that generation has got: a
 * consumer following a feed from the start is served a short page and a cursor,
 * which is the ordinary way a stream is followed, and refusing it would mean a
 * feed could not be followed until its backfill had finished. A rebuilding
 * generation is never the one answering (the pointer moves at the END of a
 * rebuild), so a read is never served from a generation that is still being
 * built.
 *
 * It hands back all three forms of the one answer: the IDENTITY (`canonical`,
 * which is what a read resolves to a table NAMESPACE, ADR-0053), the STREAM a
 * response is keyed on and its cursor validated against, and the opaque DIGEST
 * every response advertises. They come from ONE read for that reason -- computed
 * separately, two of them could describe different generations.
 */
export async function resolveCanonicalGeneration(
	c: Context<{Bindings: Env}>,
	resolved: {entry: IndexerRegistryEntry; name: string},
	surface: string,
): Promise<{ok: true; canonical: GenerationId; stream: string; generation: string} | {ok: false; response: Response}> {
	const {entry, name} = resolved;
	// ONE read, both halves: the STREAM this response is keyed on and the FOLD it
	// advertises must come from one answer, or a response could pair one
	// generation's stream with another's fold.
	const canonical = await entry.canonicalGeneration();
	if (canonical) {
		return {ok: true, canonical, stream: canonical.stream, generation: generationDigestOf(canonical)};
	}

	// WHAT IS BEING BUILT, named so the refusal is actionable rather than merely
	// negative. Each is the same OPAQUE digest a feed response advertises, so an
	// operator matches it against the admin listing instead of taking it apart. A
	// host that cannot list them (or fails to) says so with an empty list rather
	// than turning an operational read into a `500`.
	const building = await listBuilding(entry);
	// INFO and not an error: an indexer that has not got a generation yet is a build
	// in progress rather than a fault, and this line is what an operator greps for
	// while waiting for one.
	logger.info(
		`${surface}: ${JSON.stringify(name)} holds no canonical generation, so a read was refused rather than answered ` +
			`empty (${building.length} generation(s) registered)`,
	);
	return {
		ok: false,
		response: c.json(
			{
				success: false,
				error: 'no-canonical-generation',
				indexer: name,
				building,
				message:
					`this named indexer holds no generation that answers reads yet, so there is nothing to read FROM. It is ` +
					`refused rather than answered as an empty page, because an empty page is indistinguishable from "you are ` +
					`caught up", and this indexer is being built rather than empty. Whatever generations it does hold, none ` +
					`of which has caught up, are listed as \`building\`; retry once one of them is canonical.`,
			} as const,
			503,
		),
	};
}

/** The generations this name holds, as digests, or none if it cannot say. */
async function listBuilding(entry: IndexerRegistryEntry): Promise<string[]> {
	if (!entry.generations) return [];
	try {
		return (await entry.generations()).map((record) => generationDigestOf(record));
	} catch (err) {
		logger.error(`the generations of an indexer with no canonical pointer could not be listed`, err);
		return [];
	}
}
