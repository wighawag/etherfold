import {normalizeEntity, type FieldType} from '@etherfold/state-store';
import {
	assertStorableEntityNames,
	assertStorableTableNamespace,
	inTableNamespace,
	quoted,
	quotedList,
} from './identifiers.js';
import type {EntityDeclaration, Statement} from './types.js';

/**
 * ## Fixed schema vs dynamic schema (the seam)
 *
 * This repo's convention is that a schema is a static `.sql` file applied by a
 * migration step. That convention holds for FIXED tables, whose shape is known
 * when the code is written, and `_blocks` below is one of them: it is written
 * here as literal SQL, and moves to a `.sql` file the day the server package
 * introduces the codegen step for them.
 *
 * It cannot hold for ENTITY tables. Their columns are whatever a processor
 * declares, which is only known at run time, so their DDL is generated from the
 * declaration. That is the exception, it applies here and nowhere else, and the
 * containment is deliberate: only this module emits DDL, and every identifier it
 * interpolates has been validated by the seam's `normalizeEntity`, which applies
 * this store's identifier rule to EVERY backend so that a declaration is valid
 * or invalid as a fact about the declaration. Every one of them is also QUOTED
 * on the way out (`quoted`, `identifiers.ts`), because a validated SHAPE can
 * still be a SQL keyword and this backend must accept exactly what the seam
 * accepts.
 *
 * ## Why the derived index names carry the store's `_` prefix
 *
 * In SQLite an index and a table share ONE namespace, so an index named
 * `token_open` and a table named `token_open` cannot both exist. Deriving an
 * index name from an entity name without a prefix therefore put this store's
 * OWN names into the space a declaration draws from: declaring `token` and
 * `token_open` together was accepted by the seam, stored as two entities by
 * every other backend, and killed `migrate()` here with
 * `SQLITE_ERROR: there is already an index named token_open` (or
 * `...already a table named...`, depending which was created first).
 *
 * Prefixing with `_` fixes it by CONSTRUCTION rather than by a new refusal, and
 * that is the point: the seam already reserves the `_` prefix for the store, so
 * no declaration can reach into `_token_open` and no entity name has to be
 * refused for a reason that would be nonsense on a backend with no indexes in
 * it. The alternative -- refusing an entity whose name happens to equal another
 * entity's derived index name -- would have made a declaration's legality depend
 * on which OTHER entities were declared beside it, and leaked this store's
 * naming scheme into the shared surface.
 *
 * ## Why the names are a VALUE rather than constants
 *
 * Because one database holds several GENERATIONS, each in its own table-name
 * namespace (ADR-0053; what a namespace may be, and where it goes in a name, is
 * `inTableNamespace` in `identifiers.ts`). `TableNames` is that namespace
 * resolved ONCE, at construction, so no statement builder spells a name for
 * itself and no code path can be the one that forgets the namespace -- which
 * would not fail, it would quietly read and write the UNNAMESPACED table beside
 * the generation's own. It is a REQUIRED argument for exactly that reason: a
 * default would make forgetting it compile.
 */

/** Block number at which a version became valid (inclusive). */
export const LOWER = '_lower';
/** Block number at which a version stopped being valid (exclusive). NULL = live. */
export const UPPER = '_upper';
/** Surrogate identity of ONE version (a business key has many). */
export const ROWID = '_rowid';

/** The canonical block table, unnamespaced: the fixed part of the schema. */
export const BLOCKS_TABLE = '_blocks';

/**
 * The sync-cursor table: the other fixed one.
 *
 * Two columns, both opaque to this package: a caller-chosen `key` and whatever
 * string it last wrote there. It is a table in THIS store rather than a table in
 * the processor package (where it used to be, as `_sync`) because the cursor has
 * to be written in the same batch -- the same transaction -- as the block it
 * describes, and only the store issues that batch. The reasoning is at the seam,
 * in `@etherfold/state-store`'s `cursor.ts`.
 *
 * It stays neutral in its NAMES as well as its dependencies. There is no
 * `lastSync` column here: this store knows it is keeping a string for someone,
 * and nothing about `LastSync`, `unconfirmedBlocks` or what an indexer is.
 */
export const CURSOR_TABLE = '_cursor';

/** Its two columns, QUOTED at every use: both are ordinary English words SQL has opinions about. */
export const CURSOR_KEY = '"key"';
export const CURSOR_VALUE = '"value"';

