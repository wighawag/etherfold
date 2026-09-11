import {UnknownEntityError} from './errors.js';
import type {EntityId, FieldType, EntityDeclaration, NormalizedEntity} from './types.js';

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

	const fields = declaration.fields ?? {};
	for (const [field, type] of Object.entries(fields)) {
		assertIdentifier(field, `field of entity ${name}`);
		if (id.includes(field)) {
			throw new Error(`entity ${name} declares ${field} both as an id column and as a field`);
		}
		if (!FIELD_TYPES.includes(type)) {
			throw new Error(`entity ${name} declares field ${field} with unknown type ${JSON.stringify(type)}`);
		}
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

	return Object.freeze({name, id: Object.freeze([...id]), fields: Object.freeze({...fields})});
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
