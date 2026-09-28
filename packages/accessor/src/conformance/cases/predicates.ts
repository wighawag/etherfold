import {normalizeEntities, UnknownEntityError} from '@etherfold/state-store';
import {expect} from 'vitest';
import {planFind} from '../../plan.js';
import type {FindQuery, Where} from '../../types.js';
import {
	ACCESSOR_ENTITIES,
	allItems,
	block,
	cases,
	ids,
	itemRow,
	PRIVATE_USE,
	subjectWith,
	TWO_255,
	TWO_64,
} from '../fixtures.js';
import type {AccessorConformanceCase, AccessorFactory} from '../types.js';

const GROUP = 'a predicate means the same on every backend';

/**
 * Every operator, over every storage class, and the null rule.
 *
 * Each expectation is written out rather than computed, so a backend is held to
 * the answer and not to a second implementation of the rule that could share its
 * bug. No case orders, so every answer is in ascending id order (the seam's tie
 * break), which is also asserted.
 */
export function predicateCases(factory: AccessorFactory): AccessorConformanceCase[] {
	async function matching(where: Where): Promise<unknown[]> {
		const {accessor} = await subjectWith(factory, [{block: block(100), mutations: allItems()}]);
		return ids(await accessor.find({entity: 'item', where, limit: 100}));
	}

	/** What the seam's planner says about a query, as the refusal a backend must repeat. */
	function seamRefusal(query: FindQuery): string {
		try {
			planFind(normalizeEntities(ACCESSOR_ENTITIES), query);
		} catch (error) {
			return (error as Error).message;
		}
		throw new Error('the planner accepted a query this case expects it to refuse');
	}

	return cases(GROUP, {
		'no predicate answers every row, in ascending id order, as the seam answers a row': async () => {
			const {accessor} = await subjectWith(factory, [{block: block(100), mutations: allItems()}]);
			const page = await accessor.find({entity: 'item', limit: 100});
			expect(page.truncated).toBe(false);
			// the declared columns only, a u256 as a bigint and a blob as bytes
			expect(page.rows).toEqual(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => itemRow(id)));
		},

		'eq and ne, where a null field matches neither': async () => {
			expect(await matching({field: 'label', op: 'eq', value: 'apple'})).toEqual(['a', 'f']);
			expect(await matching({field: 'label', op: 'ne', value: 'apple'})).toEqual(['b', 'd', 'e']);
			expect(await matching({field: 'kind', op: 'eq', value: 'rare'})).toEqual(['b', 'e']);
		},

		'lt, lte, gt and gte on an integer, where null is neither less nor greater': async () => {
			expect(await matching({field: 'weight', op: 'lt', value: 7})).toEqual(['a', 'd', 'e']);
			expect(await matching({field: 'weight', op: 'lte', value: 7})).toEqual(['a', 'd', 'e', 'f']);
			expect(await matching({field: 'weight', op: 'gt', value: 3})).toEqual(['b', 'f']);
			expect(await matching({field: 'weight', op: 'gte', value: 3})).toEqual(['a', 'b', 'd', 'f']);
		},

		'a real compares as a number': async () => {
			expect(await matching({field: 'ratio', op: 'lt', value: 1})).toEqual(['a', 'd', 'e']);
			expect(await matching({field: 'ratio', op: 'gte', value: 1.5})).toEqual(['b', 'f']);
		},

		'text compares as UTF-8 bytes, so a supplementary-plane character is above U+FFFF': async () => {
			// UTF-16 puts U+1F600 (a surrogate pair from 0xD83D) BELOW U+FFFF, so a
			// backend comparing JavaScript strings would include `e` here
			expect(await matching({field: 'label', op: 'lt', value: '\uFFFF'})).toEqual(['a', 'b', 'd', 'f']);
			expect(await matching({field: 'label', op: 'gt', value: PRIVATE_USE})).toEqual(['e']);
			// bytes, not case-folded: `B` (0x42) is below `a` (0x61)
			expect(await matching({field: 'label', op: 'lt', value: 'a'})).toEqual(['b']);
		},

		'a u256 compares numerically, past 2^64 included': async () => {
			// as decimal text `9` would be above `10`, and as a double 2^64 + 1 would equal 2^64
			expect(await matching({field: 'amount', op: 'gt', value: 9n})).toEqual(['b', 'd', 'e', 'f']);
			expect(await matching({field: 'amount', op: 'lt', value: 10n})).toEqual(['a']);
			expect(await matching({field: 'amount', op: 'eq', value: TWO_64})).toEqual(['d']);
			expect(await matching({field: 'amount', op: 'gt', value: TWO_64})).toEqual(['e', 'f']);
			expect(await matching({field: 'amount', op: 'lte', value: TWO_64 + 1n})).toEqual(['a', 'b', 'd', 'e']);
			expect(await matching({field: 'amount', op: 'ne', value: TWO_255})).toEqual(['a', 'b', 'd', 'e']);
		},

		'a blob compares bytewise, a prefix below what it prefixes': async () => {
			expect(await matching({field: 'tag', op: 'eq', value: new Uint8Array([1])})).toEqual(['a']);
			expect(await matching({field: 'tag', op: 'gt', value: new Uint8Array([1])})).toEqual(['d', 'e']);
			expect(await matching({field: 'tag', op: 'lt', value: new Uint8Array([1])})).toEqual(['b', 'f']);
		},

		'an id column is a field like any other, compared as text': async () => {
			expect(await matching({field: 'id', op: 'eq', value: 'b'})).toEqual(['b']);
			expect(await matching({field: 'id', op: 'gt', value: 'd'})).toEqual(['e', 'f']);
			expect(await matching({field: 'id', op: 'in', values: ['f', 'a', 'z']})).toEqual(['a', 'f']);
		},

		'in matches any listed value, never a null one, and an empty list matches nothing': async () => {
			expect(await matching({field: 'kind', op: 'in', values: ['rare', null]})).toEqual(['b', 'e']);
			expect(await matching({field: 'amount', op: 'in', values: [9n, TWO_255]})).toEqual(['a', 'f']);
			expect(await matching({field: 'label', op: 'in', values: [null]})).toEqual([]);
			expect(await matching({field: 'label', op: 'in', values: []})).toEqual([]);
		},

		'a comparison with null is false, whatever the operator': async () => {
			for (const op of ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] as const) {
				expect(await matching({field: 'label', op, value: null}), op).toEqual([]);
			}
		},

		'isNull is the one operator that sees a null': async () => {
			expect(await matching({field: 'label', op: 'isNull', value: true})).toEqual(['c']);
			expect(await matching({field: 'amount', op: 'isNull', value: false})).toEqual(['a', 'b', 'd', 'e', 'f']);
		},

		'and and or combine, nest, and are true and false when empty': async () => {
			expect(
				await matching({
					and: [
						{field: 'weight', op: 'gte', value: 3},
						{field: 'kind', op: 'eq', value: 'common'},
					],
				}),
			).toEqual(['a', 'd', 'f']);
			expect(
				await matching({
					or: [
						{field: 'label', op: 'eq', value: 'Banana'},
						{field: 'weight', op: 'lt', value: 0},
					],
				}),
			).toEqual(['b', 'e']);
			expect(
				await matching({
					or: [
						{
							and: [
								{field: 'kind', op: 'eq', value: 'common'},
								{field: 'weight', op: 'gt', value: 3},
							],
						},
						{field: 'weight', op: 'isNull', value: true},
					],
				}),
			).toEqual(['c', 'f']);
			expect(await matching({and: []})).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
			expect(await matching({or: []})).toEqual([]);
		},

		"a query the seam cannot mean the same everywhere is refused in the seam's own words": async () => {
			const {accessor} = await subjectWith(factory);
			const refused: FindQuery[] = [
				{entity: 'item', where: {field: 'colour', op: 'eq', value: 'red'}, limit: 1},
				{entity: 'item', where: {field: 'weight', op: 'eq', value: '3'}, limit: 1},
				{entity: 'item', where: {field: 'amount', op: 'eq', value: 9}, limit: 1},
				{entity: 'item', where: {field: 'amount', op: 'eq', value: -1n}, limit: 1},
				{entity: 'item', where: {field: 'tag', op: 'eq', value: 'bytes'}, limit: 1},
				{entity: 'item', orderBy: {field: 'colour'}, limit: 1},
				{entity: 'item', limit: 0},
			];
			for (const query of refused) {
				await expect(accessor.find(query), JSON.stringify(query, bigints)).rejects.toThrow(seamRefusal(query));
			}
			await expect(accessor.find({entity: 'nothing', limit: 1})).rejects.toBeInstanceOf(UnknownEntityError);
		},
	});
}

function bigints(_key: string, value: unknown): unknown {
	return typeof value === 'bigint' ? `${value}n` : value;
}
