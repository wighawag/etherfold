import type {OrderBy, Where} from '@etherfold/accessor';
import {
	fieldStorage,
	normalizeEntities,
	semanticTypeOf,
	type EntityDeclaration,
	type FieldDeclaration,
	type NormalizedEntity,
} from '@etherfold/state-store';
import SchemaBuilder from '@pothos/core';
import type {GraphQLSchema} from 'graphql';
import {QUERY_ERROR_CODES, QueryRefusal} from './errors.js';
import {schemaNames, type SchemaNames} from './names.js';
import {OperationReads, type BlockAddressArg, type ResolvedRow, type Selection} from './operation.js';
import {BYTES32_SCALAR, BYTES_SCALAR, SAFE_INT_SCALAR, U256_SCALAR} from './scalars.js';

/**
 * ## One schema, built from the declarations (ADR-0099)
 *
 * The declarations are the one schema source (ADR-0098), so the GraphQL schema
 * is DERIVED from them, programmatically, with Pothos over graphql-js, as the
 * research measured: no SDL and no deploy-time codegen. Both tiers build the
 * same schema from the same array, so one typed client serves a server and a
 * browser worker.
 *
 * What each part of a declaration becomes:
 *
 * - an entity: an OBJECT TYPE (its name with the first letter capitalised:
 *   `pool` is `Pool`), whose id columns are `String!` (a business key is
 *   stringified once, at the seam) and whose fields are nullable (a whole-row
 *   write stores an unlisted field as null);
 * - `text` is `String`, `integer` is `SafeInt`, `real` is `Float`, `blob` is
 *   `Bytes` (`0x` hex), a `u256` is `U256` (a decimal string), and an enum is a
 *   GraphQL ENUM (`PoolKind`), its values mapped one to one (ADR-0098 refuses a
 *   value that is not a legal enum name at declaration time);
 * - a relation (declared on the child, `parent: {entity, as}`): a nested
 *   collection named `as` on the parent's type, read through the accessor's
 *   batched `children`, bounded per parent;
 * - and one ROOT list field per entity, named as the entity is (`pool`), never
 *   a guessed plural, for the reason ADR-0098 declares `as` rather than
 *   pluralising.
 *
 * Every list field takes `where` (per column, `{eq, ne, lt, lte, gt, gte, in,
 * isNull}`, combined with `_and` / `_or`), `orderBy` (`{field, direction}`) and
 * a REQUIRED `first` (the accessor's limit: there is no default, because a
 * default bound is a bound nobody chose). A root field also takes `block`, a
 * `BlockAddress` (`@oneOf`: `{number}` or `{hash}`), to answer as of an earlier
 * block; its nested collections read as of the same. A hash the store has no
 * record of is refused (`block-not-recorded`), never answered from another block.
 *
 * The resolvers call the accessor seam and nothing else, so the schema is the
 * same over SQLite and IndexedDB, and a capability a backend cannot serve is
 * the accessor's coded refusal, never a different schema.
 */
