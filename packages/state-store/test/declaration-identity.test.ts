import {describe, expect, it} from 'vitest';
import {normalizeEntities, normalizeEntity} from '../src/index.js';
import {entityKey} from '../src/entities.js';
import type {EntityDeclaration} from '../src/index.js';

/**
 * When two names are TWO NAMES, which is the half of the identifier rule that is
 * about identity rather than about spelling.
 *
 * The shape rule (`IDENTIFIER`, tested through the store constructors) asks
 * whether a name may be interpolated at all. This asks a different question, and
 * it is the question the backends disagreed about: `token` and `Token` are one
 * table on SQLite -- which folds identifier case even inside quotes, so the
 * keyword fix does not reach it -- and two entities on the memory, patch and
 * IndexedDB backends. `CREATE TABLE IF NOT EXISTS "Token"` matched the existing
 * `token` and was silently SKIPPED, after which `getCurrent('Token', ...)`
 * answered with `token`'s row
 * (`entity-names-differing-only-in-case-collide-on-sqlite`).
 *
 * No DDL makes the two engines agree, so the answer cannot be a backend's: the
 * declaration is refused, everywhere, where it was written. That is why THIS
 * rule sits at the seam when the SQL reserved-word list deliberately does not
 * (see the module note in `src/entities.ts`).
 */

const declaring = (declarations: EntityDeclaration[]) => () => normalizeEntities(declarations);

describe('two entity names that differ only in case', () => {
	it('are refused, naming both spellings and what to do', () => {
		expect(
			declaring([
				{name: 'token', id: ['id'], fields: {owner: 'text'}},
				{name: 'Token', id: ['id'], fields: {owner: 'text'}},
			]),
		).toThrow(/differ only in case: "token" and "Token"[\s\S]*Rename one/);
	});

	it('are refused whichever order they arrive in', () => {
		expect(
			declaring([
				{name: 'TOKEN', id: ['id'], fields: {}},
				{name: 'token', id: ['id'], fields: {}},
			]),
		).toThrow(/case/i);
	});

	it('leaves the exact-duplicate message alone, because it says something else', () => {
		expect(
			declaring([
				{name: 'token', id: ['id'], fields: {}},
				{name: 'token', id: ['id'], fields: {}},
			]),
		).toThrow(/declared more than once/);
	});

	it('does not refuse two names that differ in more than case', () => {
		expect(
			declaring([
				{name: 'token', id: ['id'], fields: {}},
				{name: 'tokens', id: ['id'], fields: {}},
			]),
		).not.toThrow();
	});
});

describe('two COLUMNS of one entity that differ only in case', () => {
	// the original report was an id COLUMN, so the rule has to hold at all three
	// levels or it closes a third of the hole.
	it('are refused as two id columns', () => {
		expect(() => normalizeEntity({name: 'placement', id: ['epoch', 'Epoch'], fields: {}})).toThrow(
			/entity placement declares two columns that differ only in case: "epoch" and "Epoch"/,
		);
	});

	it('are refused as two fields', () => {
		expect(() => normalizeEntity({name: 'token', id: ['id'], fields: {owner: 'text', Owner: 'text'}})).toThrow(
			/differ only in case/,
		);
	});

	it('are refused across the id/field boundary, because a row has ONE set of columns', () => {
		expect(() => normalizeEntity({name: 'token', id: ['owner'], fields: {Owner: 'text'}})).toThrow(
			/differ only in case/,
		);
	});

	it('keeps the older exact-collision message for the same name twice', () => {
		// an id column repeated: previously accepted here and then
		// `duplicate column name` at migrate() on a SQL backend.
		expect(() => normalizeEntity({name: 'token', id: ['id', 'id'], fields: {}})).toThrow(
			/declares the id column "id" twice/,
		);
		// and the one that already had its own words keeps them
		expect(() => normalizeEntity({name: 'token', id: ['owner'], fields: {owner: 'text'}})).toThrow(
			/both as an id column and as a field/,
		);
	});

	it('leaves a mixed-case name alone when nothing collides with it', () => {
		expect(() =>
			normalizeEntity({name: 'placementPlayer', id: ['epoch', 'playerIndex'], fields: {transferCount: 'integer'}}),
		).not.toThrow();
	});
});

