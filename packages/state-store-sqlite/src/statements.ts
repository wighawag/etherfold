import {
	assertListingLimit,
	idValues,
	mustGet,
	normalizeBlockHash,
	normalizeEntities,
	prefixValues,
	type EntityIdPrefix,
} from '@etherfold/state-store';
import {CURSOR_KEY, CURSOR_VALUE, LOWER, ROWID, UPPER, type TableNames} from './ddl.js';
import {quoted, quotedList} from './identifiers.js';
import type {BlockPointer, EntityDeclaration, Mutation, NormalizedEntity, Statement} from './types.js';

/**
 * The business key as bound values, in declared column order. Defined at the
 * seam (every backend stringifies a key the same way) and re-exported because
 * this package's public surface has always carried it.
 */
export {idValues};

/**
 * The SQL of the store, built as plain data.
 *
 * These are pure functions on purpose. The ordering inside a batch is
 * load-bearing (see `revertToStatements`), and a test can only pin an ordering
 * it can see.
 *
 * Every identifier that came from a DECLARATION is quoted on the way out
 * (`identifiers.ts`), for the reason set out there: a validated identifier shape
 * can still be a SQL keyword. The store's own COLUMN names (`_lower`, `_upper`,
 * `_rowid`) are fixed and stay bare.
 *
 * No function here spells a TABLE name. Every one of them takes the `TableNames`
 * its store resolved at construction, because a database holds several
 * generations, each in its own table-name namespace (ADR-0053), and a statement
 * that named a table itself would read and write the unnamespaced one beside the
 * generation it belongs to -- silently, and only under a namespace, which is
 * exactly the shape a test is least likely to have.
 */

/** `_lower <= N AND (_upper IS NULL OR N < _upper)` — the whole of time travel. */
export const AS_OF_PREDICATE = `${LOWER} <= ? AND (${UPPER} IS NULL OR ? < ${UPPER})`;

/** The live version: the open-row special case, served by the partial index. */
export const CURRENT_PREDICATE = `${UPPER} IS NULL`;

/** The columns of one recorded block, in `RecordedBlock` order. */
const BLOCK_COLUMNS = 'number, hash, timestamp';

/**
 * Look a block up by hash: the reorg-proof axis.
 *
 * `hash` is UNIQUE, so this is a one-row index probe, and an empty result means
 * "no such block" rather than "no such entity" (see `blocks.ts`).
 */
export function blockByHashStatement(hash: string, names: TableNames): Statement {
	return {sql: `SELECT ${BLOCK_COLUMNS} FROM ${names.blocks} WHERE hash = ? LIMIT 1`, args: [normalizeBlockHash(hash)]};
}

/** Look a block up by height. Only recorded blocks have a row; heights need none. */
export function blockByNumberStatement(number: number, names: TableNames): Statement {
	return {sql: `SELECT ${BLOCK_COLUMNS} FROM ${names.blocks} WHERE number = ? LIMIT 1`, args: [number]};
}

/**
 * The latest recorded block at or before `timestamp`, riding the timestamp index.
 *
 * `number DESC` breaks a tie rather than leaving it to the engine: several
 * blocks may carry the same timestamp (an L2 issuing more than one block per
 * second, or a chain that repeats one), and the answer must be the LATEST state
 * at that instant, deterministically.
 *
 * Nothing at or before T resolves to no row, never to the first recorded block:
 * the state before we started indexing is not the state at our first block.
 */
export function blockAtOrBeforeStatement(timestamp: number, names: TableNames): Statement {
	return {
		sql: `SELECT ${BLOCK_COLUMNS} FROM ${names.blocks} WHERE timestamp <= ? ORDER BY timestamp DESC, number DESC LIMIT 1`,
		args: [timestamp],
	};
}

/**
 * The highest recorded block: the TIP a retention window is measured back from.
 *
 * It rides the primary key, so it is a one-row index probe rather than a scan.
 * Only a store that claims a WINDOW ever asks for it: an `unbounded` store
 * refuses nothing and a `revert-only` store refuses everything, so neither pays
 * this round-trip.
 */
export function latestBlockStatement(names: TableNames): Statement {
	return {sql: `SELECT ${BLOCK_COLUMNS} FROM ${names.blocks} ORDER BY number DESC LIMIT 1`, args: []};
}

export function idPredicate(entity: NormalizedEntity): string {
	return entity.id.map((column) => `${quoted(column)} = ?`).join(' AND ');
}

/**
 * The two statements a bounded id-prefix listing compiles to, and the reason the
 * surface has the shape it has.
 *
 * Equality on the LEADING id columns plus `ORDER BY` the declared id is a
 * key-prefix range: SQLite seeks into the entity's id index and walks it in
 * order, so there is no sort and no scan, whatever the table holds. That is why
 * the seam offers a prefix and a limit and refuses a `where`, an `orderBy` or an
 * offset -- any of the three would let a handler, which runs once per event,
 * express something no index can serve. The access path is pinned by
 * `test/listing.test.ts` through `EXPLAIN QUERY PLAN`, because no behavioural
 * assertion can tell a range scan from a table scan that returns the same rows.
 *
 * Both bind `limit + 1`. The extra row never reaches the caller: it is what
 * turns "there may be more" into the `truncated` flag the seam answers with.
 */
