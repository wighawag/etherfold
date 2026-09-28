import {
	answeredRow,
	planChildren,
	planFind,
	RowsExaminedBoundError,
	type Accessor,
	type ChildrenQuery,
	type FindQuery,
	type Page,
	type PlannedOrder,
	type PlannedWhere,
} from '@etherfold/accessor';
import {boundedListing, type NormalizedEntity} from '@etherfold/state-store';
import {walk} from './idb.js';
import {above, CURRENT, startingWith, UPPER_INDEX, VERSIONS, type CurrentRecord, type VersionRecord} from './keys.js';

/**
 * ## The accessor seam on IndexedDB, rung 1: a bounded scan (ADR-0099)
 *
 * IndexedDB has no query planner, so this accessor SCANS: the queried entity's
 * key range in the live set (`[entity, ...]`, which is exactly that entity's
 * rows because the entity name leads every key, `keys.ts`), filtered in memory
 * by the planned predicate, ordered in memory, and cut to the limit. The query
 * is planned by `@etherfold/accessor`'s `planFind` / `planChildren`, the planner
 * every backend calls, so an operand arrives here already in the form the
 * column STORES (a `u256` as its 32 big-endian bytes) and every comparison with
 * null has already been folded to "matches nothing".
 *
 * The in-memory rules are the seam's, written out because IndexedDB's own key
 * order is not them: text compares as UTF-8 bytes (code point order, SQLite's
 * BINARY collation), NOT as JavaScript's UTF-16 `<` nor IndexedDB's UTF-16 key
 * order, which disagree on a supplementary-plane character against U+E000 to
 * U+FFFF; bytes compare bytewise, a prefix first (so a `u256` orders
 * numerically); numbers as numbers; nulls first ascending and last descending;
 * ties by the declared id ascending, each column as UTF-8 bytes. The id order is
 * applied by SORTING even when no order is asked for, because the order the
 * cursor walks the keys in is UTF-16 and would cut a different page.
 *
 * ## The bound is ROWS EXAMINED, and it refuses
 *
 * A scan examining more rows than the declared bound (default 25,000,
 * `DEFAULT_ROWS_EXAMINED_BOUND`, configurable per deployment) stops and throws
 * the seam's `RowsExaminedBoundError`, never answering slower as the data grows.
 * It is this backend's alone: SQLite plans and answers the same query, and that
 * difference is documented rather than hidden.
 *
 * ## As of a block: current plus the delta since it
 *
 * As of block B, a row's version live then is either its CURRENT version, if
 * that opened at or before B, or a version that CLOSED above B and had opened at
 * or before it. So the answer is the current scan (keeping rows with `lower <=
 * B`) plus the versions in the `upper` index above B (keeping this entity's with
 * `lower <= B`), merged and then sorted and cut: the cost is the churn since B,
 * not the depth of history. The two sets cannot overlap, because a row whose
 * version live at B closed above B has a current version that opened above B.
 * The delta is bounded by the same number as the scan, separately.
 *
 * The `upper` index is keyed by block across EVERY entity, so the delta examines
 * the whole database's churn since B and not the queried entity's: an as-of
 * query on a quiet entity can be refused because others changed. ADR-0099
 * accepts that (an entity-scoped index would cost a `versionchange`), and the
 * refusal says it.
 *
 * ## Relations
 *
 * A page of parents' children is one bounded key-range scan PER PARENT (the
 * child's key starts with the parent's whole key, ADR-0098), each bounded on its
 * own and each cut to the limit on its own, all in one transaction; as of a
 * block, one delta serves the whole page.
 *
 * Not part of `StateStore` (ADR-0021): it is reached through
 * `IndexedDBStateStore.accessor()`.
 */

/**
 * The rows-examined bound an IndexedDB accessor refuses past when a deployment
 * declares none (ADR-0099): generous against the measured live set of the
 * reference workload (4,072 rows), and small enough that a scan of it stays an
 * interactive answer on a phone.
 */
export const DEFAULT_ROWS_EXAMINED_BOUND = 25_000;

