import type {EntityIdOf, EntityPrefixOf, EntityRow} from './declarations.js';
import {normalizeEntity} from './entities.js';
import {UnknownEntityError} from './errors.js';
import type {Listing} from './listing.js';
import type {StateStore} from './store.js';
import type {EntityDeclaration, NormalizedEntity} from './types.js';

/**
 * ## The read surface, generated from the entity declarations
 *
 * A consumer reads state by naming an ENTITY and its DECLARED columns:
 *
 * ```ts
 * const entities = declareEntities([{name: 'token', id: 'id', fields: {owner: 'text'}}]);
 * const surface = createReadSurface(store, entities);
 *
 * const token = await surface.token.getCurrent({id: '1'}); // {id: string; owner: string | null} | undefined
 * ```
 *
 * There is no table name and no column string anywhere in that, which is the
 * point: the declaration that drives the storage is the same object that types
 * the read, so a consumer never writes -- and never maintains -- a second
 * description of the data. Rename `owner` in the declaration and the line above
 * stops COMPILING, instead of returning `undefined` in production.
 *
 * ## Why this tier is bounded, and where the unbounded one lives
 *
 * These are the seam's four reads and no more: by id at the tip, by id as of a
 * block, and the bounded listing (a PREFIX of the declared id plus a REQUIRED
 * limit) in both flavours. No predicate, no caller-supplied ordering, no offset.
 *
 * The asymmetry is deliberate and it is about WHERE THE CALLER RUNS. This tier
 * is the one a handler is held to, and a handler runs once per event on every
 * backend, including the ones with no query planner, so it gets the one shape
 * that is an indexed range scan everywhere (ADR-0021). A SERVER-side reader has
 * a planner underneath it and no per-event budget, so it may take predicates:
 * that is `createQuerySurface` in `@etherfold/state-store-sqlite`, which adds
 * `queryCurrent` / `queryAsOf` to exactly these four and types their rows off
 * the same declarations. Two tiers, one schema source.
 *
 * ## Errors stay errors
 *
 * Nothing here catches anything. A block address that resolves to no block
 * throws `NoSuchBlockError` (ADR-0015), a historical read outside a backend's
 * retention throws `BlockNotRetainedError` (ADR-0019), and both travel out of
 * this surface untouched. `undefined` keeps its one meaning: the block is known
 * and the entity was absent from it.
 *
 * ## What a GraphQL layer would do with this
 *
 * Nothing in here ships GraphQL, and nothing in here has to change for it to be
 * added. The decided stack (Hono, then Yoga, then Pothos, built
 * programmatically, no SDL and no deploy-time codegen) builds its object types
 * by walking the SAME `declareEntities` array -- a field per declared column,
 * `FieldValue` giving the scalar -- and resolves each one through the surface
 * below: `getCurrent` for a node, `listCurrent` for a `@derivedFrom`-style
 * child collection, `getAsOf` / `listAsOf` for a block argument. It is an
 * ADDITION over this surface rather than a refactor of it, which is the property
 * this task exists to guarantee.
 */

/**
 * The block address this surface's as-of reads take: whatever ITS STORE takes.
 *
 * The seam's `getAsOf` takes a resolved block NUMBER, so a surface over a plain
 * `StateStore` takes a number. Addressing by hash or by time is a read layer a
 * BACKEND adds above the seam (`@etherfold/state-store-sqlite` accepts
 * `{hash}` / `{timestamp}` / a height, ADR-0015), and a surface over that store
 * accepts all three, because this type reads the parameter off the store it was
 * handed.
 *
 * So a hash passed to a store that cannot resolve one is a COMPILE error rather
 * than a run-time surprise, and no capability has to be re-declared here to say
 * so: the store's own signature already says it.
 */
export type AsOfAddress<S extends StateStore> = Parameters<S['getAsOf']>[2];

/** The four seam reads of ONE declared entity, typed off its declaration. */
export type EntityReads<S extends StateStore, E extends EntityDeclaration> = {
	/** The entity at the tip, or `undefined` if it is absent. */
	getCurrent(id: EntityIdOf<E>): Promise<EntityRow<E> | undefined>;
	/**
	 * The entity as of a block, or `undefined` if it was absent then.
	 *
	 * Throws rather than answering when the address resolves to no block, or when
	 * the store does not retain that far back: see the module note.
	 */
	getAsOf(id: EntityIdOf<E>, at: AsOfAddress<S>): Promise<EntityRow<E> | undefined>;
	/**
	 * The children of a prefix of the declared id at the tip, ascending in the
	 * id's own order, at most `limit` of them, with `truncated` saying whether
	 * more matched.
	 */
	listCurrent(prefix: EntityPrefixOf<E>, limit: number): Promise<Listing<EntityRow<E>>>;
	/** The same listing as of a block. Refused, never answered from the tip, outside retention. */
	listAsOf(prefix: EntityPrefixOf<E>, at: AsOfAddress<S>, limit: number): Promise<Listing<EntityRow<E>>>;
};

/** The declared entities, each with its four reads, keyed by the declared name. */
export type ReadSurface<S extends StateStore, D extends readonly EntityDeclaration[]> = {
	readonly [E in D[number] as E['name']]: EntityReads<S, E>;
};