function listStatement(
	entity: NormalizedEntity,
	prefix: EntityIdPrefix,
	limit: number,
	names: TableNames,
	asOf?: number,
): Statement {
	const values = prefixValues(entity, prefix);
	assertListingLimit(entity, limit);
	const predicate = asOf === undefined ? CURRENT_PREDICATE : AS_OF_PREDICATE;
	const bounds = asOf === undefined ? [] : [asOf, asOf];
	return {
		sql:
			`SELECT * FROM ${names.entity(entity.name)} ` +
			`WHERE ${values.map((_, index) => `${quoted(entity.id[index])} = ?`).join(' AND ')} AND ${predicate} ` +
			`ORDER BY ${quotedList(entity.id)} LIMIT ?`,
		args: [...values, ...bounds, limit + 1],
	};
}

/** The children of a prefix at the tip, riding the id index. */
export function listCurrentStatement(
	entity: NormalizedEntity,
	prefix: EntityIdPrefix,
	limit: number,
	names: TableNames,
): Statement {
	return listStatement(entity, prefix, limit, names);
}

/** The same range, as of a resolved block NUMBER, under the validity predicate. */
export function listAsOfStatement(
	entity: NormalizedEntity,
	prefix: EntityIdPrefix,
	at: number,
	limit: number,
	names: TableNames,
): Statement {
	return listStatement(entity, prefix, limit, names, at);
}

/**
 * The statements that apply ONE block. The caller sends them as one batch: the
 * block row and every entity mutation land together or not at all.
 *
 * A write is close-then-insert:
 *   1. `UPDATE ... SET _upper = N WHERE <id> AND _upper IS NULL` closes the live
 *      version at this height, and
 *   2. `INSERT ... (_lower = N)` opens the new one.
 * A delete is step 1 alone.
 *
 * The block row is inserted plainly rather than upserted: applying the same
 * block twice is a bug in the caller, and a primary-key violation says so
 * immediately instead of silently double-writing versions.
 */
/** Read one cursor. `undefined` (no row) is "never written", not an error. */
export function readCursorStatement(key: string, names: TableNames): Statement {
	return {
		sql: `SELECT ${CURSOR_VALUE} AS value FROM ${names.cursor} WHERE ${CURSOR_KEY} = ? LIMIT 1`,
		args: [key],
	};
}

/**
 * Write one cursor.
 *
 * Upserted, unlike a block row, and the asymmetry is deliberate: applying the
 * same block twice is a caller bug the store makes a primary-key violation on
 * purpose, whereas a cursor exists precisely to be overwritten.
 */
export function writeCursorStatement(key: string, value: string, names: TableNames): Statement {
	return {
		sql:
			`INSERT INTO ${names.cursor} (${CURSOR_KEY}, ${CURSOR_VALUE}) VALUES (?, ?) ` +
			`ON CONFLICT(${CURSOR_KEY}) DO UPDATE SET ${CURSOR_VALUE} = excluded.${CURSOR_VALUE}`,
		args: [key, value],
	};
}

/** Forget one cursor. Deleting a row that is not there is a no-op, which is the contract. */
export function clearCursorStatement(key: string, names: TableNames): Statement {
	return {sql: `DELETE FROM ${names.cursor} WHERE ${CURSOR_KEY} = ?`, args: [key]};
}

export function applyBlockStatements(
	declarations: Iterable<EntityDeclaration> | ReadonlyMap<string, NormalizedEntity>,
	block: BlockPointer,
	mutations: readonly Mutation[],
	names: TableNames,
	cursor?: {key: string; value: string},
): Statement[] {
	const entities = asEntityMap(declarations);
	const statements: Statement[] = [
		{
			sql: `INSERT INTO ${names.blocks} (number, hash, timestamp) VALUES (?, ?, ?)`,
			// the hash is folded to one spelling here, since it is the identity a
			// consumer pins and later looks up (see `normalizeBlockHash`).
			args: [block.number, normalizeBlockHash(block.hash), block.timestamp],
		},
	];

	for (const mutation of mutations) {
		const entity = mustGet(entities, mutation.entity);
		const table = names.entity(entity.name);
		const values = idValues(entity, mutation.id);

		// (1) close the live version at this height
		statements.push({
			sql: `UPDATE ${table} SET ${UPPER} = ? WHERE ${idPredicate(entity)} AND ${UPPER} IS NULL`,
			args: [block.number, ...values],
		});

		if (mutation.type === 'upsert') {
			// (2) open the new one
			const fields = Object.keys(entity.fields);
			const columns = [...entity.id.map(quoted), ...fields.map(quoted), LOWER];
			statements.push({
				sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
				args: [...values, ...fields.map((field) => mutation.values?.[field] ?? null), block.number],
			});
		}
	}

	// LAST, and in the SAME list, which is the same `batch([...])` and therefore
	// the same transaction: the cursor and the block it describes move together or
	// neither moves. See `cursor.ts` at the seam for what the gap used to cost.
	if (cursor) statements.push(writeCursorStatement(cursor.key, cursor.value, names));

	return statements;
}

