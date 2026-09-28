import {
	createReadSurface,
	declaredRow,
	type CollectionsOf,
	normalizeEntity,
	type EntityReads,
	type EntityRow,
	type NormalizedEntity,
} from '@etherfold/state-store';
import type {BlockAddress} from './blocks.js';
import type {QueryOptions, VersionedStateStore} from './store.js';
import type {EntityDeclaration} from './types.js';

/**
 * ## The SERVER-side tier of the generated read surface
 *
 * The same entity declarations, the same typed rows, plus the two reads only a
 * backend with a query planner underneath it can honestly offer: a whole entity
 * at the tip or as of a block, with a caller-supplied predicate, ordering and
 * page.
 *
 * ```ts
 * const surface = createQuerySurface(store, entities);
 *
 * await surface.token.getCurrent({id: '1'});                        // the bounded tier, on every backend
 * await surface.token.queryCurrent({where: 'owner = ?', args: [a]}); // this tier, here only
 * ```
 *
 * ## Why the two tiers differ, where a reader meets them
 *
 * `createReadSurface` (`@etherfold/state-store`) is bounded BY CONSTRUCTION: a
 * prefix of the declared id plus a required limit, no predicate, no ordering, no
 * offset. That is not caution, it is placement. Those reads are the ones a
 * HANDLER is held to, and a handler runs once per event on every backend
 * including the ones with no query planner, so the seam gets the one shape that
 * is an indexed range scan everywhere (ADR-0021) and an accidental full scan is
 * impossible to express.
 *
 * A server-side reader has none of that constraint: SQLite is underneath it, it
 * runs per REQUEST rather than per event, and refusing it a `WHERE` would just
 * move the query somewhere with less information. So this tier takes predicates,
 * and takes them as caller-supplied SQL (`QueryOptions`), which is why its
 * values must travel through `args` and never through interpolation.
 *
 * What both tiers share is the SCHEMA SOURCE. Rows are projected to the declared
 * columns and typed off the same declarations, so renaming a field breaks a
 * `queryCurrent` consumer exactly as it breaks a `getCurrent` one. The predicate
 * text is the one part no type can check, because it is SQL.
 */

/** One declared entity's reads: the four at the seam, plus this backend's two. */
export type EntityQueries<E extends EntityDeclaration> = EntityReads<VersionedStateStore, E> & {
	/** A whole entity table at the tip, filtered, ordered and paged by the caller. */
	queryCurrent(options?: QueryOptions): Promise<EntityRow<E>[]>;
	/**
	 * A whole entity table as of a block hash, a height, or a timestamp.
	 *
	 * An empty array means the block is known and nothing matched. An address
	 * that identifies no block throws `NoSuchBlockError`, and a block outside
	 * what this store retains throws `BlockNotRetainedError`: this surface
	 * propagates both rather than folding them into an empty result.
	 */
	queryAsOf(at: BlockAddress, options?: QueryOptions): Promise<EntityRow<E>[]>;
};

/**
 * The declared entities, each with both tiers, keyed by the declared name, and a
 * parent with a collection per declared child beside them (ADR-0098), exactly as
 * `createReadSurface` types it, since that is where the collection comes from.
 */
export type QuerySurface<D extends readonly EntityDeclaration[]> = {
	readonly [E in D[number] as E['name']]: EntityQueries<E> & CollectionsOf<VersionedStateStore, D, E>;
};

/**
 * Generate both tiers of the read surface for a set of declarations over this
 * store.
 *
 * The bounded tier is not re-implemented here: it is `createReadSurface`, so a
 * consumer that moves a read from a server to a browser backend moves it
 * unchanged, and the seam has one implementation rather than one per backend.
 * The declarations are checked against the store's own by that call, so a
 * surface generated from a stale copy throws here rather than projecting a
 * column the store does not have to `null`.
 */
export function createQuerySurface<const D extends readonly EntityDeclaration[]>(
	store: VersionedStateStore,
	declarations: D,
): QuerySurface<D> {
	const bounded = createReadSurface(store, declarations) as unknown as Record<
		string,
		EntityReads<VersionedStateStore, EntityDeclaration>
	>;
	const surface: Record<string, EntityQueries<EntityDeclaration>> = {};
	for (const declaration of declarations) {
		const entity: NormalizedEntity = normalizeEntity(declaration);
		// the spread carries a parent's relation collections too; none can be
		// overwritten below, because `queryCurrent` and `queryAsOf` are reserved
		// read-surface names no `as` may take (`normalizeEntities`)
		surface[entity.name] = {
			...bounded[entity.name],
			queryCurrent: async (options) => project(entity, await store.queryCurrent(entity.name, options)),
			queryAsOf: async (at, options) => project(entity, await store.queryAsOf(entity.name, at, options)),
		};
	}
	return surface as QuerySurface<D>;
}

/**
 * Every row as the declaration describes it, projected exactly as the bounded
 * tier projects one.
 *
 * A `SELECT *` carries `_lower` and `_upper` beside the declared columns, and
 * they are storage rather than state: handing them back would give a consumer
 * something the declaration does not describe, and something that must not
 * travel back into a write.
 */
function project<T>(entity: NormalizedEntity, rows: Record<string, unknown>[]): T[] {
	return rows.map((row) => declaredRow(entity, row) as T);
}
