import type {FieldDeclaration, FieldType, SemanticTypeName} from './types.js';

/**
 * ## The semantic-type registry (ADR-0098)
 *
 * A semantic type is a tag BESIDE a field's storage class (`{storage: 'blob',
 * type: 'u256'}`), saying the stored value means more than its storage class.
 * It owns three things or it is not worth having: a CANONICAL encoding (one
 * stored form per value, so equality on the stored form is equality on the
 * value), an EQUALITY and an ORDERING. `FieldType` stays the four storage
 * classes: storage and meaning are different axes, and a fifth `FieldType` would
 * make every future semantic type a DDL case on every backend.
 *
 * The registry is the one place a semantic type is defined, so a declaration
 * naming a type it does not hold, or a storage class the type cannot be encoded
 * in, is refused at DECLARATION time, on every backend, like the identifier
 * rules (`normalizeEntity`).
 *
 * The ordering is a promise of the layers that order (the accessor seam and the
 * IndexedDB index, ADR-0099). The store seam still orders only ids,
 * lexicographically (ADR-0021), and a semantic type does not change that.
 */
export type SemanticType<Value, Encoded> = {
	/** the name a declaration uses in `{storage, type}` */
	readonly name: SemanticTypeName;
	/** the storage classes this type can be encoded in; any other is refused at declaration time */
	readonly storage: readonly FieldType[];
	/** the canonical stored form of a value; refuses a value the type does not admit */
	encode(value: Value): Encoded;
	/** the value a canonical stored form means; refuses a form that is not one */
	decode(encoded: Encoded): Value;
	/** whether two values are the same value */
	equals(a: Value, b: Value): boolean;
	/** the type's order: negative, zero or positive, as `Array.prototype.sort` wants */
	compare(a: Value, b: Value): number;
};

const U256_BYTES = 32;
const U256_MAX = (1n << 256n) - 1n;

/**
 * An unsigned 256-bit integer, a Solidity `uint256`: a `bigint` as a value, and
 * 32 big-endian bytes stored in a `blob`.
 *
 * Big-endian and FIXED-WIDTH is what makes the bytewise order of the encoding
 * the numeric order (so `9` sorts before `10`, which decimal text does not),
 * and binary keys sort bytewise on Chromium, Firefox and WebKit
 * (`docs/spikes/a-multientry-index-over-computed-field-keys/`, case G), which is
 * the same shape as a sortable BLOB in SQLite. Fixed width is also what makes
 * the encoding canonical: there is no leading-zero or hex spelling of a value.
 */
export const u256: SemanticType<bigint, Uint8Array> = Object.freeze({
	name: 'u256',
	storage: Object.freeze(['blob'] as const),
	encode(value: bigint): Uint8Array {
		if (typeof value !== 'bigint') {
			throw new Error(`a u256 is a bigint, and ${describeValue(value)} is not a bigint`);
		}
		if (value < 0n) throw new Error(`a u256 is unsigned, and ${value} is negative`);
		if (value > U256_MAX) throw new Error(`a u256 is at most 2^256 - 1, and ${value} is wider than 256 bits`);
		const bytes = new Uint8Array(U256_BYTES);
		let rest = value;
		for (let index = U256_BYTES - 1; index >= 0 && rest > 0n; index--) {
			bytes[index] = Number(rest & 0xffn);
			rest >>= 8n;
		}
		return bytes;
	},
	decode(encoded: Uint8Array): bigint {
		if (!(encoded instanceof Uint8Array) || encoded.length !== U256_BYTES) {
			throw new Error(`a u256 is stored as ${U256_BYTES} bytes, big-endian, and ${describeValue(encoded)} is not that`);
		}
		let value = 0n;
		for (const byte of encoded) value = (value << 8n) | BigInt(byte);
		return value;
	},
	equals(a: bigint, b: bigint): boolean {
		return a === b;
	},
	compare(a: bigint, b: bigint): number {
		return a < b ? -1 : a > b ? 1 : 0;
	},
});

/**
 * Every semantic type a declaration may name, by name. Keyed by
 * `SemanticTypeName`, so a name added to the type without a definition here (or
 * the reverse) does not compile.
 */
export const SEMANTIC_TYPES: {readonly [Name in SemanticTypeName]: SemanticType<unknown, unknown>} = Object.freeze({
	u256,
});

/** The semantic type a declared field names, or `undefined` for a bare storage class or an enum. */
export function semanticTypeOf(field: FieldDeclaration): SemanticType<unknown, unknown> | undefined {
	return typeof field === 'object' && 'type' in field ? SEMANTIC_TYPES[field.type] : undefined;
}

/** Whether a name is one the registry holds (own keys only: `toString` is not a semantic type). */
export function isSemanticTypeName(name: unknown): name is SemanticTypeName {
	return typeof name === 'string' && Object.hasOwn(SEMANTIC_TYPES, name);
}

function describeValue(value: unknown): string {
	if (value instanceof Uint8Array) return `${value.length} bytes`;
	if (typeof value === 'bigint') return `${value}n`;
	return value === undefined ? 'undefined' : (JSON.stringify(value) ?? String(value));
}