/**
 * The next versions a retention floor puts out of reach, as row ids, at most
 * `limit` of them.
 *
 * `${UPPER} IS NOT NULL` is the whole safety property and is written out rather
 * than left to SQL's NULL semantics, because it is the line between bounding a
 * store and destroying it: a version with no upper bound is the LIVE one, it is
 * the current state however old it is, and an entity written once at block
 * 12,082,307 and never touched again is a normal row on the real stream rather
 * than an edge case. A prune expressed as "delete rows older than the floor"
 * deletes it.
 *
 * `${UPPER} <= ?` and not `<`: the floor is the OLDEST block a read may still
 * ask about, and a version closed AT that block was already superseded when it
 * was reached, so nothing inside the window can see it.
 *
 * It rides `<table>_upper`, the index revert leg B already needs, so the range
 * is a seek and the `ORDER BY` is free. That ordering is not decoration: a pass
 * stopped by a budget must have dropped the OLDEST unreachable versions, so a
 * partially pruned store converges towards the window from the far end instead
 * of keeping arbitrary holes.
 */
export function prunableVersionsStatement(
	entity: NormalizedEntity,
	floor: number,
	limit: number,
	names: TableNames,
): Statement {
	return {
		sql:
			`SELECT ${ROWID} FROM ${names.entity(entity.name)} ` +
			`WHERE ${UPPER} IS NOT NULL AND ${UPPER} <= ? ORDER BY ${UPPER} LIMIT ?`,
		args: [floor, limit],
	};
}

/**
 * Delete an EXPLICIT, bounded set of versions, by row id.
 *
 * The obvious `DELETE FROM t WHERE _upper <= ?` is one small statement that
 * deletes an unbounded number of rows, which is precisely what a hosted backend
 * refuses (see `maxRowsPerStatement`). Naming the rows also makes the deletion
 * auditable in the same way every other statement here is -- a test can look at
 * what a prune was about to do -- and it makes the COUNT exact, which
 * `remote-sql` could not otherwise supply: its result shape carries rows and no
 * affected-row count, so a blind bounded DELETE could not report what it did or
 * know when it was finished.
 */
export function dropVersionsStatement(
	entity: NormalizedEntity,
	rowids: readonly number[],
	names: TableNames,
): Statement {
	return {
		sql: `DELETE FROM ${names.entity(entity.name)} WHERE ${ROWID} IN (${rowids.map(() => '?').join(', ')})`,
		args: [...rowids],
	};
}

/**
 * The statements that roll the state back to `keepUpTo`, in the ONLY order that
 * works.
 *
 * Per entity table:
 *   A) `DELETE FROM t WHERE _lower > :keepUpTo` — versions born on the dead
 *      branch, which never existed on the canonical one.
 *   B) `UPDATE t SET _upper = NULL WHERE _upper > :keepUpTo` — versions the dead
 *      branch closed, which must be live again.
 * Then the dead blocks leave the canonical block table, so a hash that has been
 * reorged out stops resolving.
 *
 * **A MUST run before B.** SQLite enforces the partial unique index
 * `(id) WHERE _upper IS NULL` per statement; there is no deferred mode. Re-open
 * first and the re-opened row collides with the dead-branch row that is still
 * present, both open for the same business key: SQLITE_CONSTRAINT_UNIQUE.
 * Deleting the dead branch first removes that row, so the re-open is
 * conflict-free.
 *
 * This is not a stylistic ordering and it is not safe to "tidy up". Both
 * directions are pinned by `test/revert-order.test.ts`, executed against a real
 * SQLite engine, because that is the only thing that catches it.
 */
export function revertToStatements(
	declarations: Iterable<EntityDeclaration> | ReadonlyMap<string, NormalizedEntity>,
	keepUpTo: number,
	names: TableNames,
): Statement[] {
	const entities = asEntityMap(declarations);
	const statements: Statement[] = [];

	for (const entity of entities.values()) {
		const table = names.entity(entity.name);
		// A) drop versions opened above the fork (this clears their open rows)
		statements.push({sql: `DELETE FROM ${table} WHERE ${LOWER} > ?`, args: [keepUpTo]});
		// B) re-open versions closed above the fork
		statements.push({sql: `UPDATE ${table} SET ${UPPER} = NULL WHERE ${UPPER} > ?`, args: [keepUpTo]});
	}

	// the block table is this generation's own too, so a revert here cannot delete
	// a block another generation on the same chain still needs (ADR-0053)
	statements.push({sql: `DELETE FROM ${names.blocks} WHERE number > ?`, args: [keepUpTo]});
	return statements;
}

function asEntityMap(
	declarations: Iterable<EntityDeclaration> | ReadonlyMap<string, NormalizedEntity>,
): ReadonlyMap<string, NormalizedEntity> {
	return declarations instanceof Map ? declarations : normalizeEntities(declarations as Iterable<EntityDeclaration>);
}
