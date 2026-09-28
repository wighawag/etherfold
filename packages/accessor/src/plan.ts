import {
	assertBlockNumber,
	describeField,
	fieldStorage,
	idValues,
	mustGet,
	semanticTypeOf,
	type FieldDeclaration,
	type NormalizedEntity,
} from '@etherfold/state-store';
import type {ChildrenQuery, ComparisonOperator, FindQuery, Operand, OrderBy, Selection, Where} from './types.js';

/**
 * ## The one planner every backend calls
 *
 * A query is checked and translated ONCE, here, into the form a backend
 * executes: every field resolved against the declaration, every operand turned
 * into the value the backend STORES for that field (a `u256` into its canonical
 * 32 big-endian bytes, an id given as a number into the string the seam keys it
 * by), and every comparison with null folded to "matches nothing". A backend
 * then compares stored forms with stored forms and has no semantic type, no
 * id-stringification rule and no null rule of its own to get wrong, and a query
 * one backend refuses is refused by every backend in the same sentence.
 */

/** An operand as the backend stores it: text, a number, or bytes. Never null: a null operand is planned away. */
export type StoredOperand = string | number | Uint8Array;

/**
 * A planned predicate. `{kind: 'or', of: []}` matches NOTHING and `{kind: 'and',
 * of: []}` matches everything, which is how a comparison with null (false) and
 * an `in` of no values are expressed without a kind of their own.
 */
export type PlannedWhere =
	| {readonly kind: 'and' | 'or'; readonly of: readonly PlannedWhere[]}
	| {
			readonly kind: 'compare';
			readonly column: string;
			readonly op: ComparisonOperator;
			readonly operand: StoredOperand;
	  }
	| {readonly kind: 'in'; readonly column: string; readonly operands: readonly StoredOperand[]}
	| {readonly kind: 'isNull'; readonly column: string; readonly isNull: boolean};

/** A planned order: one column, and which way. Ties are always broken by the declared id, ascending. */
export type PlannedOrder = {readonly column: string; readonly direction: 'asc' | 'desc'};

/** A planned selection over one entity. */
export type PlannedSelection = {
	/** The entity the rows are OF (the child, for `children`). */
	readonly entity: NormalizedEntity;
	readonly where: PlannedWhere | undefined;
	readonly orderBy: PlannedOrder | undefined;
	readonly limit: number;
	/** A block height, or `undefined` for the tip. */
	readonly at: number | undefined;
};

/** A planned `find`. */
export type PlannedFind = PlannedSelection;

/** A planned `children`: the selection over the CHILD, and the parents it is for. */
export type PlannedChildren = PlannedSelection & {
	readonly parent: NormalizedEntity;
	readonly relation: string;
	/** Each parent's key as the child's leading id values, in the order given (duplicates kept). */
	readonly parents: readonly (readonly string[])[];
	/** The same keys without duplicates, in first-seen order: what a backend reads. */
	readonly distinctParents: readonly (readonly string[])[];
};

/** Check and plan a `find` against the store's declarations. */
export function planFind(entities: ReadonlyMap<string, NormalizedEntity>, query: FindQuery): PlannedFind {
	const entity = mustGet(entities, query?.entity);
	return planSelection(entity, query);
}

/** Check and plan a `children` against the store's declarations. */
export function planChildren(entities: ReadonlyMap<string, NormalizedEntity>, query: ChildrenQuery): PlannedChildren {
	const parent = mustGet(entities, query?.entity);
	const child = [...entities.values()].find(
		(candidate) => candidate.parent?.entity === parent.name && candidate.parent.as === query.relation,
	);
	if (!child) {
		const declared = [...entities.values()].filter((candidate) => candidate.parent?.entity === parent.name);
		throw new Error(
			`entity ${parent.name} has no relation ${JSON.stringify(query.relation)}: a relation is declared on the ` +
				`child, as parent: {entity: '${parent.name}', as}, and the collections declared on it are ` +
				`(${declared.map((one) => `${one.parent!.as} of ${one.name}`).join(', ') || 'none'}).`,
		);
	}
	if (!Array.isArray(query.parents)) {
		throw new Error(`children of ${parent.name}.${query.relation} needs parents as an array of keys`);
	}
	// the parent's DECLARED id columns, whatever else the caller's object carries,
	// so a key cannot narrow the collection into something that is not one
	// parent's children (the read surface's `parentPrefix`, the same rule)
	const parents = query.parents.map((id) => idValues(parent, id));
	const seen = new Set<string>();
	const distinctParents = parents.filter((key) => {
		const text = JSON.stringify(key);
		if (seen.has(text)) return false;
		seen.add(text);
		return true;
	});
	return {...planSelection(child, query), parent, relation: query.relation, parents, distinctParents};
}

function planSelection(entity: NormalizedEntity, query: Selection): PlannedSelection {
	const {limit, at} = query;
	if (!Number.isInteger(limit) || limit < 1) {
		throw new Error(
			`a query on ${entity.name} needs a limit that is a whole number of rows, at least 1, got ${JSON.stringify(limit)}.`,
		);
	}
	if (at !== undefined) assertBlockNumber(at);
	return {
		entity,
		where: query.where === undefined ? undefined : planWhere(entity, query.where),
		orderBy: query.orderBy === undefined ? undefined : planOrder(entity, query.orderBy),
		limit,
		at,
	};
}

