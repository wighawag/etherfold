/**
 * ## Why every identifier from a declaration is QUOTED
 *
 * SQL cannot bind an identifier as a parameter. A table or a column name reaches
 * the engine as TEXT, which is why the seam validates the SHAPE of every name a
 * declaration carries (`normalizeEntity`, `@etherfold/state-store`) instead of
 * letting this package interpolate whatever it is handed.
 *
 * A shape check is not enough on its own, because a SQL KEYWORD has a perfectly
 * ordinary identifier shape. `index`, `order`, `group`, `select`, `table`,
 * `where`, `default`, `references` and `primary` all match
 * `/^[A-Za-z][A-Za-z0-9_]*$/`, so an entity declaring an id column named `index`
 * passed validation and then produced `..., index TEXT NOT NULL, ...`, which
 * SQLite rejects: `SQLITE_ERROR: near "index": syntax error`. The light and
 * IndexedDB backends stored the same declaration without complaint, so the
 * processor was silently non-portable and failed at deploy time on one platform
 * only (`work/notes/findings/sqlite-in-the-browser.md`).
 *
 * Quoting is the fix rather than a keyword blocklist, because the property that
 * matters is that a declaration is valid or invalid as a fact about the
 * DECLARATION rather than about the backend. Rejecting keywords would push one
 * engine's reserved-word list into the seam every backend shares, break
 * declarations that are legal today, and re-open the same hole the day SQLite
 * adds a keyword or a second SQL backend brings its own list. Quoting makes this
 * backend accept exactly what the seam accepts, which is the agreement the
 * conformance suite now asserts.
 *
 * ## The rule, and its edge
 *
 * QUOTE what came from a DECLARATION: the entity name, its id columns, its
 * fields, and the index names derived from the entity name. Do NOT quote the
 * store's OWN identifiers (`_lower`, `_upper`, `_rowid`, `_blocks` and its three
 * columns): they are chosen here, they are fixed, and leaving them bare keeps
 * "quoted" readable as "this name came from outside".
 *
 * Quoting is not a licence to interpolate anything, and it is not the security
 * boundary: the shape check still runs first and still rejects a `"` outright,
 * so the doubling below is the correct escaping for a name that can no longer
 * occur rather than the thing standing between a declaration and injection.
 */

