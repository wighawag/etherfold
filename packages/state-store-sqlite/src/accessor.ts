import {
	answeredRow,
	planChildren,
	planFind,
	type Accessor,
	type ChildrenQuery,
	type FindQuery,
	type Page,
	type PlannedOrder,
	type PlannedSelection,
	type PlannedWhere,
} from '@etherfold/accessor';
import {boundedListing, type NormalizedEntity} from '@etherfold/state-store';
import type {TableNames} from './ddl.js';
import {quoted} from './identifiers.js';
import {AS_OF_PREDICATE, CURRENT_PREDICATE} from './statements.js';
import type {Statement} from './types.js';

/**
 * ## The accessor seam on SQLite (ADR-0099)
 *
 * SQLite has a query planner, so this accessor GENERATES SQL and lets it plan:
 * the planned query (`@etherfold/accessor`'s `planFind` / `planChildren`, which
 * every backend calls, so a refusal is the same sentence everywhere) becomes one
 * `SELECT` over the entity's versioned table, under the validity predicate of
 * the tip or of the pinned block. It declares NO rows-examined bound: a server
 * answers what it can serve, and the bound is the IndexedDB accessor's alone.
 *
 * Every rule the seam fixes is SQLite's own behaviour, which is why this file is
 * short: a comparison with NULL is not true, `ORDER BY` puts NULLs first
 * ascending and last descending, a TEXT column compares under BINARY (memcmp of
 * UTF-8), a BLOB compares bytewise (so a `u256` in its canonical 32 big-endian
 * bytes orders numerically, ADR-0098), and INTEGER and REAL compare as numbers.
 * The null order is still spelled out (`NULLS FIRST` / `NULLS LAST`), so the
 * statement says what the seam promises rather than leaning on a default.
 *
 * Not part of `StateStore`: it is reached through `VersionedStateStore.accessor()`,
 * beside this backend's raw-SQL `queryCurrent` / `queryAsOf`, which stay.
 */

/** What the accessor needs of the store it reads: its declarations, table names and reads. */
export type SqliteAccessorContext = {
	readonly entities: ReadonlyMap<string, NormalizedEntity>;
	readonly names: TableNames;
	/**
	 * The most parameters one statement may bind (the store's
	 * `maxRowsPerStatement`, set by the tightest hosted backend): a page of
	 * parents is split into as few `IN` queries as fit under it, which is ONE for
	 * any page a resolver asks for in practice.
	 */
	readonly maxParams: number;
	select(statement: Statement): Promise<Record<string, unknown>[]>;
	/** Refuse a block this store does not retain (`BlockNotRetainedError`), as every as-of read does. */
	assertRetained(at: number): Promise<void>;
};

/** An accessor over one SQLite store. */
export function sqliteAccessor(context: SqliteAccessorContext): Accessor {
	return {
		async find<T>(query: FindQuery): Promise<Page<T>> {
			const planned = planFind(context.entities, query);
			if (planned.at !== undefined) await context.assertRetained(planned.at);
			const rows = await context.select(findStatement(planned, context.names));
			return page<T>(planned.entity, rows, planned.limit);
		},

		async children<T>(query: ChildrenQuery): Promise<Page<T>[]> {
			const planned = planChildren(context.entities, query);
			if (planned.at !== undefined) await context.assertRetained(planned.at);
			if (planned.parents.length === 0) return [];

			const columns = planned.parent.id;
			const fixed = paramsOf(planned);
			const perStatement = Math.max(1, Math.floor((context.maxParams - fixed) / columns.length));
			const byParent = new Map<string, Record<string, unknown>[]>();
			for (let start = 0; start < planned.distinctParents.length; start += perStatement) {
				const chunk = planned.distinctParents.slice(start, start + perStatement);
				for (const row of await context.select(childrenStatement(planned, chunk, context.names))) {
					const key = JSON.stringify(columns.map((column) => row[column]));
					let rows = byParent.get(key);
					if (!rows) byParent.set(key, (rows = []));
					rows.push(row);
				}
			}
			return planned.parents.map((key) =>
				page<T>(planned.entity, byParent.get(JSON.stringify(key)) ?? [], planned.limit),
			);
		},
	};
}

/**
 * `find` as one statement: the validity predicate, the planned predicate, the
 * planned order with the id as tie break, and `limit + 1` rows, the extra one
 * being what turns "there may be more" into `truncated`.
 */
