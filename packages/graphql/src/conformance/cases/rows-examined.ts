import {ROWS_EXAMINED_BOUND} from '@etherfold/accessor';
import {UNBOUNDED_PROBE_ROWS} from '@etherfold/accessor/conformance';
import type {StateStoreCapabilities} from '@etherfold/state-store';
import {expect} from 'vitest';
import {QUERY_ERROR_CODES} from '../../errors.js';
import type {QueryResult} from '../../executor.js';
import {assertBytes} from '../bytes.js';
import {answer, answersHistory, cases, crowd, deposit, extensions, pool, subjectWith} from '../fixtures.js';
import type {HistoryStep, QueryConformanceCase, QueryConformanceOptions, QueryExecutorFactory} from '../types.js';

const GROUP = 'what a deployment cannot serve is refused with the accessor code, per executor';

/**
 * ## A documented difference, asserted PER EXECUTOR (ADR-0099)
 *
 * The rows-examined bound is the IndexedDB accessor's alone: SQLite has a query
 * planner and a server answers what it can serve, so the refusal is NOT a parity
 * rule. The suite asks each executor what its deployment DECLARED
 * (`QueryConformanceOptions.rowsExaminedBound`) about the three queries a
 * bounded browser accessor cannot serve:
 *
 * - a scan past the bound (every row matches, the one answered is the largest);
 * - ONE parent's children past it (the bound is per parent, so the others are
 *   not what refuses it);
 * - an as-of query whose DELTA is past it: the versions closed since the block,
 *   counted across every entity, so a query on a quiet entity (`pool`) is
 *   refused because another (`crowd`) churned.
 *
 * Declaring a bound, each is refused with the accessor's code
 * (`rows-examined-bound`) carried through unchanged, naming the entity and the
 * bound, at the field that asked, and the answer is still pinned and reports its
 * generation. Declaring none, each is ANSWERED, at a size past the browser's
 * default bound (`UNBOUNDED_PROBE_ROWS`), so the same query is served by one
 * deployment and refused by the other, which is the difference documented.
 */
export function rowsExaminedCases(
	factory: QueryExecutorFactory,
	options: QueryConformanceOptions,
	capabilities: StateStoreCapabilities,
): QueryConformanceCase[] {
	const bound = options.rowsExaminedBound;
	if (bound !== undefined && (!Number.isInteger(bound) || bound < 1)) {
		throw new Error(`rowsExaminedBound must be a whole number of rows, at least 1, got ${JSON.stringify(bound)}`);
	}
	/** Past the bound when there is one; past the browser's default when there is none. */
	const rows = bound === undefined ? UNBOUNDED_PROBE_ROWS : bound + 1;
	const largest = rows - 1;

	const refusedAt = (
		result: QueryResult,
		generation: string,
		pinned: number,
		entity: string,
		path: readonly (string | number)[],
	) => {
		expect(result.data).toBeNull();
		expect(result.extensions).toEqual(extensions(generation, pinned));
		expect(result.errors).toHaveLength(1);
		const [error] = result.errors!;
		expect(error!.path).toEqual(path);
		expect(error!.extensions).toEqual({code: QUERY_ERROR_CODES.rowsExaminedBound, entity, bound});
		expect(error!.extensions.code).toBe(ROWS_EXAMINED_BOUND);
		expect(typeof error!.message).toBe('string');
		// it is JSON, as every result is
		expect(JSON.parse(JSON.stringify(result))).toEqual(result);
	};

	const scan: HistoryStep[] = [{block: 100, mutations: crowd(rows)}];
	const scanQuery = `{ crowd(where: {n: {gte: 0}}, orderBy: {field: n, direction: desc}, first: 1) { id n } }`;

	const children: HistoryStep[] = [
		{
			block: 100,
			mutations: [
				pool('big', {label: 'big'}),
				pool('small', {label: 'small'}),
				deposit('small', 's0', {who: 'one', amount: 1n}),
				...Array.from({length: rows}, (_, n) => deposit('big', `s${n}`, {who: 'many', amount: BigInt(n)})),
			],
		},
	];
	const childrenQuery = `{ pool(where: {pool: {eq: "big"}}, first: 1) { pool deposits(orderBy: {field: amount, direction: desc}, first: 1) { seq amount } } }`;
	const quietSibling = `{ pool(where: {pool: {eq: "small"}}, first: 1) { pool deposits(first: 10) { seq } } }`;

	// a quiet `pool` beside a `crowd` that churned entirely after block 100
	const delta: HistoryStep[] = [
		{block: 100, mutations: [pool('quiet', {label: 'quiet'}), ...crowd(rows)]},
		{block: 101, mutations: crowd(rows, 1)},
	];
	const deltaQuery = `{ pool(block: {number: 100}, first: 10) { pool label } }`;

	const history = answersHistory(capabilities);

	if (bound === undefined) {
		return cases(GROUP, {
			[`declaring no bound, a scan of ${rows} rows is answered`]: async () => {
				const {executor, generation} = await subjectWith(factory, scan);
				assertBytes(
					await executor({query: scanQuery}),
					answer({crowd: [{id: `p${largest}`, n: largest}]}, generation, 100),
				);
			},
			[`declaring no bound, a parent's ${rows} children are answered`]: async () => {
				const {executor, generation} = await subjectWith(factory, children);
				assertBytes(
					await executor({query: childrenQuery}),
					answer({pool: [{pool: 'big', deposits: [{seq: `s${largest}`, amount: String(largest)}]}]}, generation, 100),
				);
			},
			...(history
				? {
						[`declaring no bound, an as-of query is answered past ${rows} versions of churn since its block`]:
							async () => {
								const {executor, generation} = await subjectWith(factory, delta);
								assertBytes(
									await executor({query: deltaQuery}),
									answer({pool: [{pool: 'quiet', label: 'quiet'}]}, generation, 101),
								);
							},
					}
				: {}),
		});
	}

	return cases(GROUP, {
		[`declaring a bound of ${bound}, a scan examining more rows is refused with the accessor's code`]: async () => {
			const {executor, generation} = await subjectWith(factory, scan);
			refusedAt(await executor({query: scanQuery}), generation, 100, 'crowd', ['crowd']);
		},
		[`declaring a bound of ${bound}, one parent's children past it are refused, and a quiet sibling is answered`]:
			async () => {
				const {executor, generation} = await subjectWith(factory, children);
				refusedAt(await executor({query: childrenQuery}), generation, 100, 'deposit', ['pool', 0, 'deposits']);
				assertBytes(
					await executor({query: quietSibling}),
					answer({pool: [{pool: 'small', deposits: [{seq: 's0'}]}]}, generation, 100),
				);
			},
		...(history
			? {
					[`declaring a bound of ${bound}, an as-of query on a quiet entity is refused when others churned past it`]:
						async () => {
							const {executor, generation} = await subjectWith(factory, delta);
							refusedAt(await executor({query: deltaQuery}), generation, 101, 'pool', ['pool']);
							// and at the tip, where there is no delta, the same entity is answered
							assertBytes(
								await executor({query: `{ pool(first: 10) { pool label } }`}),
								answer({pool: [{pool: 'quiet', label: 'quiet'}]}, generation, 101),
							);
						},
				}
			: {}),
	});
}