/**
 * The writer-token table: the third fixed one, and the smallest.
 *
 * ONE row (`id = 0`, enforced by a CHECK rather than by convention) holding the
 * opaque token of whoever last claimed this store. Every mutating statement is
 * guarded on it and reads it back inside the same batch, which is ADR-0054's
 * mechanism applied one level down (ADR-0075, and `writer.ts` at the seam).
 *
 * It is IN THE NAMESPACE, with `_blocks` and `_cursor`, and that placement IS
 * the scoping decision: a generation's claim covers exactly the tables that
 * generation owns, so two generations folding into one database contend only if
 * they were addressed as one (ADR-0053). A single unnamespaced token table
 * would refuse the concurrent writing the generation model requires.
 *
 * A table of its own rather than a column on `_cursor`, unlike ADR-0054's
 * revision, which rides the pointer row every commit already writes: there is no
 * row here that every mutation touches (`revertTo` writes no cursor, `prune`
 * writes none) and the cursor keyspace is the CALLER's.
 */
export const WRITER_TABLE = '_writer';

/**
 * Every name ONE store uses, resolved from its namespace: SQL-ready text, and
 * the only place a table or an index name is spelled.
 *
 * The quoting follows the rule in `identifiers.ts` and nothing else: a name that
 * came from a DECLARATION is quoted (the entity tables, and the indexes derived
 * from their names), and the store's OWN fixed names stay bare. A namespace is
 * neither, so it is admitted only in a shape that is a legal bare identifier
 * fragment, which is what lets `_blocks` stay bare as `_<ns>_blocks`.
 */
export type TableNames = {
	/** The namespace, or `undefined` for the names this store has always used. */
	readonly namespace: string | undefined;
	/** The block table. */
	readonly blocks: string;
	/** The sync-cursor table. */
	readonly cursor: string;
	/** The writer-token table. */
	readonly writer: string;
	/** One declared entity's table, quoted. */
	entity(name: string): string;
	/** One index derived from an entity name, quoted, in the store's `_` namespace. */
	index(entity: string, suffix: string): string;
};

/**
 * The names for one namespace, or -- with no argument -- the names this store
 * creates today, byte for byte.
 *
 * The namespace is VALIDATED here, which makes this the one gate between a
 * configured namespace and an identifier: `VersionedStateStore` calls it in its
 * constructor, so a namespace this store could not keep separate is refused
 * where it was configured rather than at `migrate()` on a deployed server.
 */
export function tableNames(namespace?: string): TableNames {
	if (namespace !== undefined) assertStorableTableNamespace(namespace);
	const qualified = (name: string) => inTableNamespace(namespace, name);
	return {
		namespace,
		blocks: qualified(BLOCKS_TABLE),
		cursor: qualified(CURSOR_TABLE),
		writer: qualified(WRITER_TABLE),
		entity: (name) => quoted(qualified(name)),
		// the `_` prefix is what keeps a derived index out of the space a
		// DECLARATION draws from; the namespace goes inside it. See the module note.
		index: (entity, suffix) => quoted(qualified(`_${entity}_${suffix}`)),
	};
}

/**
 * Rows exist here only for blocks that carry our logs, not for every chain
 * block: state only changes where our events occur.
 *
 * There is deliberately no `parentHash`. It is not on a log, so recording it
 * would cost the extra `eth_getBlockByHash` round-trip per block that this whole
 * design exists to avoid (ADR-0002 makes the in-browser path primary, and a
 * browser provider cannot even batch those calls). It would also be close to
 * meaningless if it were stored: this table is SPARSE, holding only blocks that
 * carry our logs, so consecutive rows are almost never parent and child and the
 * linkage a `parentHash` implies would not exist to check. The chain-linkage
 * cross-check it would serve (`verifyBlocks`, ADR-0004) is deferred in the
 * design's §9, and if it is ever built it needs the field plumbed onto the log
 * stream first, not reconstructed here.
 */
export function fixedSchemaDDL(names: TableNames): string[] {
	return [
		`CREATE TABLE IF NOT EXISTS ${names.blocks} (
	number INTEGER PRIMARY KEY,
	hash TEXT NOT NULL UNIQUE,
	timestamp INTEGER NOT NULL
)`,
		`CREATE INDEX IF NOT EXISTS ${names.blocks}_timestamp ON ${names.blocks} (timestamp)`,
		`CREATE TABLE IF NOT EXISTS ${names.cursor} (
	${CURSOR_KEY} TEXT PRIMARY KEY,
	${CURSOR_VALUE} TEXT NOT NULL
)`,
		`CREATE TABLE IF NOT EXISTS ${names.writer} (
	id INTEGER PRIMARY KEY CHECK (id = 0),
	token TEXT NOT NULL
)`,
	];
}