/**
 * Generate the read surface of a set of declarations over a store.
 *
 * The declarations are passed rather than read off `store.declarations` because
 * a `ReadonlyMap<string, NormalizedEntity>` has no literal types to derive from,
 * so it can produce a read but not a TYPED one. That redundancy is then CHECKED
 * rather than trusted: every declaration is compared with the one the store was
 * built with, and a disagreement throws here, at construction, naming both. A
 * surface built from a declaration the store does not share would be the very
 * second description of the data this exists to remove.
 */
export function createReadSurface<S extends StateStore, const D extends readonly EntityDeclaration[]>(
	store: S,
	declarations: D,
): ReadSurface<S, D> {
	const surface: Record<string, EntityReads<S, EntityDeclaration>> = {};
	for (const declaration of declarations) {
		const entity = normalizeEntity(declaration);
		assertDeclaredBy(store.declarations, entity);
		surface[entity.name] = readsFor(store, entity);
	}
	return surface as ReadSurface<S, D>;
}

function readsFor<S extends StateStore>(store: S, entity: NormalizedEntity): EntityReads<S, EntityDeclaration> {
	// The address travels out to the store as it arrived. `AsOfAddress<S>` is
	// read off this store's own signature, so it is exactly what this store's
	// `getAsOf` accepts; the seam types the parameter as a block number, which is
	// the narrower of the two, hence the one cast.
	const at = (address: AsOfAddress<S>): number => address as number;
	return {
		getCurrent: async (id) => row(entity, await store.getCurrent(entity.name, id)),
		getAsOf: async (id, address) => row(entity, await store.getAsOf(entity.name, id, at(address))),
		listCurrent: async (prefix, limit) => listing(entity, await store.listCurrent(entity.name, prefix, limit)),
		listAsOf: async (prefix, address, limit) =>
			listing(entity, await store.listAsOf(entity.name, prefix, at(address), limit)),
	};
}

/**
 * One row as the DECLARATION describes it: the id columns, then every declared
 * field, and nothing else.
 *
 * Exported because a backend's own richer read layer projects the same way
 * (`@etherfold/state-store-sqlite`'s `createQuerySurface`), and two copies of
 * "what a row is" would be two answers to the question this surface exists to
 * answer once.
 *
 * It is a projection rather than a cast, and that is the difference between a
 * type that is true and a type that is merely asserted. A versioned backend
 * answers a read with `SELECT *`, so the raw row carries `_lower` and `_upper`
 * alongside the declared columns; handing those back would give a caller state
 * the declaration does not describe, and would let a row be spread straight into
 * a write. A declared field the row does not carry reads as `null`, which is
 * what the store means by an unlisted field of a whole-row write.
 */
export function declaredRow(entity: NormalizedEntity, raw: Record<string, unknown>): Record<string, unknown> {
	const projected: Record<string, unknown> = {};
	for (const column of entity.id) projected[column] = raw[column];
	for (const field of Object.keys(entity.fields)) projected[field] = raw[field] ?? null;
	return projected;
}

function row<T>(entity: NormalizedEntity, raw: Record<string, unknown> | undefined): T | undefined {
	return raw === undefined ? undefined : (declaredRow(entity, raw) as T);
}

function listing<T>(entity: NormalizedEntity, found: Listing<Record<string, unknown>>): Listing<T> {
	return {rows: found.rows.map((raw) => declaredRow(entity, raw) as T), truncated: found.truncated};
}

/**
 * The reader and the store must be reading the SAME declaration.
 *
 * Compared on the whole shape (id columns in order, fields and their storage
 * classes) rather than on the name alone, because a surface generated from a
 * stale copy would type its rows off columns the store does not have and project
 * them to `null` -- a plausible wrong answer, which is the failure mode this
 * seam refuses everywhere else.
 *
 * Exported because the declarations a surface is generated from are not always
 * on the same THREAD as the store that holds the rows: the port proxy in
 * `@etherfold/browser` asks its host for them and compares them here, so a
 * cross-boundary surface refuses the same disagreement, in the same words, as
 * the same-thread one -- rather than growing a second, weaker rule of its own.
 */
export function assertDeclaredBy(declarations: ReadonlyMap<string, NormalizedEntity>, entity: NormalizedEntity): void {
	const known = declarations.get(entity.name);
	if (!known) {
		throw new UnknownEntityError(
			entity.name,
			[...declarations.keys()],
			`entity ${entity.name} is not declared to this store, which was built with ` +
				`(${[...declarations.keys()].join(', ') || 'no entities'}). A read surface is generated from the ` +
				`declarations the store itself was given.`,
		);
	}
	if (shapeOf(entity) !== shapeOf(known)) {
		throw new Error(
			`entity ${entity.name} is declared differently to this store: the read surface says ` +
				`${shapeOf(entity)} and the store was built with ${shapeOf(known)}. One declaration describes the data ` +
				`for storage AND for reads; two of them are the drift this surface exists to remove.`,
		);
	}
}

function shapeOf(entity: NormalizedEntity): string {
	const fields = Object.entries(entity.fields)
		.map(([field, type]) => `${field}: ${type}`)
		.sort();
	return `id(${entity.id.join(', ')}) {${fields.join(', ')}}`;
}
