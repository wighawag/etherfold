import {
	assertDeclaredBy,
	normalizeEntity,
	type EntityDeclaration,
	type EntityId,
	type EntityIdPrefix,
	type Listing,
	type NormalizedEntity,
	type ReadSurface,
	type StateStore,
} from '@etherfold/state-store';
import type {PortRow} from './envelope.js';

/**
 * THE STORE'S READ SEAM, PROXIED ACROSS A PORT (ADR-0082).
 *
 * The host holds the store opened for WRITING and a tab holds a port, so the
 * four reads a consumer actually renders from have to cross. They are already
 * async on every backend, which is why this is a proxy rather than a design: a
 * call goes out as a CASE on the envelope, the host serves it from the store its
 * canonical generation folds into, and the rows come back projected by the SAME
 * `declaredRow` a same-thread read projects with.
 *
 * ## What it buys, and why it survives the query surface
 *
 * An app that reads three entities by id gets TYPED rows -- typed off the
 * declarations it already wrote -- with no query language loaded at all. That is
 * the whole reason this surface exists beside the executor
 * `the-same-query-runs-against-a-worker-and-a-server` puts on this same port: a
 * GraphQL runtime is tens of kilobytes on the first-paint path for an app whose
 * reads are `getCurrent`.
 *
 * ## What it does NOT grow
 *
 * Four reads, and there will not be a fifth. The seam has no predicate, no
 * caller-supplied ordering and no offset, because a handler runs once per event
 * on a substrate with no query planner and a key-prefix range with a limit is
 * the one shape that is an indexed range scan everywhere (ADR-0021). Richer
 * queries arrive as an EXECUTOR on this port, with its own serialisation,
 * because that surface has an HTTP twin to stay parity with. This one has none,
 * so it uses structured clone honestly.
 */

/**
 * THE FOUR READS AS THE WIRE SPEAKS THEM: an entity NAME and untyped rows.
 *
 * The counterpart of `EntityStateView` (`@etherfold/processor-entities`), which
 * is the same four reads over a store on this thread -- and, like it, the thing a
 * TYPED surface is generated over rather than the thing an app should hold.
 * `createPortReadSurface` is what turns an app's declarations into named entities
 * and typed rows; this is what it calls.
 *
 * It carries no `capabilities` getter, and that absence is deliberate rather
 * than pending: what a store reports about itself is synchronous on this thread
 * and a round trip across a port, so it is a surface with its own shape rather
 * than a field to smuggle onto this one.
 */
export type PortStateReads = {
	/** What the host's store was BUILT WITH, so a surface can be checked against it. */
	declarations(): Promise<readonly NormalizedEntity[]>;
	/** One entity at the tip, or `undefined` if it is absent. */
	getCurrent(entity: string, id: EntityId): Promise<PortRow | undefined>;
	/** One entity as of a block NUMBER. Refused, never answered from the tip, outside retention. */
	getAsOf(entity: string, id: EntityId, at: number): Promise<PortRow | undefined>;
	/** The rows of an id PREFIX at the tip, ascending, bounded by a REQUIRED limit. */
	listCurrent(entity: string, prefix: EntityIdPrefix, limit: number): Promise<Listing<PortRow>>;
	/** The same listing as of a block NUMBER. */
	listAsOf(entity: string, prefix: EntityIdPrefix, at: number, limit: number): Promise<Listing<PortRow>>;
};

/**
 * What this module needs of a port: the untyped reads, and nothing else.
 *
 * Declared here rather than taking the whole `IndexerPort` so that the direction
 * of the dependency is the honest one -- a surface is generated OVER the reads a
 * port offers -- and so a test can generate one over a hand-written pair of
 * reads without building a host.
 */
export type PortWithReads = {readonly reads: PortStateReads};

/**
 * GENERATE THE READ SURFACE OF A SET OF DECLARATIONS OVER A PORT.
 *
 * The port-side twin of `createReadSurface`, with the same call shape, the same
 * result TYPE and the same four reads per entity:
 *
 * ```ts
 * const indexer = connectToIndexerHost(dedicatedWorkerHost(worker));
 * const reads = createPortReadSurface(indexer, myProcessor.entities);
 *
 * const token = await reads.token.getCurrent({id: '1'}); // {id: string; owner: string | null}
 * ```
 *
 * The as-of address is a block NUMBER, which is what the seam takes: addressing
 * by hash or by time is a read layer a BACKEND adds above the seam, and a host
 * that has one is not reachable from here -- a port speaks the seam, so the
 * surface a tab holds is the seam's.
 *
 * ## The declarations are CHECKED against the host, on the first read
 *
 * `createReadSurface` compares its declarations with the store's at CONSTRUCTION
 * and refuses a disagreement naming both, because a surface generated from a
 * stale copy types its rows off columns the store does not have and projects
 * them to `null` -- a plausible wrong answer. That question cannot be asked
 * synchronously across a port, so it is asked ONCE, as soon as this is called,
 * and every read awaits the answer: the refusal lands on the first read instead
 * of on the constructor, in the same words, by the same rule
 * (`assertDeclaredBy`). It is not re-asked afterwards; a host's declarations do
 * not change under a tab, because both ends come out of one build.
 */
export function createPortReadSurface<const D extends readonly EntityDeclaration[]>(
	port: PortWithReads,
	declarations: D,
): ReadSurface<StateStore, D> {
	const entities = [...declarations].map(normalizeEntity);

	/**
	 * Asked once, on construction, so the round trip is in flight while the app
	 * is still wiring itself up rather than on the first thing a user waits for.
	 */
	const agreed = port.reads.declarations().then((hosted) => {
		const byName = new Map(hosted.map((entity) => [entity.name, entity]));
		for (const entity of entities) {
			assertDeclaredBy(byName, entity);
		}
	});
	// An app may hold a surface it never reads from, and a rejection nobody is
	// waiting for is a warning in every runtime this ships to. The rejection is
	// still delivered to every read below, which is where a caller can act on it.
	agreed.catch(() => undefined);

	const surface: Record<string, unknown> = {};
	for (const entity of entities) {
		surface[entity.name] = {
			getCurrent: async (id: EntityId) => {
				await agreed;
				return port.reads.getCurrent(entity.name, id);
			},
			getAsOf: async (id: EntityId, at: number) => {
				await agreed;
				return port.reads.getAsOf(entity.name, id, at);
			},
			listCurrent: async (prefix: EntityIdPrefix, limit: number) => {
				await agreed;
				return port.reads.listCurrent(entity.name, prefix, limit);
			},
			listAsOf: async (prefix: EntityIdPrefix, at: number, limit: number) => {
				await agreed;
				return port.reads.listAsOf(entity.name, prefix, at, limit);
			},
		};
	}
	return surface as ReadSurface<StateStore, D>;
}
