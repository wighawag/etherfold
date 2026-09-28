import type {Mutation} from '@etherfold/state-store';
import {expect} from 'vitest';
import {RowsExaminedBoundError, ROWS_EXAMINED_BOUND} from '../../errors.js';
import type {FindQuery} from '../../types.js';
import {block, cases, subjectWith} from '../fixtures.js';
import type {AccessorConformanceCase, AccessorConformanceOptions, AccessorFactory} from '../types.js';

const GROUP = 'a rows-examined bound is declared, and held to';

/**
 * How many rows a backend declaring NO bound is asked to answer over: one more
 * than the browser's default bound (25,000, ADR-0099), so "no bound" is checked
 * at the size where a bounded backend would already have refused.
 */
export const UNBOUNDED_PROBE_ROWS = 25_001;

function crowd(count: number): Mutation[] {
	return Array.from({length: count}, (_, n) => ({type: 'upsert', entity: 'crowd', id: {id: `p${n}`}, values: {n}}));
}

/**
 * A query no backend answers without examining every row: the predicate matches
 * all of them and the order is by a field the predicate does not narrow, so the
 * one row answered is the largest of all.
 */
const EXAMINES_EVERY_ROW: FindQuery = {
	entity: 'crowd',
	where: {field: 'n', op: 'gte', value: 0},
	orderBy: {field: 'n', direction: 'desc'},
	limit: 1,
};

/**
 * The bound is a backend's own and a DOCUMENTED difference between deployments,
 * not a parity rule (ADR-0099), so this chapter asks each backend what it
 * DECLARED (`AccessorConformanceOptions.rowsExaminedBound`): a bounded backend
 * answers up to its bound and refuses past it with the seam's coded error naming
 * the bound, and a backend declaring none answers where a bounded one would have
 * refused.
 */
export function rowsExaminedCases(
	factory: AccessorFactory,
	options: AccessorConformanceOptions,
): AccessorConformanceCase[] {
	const bound = options.rowsExaminedBound;
	if (bound === undefined) {
		return cases(GROUP, {
			[`a backend declaring no bound answers a query examining ${UNBOUNDED_PROBE_ROWS} rows`]: async () => {
				const {accessor} = await subjectWith(factory, [{block: block(100), mutations: crowd(UNBOUNDED_PROBE_ROWS)}]);
				const page = await accessor.find(EXAMINES_EVERY_ROW);
				expect(page.rows).toEqual([{id: `p${UNBOUNDED_PROBE_ROWS - 1}`, n: UNBOUNDED_PROBE_ROWS - 1}]);
				expect(page.truncated).toBe(true);
			},
		});
	}

	if (!Number.isInteger(bound) || bound < 1) {
		throw new Error(`rowsExaminedBound must be a whole number of rows, at least 1, got ${JSON.stringify(bound)}`);
	}

	return cases(GROUP, {
		[`a backend declaring a bound of ${bound} answers a query examining that many rows`]: async () => {
			const {accessor} = await subjectWith(factory, [{block: block(100), mutations: crowd(bound)}]);
			const page = await accessor.find(EXAMINES_EVERY_ROW);
			expect(page.rows).toEqual([{id: `p${bound - 1}`, n: bound - 1}]);
		},

		[`and refuses one examining more, with the seam's coded error naming the bound`]: async () => {
			const {accessor} = await subjectWith(factory, [{block: block(100), mutations: crowd(bound + 1)}]);
			const refused = await accessor.find(EXAMINES_EVERY_ROW).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(refused).toBeInstanceOf(RowsExaminedBoundError);
			expect(refused).toMatchObject({code: ROWS_EXAMINED_BOUND, bound, entity: 'crowd'});
		},
	});
}