/** What a deployment configures about its IndexedDB accessor. */
export type IndexedDBAccessorOptions = {
	/**
	 * The most rows one scan examines before the query is refused with
	 * `RowsExaminedBoundError` (ADR-0099). Defaults to
	 * `DEFAULT_ROWS_EXAMINED_BOUND` (25,000); a whole number, at least 1.
	 *
	 * It bounds, each on its own: the scan of the queried entity at the tip, the
	 * scan of ONE parent's children in a relation page, and the as-of delta (the
	 * versions of every entity closed above the block).
	 */
	readonly rowsExaminedBound?: number;
};

/** The accessor, and the bound it was configured with, so a deployment can report it. */
export type IndexedDBAccessor = Accessor & {
	readonly rowsExaminedBound: number;
};

/** What the accessor needs of the store it reads. */
export type IndexedDBAccessorContext = {
	readonly entities: ReadonlyMap<string, NormalizedEntity>;
	database(): Promise<IDBDatabase>;
	/** The store's `oneTransactionAtATime` wait: a promise of the commit, or `undefined`. */
	commitIfSerialising(tx: IDBTransaction): Promise<void> | undefined;
	/** Refuse a block this store does not retain (`BlockNotRetainedError`), as every as-of read does. */
	assertRetained(at: number): Promise<void>;
};

type Row = Record<string, unknown>;

/** An accessor over one IndexedDB store. */
export function indexedDBAccessor(
	context: IndexedDBAccessorContext,
	options: IndexedDBAccessorOptions = {},
): IndexedDBAccessor {
	const bound = options.rowsExaminedBound ?? DEFAULT_ROWS_EXAMINED_BOUND;
	if (!Number.isInteger(bound) || bound < 1) {
		throw new Error(
			`rowsExaminedBound must be a whole number of rows, at least 1, got ${JSON.stringify(bound) ?? String(bound)}`,
		);
	}

	/** Run `read` in one read transaction over the stores it needs, and honour `oneTransactionAtATime`. */
	async function reading<R>(at: number | undefined, read: (tx: IDBTransaction) => Promise<R>): Promise<R> {
		const db = await context.database();
		const tx = db.transaction(at === undefined ? [CURRENT] : [CURRENT, VERSIONS], 'readonly');
		const settled = context.commitIfSerialising(tx);
		let outcome: {ok: true; value: R} | {ok: false; error: unknown};
		try {
			outcome = {ok: true, value: await read(tx)};
		} catch (error) {
			outcome = {ok: false, error};
		}
		await settled;
		if (!outcome.ok) throw outcome.error;
		return outcome.value;
	}

	return {
		rowsExaminedBound: bound,

		async find<T>(query: FindQuery): Promise<Page<T>> {
			const planned = planFind(context.entities, query);
			const {entity, where, at} = planned;
			if (at !== undefined) await context.assertRetained(at);
			const rows = await reading(at, async (tx) => {
				const matched = await scanCurrent(tx, entity, [], where, at, bound, () => tipRefusal(entity, bound, at));
				if (at !== undefined) {
					for (const group of (await scanDelta(tx, entity, at, where, bound, undefined)).values()) {
						matched.push(...group);
					}
				}
				return matched;
			});
			return pageOf<T>(entity, rows, planned.orderBy, planned.limit);
		},

		async children<T>(query: ChildrenQuery): Promise<Page<T>[]> {
			const planned = planChildren(context.entities, query);
			const {entity, parent, where, at} = planned;
			if (at !== undefined) await context.assertRetained(at);
			if (planned.parents.length === 0) return [];

			const byParent = await reading(at, async (tx) => {
				const grouped = new Map<string, Row[]>();
				for (const key of planned.distinctParents) {
					grouped.set(
						JSON.stringify(key),
						await scanCurrent(tx, entity, key, where, at, bound, () => childrenRefusal(entity, parent, key, bound)),
					);
				}
				if (at !== undefined) {
					const wanted = new Set(grouped.keys());
					for (const [key, rows] of await scanDelta(tx, entity, at, where, bound, {parent, wanted})) {
						grouped.get(key)!.push(...rows);
					}
				}
				return grouped;
			});
			return planned.parents.map((key) =>
				pageOf<T>(entity, byParent.get(JSON.stringify(key)) ?? [], planned.orderBy, planned.limit),
			);
		},
	};
}

/**
 * The live rows of `entity` whose key starts with `prefix` (none: every row of
 * the entity) that match `where`, and, as of a block, that were already live
 * then. Throws `refuse()` past the bound.
 */
