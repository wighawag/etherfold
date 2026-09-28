import {describe, expect, expectTypeOf, it} from 'vitest';
import {
	assertFieldValues,
	describeField,
	fieldStorage,
	normalizeEntity,
	SEMANTIC_TYPES,
	semanticTypeOf,
	u256,
	declareEntities,
	type EntityDeclaration,
	type EntityRow,
} from '../src/index.js';

/**
 * The semantic-type registry (ADR-0098): a field may declare `{storage, type}`
 * beside the bare storage classes, and a semantic type owns a canonical
 * encoding, a decode, an equality and an ordering. `u256` is the first member.
 *
 * These are the registry's own cases and the declaration-time refusals. No
 * backend uses a semantic type yet: that is `every-backend-stores-a-u256-canonically`.
 */

const MAX = 2n ** 256n - 1n;

function withAmount(field: unknown): EntityDeclaration {
	return {name: 'pool', id: 'id', fields: {amount: field}} as unknown as EntityDeclaration;
}

/** Unsigned bytewise comparison, which is how IndexedDB orders a binary key and SQLite a BLOB. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const length = Math.min(a.length, b.length);
	for (let index = 0; index < length; index++) {
		if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
	}
	return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

describe('the semantic-type registry', () => {
	it('has u256 as its one member', () => {
		expect(Object.keys(SEMANTIC_TYPES)).toEqual(['u256']);
		expect(SEMANTIC_TYPES.u256).toBe(u256);
		expect(u256.name).toBe('u256');
		expect(u256.storage).toEqual(['blob']);
	});
});

describe('u256', () => {
	it('encodes as 32 big-endian bytes and decodes back to the same bigint at the boundaries', () => {
		for (const value of [0n, 1n, 2n ** 64n, MAX]) {
			const encoded = u256.encode(value);
			expect(encoded).toBeInstanceOf(Uint8Array);
			expect(encoded.length).toBe(32);
			expect(u256.decode(encoded)).toBe(value);
		}
		expect([...u256.encode(0n)]).toEqual(new Array(32).fill(0));
		expect([...u256.encode(1n)]).toEqual([...new Array(31).fill(0), 1]);
		expect([...u256.encode(2n ** 64n)]).toEqual([...new Array(23).fill(0), 1, ...new Array(8).fill(0)]);
		expect([...u256.encode(MAX)]).toEqual(new Array(32).fill(255));
	});

	it('refuses, at encode, a negative value, one wider than 256 bits, and anything that is not a bigint', () => {
		expect(() => u256.encode(-1n)).toThrow(/negative/);
		expect(() => u256.encode(2n ** 256n)).toThrow(/wider than 256 bits/);
		for (const value of [1, '1', null, undefined, 1.5]) {
			expect(() => u256.encode(value as unknown as bigint)).toThrow(/not a bigint/);
		}
	});

	it('refuses, at decode, bytes that are not its 32-byte encoding', () => {
		expect(() => u256.decode(new Uint8Array(31))).toThrow(/32 bytes/);
		expect(() => u256.decode(new Uint8Array(33))).toThrow(/32 bytes/);
		expect(() => u256.decode('0' as unknown as Uint8Array)).toThrow(/32 bytes/);
	});

	it('has one encoding per value, so equal values have equal bytes', () => {
		expect(u256.equals(10n, 10n)).toBe(true);
		expect(u256.equals(9n, 10n)).toBe(false);
		expect(compareBytes(u256.encode(10n), u256.encode(10n))).toBe(0);
	});

	it('orders numerically, and the bytewise order of its encoding IS that order (9 before 10)', () => {
		const sample = [10n, MAX, 0n, 2n ** 63n + 7n, 9n, 2n ** 64n, 1n, 255n, 256n, 2n ** 64n - 1n];
		const numeric = [...sample].sort(u256.compare);
		expect(numeric.slice(0, 4)).toEqual([0n, 1n, 9n, 10n]);
		expect(numeric.at(-1)).toBe(MAX);
		const bytewise = sample
			.map((value) => u256.encode(value))
			.sort(compareBytes)
			.map((bytes) => u256.decode(bytes));
		expect(bytewise).toEqual(numeric);
		// and the decimal text a u256 is stored as today does NOT sort that way
		expect(sample.map(String).sort().slice(0, 3)).toEqual(['0', '1', '10']);
	});
});

describe('a field declared with a semantic type', () => {
	it('is accepted and kept on the normalized entity as declared, beside a bare field that is unchanged', () => {
		const entity = normalizeEntity({
			name: 'pool',
			id: 'id',
			fields: {amount: {storage: 'blob', type: 'u256'}, owner: 'text'},
		});
		expect(entity.fields).toEqual({amount: {storage: 'blob', type: 'u256'}, owner: 'text'});
		expect(Object.isFrozen(entity.fields.amount)).toBe(true);
		expect(fieldStorage(entity.fields.amount)).toBe('blob');
		expect(describeField(entity.fields.amount)).toBe('blob u256');
		expect(semanticTypeOf(entity.fields.amount)).toBe(u256);
		expect(semanticTypeOf(entity.fields.owner)).toBeUndefined();
	});

	it('refuses an unknown semantic type at declaration time, naming it and the known ones', () => {
		for (const type of ['u257', 'U256', '', 1]) {
			expect(() => normalizeEntity(withAmount({storage: 'blob', type}))).toThrow(/unknown semantic type.*known: u256/);
		}
	});

	it('refuses a storage class the type cannot be encoded in, at declaration time', () => {
		for (const storage of ['text', 'integer', 'real']) {
			expect(() => normalizeEntity(withAmount({storage, type: 'u256'}))).toThrow(
				new RegExp(`u256 in ${storage}.*encoded in blob`),
			);
		}
		expect(() => normalizeEntity(withAmount({storage: 'bytes', type: 'u256'}))).toThrow(/u256 in bytes/);
		expect(() => normalizeEntity(withAmount({type: 'u256'}))).toThrow(/u256 in undefined/);
	});

	it('refuses a field that is both an enum and a semantic type, or carries an unknown key', () => {
		expect(() => normalizeEntity(withAmount({storage: 'blob', type: 'u256', enum: ['a']}))).toThrow(/storage class/);
		expect(() => normalizeEntity(withAmount({storage: 'blob', type: 'u256', codec: 'x'}))).toThrow(/storage class/);
	});

	it('is not mistaken for an enum by the write-time enum check', () => {
		const entity = normalizeEntity(withAmount({storage: 'blob', type: 'u256'}));
		expect(() => assertFieldValues(entity, {amount: u256.encode(1n)})).not.toThrow();
	});

	it('is typed unknown by a derived row until a backend stores it canonically, and a bare field is unchanged', () => {
		const [POOL] = declareEntities([
			{name: 'pool', id: 'id', fields: {amount: {storage: 'blob', type: 'u256'}, owner: 'text'}},
		]);
		expectTypeOf<EntityRow<typeof POOL>['amount']>().toEqualTypeOf<unknown>();
		expectTypeOf<EntityRow<typeof POOL>['owner']>().toEqualTypeOf<string | null>();
	});

	it('leaves a declaration with no semantic type exactly as it was', () => {
		expect(normalizeEntity({name: 'token', id: 'id', fields: {owner: 'text', status: 'blob'}})).toEqual({
			name: 'token',
			id: ['id'],
			fields: {owner: 'text', status: 'blob'},
		});
	});
});
