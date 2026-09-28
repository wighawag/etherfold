import {u256} from '@etherfold/state-store';
import {Kind, type ValueNode} from 'graphql';

/**
 * ## The three scalars the declarations need beyond GraphQL's own
 *
 * Each is chosen so a result is JSON and reads the same on every executor
 * (ADR-0099's first parity rule): no executor hands back a `bigint` or a
 * `Uint8Array` locally and a string remotely.
 */

/**
 * `U256`: a `u256` field (ADR-0098), carried as a DECIMAL STRING, because JSON
 * has no `bigint` and a number loses everything past 2^53.
 *
 * In: a decimal string of digits, or (in a document) an integer literal, or (in
 * process) a `bigint` or a safe whole number, each checked against the type's
 * own range (`u256.encode`), so a negative or 257-bit value is refused as the
 * store refuses it, before anything is read. Out: the decimal string of the
 * `bigint` the accessor answers.
 */
export const U256_SCALAR = {
	description: 'An unsigned 256-bit integer (a Solidity uint256), carried as a decimal string.',
	serialize(value: unknown): string {
		if (typeof value !== 'bigint') throw new TypeError(`a U256 is answered from a bigint, got ${typeof value}`);
		return value.toString(10);
	},
	parseValue(value: unknown): bigint {
		return checkedU256(asBigInt(value));
	},
	parseLiteral(node: ValueNode): bigint {
		if (node.kind === Kind.STRING || node.kind === Kind.INT) return checkedU256(asBigInt(node.value));
		throw new TypeError('a U256 is a decimal string or an integer literal');
	},
};

function asBigInt(value: unknown): bigint {
	if (typeof value === 'bigint') return value;
	if (typeof value === 'string' && /^[0-9]+$/.test(value)) return BigInt(value);
	if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
	throw new TypeError(`a U256 is a decimal string of digits, got ${JSON.stringify(value) ?? String(value)}`);
}

function checkedU256(value: bigint): bigint {
	u256.encode(value);
	return value;
}

/**
 * `SafeInt`: an `integer` field, and a block number. GraphQL's `Int` is 32 bits
 * and refuses anything wider at serialisation, which a counter, an amount or a
 * block height on a fast chain would reach; a store's `integer` is answered as
 * a JavaScript number, so the honest range is the safe integers, ±(2^53 - 1).
 * The name is the one `graphql-scalars` uses for the same range.
 */
export const SAFE_INT_SCALAR = {
	description: 'A whole number between -(2^53 - 1) and 2^53 - 1.',
	serialize(value: unknown): number {
		return checkedSafeInt(value);
	},
	parseValue(value: unknown): number {
		return checkedSafeInt(value);
	},
	parseLiteral(node: ValueNode): number {
		if (node.kind === Kind.INT) return checkedSafeInt(Number(node.value));
		throw new TypeError('a SafeInt is an integer literal');
	},
};

function checkedSafeInt(value: unknown): number {
	if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
	throw new TypeError(`a SafeInt is a whole number within ±(2^53 - 1), got ${JSON.stringify(value) ?? String(value)}`);
}

/**
 * `Bytes`: a plain `blob` field, carried as lowercase `0x` hex (an even number
 * of digits). In, the same, case-insensitively; in process a `Uint8Array` too.
 */
export const BYTES_SCALAR = {
	description: 'Bytes, carried as 0x-prefixed hexadecimal.',
	serialize(value: unknown): string {
		if (!(value instanceof Uint8Array)) throw new TypeError('Bytes are answered from a Uint8Array');
		let hex = '0x';
		for (const byte of value) hex += byte.toString(16).padStart(2, '0');
		return hex;
	},
	parseValue(value: unknown): Uint8Array {
		if (value instanceof Uint8Array) return value;
		return fromHex(value);
	},
	parseLiteral(node: ValueNode): Uint8Array {
		if (node.kind === Kind.STRING) return fromHex(node.value);
		throw new TypeError('Bytes are a 0x-prefixed hexadecimal string');
	},
};

function fromHex(value: unknown): Uint8Array {
	if (typeof value !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(value)) {
		throw new TypeError(
			`Bytes are 0x-prefixed hexadecimal with an even number of digits, got ${JSON.stringify(value) ?? String(value)}`,
		);
	}
	const bytes = new Uint8Array((value.length - 2) / 2);
	for (let index = 0; index < bytes.length; index++) {
		bytes[index] = parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
	}
	return bytes;
}
