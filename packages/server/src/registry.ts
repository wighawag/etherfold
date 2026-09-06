import type {GenerationId, LogIngestion} from '@etherfold/core';
import type {Context} from 'hono';
import type {Bindings} from 'hono/types';

/**
 * ONE named indexer this host was built with, as the routes see it.
 *
 * A NAMED INDEXER is the server's multi-tenancy unit: one indexed answer set
 * over one chain, fully isolated from every other (ADR-0036). The name arrives
 * at DEPLOY time -- an operator supplies it and a host registers the N it was
 * built with -- so nothing here loads code, resolves a module or invents a name
 * for a caller that gave none.
 *
 * ## ONE ENTRY, SEVERAL LIVE WIRE CONTEXTS
 *
 * This is the widening the entry OBJECT existed for. An entry used to be one
 * `LogIngestion`, so a filter or config change -- which is a NEW STREAM, and
 * therefore a new `{source, config}` on the wire -- could not be fed at all: the
 * single receiver refused the successor's batches with the `400` that is
 * deliberately not resumable, and the successor starved while the incumbent went
 * on being fed. Now the ROUTE SEGMENT selects the INDEXER and the batch's own
 * `{source, config}` selects WHICH receiver inside it, so both are fed and
 * neither advances the other's cursor.
 *
 * The refusal families are untouched by that. A context in NEITHER receiver is
 * still a `400`, a wrong `fromBlock` is still the one resumable `409`, a name
 * this host was not built with is still a `404` and a host with no registry at
 * all is still a `501`.
 *
 * The NAME is deliberately NOT a field on the entry. The route segment is the one
 * source of that value, and a second copy an entry could disagree with is a
 * discriminator a write path might key on wrongly.
 *
 * ## Both questions are ASKED rather than READ, and that is what makes the live
 * set derivable
 *
 * They are methods, not fields, because the honest answer to either can only be
 * had from the generation registry, which is durable and shared: a generation
 * DELETED by another process (or by an operator making room at a cap) stops being
 * live without this host being told, and the canonical pointer MOVES the same
 * way. A record of receivers captured when the host booted could express neither,
 * and would go on feeding a fold whose state has been dropped.
 *
 * `ReceivingIndexer` (`@etherfold/core`) implements exactly these two, so a host
 * holding one registers it as the entry itself.
 */
export type IndexerRegistryEntry = {
	/**
	 * The receivers this name holds RIGHT NOW: one per LIVE WIRE CONTEXT.
	 *
	 * At most one per stream, because a stream IS an address on the wire: a batch
	 * carries `{source, config}` and nothing that could tell two folds over one
	 * stream apart. A processor-change successor therefore has no receiver here at
	 * all -- it re-folds the stream the writer stores (ADR-0044) -- and this list is
	 * the filter-change case only.
	 *
	 * LIVE is derived from the registry and never from a rule about promotion: a
	 * context is live while its generation is registered, and stops being live when
	 * that generation is deleted (and its stream reaped with it, if it was the last
	 * on it). A superseded generation is RETAINED under the caps, so being no longer
	 * canonical is not by itself a reason to drop out of this list.
	 */
	liveIngestions(): Promise<readonly LogIngestion[]>;
	/**
	 * WHICH GENERATION ANSWERS READS: the canonical one, both halves in ONE read.
	 *
	 * The feed keys its read on the STREAM and advertises the FOLD, and it must not
	 * pair one with the other's neighbour, which is why this is one call rather
	 * than two fields to read one after the other.
	 */
	canonicalGeneration(): Promise<GenerationId>;
};

/**
 * How a host resolves ONE name into the entry it registered under it.
 *
 * A FUNCTION rather than a record, per REQUEST, for the same reason `getDB` is
 * one: on Cloudflare the bindings arrive on the request's `env` and there is no
 * app-construction moment at which they exist.
 *
 * It is SYNCHRONOUS, and the entry's own two questions are the asynchronous
 * half: resolving a NAME is a lookup in what this host was built with, while
 * resolving what that name currently HOLDS is a read of durable state. Keeping
 * them apart is what lets the `404` for an unknown name be answered without
 * touching a database.
 *
 * `undefined` means "this host was not built with that name", which the routes
 * REFUSE rather than default: a batch that reached the wrong tenant silently is
 * the failure this whole discriminator exists to make impossible.
 */
export type IndexerResolver<Env extends Bindings = Bindings> = (
	c: Context<{Bindings: Env}>,
	name: string,
) => IndexerRegistryEntry | undefined;

/**
 * The entry for a host holding ONE receiver under a name, with no generations
 * behind it.
 *
 * Every host that is not built on a generation container is this: the Worker
 * host, a test, `etherfold index` today. Its one live wire context is the
 * receiver's own, and the generation that answers reads is the one that receiver
 * folds -- which is exactly what the feed advertised before an entry could hold
 * more than one, so nothing about such a deployment changes.
 */
export function singleContextEntry(ingestion: LogIngestion): IndexerRegistryEntry {
	const live = [ingestion] as const;
	return {
		liveIngestions: async () => live,
		// DERIVED on the call and never captured: `generation` reads the processor's
		// version hash at the moment it is asked, and `configure()` can move it
		canonicalGeneration: async () => ingestion.generation,
	};
}

/**
 * The registry a host that knows all its named indexers up front can pass
 * straight to `createServer`.
 *
 * Sugar over the resolver and nothing more: a host whose set of names depends on
 * the request (a Worker reading a binding) writes its own function instead, and
 * one holding a generation container passes that container as the entry. The
 * lookup is an OWN-PROPERTY read, so a name like `constructor` or `toString`
 * resolves to nothing rather than to something off `Object.prototype`.
 */
export function indexerRegistry<Env extends Bindings = Bindings>(
	indexers: Readonly<Record<string, LogIngestion>>,
): IndexerResolver<Env> {
	return (_c, name) =>
		Object.prototype.hasOwnProperty.call(indexers, name)
			? singleContextEntry(indexers[name] as LogIngestion)
			: undefined;
}
