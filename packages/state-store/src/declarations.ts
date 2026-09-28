import type {EntityIdPrefix} from './listing.js';
import type {SemanticValue} from './semantic-types.js';
import type {EntityDeclaration, FieldDeclaration, SemanticTypeName} from './types.js';

/**
 * The declaration, read as TYPES: one description of the data, for storage AND
 * for reads.
 *
 * `{name, id, fields}` already drives the layout, the versions, the as-of read
 * and the revert. What lives here is the other half of the same object: the
 * shape of a row, of a business key and of a listing prefix, DERIVED from the
 * declaration rather than written a second time next to it. A consumer that
 * hand-wrote `type Token = {id: string; owner: string}` would own a second
 * description that drifts silently the day a field is renamed; derived, the
 * rename stops the consumer compiling.
 *
 * ## Nothing here decodes anything
 *
 * A field's TypeScript type is what the declaration describes and nothing more:
 * `text` is a `string`, and if that string is the decimal form of a `uint256`
 * this surface still hands back the string. Decoding on a guess -- "text that
 * parses as digits is a BigInt" -- would make one declaration mean two things.
 * A field that IS a u256 says so, with the semantic type `{storage: 'blob',
 * type: 'u256'}` (ADR-0098), and the seam then answers a `bigint` for it on every
 * backend. See ADR-0025 and its amendment.
 *
 * ## Why a helper rather than `as const`
 *
 * `declareEntities` is an identity function whose only job is to keep the
 * literals. An ANNOTATED declaration (`const TOKEN: EntityDeclaration = ...`)
 * widens `'owner'` to `string` and `'text'` to `FieldType`, after which nothing
 * can be derived; `as const` keeps them but says nothing about validity. This
 * keeps them AND checks the shape where it is written.
 */

/**
 * Pin the literal types of a set of declarations, and check their shape.
 *
 * The value is unchanged and is still an ordinary `readonly EntityDeclaration[]`,
 * so the SAME array goes to the store's constructor, to a processor's `entities`
 * and to `createReadSurface`. That is the point: one array, one description.
 *
 * ```ts
 * const entities = declareEntities([{name: 'token', id: 'id', fields: {owner: 'text'}}]);
 * const store = new MemoryStateStore(entities);
 * const surface = createReadSurface(store, entities);
 * ```
 */
export function declareEntities<const D extends readonly EntityDeclaration[]>(declarations: D): D {
	return declarations;
}

/**
 * The declared id columns as a tuple, whichever way they were written.
 *
 * `id: 'id'` and `id: ['id']` are the same declaration (`normalizeEntity` says
 * so at run time), so they are the same type here.
 */
export type IdColumnsOf<E extends EntityDeclaration> = E extends {id: infer I}
	? I extends string
		? readonly [I]
		: I extends readonly string[]
			? I
			: readonly string[]
	: never;

/** The declared entity of that name, out of a set of declarations. */
export type EntityNamed<D extends readonly EntityDeclaration[], Name> = Extract<D[number], {name: Name}>;

/**
 * What a declared field holds, as a TypeScript type.
 *
 * `blob` is a `Uint8Array` because that is what the backends hand back for one;
 * `integer` and `real` are both `number`, which is the honest reading of a
 * 64-bit SQLite INTEGER (and the reason a u256 is not an integer field: it does
 * not fit, so it is a semantic type, ADR-0098).
 *
 * An enum (ADR-0098) is the UNION of its declared values, which is true rather
 * than hopeful because every backend refuses any other value at write time.
 * Under an annotated declaration its values are not literal, and it reads as
 * `string`, which is still true.
 *
 * A semantic type (`{storage, type}`, ADR-0098) is the value its type answers
 * (`SemanticValue`): a `u256` is a `bigint`. That is true rather than hopeful
 * because every backend stores one canonically and the seam decodes it
 * (`decodeFieldValues`), and a port carries a `bigint` by structured clone as
 * itself, so `createReadSurface` and `createPortReadSurface` both answer one.
 * The storage class does not show through: a `u256` in a `blob` is never a
 * `Uint8Array` to a reader (ADR-0025's "for free", cashed).
 */
export type FieldValue<T extends FieldDeclaration> = T extends {readonly enum: readonly (infer V extends string)[]}
	? V
	: T extends {readonly type: infer N extends SemanticTypeName}
		? SemanticValue<N>
		: T extends 'text'
			? string
			: T extends 'integer' | 'real'
				? number
				: T extends 'blob'
					? Uint8Array
					: never;

/**
 * One row of a declared entity: its id columns, then its fields.
 *
 * The id columns are `string` because a business key is stringified once, at the
 * seam (`idValues`), so that `{id: 1}` and `{id: '1'}` are one entity on every
 * backend. Every FIELD is nullable, and that is not defensiveness: `set` writes
 * a WHOLE row, so a declared field the handler did not list IS null, and a type
 * that hid it would be a type that lies on the common partial-write path.
 *
 * The version columns (`_lower`, `_upper`) are deliberately absent: they are
 * storage rather than state, and a read surface that handed them back would hand
 * a caller something the declaration does not describe (and something that must
 * never travel back into a write).
 */
export type EntityRow<E extends EntityDeclaration> = {
	readonly [K in IdColumnsOf<E>[number] | Extract<keyof E['fields'], string>]: K extends keyof E['fields']
		? FieldValue<E['fields'][K]> | null
		: string;
};

/**
 * A business key of a declared entity: every id column, and no others.
 *
 * `string | number` per column, because the stringification is the seam's job
 * and a caller should not have to do it to pass an epoch.
 */
export type EntityIdOf<E extends EntityDeclaration> = {
	[K in IdColumnsOf<E>[number]]: string | number;
};

/**
 * A listing prefix of a declared entity: a LEADING run of its id columns, at
 * least one of them.
 *
 * Under `id: ['epoch', 'position', 'playerIndex']` this is
 * `{epoch} | {epoch, position} | {epoch, position, playerIndex}` and nothing
 * else, so the prefix rule `prefixValues` enforces at run time is enforced here
 * at compile time as well. `{position}` does not compile, because it would need
 * a scan rather than a range.
 */
export type EntityPrefixOf<E extends EntityDeclaration> = IdPrefixes<IdColumnsOf<E>>;

type IdPrefixes<C> = C extends readonly []
	? never
	: C extends readonly [infer H extends string, ...infer R extends readonly string[]]
		? {[K in H]: string | number} | ({[K in H]: string | number} & IdPrefixes<R>)
		: // declarations whose id columns are not literal (an annotated declaration)
			// derive nothing, so the run-time rule is the only rule left
			EntityIdPrefix;
