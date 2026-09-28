import {expect} from 'vitest';
import type {QueryResult} from '../executor.js';

/**
 * "The same query answers the same" means the same BYTES (ADR-0099): what
 * crosses a transport is the JSON text, so two executors whose results are
 * deeply equal but serialise differently (a key in another order, a `bigint`
 * where a string was owed, an `undefined` that vanishes on one side) do not
 * answer the same. So a result is compared as the string it serialises to.
 *
 * The deep comparison runs first only for the readable diff it prints; the
 * string comparison is the assertion.
 */
export function assertBytes(actual: QueryResult, expected: QueryResult): void {
	expect(plain(actual)).toEqual(expected);
	expect(serialised(actual)).toBe(JSON.stringify(expected));
}

/** The result as JSON text, or a marker naming why it is not JSON at all (a `bigint` throws in `JSON.stringify`). */
export function serialised(result: unknown): string {
	try {
		return JSON.stringify(result);
	} catch (error) {
		return `<not JSON: ${(error as Error).message}>`;
	}
}

function plain(result: unknown): unknown {
	const text = serialised(result);
	return text.startsWith('<not JSON') ? result : JSON.parse(text);
}