/** One identifier as SQL text: double-quoted, with any embedded quote doubled. */
export function quoted(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/** A comma-separated identifier list, e.g. the columns of an index. */
export function quotedList(names: readonly string[]): string {
	return names.map(quoted).join(', ');
}

/**
 * ## THE TABLE-NAME NAMESPACE: several generations in ONE database
 *
 * A **generation** is a stream plus a fold over it, an indexer holds several and
 * one is canonical. Their state is a TABLE-NAME NAMESPACE inside one database
 * rather than a generation COLUMN or a database each (ADR-0053), so a successor
 * rebuilding beside the incumbent gets its own entity tables, its own `_blocks`
 * and its own `_cursor`, and retiring one is a `DROP` of exactly its tables.
 *
 * The namespace is a NAME the CALLER chooses, because it has to be derivable
 * before the processor exists: a generation is `{stream digest, processor
 * version hash}` and both halves are computable up front, which is what keeps
 * the state-then-processor build order (ADR-0043) intact.
 *
 * ## Why the shape rule is narrower than a declaration's
 *
 * The namespace is joined to a name with an UNDERSCORE, so an underscore INSIDE
 * a namespace would make the join ambiguous: `a_b` + `c` and `a` + `b_c` are one
 * table, and two generations would silently share rows -- the single failure
 * this namespace exists to prevent. Banning it makes the join injective by
 * construction rather than by a uniqueness argument nobody can check from one
 * store, which only ever sees its own name.
 *
 * Everything else is admitted, INCLUDING a leading digit and a mixed case, which
 * `IDENTIFIER` at the seam refuses for a declaration. That is not a
 * contradiction, it is a different question: a declaration must be portable
 * across backends that key on the exact string, while this name is only ever
 * spliced into an identifier THIS package emits, and every one of those is
 * either quoted (an entity table, a derived index) or begins with `_` (the fixed
 * tables). A rendered generation digest (`generationDigestOf`,
 * `@etherfold/core`) is 32 lowercase hex characters that may start with a digit,
 * so admitting one is what lets a caller pass the identity it already has
 * instead of decorating it.
 *
 * The one hazard the shape cannot close is CASE: SQLite folds identifier case,
 * so namespaces `genA` and `GENA` are ONE namespace here and two on a backend
 * that keys by the exact string. A store sees only its own name and cannot
 * refuse the collision, so it is the caller's to avoid -- and a caller deriving
 * the name from a digest, which is what this exists for, never meets it.
 *
 * ## Where the namespace goes in a name, and why it is not simply a prefix
 *
 * It goes INSIDE the reserved `_` prefix: `token` becomes `<ns>_token`, and the
 * store's own `_blocks` becomes `_<ns>_blocks`. Prefixing everything uniformly
 * would have produced `<ns>__blocks`, which stops starting with `_` and so stops
 * being recognisable as a fixed table -- the property
 * `every-fixed-table-lives-in-the-reserved-underscore-namespace` established and
 * `packages/cli/test/fixedTableNamespace.test.ts` asserts on the database a
 * combined deployment shares between this store and `@etherfold/server`. Keeping
 * the `_` in the lead also keeps a declaration out of the store's names for
 * free, since the seam already refuses a declaration that starts with one.
 *
 * One overlap is left, and it is left knowingly: an UNNAMESPACED store declaring
 * an entity literally named `genA_token` lands on the same table as namespace
 * `genA`'s entity `token`. It takes a database that MIXES a namespaced store
 * with an unnamespaced one, which the model does not produce -- a database that
 * holds generations names every one of them -- and closing it would mean
 * refusing an entity name for what some other store might be called, which is
 * the declaration-legality-depends-on-its-neighbours failure the derived index
 * names were prefixed to avoid.
 */
const TABLE_NAMESPACE = /^[A-Za-z0-9]+$/;

/**
 * Refuse, at construction, a namespace this store could not keep separate.
 *
 * Called by `tableNames` (`ddl.ts`), which is every route from a configured
 * namespace to an identifier, so a bad one fails where it was CONFIGURED rather
 * than at `migrate()` on a deployed server -- the same placement as the
 * `sqlite_` rule below, and for the same reason.
 */
export function assertStorableTableNamespace(namespace: string): void {
	if (typeof namespace !== 'string' || !TABLE_NAMESPACE.test(namespace)) {
		throw new Error(
			`invalid table namespace ${JSON.stringify(namespace)} for @etherfold/state-store-sqlite: ` +
				`it must match ${TABLE_NAMESPACE}. The namespace is joined to every name this store emits with an ` +
				`underscore, so an underscore inside it would make that join ambiguous and let two namespaces resolve ` +
				`to one table. A rendered generation digest is a valid namespace as it comes.`,
		);
	}
	if (namespace.toLowerCase() === SQLITE_INTERNAL_PREFIX.slice(0, -1)) {
		throw new Error(
			`table namespace ${JSON.stringify(namespace)} cannot be used by @etherfold/state-store-sqlite: ` +
				`its entity tables would be named "${SQLITE_INTERNAL_PREFIX}<entity>", and SQLite reserves object names ` +
				`beginning with "${SQLITE_INTERNAL_PREFIX}" for its own use, however they are quoted. Choose another namespace.`,
		);
	}
}

/**
 * One name, in a namespace: the store's own `_blocks` becomes `_<ns>_blocks` and
 * an entity's `token` becomes `<ns>_token`.
 *
 * An ABSENT namespace returns the name UNCHANGED, byte for byte, which is what
 * makes this additive: every existing database keeps the tables it has.
 */
export function inTableNamespace(namespace: string | undefined, name: string): string {
	if (namespace === undefined) return name;
	return name.startsWith('_') ? `_${namespace}${name}` : `${namespace}_${name}`;
}

/**
 * ## The one name quoting cannot rescue
 *
 * SQLite reserves every SCHEMA-OBJECT name beginning with `sqlite_` (matched
 * case-insensitively) for its own use, and refuses to create one however it is
 * spelled: `CREATE TABLE "sqlite_thing" (...)` is
 * `SQLITE_ERROR: object name reserved for internal use`. Unlike a keyword this
 * survives quoting, so there is nothing this package can do at DDL time.
 *
 * That makes it the one shape in this class that is genuinely THIS engine's
 * limit rather than the declaration's: a `sqlite_`-prefixed entity name is
 * stored happily by the memory, patch and IndexedDB backends. It does not become
 * a seam rule for that reason -- the seam would then carry one engine's
 * namespace, which is the thing `entity-identifier-sql-keyword` decided against
 * -- but it does move to DECLARATION time, here, so it fails where the store was
 * constructed instead of at `migrate()` on a deployed server. That is the
 * property the conformance suite asserts of every backend: refused when the
 * declaration is made, or storable, and never a third thing.
 *
 * It applies to entity names ONLY. A `sqlite_`-prefixed COLUMN is perfectly
 * legal in SQLite, so refusing one would be this backend narrowing the seam for
 * no engine reason at all -- the opposite failure, and just as visible to a
 * processor author.
 */
export const SQLITE_INTERNAL_PREFIX = 'sqlite_';

/**
 * Refuse, at construction, any entity this engine could not create a table for.
 *
 * Called by `VersionedStateStore`'s constructor and by `ddlForEntity`, which
 * between them is every route from a declaration to DDL.
 */
export function assertStorableEntityNames(entities: Iterable<{readonly name: string}>): void {
	for (const entity of entities) {
		if (entity.name.toLowerCase().startsWith(SQLITE_INTERNAL_PREFIX)) {
			throw new Error(
				`entity ${JSON.stringify(entity.name)} cannot be stored by @etherfold/state-store-sqlite: ` +
					`SQLite reserves object names beginning with "${SQLITE_INTERNAL_PREFIX}" for its own use, ` +
					`however they are quoted. Rename the entity. (A "${SQLITE_INTERNAL_PREFIX}" column name is fine; ` +
					`only the entity name becomes a table name.)`,
			);
		}
	}
}