export function buildQuerySchema(declarations: readonly EntityDeclaration[]): GraphQLSchema {
	const entities = normalizeEntities(declarations);
	const names = schemaNames(entities);
	const builder = new SchemaBuilder<SchemaTypes>({});

	builder.scalarType('U256', U256_SCALAR);
	builder.scalarType('SafeInt', SAFE_INT_SCALAR);
	builder.scalarType('Bytes', BYTES_SCALAR);
	builder.scalarType('Bytes32', BYTES32_SCALAR);
	// a root field's `block`: a height OR a hash, exactly one (`@oneOf`), as the
	// SQLite store's own `BlockAddress` takes them. A hash names one block of one
	// chain; a height is whatever block holds it now.
	const blockAddress = builder.inputType('BlockAddress', {
		isOneOf: true,
		fields: (t: Loose) => ({
			number: t.field({type: 'SafeInt', required: false}),
			hash: t.field({type: 'Bytes32', required: false}),
		}),
	} as Loose);
	const direction = builder.enumType('OrderDirection', {values: ['asc', 'desc'] as const});

	// the filter input of each value type a column may hold, built once and shared
	const filters = new Map<string, Loose>();
	const filterOf = (valueType: Loose, name: string): Loose => {
		let filter = filters.get(name);
		if (!filter) {
			filter = builder.inputType(name, {
				fields: (t: Loose) => ({
					eq: t.field({type: valueType, required: false}),
					ne: t.field({type: valueType, required: false}),
					lt: t.field({type: valueType, required: false}),
					lte: t.field({type: valueType, required: false}),
					gt: t.field({type: valueType, required: false}),
					gte: t.field({type: valueType, required: false}),
					in: t.field({type: [valueType], required: {list: false, items: false}}),
					isNull: t.boolean({required: false}),
				}),
			});
			filters.set(name, filter);
		}
		return filter;
	};

	// every entity's enums, object type, where and orderBy, first, so relations and
	// recursive predicates can refer to any of them
	const types = new Map<string, EntityTypes>();
	for (const entity of entities.values()) {
		const named = names.entities.get(entity.name)!;
		const enums = new Map<string, Loose>();
		for (const [field, declared] of Object.entries(entity.fields)) {
			if (typeof declared === 'object' && 'enum' in declared) {
				enums.set(field, builder.enumType(named.enums.get(field)!, {values: [...declared.enum] as Loose}));
			}
		}
		types.set(entity.name, {
			object: builder.objectRef<ResolvedRow>(named.object),
			where: builder.inputRef<Loose>(named.where),
			orderBy: builder.inputRef<Loose>(named.orderBy),
			field: builder.enumType(named.field, {values: [...entity.id, ...Object.keys(entity.fields)] as Loose}),
			enums,
		});
	}

	const valueTypeOf = (entity: NormalizedEntity, column: string): {type: Loose; filter: Loose} => {
		if (entity.id.includes(column)) return {type: 'String', filter: filterOf('String', names.filters.String)};
		const enumType = types.get(entity.name)!.enums.get(column);
		if (enumType) {
			return {type: enumType, filter: filterOf(enumType, names.entities.get(entity.name)!.enumFilters.get(column)!)};
		}
		const scalar = scalarOf(entity.fields[column]!);
		return {type: scalar, filter: filterOf(scalar, names.filters[scalar])};
	};

	for (const entity of entities.values()) {
		const own = types.get(entity.name)!;
		const children = [...entities.values()].filter((child) => child.parent?.entity === entity.name);

		own.where.implement({
			fields: (t: Loose) => {
				const fields: Record<string, Loose> = {};
				for (const column of columnsOf(entity)) {
					fields[column] = t.field({type: valueTypeOf(entity, column).filter, required: false});
				}
				fields._and = t.field({type: [own.where], required: {list: false, items: true}});
				fields._or = t.field({type: [own.where], required: {list: false, items: true}});
				return fields;
			},
		});
		own.orderBy.implement({
			fields: (t: Loose) => ({
				field: t.field({type: own.field, required: true}),
				direction: t.field({type: direction, required: false}),
			}),
		});

		own.object.implement({
			fields: (t: Loose) => {
				const fields: Record<string, Loose> = {};
				for (const column of entity.id) {
					fields[column] = t.field({type: 'String', nullable: false, resolve: (row: ResolvedRow) => row[column]});
				}
				for (const column of Object.keys(entity.fields)) {
					fields[column] = t.field({
						type: valueTypeOf(entity, column).type,
						nullable: true,
						resolve: (row: ResolvedRow) => row[column] ?? null,
					});
				}
				for (const child of children) {
					const relation = child.parent!.as;
					const childTypes = types.get(child.name)!;
					fields[relation] = t.field({
						type: [childTypes.object],
						nullable: {list: false, items: false},
						args: listArgs(t, childTypes),
						resolve: (row: ResolvedRow, args: ListArgs, reads: OperationReads) =>
							reads.children(entity, relation, row, selectionOf(child, args)),
					});
				}
				return fields;
			},
		});
	}

	builder.queryType({
		fields: (t: Loose) => {
			const fields: Record<string, Loose> = {};
			for (const entity of entities.values()) {
				const own = types.get(entity.name)!;
				fields[entity.name] = t.field({
					type: [own.object],
					nullable: {list: false, items: false},
					args: {...listArgs(t, own), block: t.arg({type: blockAddress, required: false})},
					resolve: async (_root: unknown, args: ListArgs & {block?: BlockAddressArg | null}, reads: OperationReads) =>
						reads.find(entity, selectionOf(entity, args), await reads.readAt(args.block)),
				});
			}
			return fields;
		},
	});

	// in DECLARATION order (Pothos sorts by default), so the schema reads as the
	// declarations read and an enum's values keep the order they were declared in
	return builder.toSchema({sortSchema: false});
}

/**
 * The GraphQL scalar a plain or semantic field is. An enum never reaches here:
 * it is its own type.
 */
