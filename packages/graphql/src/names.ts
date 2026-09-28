import type {NormalizedEntity} from '@etherfold/state-store';

/**
 * ## Every type name the schema gives, decided before anything is built
 *
 * An entity's type is its name with the first letter capitalised, and the
 * types generated beside it are suffixed (`PoolWhere`, `PoolOrderBy`,
 * `PoolField`, `PoolKind` for the enum field `kind`). Entity names are unique
 * case-insensitively (ADR-0098's identifier rules), so two entities never
 * capitalise to one type; but a generated name CAN meet another entity's (an
 * entity `poolWhere` beside `pool`), or a fixed one (an entity `string`).
 *
 * GraphQL names share the identifier alphabet, so no prefix or separator keeps
 * them apart by construction, and the schema refuses such a set at BUILD time,
 * naming both owners, rather than letting graphql-js fail with a bare
 * duplicate. The predicate's combinators are `_and` / `_or` for the opposite
 * reason: a column may not begin with `_` (the reserved namespace), so those
 * two can never meet a column and need no refusal.
 */
export type SchemaNames = {
	readonly entities: ReadonlyMap<string, EntityNames>;
	/** The shared filter input of each scalar a column may hold. */
	readonly filters: {
		readonly String: string;
		readonly SafeInt: string;
		readonly Float: string;
		readonly Bytes: string;
		readonly U256: string;
	};
};

export type EntityNames = {
	readonly object: string;
	readonly where: string;
	readonly orderBy: string;
	readonly field: string;
	/** The enum type of each enum field, by field. */
	readonly enums: ReadonlyMap<string, string>;
	/** The filter input of each enum field, by field. */
	readonly enumFilters: ReadonlyMap<string, string>;
};

/** Every name the schema will give, or a refusal naming the first two owners of one name. */
export function schemaNames(entities: ReadonlyMap<string, NormalizedEntity>): SchemaNames {
	const owners = new Map<string, string>();
	const claim = (name: string, owner: string): string => {
		const taken = owners.get(name);
		if (taken !== undefined) {
			throw new Error(
				`the GraphQL schema built from these declarations would give two types the name ${name}: ${taken}, and ` +
					`${owner}. Rename one of the entities (or the field) so their generated names differ.`,
			);
		}
		owners.set(name, owner);
		return name;
	};

	for (const builtIn of ['String', 'Int', 'Float', 'Boolean', 'ID', 'Query'])
		claim(builtIn, `GraphQL's own ${builtIn}`);
	for (const fixed of ['U256', 'SafeInt', 'Bytes', 'OrderDirection']) claim(fixed, `the scalar or enum ${fixed}`);
	const filters = {
		String: claim('StringFilter', 'the filter over String'),
		SafeInt: claim('SafeIntFilter', 'the filter over SafeInt'),
		Float: claim('FloatFilter', 'the filter over Float'),
		Bytes: claim('BytesFilter', 'the filter over Bytes'),
		U256: claim('U256Filter', 'the filter over U256'),
	};

	const named = new Map<string, EntityNames>();
	for (const entity of entities.values()) {
		const type = capitalised(entity.name);
		const of = `entity ${entity.name}`;
		const enums = new Map<string, string>();
		const enumFilters = new Map<string, string>();
		named.set(entity.name, {
			object: claim(type, `the type of ${of}`),
			where: claim(`${type}Where`, `the where input of ${of}`),
			orderBy: claim(`${type}OrderBy`, `the orderBy input of ${of}`),
			field: claim(`${type}Field`, `the field enum of ${of}`),
			enums,
			enumFilters,
		});
		for (const [field, declared] of Object.entries(entity.fields)) {
			if (typeof declared !== 'object' || !('enum' in declared)) continue;
			const name = `${type}${capitalised(field)}`;
			enums.set(field, claim(name, `the enum of ${entity.name}.${field}`));
			enumFilters.set(field, claim(`${name}Filter`, `the filter over the enum of ${entity.name}.${field}`));
		}
	}
	return {entities: named, filters};
}

function capitalised(name: string): string {
	return name.charAt(0).toUpperCase() + name.slice(1);
}