describe('the rules that did NOT change', () => {
	it('still rejects the store `_` prefix at all three levels', () => {
		expect(() => normalizeEntity({name: '_secret', id: ['id'], fields: {}})).toThrow(/reserved/i);
		expect(() => normalizeEntity({name: 'token', id: ['_rowid'], fields: {}})).toThrow(/reserved/i);
		expect(() => normalizeEntity({name: 'token', id: ['id'], fields: {_lower: 'integer'}})).toThrow(/reserved/i);
	});

	it('still accepts a SQL keyword, because that half is the backend to quote', () => {
		expect(() =>
			normalizeEntity({name: 'order', id: ['group', 'index'], fields: {select: 'text', default: 'text'}}),
		).not.toThrow();
	});

	it('still rejects anything outside ASCII, which is why there is no NFC/NFD rule', () => {
		// `café` and `cafe` + U+0301 are the same collision SHAPE as case, and they
		// are unreachable: neither spelling is an identifier here in the first place.
		expect(() => normalizeEntity({name: 'caf\u00e9', id: ['id'], fields: {}})).toThrow(/identifier/i);
		expect(() => normalizeEntity({name: 'cafe\u0301', id: ['id'], fields: {}})).toThrow(/identifier/i);
		// and the dotted capital I, which is the pair a locale-sensitive fold gets
		// wrong -- also not an identifier, so the fold never meets it.
		expect(() => normalizeEntity({name: 'token', id: ['\u0130d'], fields: {}})).toThrow(/identifier/i);
	});

	it('does not limit an identifier length, because no backend does', () => {
		const long = `long${'x'.repeat(196)}`;
		expect(() => normalizeEntity({name: long, id: [`${long}Key`], fields: {[`${long}Field`]: 'text'}})).not.toThrow();
	});
});

describe('an id VALUE containing the key separator is refused, not silently merged', () => {
	// `entityKey` joins the entity name and the id values with U+0000, and the memory
	// and patch backends key rows on that string. Before this refusal, for `id: ['x',
	// 'y']` the two DIFFERENT business keys below produced the same string and became
	// ONE row: the second write overwrote the first and both reads answered with it.
	// Verified on MemoryStateStore, 2026-08-23. SQLite (separate columns) and
	// IndexedDB (an array key) kept them apart, so the same processor meant different
	// things per backend -- the divergence the seam exists to prevent.
	const declaration = normalizeEntity({name: 'pair', id: ['x', 'y'], fields: {v: 'text'}});

	it('refuses a NUL in an id value, naming the entity and the column', () => {
		expect(() => entityKey(declaration, {x: 'a\u0000b', y: 'c'})).toThrow(/id column x contains a NUL/);
		expect(() => entityKey(declaration, {x: 'a', y: 'b\u0000c'})).toThrow(/id column y contains a NUL/);
	});

	it('is the pair that used to collide, so neither can reach a backend now', () => {
		// the point is that these two were EQUAL as strings; both are refused, so the
		// collision is unreachable rather than merely unlikely
		expect(() => entityKey(declaration, {x: 'a\u0000b', y: 'c'})).toThrow();
		expect(() => entityKey(declaration, {x: 'a', y: 'b\u0000c'})).toThrow();
	});

	it('leaves every ordinary id value alone', () => {
		// an address, a hash and a decimal: what an id actually is
		expect(entityKey(declaration, {x: '0xabc', y: '42'})).toBe('pair\u00000xabc\u000042');
		expect(entityKey(declaration, {x: 1, y: 2})).toBe('pair\u00001\u00002');
	});
});