function scalarOf(declared: FieldDeclaration): ScalarName {
	if (semanticTypeOf(declared)?.name === 'u256') return 'U256';
	switch (fieldStorage(declared)) {
		case 'text':
			return 'String';
		case 'integer':
			return 'SafeInt';
		case 'real':
			return 'Float';
		case 'blob':
			return 'Bytes';
	}
}

export type ScalarName = keyof SchemaNames['filters'];

function columnsOf(entity: NormalizedEntity): string[] {
	return [...entity.id, ...Object.keys(entity.fields)];
}

function listArgs(t: Loose, types: EntityTypes): Record<string, Loose> {
	return {
		where: t.arg({type: types.where, required: false}),
		orderBy: t.arg({type: types.orderBy, required: false}),
		first: t.arg.int({required: true}),
	};
}

type ListArgs = {
	where?: Record<string, unknown> | null;
	orderBy?: {field: string; direction?: 'asc' | 'desc' | null} | null;
	first: number;
};

/** A list field's arguments as the accessor's selection, or a coded refusal of what the schema admits and the query cannot mean. */
function selectionOf(entity: NormalizedEntity, args: ListArgs): Selection {
	if (!Number.isInteger(args.first) || args.first < 1) {
		throw new QueryRefusal(
			QUERY_ERROR_CODES.invalidQuery,
			`first on ${entity.name} is ${args.first}: it is how many rows to answer, a whole number at least 1.`,
		);
	}
	const where = whereOf(entity, args.where);
	const orderBy: OrderBy | undefined = args.orderBy
		? {field: args.orderBy.field, direction: args.orderBy.direction ?? 'asc'}
		: undefined;
	return {
		...(where === undefined ? {} : {where}),
		...(orderBy === undefined ? {} : {orderBy}),
		limit: args.first,
	};
}

const COMPARISONS = new Set(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']);

/**
 * A `where` argument as the accessor's predicate. Every key of one object is a
 * conjunct, and so is every operator of one column's filter. An explicit `null`
 * operand is passed through (a comparison with null matches nothing, on every
 * backend); an explicit `null` where a filter, a list or a flag was expected is
 * refused, because it could be read as "is null" and is not.
 */
function whereOf(entity: NormalizedEntity, input: Record<string, unknown> | null | undefined): Where | undefined {
	if (input === null || input === undefined) return undefined;
	const refuse = (what: string, instead: string): never => {
		throw new QueryRefusal(
			QUERY_ERROR_CODES.invalidQuery,
			`where on ${entity.name} gives ${what} as null: ${instead}, or leave it out.`,
		);
	};
	const parts: Where[] = [];
	for (const [key, value] of Object.entries(input)) {
		if (value === undefined) continue;
		if (key === '_and' || key === '_or') {
			if (value === null) refuse(key, 'give a list of predicates');
			const of = (value as Record<string, unknown>[]).map((one) => whereOf(entity, one) ?? {and: []});
			parts.push(key === '_and' ? {and: of} : {or: of});
			continue;
		}
		if (value === null) refuse(key, 'to match a null field use {isNull: true}');
		for (const [op, operand] of Object.entries(value as Record<string, unknown>)) {
			if (operand === undefined) continue;
			if (op === 'in') {
				if (operand === null) refuse(`${key}.in`, 'give a list of values');
				parts.push({field: key, op: 'in', values: operand as never[]});
			} else if (op === 'isNull') {
				if (operand === null) refuse(`${key}.isNull`, 'give true (is null) or false (is not null)');
				parts.push({field: key, op: 'isNull', value: operand as boolean});
			} else if (COMPARISONS.has(op)) {
				parts.push({field: key, op: op as 'eq', value: operand as never});
			}
		}
	}
	return parts.length === 1 ? parts[0] : {and: parts};
}

/**
 * The builder is typed loosely on purpose: every type here is built from data
 * at run time, so there is no static shape for Pothos to infer, and the checks
 * that matter (a declared field, an operand of the right kind) are the
 * accessor's planner's, at run time, on every backend.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

type SchemaTypes = {
	Context: OperationReads;
	Scalars: {
		U256: {Input: bigint; Output: bigint};
		SafeInt: {Input: number; Output: number};
		Bytes: {Input: Uint8Array; Output: Uint8Array};
		Bytes32: {Input: string; Output: string};
	};
};

type EntityTypes = {
	object: Loose;
	where: Loose;
	orderBy: Loose;
	field: Loose;
	enums: Map<string, Loose>;
};