function sqlType(type: FieldType): string {
	switch (type) {
		case 'text':
			return 'TEXT';
		case 'integer':
			return 'INTEGER';
		case 'real':
			return 'REAL';
		case 'blob':
			return 'BLOB';
	}
}

/**
 * The DDL for one entity: the table plus the four indexes the access paths need.
 * The caller writes no SQL, which is the point: `{name, id, fields}` in, a
 * time-travellable table out.
 */
export function ddlForEntity(declaration: EntityDeclaration, names: TableNames): string[] {
	const entity = normalizeEntity(declaration);
	assertStorableEntityNames([entity]);
	const table = names.entity(entity.name);
	const idList = quotedList(entity.id);
	/** An index of this entity, in the store's own `_` namespace. See the module note. */
	const index = (suffix: string) => names.index(entity.name, suffix);

	const columns = [
		`${ROWID} INTEGER PRIMARY KEY AUTOINCREMENT`,
		...entity.id.map((column) => `${quoted(column)} TEXT NOT NULL`),
		...Object.entries(entity.fields).map(([field, type]) => `${quoted(field)} ${sqlType(type)}`),
		`${LOWER} INTEGER NOT NULL`,
		// nullable on purpose: NULL is how "still valid at the tip" is expressed.
		// A sentinel such as INT64_MAX would leak into every query and every
		// consumer, and is rejected outright by at least one supported backend.
		`${UPPER} INTEGER`,
	];

	return [
		`CREATE TABLE IF NOT EXISTS ${table} (\n\t${columns.join(',\n\t')}\n)`,
		// The live set, and the invariant SQLite cannot express as a constraint:
		// at most one open version per business key.
		`CREATE UNIQUE INDEX IF NOT EXISTS ${index('open')} ON ${table} (${idList}) WHERE ${UPPER} IS NULL`,
		// Time travel: the point as-of probe rides this B-tree, which is why it
		// stays effectively flat as history accumulates.
		`CREATE INDEX IF NOT EXISTS ${index('history')} ON ${table} (${idList}, ${LOWER})`,
		// Revert leg A: versions opened above the fork.
		`CREATE INDEX IF NOT EXISTS ${index('lower')} ON ${table} (${LOWER})`,
		// Revert leg B: versions closed above the fork.
		`CREATE INDEX IF NOT EXISTS ${index('upper')} ON ${table} (${UPPER})`,
	];
}

/**
 * Every statement needed to bring an empty database to the declared shape.
 *
 * All of it is `IF NOT EXISTS`, so it is safe to run on every boot and safe to
 * resume: unlike applying a block, migrating is idempotent and therefore does
 * not need to be one atomic unit.
 */
export function migrationStatements(declarations: Iterable<EntityDeclaration>, names: TableNames): Statement[] {
	const sql = [...fixedSchemaDDL(names)];
	for (const declaration of declarations) {
		sql.push(...ddlForEntity(declaration, names));
	}
	return sql.map((statement) => ({sql: statement, args: []}));
}

/**
 * Every statement needed to remove THIS store's tables and nothing else: what
 * retiring a generation is.
 *
 * ADR-0053 chose a table-name namespace over a generation COLUMN largely for
 * this: discarding a rebuild is a `DROP` per table rather than a full-scan
 * `DELETE ... WHERE generation = ?` that has to be driven in bounded chunks and
 * does not reclaim a page without `VACUUM`. There is no predicate here, and so
 * no filter anyone can forget.
 *
 * The indexes are deliberately not named. SQLite drops an index with its table,
 * and naming them would be a second list to keep in step with `ddlForEntity` --
 * one that would go stale silently, since a leftover index is invisible until a
 * name collides with it much later.
 *
 * `IF EXISTS` throughout, so this is idempotent in the same way migrating is,
 * and dropping a generation that never migrated is a no-op rather than an error.
 */
export function dropSchemaStatements(declarations: Iterable<EntityDeclaration>, names: TableNames): Statement[] {
	const sql: string[] = [];
	for (const declaration of declarations) {
		sql.push(`DROP TABLE IF EXISTS ${names.entity(normalizeEntity(declaration).name)}`);
	}
	sql.push(
		`DROP TABLE IF EXISTS ${names.blocks}`,
		`DROP TABLE IF EXISTS ${names.cursor}`,
		`DROP TABLE IF EXISTS ${names.writer}`,
	);
	return sql.map((statement) => ({sql: statement, args: []}));
}