async function scanCurrent(
	tx: IDBTransaction,
	entity: NormalizedEntity,
	prefix: readonly string[],
	where: PlannedWhere | undefined,
	at: number | undefined,
	bound: number,
	refuse: () => Error,
): Promise<Row[]> {
	const matched: Row[] = [];
	let examined = 0;
	await walk(tx.objectStore(CURRENT).openCursor(startingWith([entity.name, ...prefix])), (cursor) => {
		if (++examined > bound) return 'stop';
		const record = cursor.value as CurrentRecord;
		if ((at === undefined || record.lower <= at) && matches(where, record.values)) matched.push(record.values);
		return 'continue';
	});
	if (examined > bound) throw refuse();
	return matched;
}

/**
 * The versions of `entity` that were live as of `at` and have CLOSED since,
 * matching `where`: the `upper` index above `at`, which holds every entity's
 * closed versions, so every one of them counts against the bound. Grouped by the
 * parent's key when `relation` is given (and only the wanted parents kept), else
 * all under one key.
 */
async function scanDelta(
	tx: IDBTransaction,
	entity: NormalizedEntity,
	at: number,
	where: PlannedWhere | undefined,
	bound: number,
	relation: {readonly parent: NormalizedEntity; readonly wanted: ReadonlySet<string>} | undefined,
): Promise<Map<string, Row[]>> {
	const grouped = new Map<string, Row[]>();
	let examined = 0;
	await walk(tx.objectStore(VERSIONS).index(UPPER_INDEX).openCursor(above(at)), (cursor) => {
		if (++examined > bound) return 'stop';
		if ((cursor.primaryKey as IDBValidKey[])[0] !== entity.name) return 'continue';
		const version = cursor.value as VersionRecord;
		if (version.lower > at || !matches(where, version.values)) return 'continue';
		const key = relation ? JSON.stringify(relation.parent.id.map((column) => version.values[column])) : '';
		if (relation && !relation.wanted.has(key)) return 'continue';
		let rows = grouped.get(key);
		if (!rows) grouped.set(key, (rows = []));
		rows.push(version.values);
		return 'continue';
	});
	if (examined > bound) throw deltaRefusal(entity, at, bound);
	return grouped;
}

function tipRefusal(entity: NormalizedEntity, bound: number, at: number | undefined): RowsExaminedBoundError {
	return new RowsExaminedBoundError(
		entity.name,
		bound,
		`the query on entity ${entity.name}${at === undefined ? '' : ` as of block ${at}`} was refused: it would ` +
			`examine more than ${bound} of its rows, which is this IndexedDB accessor's rows-examined bound (ADR-0099). ` +
			`This backend has no query planner and answers by scanning the entity, so a set past the bound is refused ` +
			`rather than answered slower as it grows; a backend with a query planner (SQLite) answers the same query. ` +
			`Raise rowsExaminedBound for this deployment, or read fewer rows of ${entity.name}.`,
	);
}

function childrenRefusal(
	entity: NormalizedEntity,
	parent: NormalizedEntity,
	key: readonly string[],
	bound: number,
): RowsExaminedBoundError {
	return new RowsExaminedBoundError(
		entity.name,
		bound,
		`the children of ${parent.name} ${JSON.stringify(key)} (entity ${entity.name}) were refused: that parent has ` +
			`more than ${bound} of them, and this IndexedDB accessor scans one parent's children at a time under its ` +
			`rows-examined bound (ADR-0099); a backend with a query planner (SQLite) answers the same query. Raise ` +
			`rowsExaminedBound for this deployment.`,
	);
}

function deltaRefusal(entity: NormalizedEntity, at: number, bound: number): RowsExaminedBoundError {
	return new RowsExaminedBoundError(
		entity.name,
		bound,
		`the query on entity ${entity.name} as of block ${at} was refused: more than ${bound} versions have been ` +
			`closed since block ${at}, and this IndexedDB accessor answers as of a block from the current rows plus ` +
			`that delta, under its rows-examined bound (ADR-0099). The delta counts the changes to every entity in ` +
			`the database since the block, not only to ${entity.name}, so a query on an entity that has not changed ` +
			`can be refused because others have. Ask as of a more recent block (or the tip), or raise ` +
			`rowsExaminedBound for this deployment.`,
	);
}