/** The declared field a column is, or `'id'` for an id column. */
type ColumnKind = 'id' | FieldDeclaration;

function columnKind(entity: NormalizedEntity, column: unknown, what: string): ColumnKind {
	if (typeof column === 'string') {
		if (entity.id.includes(column)) return 'id';
		if (Object.hasOwn(entity.fields, column)) return entity.fields[column]!;
	}
	throw new Error(
		`${what} names ${JSON.stringify(column)}, which entity ${entity.name} does not declare: it may name an id ` +
			`column (${entity.id.join(', ')}) or a declared field (${Object.keys(entity.fields).join(', ') || 'none'}).`,
	);
}

function planOrder(entity: NormalizedEntity, orderBy: OrderBy): PlannedOrder {
	columnKind(entity, orderBy?.field, 'orderBy');
	const direction = orderBy.direction ?? 'asc';
	if (direction !== 'asc' && direction !== 'desc') {
		throw new Error(
			`orderBy on ${entity.name}.${orderBy.field} has direction ${JSON.stringify(direction)}: asc or desc`,
		);
	}
	return {column: orderBy.field, direction};
}

const COMPARISONS: ReadonlySet<string> = new Set<ComparisonOperator>(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']);

/** Matches nothing: what a comparison with null is. */
const NOTHING: PlannedWhere = Object.freeze({kind: 'or', of: Object.freeze([])});

function planWhere(entity: NormalizedEntity, where: Where): PlannedWhere {
	if (where === null || typeof where !== 'object') {
		throw new Error(`a predicate on ${entity.name} must be an object, got ${JSON.stringify(where)}`);
	}
	if ('and' in where || 'or' in where) {
		const kind = 'and' in where ? 'and' : 'or';
		const of = (where as Record<string, unknown>)[kind];
		if (!Array.isArray(of) || Object.keys(where).length !== 1) {
			throw new Error(`a predicate on ${entity.name} with ${kind} takes an array of predicates and nothing else`);
		}
		return {kind, of: of.map((one: Where) => planWhere(entity, one))};
	}
	const kind = columnKind(entity, where.field, `a predicate on ${entity.name}`);
	const column = where.field;
	if (where.op === 'isNull') {
		if (typeof where.value !== 'boolean') {
			throw new Error(`isNull on ${entity.name}.${column} takes true (IS NULL) or false (IS NOT NULL)`);
		}
		return {kind: 'isNull', column, isNull: where.value};
	}
	if (where.op === 'in') {
		if (!Array.isArray(where.values)) {
			throw new Error(`in on ${entity.name}.${column} takes an array of values`);
		}
		const operands = where.values
			.filter((value) => value !== null)
			.map((value) => storedOperand(entity, column, kind, value));
		return operands.length === 0 ? NOTHING : {kind: 'in', column, operands};
	}
	if (!COMPARISONS.has(where.op)) {
		throw new Error(
			`a predicate on ${entity.name}.${column} has operator ${JSON.stringify((where as {op: unknown}).op)}; the ` +
				`operators are eq, ne, lt, lte, gt, gte, in and isNull, combined with and / or.`,
		);
	}
	if (where.value === null) return NOTHING;
	return {kind: 'compare', column, op: where.op, operand: storedOperand(entity, column, kind, where.value)};
}

/**
 * An operand as the column STORES it, or a refusal naming the field and what it
 * holds.
 *
 * An operand of the wrong kind is refused rather than compared, because engines
 * disagree about comparing across kinds (SQLite orders every INTEGER before
 * every TEXT before every BLOB, IndexedDB orders keys by type differently, and
 * memory would compare with `<`), so a mismatched query is one that could not
 * mean the same thing on two backends.
 */
function storedOperand(entity: NormalizedEntity, column: string, kind: ColumnKind, value: Operand): StoredOperand {
	const refuse = (holds: string, reason?: string): never => {
		throw new Error(
			`a predicate on ${entity.name}.${column} compares it with ${describeOperand(value)}, and it holds ${holds}` +
				(reason ? `: ${reason}` : '') +
				'.',
		);
	};
	if (kind === 'id') {
		if (typeof value === 'string') return value;
		if (typeof value === 'number' && Number.isFinite(value)) return String(value);
		return refuse('an id value (a string, or a number stringified as the seam stringifies an id)');
	}
	const semantic = semanticTypeOf(kind);
	if (semantic) {
		try {
			return semantic.encode(value) as StoredOperand;
		} catch (error) {
			return refuse(`a ${describeField(kind)}`, (error as Error).message);
		}
	}
	switch (fieldStorage(kind)) {
		case 'text':
			return typeof value === 'string' ? value : refuse('text (a string)');
		case 'integer':
		case 'real':
			return typeof value === 'number' && Number.isFinite(value) ? value : refuse('a number (finite)');
		case 'blob':
			return value instanceof Uint8Array ? value : refuse('a blob (a Uint8Array)');
	}
}

function describeOperand(value: unknown): string {
	if (typeof value === 'bigint') return `${value}n`;
	if (value instanceof Uint8Array) return `${value.length} bytes`;
	return value === undefined ? 'undefined' : (JSON.stringify(value) ?? String(value));
}
