import {UnknownEntityError} from './errors.js';
import {isSemanticTypeName, SEMANTIC_TYPES} from './semantic-types.js';
import type {
	EntityId,
	EnumField,
	FieldDeclaration,
	FieldType,
	EntityDeclaration,
	EntityRelation,
	NormalizedEntity,
	SemanticField,
} from './types.js';

/**
 * Validation of a declaration, once, for every backend.
 *
 * The rule is set by the STRICTEST backend and applied uniformly, which is the
 * only arrangement under which "this declaration is valid" is a fact about the
 * declaration rather than about the deployment. A SQL store interpolates entity
 * and field names into DDL, because SQL cannot bind an identifier as a
 * parameter, so it needs names it can trust; an object-store backend would
 * happily take anything. If each backend validated to its own taste, a
 * declaration would be accepted in a browser and fatal on a server, which is
 * exactly the failure `work/notes/findings/sqlite-in-the-browser.md` recorded.
 *
 * The rule is a SHAPE rule, and it deliberately does not know about SQL KEYWORDS.
 * `index`, `order`, `group` and the rest have ordinary identifier shapes, and
 * refusing them here would push one engine's reserved-word list into the surface
 * every backend shares, break declarations that are legal today, and re-open the
 * hole the day a second SQL backend arrives with a different list. A SQL backend
 * QUOTES what it interpolates instead (`identifiers.ts` in
 * `@etherfold/state-store-sqlite`), so it accepts exactly what this function
 * accepts. That agreement is asserted for every backend by the
 * `a declaration means the same thing on every backend` group of
 * `@etherfold/state-store-conformance`.
 *
 * ## Why CASE is refused here when a keyword list is not
 *
 * The two look contradictory side by side, and they are not. A keyword list is
 * one engine's VOCABULARY: `index` is a word SQLite happens to have taken, it
 * means nothing to a key-value store, and quoting removes the problem entirely,
 * so the list has no business being at a surface every backend shares.
 *
 * Case is not vocabulary, it is IDENTITY. `token` and `Token` are two names
 * asking whether they are two THINGS, and the backends disagree about the
 * answer: SQLite folds identifier case (quoted or not -- quoting does not help
 * here the way it helps with a keyword), so it stores one table, while the
 * memory, patch and IndexedDB backends key by the exact string and store two
 * entities. There is no spelling of the DDL that makes SQLite keep them apart,
 * so the choice is not "where does the workaround go" but "which answer is the
 * declaration's", and the only answer that is the same everywhere is: two names
 * a backend could confuse are ONE name, and declaring both is a mistake.
 *
 * The rule is therefore a PORTABILITY rule -- it exists because the backends
 * disagree -- rather than one engine's vocabulary, which is why it lives at the
 * seam and the keyword list does not.
 *
 * Its ASCII-only companion falls out of `IDENTIFIER` for free: a name may not
 * contain a non-ASCII character at all, so there is no pair of identifiers that
 * are equal only after NFC/NFD normalisation (the same collision SHAPE as case),
 * and `fold` below has no dotted I and no eszett to get wrong. That is not an
 * accident of the regex; it is the reason the regex stays ASCII-only.
 */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The `_` prefix means NOT A USER ENTITY: a version column, or a FIXED table
 * belonging to whoever composed this database.
 *
 * It is deliberately not "the store's", because two packages put tables there.
 * The store's own are `_blocks` and `_cursor` (`@etherfold/state-store-sqlite`),
 * and the indexer-server's are `_meta` and `_emissions`, which share ONE database
 * handle with the entity tables in every combined shape. An entity named after
 * one of those would have been created as `CREATE TABLE IF NOT EXISTS "<name>"`
 * against the existing table, succeeded silently, and failed much later as a
 * column error on a write.
 *
 * The namespace is what closes that, and it closes it WITHOUT this package
 * learning anything about the packages composed above it: the rule stays "a name
 * starting with `_` is not yours", and a fixed table earns its protection by
 * being named inside it. Parameterising the reserved set so a host declares its
 * own fixed names was considered and refused: it grows optional API here for a
 * guard that is off by default (a browser uses this store with no server at all)
 * and relocates the discipline rather than removing it.
 */
function isReserved(name: string): boolean {
	return name.startsWith('_');
}

/**
 * The form two identifiers are compared in when asking whether SOME backend
 * would store them as one.
 *
 * `toLowerCase` and never `toLocaleLowerCase`: this must not depend on the
 * host's locale, and it does not have to, because `IDENTIFIER` admits ASCII
 * only. Under that alphabet the fold is exact rather than approximate.
 */