export function findStatement(planned: PlannedSelection, names: TableNames): Statement {
	const validity = validityOf(planned.at);
	const where = planned.where ? whereOf(planned.where) : undefined;
	return {
		sql:
			`SELECT * FROM ${names.entity(planned.entity.name)} WHERE ${validity.sql}` +
			(where ? ` AND ${where.sql}` : '') +
			` ORDER BY ${orderOf(planned.entity, planned.orderBy)} LIMIT ?`,
		args: [...validity.args, ...(where?.args ?? []), planned.limit + 1],
	};
}

/**
 * The children of a chunk of parents as ONE statement: the parents' keys as one
 * `IN` (over the column, or over row values for a key of several columns), and
 * the per-parent bound as a window: each child is ranked within its parent by
 * the planned order, and a parent's rows past `limit + 1` are never returned.
 * The bound is therefore per PARENT inside one query, so one prolific parent
 * cannot starve the others (ADR-0099).
 */
export function childrenStatement(
	planned: PlannedSelection & {readonly parent: NormalizedEntity},
	parents: readonly (readonly string[])[],
	names: TableNames,
): Statement {
	const validity = validityOf(planned.at);
	const where = planned.where ? whereOf(planned.where) : undefined;
	const columns = planned.parent.id.map(quoted);
	const keys =
		columns.length === 1
			? `${columns[0]} IN (${parents.map(() => '?').join(', ')})`
			: `(${columns.join(', ')}) IN (VALUES ${parents.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ')})`;
	const inner =
		`SELECT *, ROW_NUMBER() OVER (PARTITION BY ${columns.join(', ')} ORDER BY ${orderOf(planned.entity, planned.orderBy)}) AS ${RANK} ` +
		`FROM ${names.entity(planned.entity.name)} WHERE ${validity.sql} AND ${keys}` +
		(where ? ` AND ${where.sql}` : '');
	return {
		sql: `SELECT * FROM (${inner}) WHERE ${RANK} <= ? ORDER BY ${columns.join(', ')}, ${RANK}`,
		args: [...validity.args, ...parents.flat(), ...(where?.args ?? []), planned.limit + 1],
	};
}

/** The window's rank column: in the `_` namespace, which no declared name may take. */
const RANK = '_rank';

/** How many parameters a children statement binds besides the parents' keys. */
function paramsOf(planned: PlannedSelection): number {
	return validityOf(planned.at).args.length + (planned.where ? whereOf(planned.where).args.length : 0) + 1;
}

function validityOf(at: number | undefined): Statement {
	return at === undefined ? {sql: CURRENT_PREDICATE, args: []} : {sql: `(${AS_OF_PREDICATE})`, args: [at, at]};
}

const SQL_OPERATORS = {eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>='} as const;

/**
 * A planned predicate as SQL. The planner has already folded every comparison
 * with null to an empty `or`, so what is left is SQL's own semantics: a NULL
 * column makes a comparison NULL, which `WHERE` treats as false, and with no
 * `NOT` in the language that is the seam's "a comparison with null is false".
 */
export function whereOf(where: PlannedWhere): Statement {
	switch (where.kind) {
		case 'and':
		case 'or': {
			if (where.of.length === 0) return {sql: where.kind === 'and' ? '1' : '0', args: []};
			const parts = where.of.map(whereOf);
			return {
				sql: `(${parts.map((part) => part.sql).join(where.kind === 'and' ? ' AND ' : ' OR ')})`,
				args: parts.flatMap((part) => part.args),
			};
		}
		case 'compare':
			return {sql: `${quoted(where.column)} ${SQL_OPERATORS[where.op]} ?`, args: [where.operand]};
		case 'in':
			return {
				sql: `${quoted(where.column)} IN (${where.operands.map(() => '?').join(', ')})`,
				args: [...where.operands],
			};
		case 'isNull':
			return {sql: `${quoted(where.column)} IS ${where.isNull ? '' : 'NOT '}NULL`, args: []};
	}
}

/** The planned order, nulls placed as the seam promises, then the declared id ascending. */
function orderOf(entity: NormalizedEntity, orderBy: PlannedOrder | undefined): string {
	const tieBreak = entity.id.map((column) => `${quoted(column)} ASC`);
	if (!orderBy) return tieBreak.join(', ');
	const first =
		orderBy.direction === 'asc'
			? `${quoted(orderBy.column)} ASC NULLS FIRST`
			: `${quoted(orderBy.column)} DESC NULLS LAST`;
	return [first, ...tieBreak].join(', ');
}

function page<T>(entity: NormalizedEntity, rows: readonly Record<string, unknown>[], limit: number): Page<T> {
	return boundedListing(
		rows.map((row) => answeredRow(entity, row) as T),
		limit,
	);
}