/** Sort, cut to `limit` (plus the one that says whether it cut), and answer as the seam answers. */
function pageOf<T>(entity: NormalizedEntity, rows: Row[], orderBy: PlannedOrder | undefined, limit: number): Page<T> {
	rows.sort(rowOrder(entity, orderBy));
	return boundedListing(
		rows.slice(0, limit + 1).map((row) => answeredRow(entity, row) as T),
		limit,
	);
}

/** The planned order, nulls placed as the seam promises, then the declared id ascending as UTF-8. */
function rowOrder(entity: NormalizedEntity, orderBy: PlannedOrder | undefined): (a: Row, b: Row) => number {
	return (a, b) => {
		if (orderBy) {
			const ordered = compareOrdered(a[orderBy.column] ?? null, b[orderBy.column] ?? null, orderBy.direction);
			if (ordered !== 0) return ordered;
		}
		for (const column of entity.id) {
			const tie = compareStored(a[column], b[column]);
			if (tie !== 0) return tie;
		}
		return 0;
	};
}

/** Nulls first ascending and last descending, which is one rule: null is the smallest value. */
function compareOrdered(a: unknown, b: unknown, direction: 'asc' | 'desc'): number {
	const ascending = a === null ? (b === null ? 0 : -1) : b === null ? 1 : compareStored(a, b);
	return direction === 'asc' ? ascending : -ascending;
}

/** Whether a stored row matches a planned predicate. A null field matches no comparison. */
function matches(where: PlannedWhere | undefined, values: Row): boolean {
	if (where === undefined) return true;
	switch (where.kind) {
		case 'and':
			return where.of.every((one) => matches(one, values));
		case 'or':
			return where.of.some((one) => matches(one, values));
		case 'isNull':
			return (values[where.column] ?? null) === null ? where.isNull : !where.isNull;
		case 'in': {
			const value = values[where.column] ?? null;
			return value !== null && where.operands.some((operand) => compareStored(value, operand) === 0);
		}
		case 'compare': {
			const value = values[where.column] ?? null;
			if (value === null) return false;
			const compared = compareStored(value, where.operand);
			switch (where.op) {
				case 'eq':
					return compared === 0;
				case 'ne':
					return compared !== 0;
				case 'lt':
					return compared < 0;
				case 'lte':
					return compared <= 0;
				case 'gt':
					return compared > 0;
				case 'gte':
					return compared >= 0;
			}
		}
	}
}

/**
 * Two non-null STORED values of one column, in the seam's order: text as UTF-8
 * bytes, numbers as numbers, bytes bytewise. The planner has already refused an
 * operand of the wrong kind, so two different kinds meeting here is a defect and
 * is thrown rather than guessed at.
 */
function compareStored(a: unknown, b: unknown): number {
	if (typeof a === 'string' && typeof b === 'string') return compareUtf8(a, b);
	if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
	const left = bytesOf(a);
	const right = bytesOf(b);
	if (left && right) return compareBytes(left, right);
	throw new Error(`the IndexedDB accessor cannot compare a stored ${kindOf(a)} with a ${kindOf(b)}`);
}

/**
 * Two strings in the order of their UTF-8 bytes, which is code point order,
 * without encoding either.
 *
 * UTF-16 code units already order like code points except where a surrogate
 * (U+D800 to U+DFFF, the halves of a supplementary-plane character) meets a
 * unit from U+E000 to U+FFFF: as units the surrogate is smaller, as code points
 * the character it belongs to is larger. So at the first unit that differs,
 * lift surrogates above U+FFFF's range and compare.
 */
function compareUtf8(a: string, b: string): number {
	const length = Math.min(a.length, b.length);
	for (let index = 0; index < length; index++) {
		const x = a.charCodeAt(index);
		const y = b.charCodeAt(index);
		if (x !== y) return codePointRank(x) - codePointRank(y);
	}
	return a.length - b.length;
}

function codePointRank(unit: number): number {
	return unit >= 0xd800 && unit <= 0xdfff ? unit + 0x10000 : unit;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const length = Math.min(a.length, b.length);
	for (let index = 0; index < length; index++) {
		if (a[index] !== b[index]) return a[index]! - b[index]!;
	}
	return a.length - b.length;
}

function bytesOf(value: unknown): Uint8Array | undefined {
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	return undefined;
}

function kindOf(value: unknown): string {
	return value === null ? 'null' : value instanceof Uint8Array ? 'blob' : typeof value;
}