function fold(name: string): string {
	return name.toLowerCase();
}

function assertIdentifier(name: unknown, what: string): asserts name is string {
	if (typeof name === 'string' && isReserved(name)) {
		throw new Error(
			`reserved identifier for ${what}: ${JSON.stringify(name)}. Names starting with "_" are not user entities.`,
		);
	}
	if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
		throw new Error(
			`invalid identifier for ${what}: ${JSON.stringify(name)}. ` +
				`Must match ${IDENTIFIER} (identifiers cannot be bound as parameters, so they are not interpolated blindly).`,
		);
	}
}

const FIELD_TYPES: FieldType[] = ['text', 'integer', 'real', 'blob'];

/** Validate a declaration and put it in the shape the rest of a store uses. */
export function normalizeEntity(declaration: EntityDeclaration): NormalizedEntity {
	assertIdentifier(declaration?.name, 'entity name');
	const name = declaration.name;

	const id = typeof declaration.id === 'string' ? [declaration.id] : declaration.id;
	if (!Array.isArray(id) || id.length === 0) {
		throw new Error(`entity ${name} must declare at least one id column`);
	}
	for (const column of id) {
		assertIdentifier(column, `id column of entity ${name}`);
	}

	const fields: Record<string, FieldDeclaration> = {};
	for (const [field, type] of Object.entries(declaration.fields ?? {})) {
		assertIdentifier(field, `field of entity ${name}`);
		if (id.includes(field)) {
			throw new Error(`entity ${name} declares ${field} both as an id column and as a field`);
		}
		fields[field] = fieldOf(name, field, type);
	}

	// The id columns and the fields are ONE namespace -- they are the columns of
	// one row -- so they are folded together rather than a set each.
	const columns = new Map<string, string>();
	for (const column of [...id, ...Object.keys(fields)]) {
		const declared = columns.get(fold(column));
		if (declared === column) {
			throw new Error(`entity ${name} declares the id column ${JSON.stringify(column)} twice`);
		}
		if (declared !== undefined) {
			throw new Error(differOnlyInCase(`entity ${name} declares two columns`, declared, column));
		}
		columns.set(fold(column), column);
	}

	const parent = relationOf(name, declaration.parent);
	return Object.freeze({
		name,
		id: Object.freeze([...id]),
		fields: Object.freeze(fields),
		...(parent ? {parent} : {}),
	});
}

/**
 * A legal GraphQL enum value: a GraphQL `Name` that is not `true`, `false` or
 * `null`, and does not begin with `__` (the introspection namespace). Refused at
 * declaration time, so the schema ADR-0099 builds maps a declared value to an
 * enum value one to one rather than renaming it (ADR-0098).
 */
const GRAPHQL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NOT_ENUM_VALUES: readonly string[] = ['true', 'false', 'null'];

/** One field's declaration, checked, in the shape `NormalizedEntity.fields` holds. */
function fieldOf(name: string, field: string, type: unknown): FieldDeclaration {
	if (typeof type === 'string') {
		if (!FIELD_TYPES.includes(type as FieldType)) {
			throw new Error(`entity ${name} declares field ${field} with unknown type ${JSON.stringify(type)}`);
		}
		return type as FieldType;
	}
	if (type === null || typeof type !== 'object' || Array.isArray(type)) {
		throw new Error(`entity ${name} declares field ${field} with unknown type ${JSON.stringify(type)}`);
	}
	const declared = type as Record<string, unknown>;
	const keys = Object.keys(declared);
	const isEnum = keys.every((key) => key === 'storage' || key === 'enum') && 'enum' in declared;
	const isSemantic = keys.every((key) => key === 'storage' || key === 'type') && 'type' in declared;
	if (!isEnum && !isSemantic) {
		throw new Error(
			`entity ${name} declares field ${field} as ${JSON.stringify(type)}: a field is a storage class ` +
				`(${FIELD_TYPES.join(', ')}), an enum, {storage: 'text', enum: [...]}, or a semantic type beside its ` +
				`storage class, {storage, type} (known: ${Object.keys(SEMANTIC_TYPES).join(', ')}).`,
		);
	}
	if (isSemantic) return semanticFieldOf(name, field, declared.storage, declared.type);
	if (declared.storage !== 'text') {
		throw new Error(
			`entity ${name} declares field ${field} as an enum over ${JSON.stringify(declared.storage)}: an enum is a ` +
				`value set over text, so its storage is 'text'.`,
		);
	}
	const values = declared.enum;
	if (!Array.isArray(values) || values.length === 0) {
		throw new Error(
			`entity ${name} declares field ${field} as an enum of ${JSON.stringify(values)}: an enum declares at least ` +
				`one value, as a list of names.`,
		);
	}
	const seen = new Set<string>();
	for (const value of values) {
		if (
			typeof value !== 'string' ||
			!GRAPHQL_NAME.test(value) ||
			NOT_ENUM_VALUES.includes(value) ||
			value.startsWith('__')
		) {
			throw new Error(
				`entity ${name} declares field ${field} with the enum value ${JSON.stringify(value)}, which is not a legal ` +
					`GraphQL enum name: it must match ${GRAPHQL_NAME}, must not begin with "__", and must not be true, ` +
					`false or null. The GraphQL schema maps each declared value to an enum value one to one (ADR-0098).`,
			);
		}
		if (seen.has(value)) {
			throw new Error(`entity ${name} declares field ${field} with the enum value ${JSON.stringify(value)} twice`);
		}
		seen.add(value);
	}
	return Object.freeze({storage: 'text', enum: Object.freeze([...(values as string[])])});
}

