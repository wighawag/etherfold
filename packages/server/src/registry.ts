import type {GenerationId, GenerationRecord, LogIngestion} from '@etherfold/core';
import type {Context} from 'hono';
import type {Bindings} from 'hono/types';
import type {RemoteSQL} from 'remote-sql';

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
 * ## ONE ENTRY, ONE DATABASE
 *
 * A NAMED INDEXER **is** a database (ADR-0053), so which database this name's
 * rows live in is part of what the name resolves to, and not a handle the whole
 * host shares. `getDB` answers per REQUEST and knows no name, which is exactly
 * right for the host-level surfaces (`/status`, `/admin/setup`, which report on
 * the deployment rather than on a tenant) and wrong for anything keyed on one --
 * so every route that acts on ONE named indexer reads through the handle THAT
 * NAME owns and never through the host's.
 *
 * `ReceivingIndexer` (`@etherfold/core`) answers the two QUESTIONS below and
 * cannot carry this: that package knows no database, and its state is a type
 * parameter precisely so it does not. `indexerEntryOn` is the one line that
 * pairs a container with the handle its host opened for it.
 */
export type IndexerRegistryEntry = {
	/**
	 * THE DATABASE THIS NAME OWNS: where its stored stream, its coverage claims,
	 * its generation registry, its canonical pointer and its counters live.
	 *
	 * REQUIRED, and that is the isolation being STRUCTURAL rather than remembered:
	 * a host registering a second named indexer cannot leave this out and silently
	 * inherit the first one's rows, because there is nothing to leave out. The two
	 * levels ADR-0053 decides meet here -- a generation is a table NAMESPACE inside
	 * one of these, and a named indexer is the DATABASE -- which is what makes
	 * deleting a named indexer a complete, cheap operation with no filter for a
	 * later read to forget.
	 *
	 * Two names MAY be given one handle (`_emissions.indexer` and the registry's own
	 * name column keep them apart, which is why those columns are kept even though
	 * they are redundant on every shape this repo builds today). That is
	 * COLOCATION, it is what a future serverless deployment would need in one D1
	 * database, and it is a host's decision to make explicitly rather than one this
	 * type makes for it by defaulting.
	 *
	 * A FIELD rather than a question, unlike the two below: a host already holds
	 * this handle when it resolves the name, exactly as it holds the one `getDB`
	 * returns, and on Cloudflare a per-request resolver reads it off the request's
	 * `env` -- so N static bindings express the N named indexers a host was built
	 * with (ADR-0053), while what a name currently HOLDS is durable state that has
	 * to be read.
	 */
	db: RemoteSQL;
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
	 *
	 * `undefined` is a real answer and not an error: NO GENERATION ANSWERS READS
	 * HERE YET. A host holding a fold always has one (the first generation
	 * registered takes the pointer), but a READ TIER resolves the pointer from the
	 * durable rows of a database somebody else is writing, and a first build has not
	 * necessarily got as far as registering anything. Every read that resolves this
	 * REFUSES on that answer rather than serving the empty page it would otherwise
	 * produce (`resolveCanonicalGeneration`, ADR-0015): "nothing here yet" and "this
	 * is still being built" must not arrive in the same shape.
	 */
	canonicalGeneration(): Promise<GenerationId | undefined>;
	/**
	 * EVERY generation this name holds, oldest first -- what there is to point AT.
	 *
	 * OPTIONAL, because a host that holds ONE fold and no registry has no such list
	 * to give (`singleContextEntry`), and inventing one from the single generation it
	 * folds would answer "here is what you may revert to" with the one generation a
	 * revert cannot mean. Absent is a CAPABILITY statement and the admin surface says
	 * so with a `501`, exactly as the ingest routes do for a host with no registry at
	 * all.
	 *
	 * It is what makes the pointer move USABLE rather than a guess: a feed response
	 * advertises its generation as an OPAQUE digest (compared, never parsed), so an
	 * operator matches that value against this listing instead of taking it apart.
	 */
	generations?(): Promise<readonly GenerationRecord[]>;
	/**
	 * MOVE THE CANONICAL POINTER to one of them: forwards it promotes, BACKWARDS it
	 * reverts, and it is the same one small write either way.
	 *
	 * OPTIONAL for the same reason `generations` is, and paired with it: a host with
	 * no registry has no pointer to move. `ReceivingIndexer` (`@etherfold/core`)
	 * answers both, so a host that holds one registers the container itself and adds
	 * only the database (`indexerEntryOn`).
	 *
	 * It REFUSES a generation this name does not hold (`UnknownGenerationError`) and
	 * deliberately does not require the host to hold a FOLD for the target: reads on
	 * this runtime resolve the pointer to a table NAMESPACE (ADR-0053), so the
	 * generation an operator reverts to answers with no engine at all -- which is the
	 * ordinary case on a host redeployed with the new processor alone.
	 */
	promote?(id: GenerationId): Promise<GenerationRecord>;
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
 *
 * The DATABASE is the one that receiver folds INTO, and saying so is the whole
 * of what a single-name host has to get right: `run` and `index` hold one handle
 * that the store, the emission appender and the server all share, so they pass
 * that one. A host that passed a different handle here than the one its fold
 * writes would be serving a feed over a database nothing appends to.
 */
export function singleContextEntry(db: RemoteSQL, ingestion: LogIngestion): IndexerRegistryEntry {
	const live = [ingestion] as const;
	return {
		db,
		liveIngestions: async () => live,
		// DERIVED on the call and never captured: `generation` reads the processor's
		// version hash at the moment it is asked, and `configure()` can move it
		canonicalGeneration: async () => ingestion.generation,
	};
}

/**
 * The entry for a name whose CONTENTS already answer the entry's two questions,
 * over the DATABASE that name owns.
 *
 * The one line a host holding a `ReceivingIndexer` (`@etherfold/core`) writes:
 * that container answers `liveIngestions` and `canonicalGeneration` itself, and
 * it deliberately knows no database, so what a host adds here is the handle it
 * opened for this name and nothing else.
 *
 * The questions are FORWARDED rather than spread, because they are methods on an
 * object that reads its own state: copying them off a class instance would
 * unbind them. The two OPTIONAL ones are forwarded only where what was handed
 * over answers them, so an entry never claims a capability its holder lacks.
 */
export function indexerEntryOn(db: RemoteSQL, holds: Omit<IndexerRegistryEntry, 'db'>): IndexerRegistryEntry {
	return {
		db,
		liveIngestions: () => holds.liveIngestions(),
		canonicalGeneration: () => holds.canonicalGeneration(),
		...(holds.generations
			? {generations: () => (holds.generations as () => Promise<readonly GenerationRecord[]>)()}
			: {}),
		...(holds.promote
			? {promote: (id: GenerationId) => (holds.promote as (id: GenerationId) => Promise<GenerationRecord>)(id)}
			: {}),
	};
}

/**
 * The registry a host that knows all its named indexers up front can pass
 * straight to `createServer`.
 *
 * Sugar over the resolver and nothing more: a host whose set of names depends on
 * the request (a Worker reading a binding) writes its own function instead. The
 * lookup is an OWN-PROPERTY read, so a name like `constructor` or `toString`
 * resolves to nothing rather than to something off `Object.prototype`.
 *
 * It takes ENTRIES rather than receivers, because a name resolves to what it
 * holds AND to the database it holds it in: `singleContextEntry(db, ingestion)`
 * builds one for a host with one receiver per name, `indexerEntryOn(db,
 * container)` for one holding generations, and a host colocating two names in one
 * database passes the same handle twice -- deliberately, where it can be read.
 */
export function indexerRegistry<Env extends Bindings = Bindings>(
	indexers: Readonly<Record<string, IndexerRegistryEntry>>,
): IndexerResolver<Env> {
	return (_c, name) =>
		Object.prototype.hasOwnProperty.call(indexers, name) ? (indexers[name] as IndexerRegistryEntry) : undefined;
}
