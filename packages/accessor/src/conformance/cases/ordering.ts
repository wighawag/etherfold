import {expect} from 'vitest';
import type {OrderBy} from '../../types.js';
import {allItems, block, cases, ids, subjectWith} from '../fixtures.js';
import type {AccessorConformanceCase, AccessorFactory} from '../types.js';

const GROUP = 'an order and a limit mean the same on every backend';

/**
 * Ordering by each storage class, both ways, with nulls first ascending and last
 * descending, ties broken by the declared id ascending, and a limit that cuts
 * the same rows everywhere and says whether it cut any.
 */
export function orderingCases(factory: AccessorFactory): AccessorConformanceCase[] {
	async function ordered(orderBy: OrderBy, limit = 100): Promise<{ids: unknown[]; truncated: boolean}> {
		const {accessor} = await subjectWith(factory, [{block: block(100), mutations: allItems()}]);
		const page = await accessor.find({entity: 'item', orderBy, limit});
		return {ids: ids(page), truncated: page.truncated};
	}

	return cases(GROUP, {
		'text orders by UTF-8 bytes, nulls first ascending, ties by id': async () => {
			// `B` before `a`, and U+E000 before U+1F600, which UTF-16 would reverse
			expect((await ordered({field: 'label'})).ids).toEqual(['c', 'b', 'a', 'f', 'd', 'e']);
		},

		'descending puts nulls last, and ties still ascend by id': async () => {
			expect((await ordered({field: 'label', direction: 'desc'})).ids).toEqual(['e', 'd', 'a', 'f', 'b', 'c']);
		},

		'a u256 orders numerically: 9 before 10, and past 2^64': async () => {
			expect((await ordered({field: 'amount'})).ids).toEqual(['c', 'a', 'b', 'd', 'e', 'f']);
			expect((await ordered({field: 'amount', direction: 'desc'})).ids).toEqual(['f', 'e', 'd', 'b', 'a', 'c']);
		},

		'an integer and a real order as numbers': async () => {
			expect((await ordered({field: 'weight'})).ids).toEqual(['c', 'e', 'a', 'd', 'f', 'b']);
			expect((await ordered({field: 'ratio'})).ids).toEqual(['c', 'd', 'e', 'a', 'b', 'f']);
		},

		'a blob orders bytewise, a prefix before what it prefixes': async () => {
			expect((await ordered({field: 'tag'})).ids).toEqual(['c', 'f', 'b', 'a', 'e', 'd']);
		},

		'an id column orders like a text field': async () => {
			expect((await ordered({field: 'id', direction: 'desc'})).ids).toEqual(['f', 'e', 'd', 'c', 'b', 'a']);
		},

		'a limit cuts the ordered rows and says it did': async () => {
			expect(await ordered({field: 'weight'}, 2)).toEqual({ids: ['c', 'e'], truncated: true});
			expect(await ordered({field: 'weight', direction: 'desc'}, 3)).toEqual({ids: ['b', 'f', 'a'], truncated: true});
		},

		'a limit the rows exactly fill is not truncated': async () => {
			expect(await ordered({field: 'weight'}, 6)).toEqual({
				ids: ['c', 'e', 'a', 'd', 'f', 'b'],
				truncated: false,
			});
		},

		'a limit applies after the predicate': async () => {
			const {accessor} = await subjectWith(factory, [{block: block(100), mutations: allItems()}]);
			const page = await accessor.find({
				entity: 'item',
				where: {field: 'kind', op: 'eq', value: 'common'},
				orderBy: {field: 'amount', direction: 'desc'},
				limit: 2,
			});
			expect({ids: ids(page), truncated: page.truncated}).toEqual({ids: ['f', 'd'], truncated: true});
		},
	});
}