/**
 * A `{storage, type}` field, checked against the semantic-type registry: the
 * type must be one it holds, and the storage class one the type can be encoded
 * in (ADR-0098). Both are facts about the declaration, so both are refused here,
 * at declaration time, on every backend.
 */
function semanticFieldOf(name: string, field: string, storage: unknown, type: unknown): SemanticField {
	if (!isSemanticTypeName(type)) {
		throw new Error(
			`entity ${name} declares field ${field} with the unknown semantic type ${JSON.stringify(type)} ` +
				`(known: ${Object.keys(SEMANTIC_TYPES).join(', ')}).`,
		);
	}
	const semantic = SEMANTIC_TYPES[type];
	if (!semantic.storage.includes(storage as FieldType)) {
		throw new Error(
			`entity ${name} declares field ${field} as a ${type} in ${String(storage)}: a ${type} is encoded in ` +
				`${semantic.storage.join(' or ')}, so its storage is ${semantic.storage.map((s) => `'${s}'`).join(' or ')}.`,
		);
	}
	return Object.freeze({storage: storage as FieldType, type});
}

/** The storage class of a declared field, whichever way it was declared: all a backend's layout needs. */
export function fieldStorage(field: FieldDeclaration): FieldType {
	return typeof field === 'string' ? field : field.storage;
}

/**
 * A declared field as one string, for comparing two declarations and for
 * naming them in a refusal: `text`, `text enum(open, closed)`, or `blob u256`.
 *
 * The values are in DECLARED order, and two enums listing the same values in
 * another order describe themselves differently: a declaration is compared as
 * written, exactly as its id columns are.
 */
export function describeField(field: FieldDeclaration): string {
	if (typeof field === 'string') return field;
	return 'type' in field ? `${field.storage} ${field.type}` : `${field.storage} enum(${field.enum.join(', ')})`;
}

/**
 * Each entity's enum fields with their value sets, built once per normalized
 * entity and kept OFF it, so a `NormalizedEntity` stays plain data (it is
 * compared, serialised and posted across a port) while the write-time check
 * is a set lookup.
 */
const enumSets = new WeakMap<NormalizedEntity, readonly (readonly [string, EnumField, ReadonlySet<string>])[]>();

function enumFieldsOf(entity: NormalizedEntity): readonly (readonly [string, EnumField, ReadonlySet<string>])[] {
	let known = enumSets.get(entity);
	if (!known) {
		known = Object.entries(entity.fields).flatMap(([field, declared]) =>
			typeof declared === 'string' || !('enum' in declared) ? [] : [[field, declared, new Set(declared.enum)] as const],
		);
		enumSets.set(entity, known);
	}
	return known;
}

/**
 * Refuse an upsert's values that its declaration does not admit, before a
 * backend writes anything: today, a value of an enum field outside its declared
 * set (ADR-0098). Every backend calls it where it plans a block, beside
 * `idValues`, so a refused value leaves the store as it was, and the refusal is
 * the same sentence on every backend.
 *
 * NULL (or an unlisted field, which a whole-row write stores as NULL) is
 * admitted, as it is for every field. An entity with no enum field pays one
 * cached empty-list check.
 */
export function assertFieldValues(entity: NormalizedEntity, values: Record<string, unknown> | undefined): void {
	for (const [field, declared, allowed] of enumFieldsOf(entity)) {
		const value = values?.[field];
		if (value === null || value === undefined) continue;
		if (typeof value !== 'string' || !allowed.has(value)) {
			throw new Error(
				`entity ${entity.name} field ${field} is declared as an enum of (${declared.enum.join(', ')}), and was ` +
					`written ${JSON.stringify(value)}, which is not one of them. The value is refused rather than stored.`,
			);
		}
	}
}

