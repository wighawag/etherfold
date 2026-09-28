import type {EntityId} from '@etherfold/state-store';

/**
 * ## The accessor seam (ADR-0099)
 *
 * One interface the query layer's resolvers call and each backend implements:
 * the rows of an entity matching a predicate over its declared fields, ordered
 * by one of them, bounded, at the tip or as of a block; and the children of a
 * PAGE of parents through a declared relation, in one call, bounded per parent.
 *
 * It is deliberately NOT a member of `StateStore` (ADR-0021). The handler seam
 * narrowed to reads that are one indexed range scan on every backend because a
 * handler runs once per event on a substrate with no query planner, and a
 * predicate-taking read there would undo that. A resolver runs once per
 * REQUEST, above the store, and this is its seam.
 *
 * ## What every backend must mean by a query
 *
 * The semantics are FIXED here rather than left to each engine, because one
 * GraphQL document runs against a server and a browser worker and must answer
 * the same (ADR-0099):
 *
 * - The operators are `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in` and `isNull`,
 *   combined with `and` and `or`. There is no `not`.
 * - A comparison with NULL is false, as in SQL: a row whose field is null
 *   matches no `eq`, `ne`, `lt`, ..., or `in`, and an operand that is `null`
 *   matches no row. `isNull` is the one operator that sees a null. With no `not`
 *   in the language, SQL's three-valued logic and this two-valued reading give
 *   the same rows, so a backend filtering in memory answers what SQL answers.
 * - Nulls order FIRST ascending and LAST descending, as SQLite does.
 * - Text compares as its UTF-8 bytes (code point order, SQLite's BINARY
 *   collation), NOT JavaScript's UTF-16 order: they disagree on a supplementary
 *   plane character against U+E000 to U+FFFF.
 * - A `u256` (ADR-0098) compares and orders NUMERICALLY, `9` before `10` and
 *   values past 2^64 included, which its canonical encoding (32 big-endian
 *   bytes) makes the same thing as comparing its bytes. So does a plain `blob`:
 *   bytewise.
 * - `integer` and `real` compare as numbers.
 * - Rows that tie on the ordered field, and every row when no order is asked
 *   for, come in ascending order of the declared id, column by column, each
 *   compared as UTF-8 bytes: a deterministic order, so a limit cuts the SAME
 *   rows on every backend.
 *
 * A query the seam cannot mean the same everywhere (an undeclared field, an
 * operand of the wrong kind for the field) is refused before any backend runs
 * it, by the one planner every backend calls (`planFind`, `planChildren`), so
 * the refusal is the same sentence on every backend.
 */
export interface Accessor {
	/**
	 * The rows of one entity matching `where`, ordered, at most `limit` of them.
	 *
	 * Rows are answered as the store seam answers them: the declared id columns
	 * and fields only (never a version column), a `u256` as a `bigint`, a `blob`
	 * as a `Uint8Array`.
	 *
	 * As of a block (`at`), a block outside what the store retains is refused
	 * with the seam's `BlockNotRetainedError`, never answered from the tip. A
	 * BOUNDED backend refuses past its rows-examined bound with
	 * `RowsExaminedBoundError`; a backend with a query planner has no bound and
	 * answers.
	 */
	find<T = Record<string, unknown>>(query: FindQuery): Promise<Page<T>>;
	/**
	 * The children of each of a PAGE of parents through one declared relation
	 * (ADR-0098), in ONE call: one page per parent, in the order the parents were
	 * given, each bounded by `limit` on its own.
	 *
	 * The bound is PER PARENT and not per batch, because a batch bound would let
	 * one prolific parent starve the others (ADR-0099). A parent with no children,
	 * or no row at all, has an empty page.
	 */
	children<T = Record<string, unknown>>(query: ChildrenQuery): Promise<Page<T>[]>;
}

/**
 * What a read answers: at most `limit` rows, and whether there were MORE.
 *
 * `truncated` cannot be inferred from `rows.length === limit` (a set that exactly
 * fills the limit is not one that was cut off), which is the same reason the
 * seam's `Listing` carries it.
 */
export type Page<T> = {
	readonly rows: readonly T[];
	readonly truncated: boolean;
};

/** Where a read is answered from: the tip, or a block height (the pinned block of an operation). */
export type ReadAt = {
	/**
	 * A block HEIGHT to answer as of; absent reads the tip. A number rather than a
	 * hash or a timestamp, because the query layer pins one block per operation
	 * and pins it by number (ADR-0099); resolving an address is its business.
	 */
	readonly at?: number;
};

/** The shape shared by both reads: a predicate, an order, a bound and a block. */
export type Selection = ReadAt & {
	/** A predicate over the entity's id columns and declared fields; absent matches every row. */
	readonly where?: Where;
	/** One id column or declared field to order by; absent orders by the declared id. */
	readonly orderBy?: OrderBy;
	/**
	 * At most this many rows (per PARENT, for `children`). Required and whole,
	 * at least 1: there is no default, because a default bound is a bound nobody
	 * chose.
	 */
	readonly limit: number;
};

/** `find`'s query: one entity, by its declared name. */
export type FindQuery = Selection & {
	readonly entity: string;
};

/**
 * `children`'s query: the PARENT entity, the relation's collection name on it
 * (the child's declared `parent.as`), and the parents' keys. The predicate and
 * the order are over the CHILD.
 */
export type ChildrenQuery = Selection & {
	readonly entity: string;
	readonly relation: string;
	readonly parents: readonly EntityId[];
};

/** One field to order by, and which way. `asc` when `direction` is absent. */
export type OrderBy = {
	readonly field: string;
	readonly direction?: 'asc' | 'desc';
};

/**
 * A value a predicate compares a field with, in the form the store seam answers
 * for that field: a `string` for text (an enum included) and for an id column
 * (which also takes a `number`, stringified as the seam stringifies an id), a
 * `number` for `integer` and `real`, a `Uint8Array` for a `blob`, a `bigint` for
 * a `u256`. `null` is admitted and matches nothing (a comparison with null is
 * false).
 */
export type Operand = string | number | bigint | Uint8Array | null;

/** The six comparisons. */
export type ComparisonOperator = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';

/** A predicate: a comparison, or an `and` / `or` of predicates. */
export type Where =
	| {readonly and: readonly Where[]}
	| {readonly or: readonly Where[]}
	| {readonly field: string; readonly op: ComparisonOperator; readonly value: Operand}
	| {readonly field: string; readonly op: 'in'; readonly values: readonly Operand[]}
	/** `value: true` is IS NULL, `false` is IS NOT NULL. */
	| {readonly field: string; readonly op: 'isNull'; readonly value: boolean};
