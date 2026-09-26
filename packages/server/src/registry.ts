import type {
	GenerationFolding,
	GenerationId,
	GenerationRecord,
	LogIngestion,
	ReclaimReport,
	ReconfigureReport,
	SlottedGenerations,
	StateMovedDetach,
	StateMovedHandler,
} from '@etherfold/core';
import type {Context} from 'hono';
import type {Bindings} from 'hono/types';
import type {RemoteSQL} from 'remote-sql';

/**
 * WHAT ONE UPLOAD DID (`POST /{indexer}/admin/upload`), in the three answers a
 * caller has to be able to tell apart.
 *
 * RE-EXPORTED rather than declared, because the upload is one ARRIVAL of two and
 * they answer ONE contract rather than two that agree on the day they were
 * written (ADR-0085): a browser tab's hot update hands its container a module
 * object and reports the same `registered` / `unchanged` / `failed`, from
 * `@etherfold/browser`. The type therefore lives in the only package both of
 * them already depend on, and its whole rationale is stated there
 * (`@etherfold/core`, `arrival.ts`) rather than half here.
 *
 * It keeps its name at this boundary because this is where a caller meets it: an
 * admin route's JSON body is what a deploy hook or a file watcher branches on.
 */
export type {ReconfigureReport} from '@etherfold/core';

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
	 * stream apart -- and since ADR-0087 the receiver at that address is the
	 * DEPLOYMENT's own writer of the stream rather than any fold over it. A
	 * processor-change successor therefore adds no entry here at all, sharing the
	 * stream it was created beside, so a SECOND entry is the filter-change case only.
	 *
	 * LIVE is derived from the registry and never from a rule about promotion: a
	 * context is live while at least one registered generation folds that stream, and
	 * stops being live when the last of them is deleted. The STREAM is not deleted
	 * with it -- a stream outlives every fold over it and goes only when an operator
	 * asks (ADR-0087) -- and a superseded generation is RETAINED under the caps, so
	 * being no longer canonical is not by itself a reason to drop out of this list.
	 *
	 * ## OPTIONAL: absent means THIS NAME ACCEPTS NO INGESTION AT ALL
	 *
	 * A CAPABILITY statement about the deployment, exactly as an absent
	 * `generations` / `promote` / `onStateMoved` is, and the ingest routes say so
	 * with a `501 ingestion-not-accepted` rather than taking a batch they would not
	 * apply. The COMBINED shape is what states it (`etherfold run`): that process
	 * fetches the chain for itself and folds through an in-process direct wire, so a
	 * remote sender pushing into it would be a second writer nobody asked for --
	 * while it holds everything the READ routes need, which is why it registers a
	 * name at all instead of the nothing it used to register.
	 *
	 * It is PER ENTRY and therefore per NAME: a host may accept ingestion for one
	 * name and refuse it for another, and each answers for itself.
	 *
	 * ## ABSENT is NOT an EMPTY list, and the two must never be conflated
	 *
	 * `[]` means "no live wire contexts RIGHT NOW" -- every generation deleted,
	 * whatever became of the streams they folded -- which is a legitimate TRANSIENT state on a host that DOES
	 * accept ingestion, and which the ingest route already answers for: a batch is
	 * refused as a foreign context (`400`, naming the empty `expected`) and the
	 * cursor question answers with an empty list. Expressing a permanent refusal as
	 * an empty list would make the two indistinguishable to a sender, and would have
	 * this host answer as though a batch might land here once something came back.
	 * The absence has to be a statement about the DEPLOYMENT rather than a value
	 * that happens to be empty.
	 */
	liveIngestions?(): Promise<readonly LogIngestion[]>;
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
	/**
	 * WHAT EACH DURABLE SLOT NAMES: the generation that answers reads, the one being
	 * built beside it, and the one a revert moves back to (ADR-0084).
	 *
	 * The half of the operator's picture `generations` alone cannot give. That list
	 * says WHAT is held; this says what each of them is FOR -- and the difference is
	 * the whole of what makes a generation reclaimable, since one no slot names is
	 * garbage by definition rather than by an operator's judgement about digests and
	 * timestamps.
	 *
	 * PAIRED with `reclaim` rather than optional on its own account: both are answered
	 * by a container over a durable registry (`ReceivingIndexer`), so an entry has both
	 * or neither, and a surface that found one without the other would be reporting
	 * what may be reclaimed on a host that cannot reclaim it. Absent is a CAPABILITY
	 * statement, exactly as an absent `generations` / `promote` is.
	 */
	slots?(): Promise<SlottedGenerations>;
	/**
	 * RECLAIM EVERY GENERATION NO SLOT NAMES, and report what came back.
	 *
	 * The operator's answer to a cap that refused, or to a disk that is full. A cap
	 * REFUSES at its bound and never evicts, which is sound and was the only
	 * instrument there was: it names what COULD be deleted and gives nothing to delete
	 * it with. This is that missing verb, and it deletes nothing a slot names -- the
	 * generation answering reads, the pending successor, and `predecessor`, which is
	 * not canonical right now and is precisely the way back from a bad upgrade.
	 *
	 * It is a VERB an operator runs and never a sweep on a timer: an automatic reclaim
	 * deletes with nobody present, which is a different decision with a different risk
	 * profile and one ADR-0084 does not make.
	 *
	 * OPTIONAL and paired with `slots` (see above). It is deliberately not paired with
	 * `promote`: a pointer move is REVERSIBLE and this DELETES state, so a host may
	 * one day answer one and not the other, and the two refusals say different things.
	 */
	reclaim?(): Promise<ReclaimReport>;
	/**
	 * WHETHER EACH GENERATION CAN FOLD ON THIS DEPLOYMENT: `held` (this process folds it),
	 * `instantiable` (from the bundle stored on its row, the moment it has to fold) or
	 * `frozen` with the reason (ADR-0092, `GenerationFolding`).
	 *
	 * The question an operator has to answer BEFORE a revert, which `generations` and
	 * `slots` cannot: two generations that answer reads identically may be one that
	 * resumes and one that never advances again. It is also where a canonical generation
	 * that stalled because its stored code could not be built SAYS so, rather than a
	 * deployment that merely stops advancing.
	 *
	 * OPTIONAL, and on its own account: it is a fact about the PROCESS answering (what it
	 * folds and what it can instantiate), not about the registry, so a host may answer
	 * the other questions without it. Absent, the admin listing simply carries no such
	 * field, exactly as it carries no `slot` where `slots` is absent.
	 */
	folding?(): Promise<readonly GenerationFolding[]>;
	/**
	 * RECEIVE A PROCESSOR BUNDLE'S BYTES and register the generation they name,
	 * BESIDE the incumbent -- the upload arrival (`POST /{indexer}/admin/upload`,
	 * ADR-0085's amendment of 2026-09-22).
	 *
	 * The ONE way code reaches a running Node process (ADR-0094): a module OBJECT
	 * cannot cross HTTP, and a self-contained bundle's BYTES can (ADR-0085). What the
	 * route hands over is exactly the octets it read, within its bound and under its
	 * content type; everything else is the host's.
	 *
	 * The HOST computes the identity from those bytes (ADR-0086) -- nothing the
	 * sender says about identity is read, and this seam carries nothing it could say
	 * it with. It must REFUSE BEFORE REGISTERING (self-containment, evaluation, the
	 * processor it carries), failing before anything is registered rather than
	 * unwinding afterwards and saying so through `ReconfigureReport` rather than by
	 * throwing; register BESIDE and never restart or re-open, since the incumbent
	 * answering every read throughout is the property the affordance exists to
	 * preserve; register through the same path every registration of this deployment
	 * takes so the bytes are stored on the generation's row (ADR-0092); and answer the
	 * shared three-outcome report with `arrival: 'upload'`.
	 *
	 * OPTIONAL, and on its own: this package names no runtime and cannot turn bytes
	 * into a fold, so it is answered by a host that can (`etherfold node`, ADR-0094). Absent is a
	 * CAPABILITY statement and the admin surface answers it with a `501`.
	 */
	upload?(bundle: Uint8Array): Promise<ReconfigureReport>;
	/**
	 * BE TOLD THE STATE MOVED, for this name: the state-moved SIGNAL the fold that
	 * answers reads publishes as it applies each block (ADR-0083). Returns the detach.
	 *
	 * This package APPLIES NO BLOCKS -- an ingest route delegates to a receiver the
	 * host constructed -- so the signal is produced in `@etherfold/core`
	 * (`ReceivingIndexer.onStateMoved`) and what an entry adds is the way to REACH it
	 * from a route, which is the only handle a route has on a name. A transport that
	 * pushes it to a client (SSE, a socket) attaches here; the publication needs no
	 * change to acquire one, which is what ADR-0083 means by the producer being
	 * transport-agnostic.
	 *
	 * OPTIONAL, and paired with nothing: `generations` and `promote` are absent
	 * together because a host with no registry has neither, while this is absent on a
	 * host that holds a bare receiver and no container (`singleContextEntry`), which
	 * has no publisher at all. Absent is a CAPABILITY statement, exactly as it is for
	 * those two, and a surface built over it says so rather than going quiet -- which
	 * matters most on Cloudflare Workers, where an ingest invocation cannot write into
	 * a stream opened by another request and the host must REFUSE rather than appear
	 * to work.
	 *
	 * Best-effort and nothing held per subscriber, which is the producer's own
	 * property and is not softened by being reached through here: a client that missed
	 * a notification is repaired by the next one plus the coherence token.
	 */
	onStateMoved?(handler: StateMovedHandler): StateMovedDetach;
	/**
	 * THE COHERENCE TOKEN THAT FOLD IS PUBLISHING UNDER RIGHT NOW
	 * (`ReceivingIndexer.coherenceNow`), read without waiting for a notification.
	 *
	 * PAIRED with `onStateMoved` rather than optional on its own account: both come
	 * from the one publisher a CONTAINER holds, so an entry has both (`indexerEntryOn`)
	 * or neither (`singleContextEntry`), and a transport that finds one without the
	 * other refuses rather than serving half the answer.
	 *
	 * It is what lets a stream tell a client AT CONNECT whether what that client
	 * already holds may be stale, which is how a REMOTE reader converges: it has no
	 * store to re-read and no state query surface yet, so ADR-0083 gives it the
	 * current position and token on connect instead of a re-query. Compared and never
	 * parsed, exactly as on a notification.
	 */
	coherenceNow?(): string;
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
	if (!ingestion.generation) {
		// REFUSED rather than answered `undefined`. This entry's whole claim is that the
		// generation which answers reads is the one THIS receiver folds, and a receiver
		// with no fold behind it -- the STREAM WRITER a generation container holds at a
		// stream's address (ADR-0087) -- cannot say that. Such a host has generations, so
		// it registers through `indexerEntryOn` and the CONTAINER answers the pointer.
		throw new Error(
			`this receiver names no generation, so it cannot be registered as a single-context entry: the entry's ` +
				`canonical generation IS the fold behind the receiver, and there is none. A host holding a GENERATION ` +
				`CONTAINER registers it with \`indexerEntryOn\` instead, which asks the container.`,
		);
	}
	return {
		db,
		liveIngestions: async () => live,
		// DERIVED on the call and never captured: `generation` resolves the fold half
		// at the moment it is asked. An ARRIVAL-supplied identity is a constant
		// (ADR-0086), but the declared fallback still under it is not -- it covers the
		// processor's config, and `configure()` can move it -- so reading it late is what
		// keeps both answers honest.
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
 * unbind them. The OPTIONAL ones are forwarded only where what was handed over
 * answers them, so an entry never claims a capability its holder lacks -- and
 * `liveIngestions` is one of them, so a host registering a container that accepts
 * no pushes hands over what it wants answered WITHOUT that question and gets an
 * entry that refuses ingestion (see the field).
 */
export function indexerEntryOn(db: RemoteSQL, holds: Omit<IndexerRegistryEntry, 'db'>): IndexerRegistryEntry {
	return {
		db,
		...(holds.liveIngestions
			? {liveIngestions: () => (holds.liveIngestions as () => Promise<readonly LogIngestion[]>)()}
			: {}),
		canonicalGeneration: () => holds.canonicalGeneration(),
		...(holds.generations
			? {generations: () => (holds.generations as () => Promise<readonly GenerationRecord[]>)()}
			: {}),
		...(holds.promote
			? {promote: (id: GenerationId) => (holds.promote as (id: GenerationId) => Promise<GenerationRecord>)(id)}
			: {}),
		...(holds.slots ? {slots: () => (holds.slots as () => Promise<SlottedGenerations>)()} : {}),
		...(holds.reclaim ? {reclaim: () => (holds.reclaim as () => Promise<ReclaimReport>)()} : {}),
		...(holds.folding ? {folding: () => (holds.folding as () => Promise<readonly GenerationFolding[]>)()} : {}),
		...(holds.upload
			? {upload: (bundle: Uint8Array) => (holds.upload as (bundle: Uint8Array) => Promise<ReconfigureReport>)(bundle)}
			: {}),
		...(holds.onStateMoved
			? {
					onStateMoved: (handler: StateMovedHandler) =>
						(holds.onStateMoved as (handler: StateMovedHandler) => StateMovedDetach)(handler),
				}
			: {}),
		...(holds.coherenceNow ? {coherenceNow: () => (holds.coherenceNow as () => string)()} : {}),
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