/**
 * The names the generated read surface already gives EVERY entity
 * (`createReadSurface`), which a relation's `as` may therefore not take: the
 * parent-side collection is offered beside them, on the parent (ADR-0098).
 */
const READ_SURFACE_NAMES: readonly string[] = ['getCurrent', 'getAsOf', 'listCurrent', 'listAsOf'];

/**
 * The SHAPE of one declared relation, which is all one declaration can check on
 * its own: whether it matches the ids is a question about TWO declarations, and
 * `normalizeEntities` asks it once every entity is known.
 */
function relationOf(name: string, parent: EntityDeclaration['parent']): EntityRelation | undefined {
	if (parent === undefined) return undefined;
	if (parent === null || typeof parent !== 'object') {
		throw new Error(`entity ${name} declares its parent as ${JSON.stringify(parent)}: expected {entity, as}`);
	}
	assertIdentifier(parent.entity, `parent of entity ${name}`);
	assertIdentifier(parent.as, `the collection entity ${name} declares on its parent`);
	const taken = READ_SURFACE_NAMES.find((read) => fold(read) === fold(parent.as));
	if (taken !== undefined) {
		throw new Error(
			`entity ${name} names its collection on parent ${parent.entity} ${JSON.stringify(parent.as)}, which the ` +
				`generated read surface already uses (${READ_SURFACE_NAMES.join(', ')}). Choose another \`as\`.`,
		);
	}
	return Object.freeze({entity: parent.entity, as: parent.as});
}

/**
 * Every declared relation, checked against the ids of BOTH declarations it joins.
 *
 * The child's leading id columns must be the parent's WHOLE id, by name and in
 * order (ADR-0098): a child carrying part of its parent's key belongs to no
 * single parent, so the relation would be a claim the ids do not make. The child
 * must also add at least one id column of its own, since a child keyed exactly
 * by its parent's id is at most one row per parent (and an entity naming ITSELF
 * as parent is that case). Then the parent-side name: `as` is a field of the
 * parent in every surface generated from it, so it may not collide with a column
 * of the parent or with another relation's `as` on the same parent, compared as
 * the identifier rules compare the columns of one row (`fold`).
 */
function assertRelations(entities: ReadonlyMap<string, NormalizedEntity>): void {
	const collections = new Map<string, Map<string, string>>();
	for (const child of entities.values()) {
		const relation = child.parent;
		if (!relation) continue;
		const parent = entities.get(relation.entity);
		if (!parent) {
			throw new Error(
				`entity ${child.name} declares parent ${relation.entity}, which is not declared ` +
					`(declared: ${[...entities.keys()].join(', ')}). A relation names an entity of the same set.`,
			);
		}

		const leading = child.id.slice(0, parent.id.length);
		if (leading.length !== parent.id.length || leading.some((column, index) => column !== parent.id[index])) {
			throw new Error(
				`entity ${child.name} declares its id as (${child.id.join(', ')}) and parent ${parent.name}, whose id is ` +
					`(${parent.id.join(', ')}). A child's leading id columns must be its parent's whole id, by name and in ` +
					`order, so that each child belongs to exactly one parent: declare ${child.name}'s id as ` +
					`(${parent.id.join(', ')}, ...).`,
			);
		}
		if (child.id.length === parent.id.length) {
			throw new Error(
				`entity ${child.name} declares parent ${parent.name} and adds no id column to its id ` +
					`(${parent.id.join(', ')}). A child needs at least one id column of its own after its parent's whole id, ` +
					`or every parent has at most one child and the relation is not a collection.`,
			);
		}

		const clash = [...parent.id, ...Object.keys(parent.fields)].find((column) => fold(column) === fold(relation.as));
		if (clash !== undefined) {
			throw new Error(
				`entity ${child.name} names its collection on parent ${parent.name} ${JSON.stringify(relation.as)}, which ` +
					`collides with ${parent.name}'s ${parent.id.includes(clash) ? 'id column' : 'field'} ` +
					`${JSON.stringify(clash)}. Choose another \`as\`.`,
			);
		}
		const named = collections.get(parent.name) ?? new Map<string, string>();
		const sibling = named.get(fold(relation.as));
		if (sibling !== undefined) {
			throw new Error(
				`entities ${sibling} and ${child.name} both name their collection on parent ${parent.name} ` +
					`${JSON.stringify(relation.as)}. One parent's collections need one name each.`,
			);
		}
		named.set(fold(relation.as), child.name);
		collections.set(parent.name, named);
	}
}

export function normalizeEntities(declarations: Iterable<EntityDeclaration>): Map<string, NormalizedEntity> {
	const entities = new Map<string, NormalizedEntity>();
	const folded = new Map<string, string>();
	for (const declaration of declarations) {
		const entity = normalizeEntity(declaration);
		if (entities.has(entity.name)) {
			throw new Error(`entity ${entity.name} is declared more than once`);
		}
		const declared = folded.get(fold(entity.name));
		if (declared !== undefined) {
			throw new Error(differOnlyInCase('two entity names', declared, entity.name));
		}
		folded.set(fold(entity.name), entity.name);
		entities.set(entity.name, entity);
	}
	assertRelations(entities);
	return entities;
}

/**
 * The one message both halves of the case rule are refused with.
 *
 * It names BOTH spellings, because the author sees one of them at the point they
 * are reading and the other is the whole content of the complaint; and it says
 * what to do, because "rename one" is the only fix (there is no escaping,
 * quoting or configuration that makes SQLite keep the two apart).
 */
function differOnlyInCase(what: string, declared: string, clashing: string): string {
	return (
		`${what} that differ only in case: ${JSON.stringify(declared)} and ${JSON.stringify(clashing)}. ` +
		`Identifiers are compared case-insensitively for EVERY backend, because at least one folds them ` +
		`(SQLite, quoted or not) and would store the two as one where the others store two. Rename one of them.`
	);
}

export function mustGet(entities: ReadonlyMap<string, NormalizedEntity>, name: string): NormalizedEntity {
	const entity = entities.get(name);
	if (!entity) {
		throw new UnknownEntityError(name, [...entities.keys()]);
	}
	return entity;
}

/**
 * The business key of one entity, in DECLARED column order, as strings.
 *
 * Stringifying is the one normalisation the model makes: `{id: 1}` and
 * `{id: '1'}` are the same entity, because a key that means one thing to a
 * handler and another to the store is a bug that only shows up as a duplicate
 * row much later.
 */
export function idValues(entity: NormalizedEntity, id: EntityId): string[] {
	return entity.id.map((column) => {
		const value = id?.[column];
		if (value === undefined || value === null) {
			throw new Error(`entity ${entity.name} requires an id column ${column}, got ${JSON.stringify(value)}`);
		}
		const text = String(value);
		if (text.includes(SEPARATOR)) {
			// Refused rather than escaped, because the damage is SILENT and permanent.
			// `entityKey` joins these values with U+0000, and the memory and patch
			// backends use that string as a map key, so for `id: ['x', 'y']` the keys
			// {x: 'a\0b', y: 'c'} and {x: 'a', y: 'b\0c'} collapse to ONE row: the second
			// write overwrites the first and both reads answer with it. The SQL backend
			// keeps them apart (separate columns) and IndexedDB does too (an array key),
			// so the same processor silently means different things per backend, which is
			// the one thing the seam exists to prevent.
			//
			// A length-prefixed or escaped join would also close it, and was weighed: it
			// changes every key string for data that has never had this problem, to keep
			// admitting a value no chain produces (an id comes from event args, where a
			// string is an address, a hash or a decimal). Refusing states the rule where
			// the value arrives, beside the id-is-required refusal above.
			throw new Error(
				`entity ${entity.name} id column ${column} contains a NUL character (U+0000), which is the separator ` +
					`this store keys rows with. Two different ids could not be told apart, so it is refused rather than ` +
					`stored: ${JSON.stringify(text)}`,
			);
		}
		return text;
	});
}

/**
 * The character `entityKey` joins an entity name and its id values with.
 *
 * U+0000 because no legitimate id value contains one: an id comes from decoded
 * event args, so a string value is an address, a hash or a decimal. `idValues`
 * REFUSES a value that does contain one, which is what makes the join safe to
 * treat as unambiguous.
 */
const SEPARATOR = '\u0000';

/**
 * A stable string for one entity instance, usable as a Map key.
 *
 * Built from the DECLARED id columns rather than from whatever keys the caller's
 * object happens to carry, so `{account, token}` and `{token, account}` are one
 * key, and an extra property on the caller's object cannot fork it into two.
 */
export function entityKey(entity: NormalizedEntity, id: EntityId): string {
	return [entity.name, ...idValues(entity, id)].join(SEPARATOR);
}
