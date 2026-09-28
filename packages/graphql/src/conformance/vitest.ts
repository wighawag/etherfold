import {describe, it} from 'vitest';
import {queryConformanceCases} from './suite.js';
import type {QueryConformanceCase, QueryConformanceOptions, QueryExecutorFactory} from './types.js';

/**
 * Register the whole suite as vitest tests. One factory, one call, awaited at
 * the top level of the test file (the case list depends on what the store
 * claims, which is read from a probe):
 *
 * ```ts
 * await describeQueryConformance('the in-process executor over SQLite', (declarations) => {
 *   const store = new VersionedStateStore(createTestDB(), declarations);
 *   const executor = localExecutor(buildQuerySchema(declarations), {accessor: store.accessor(), generation, tip});
 *   return {store, executor, generation};
 * });
 * ```
 *
 * A deployment whose accessor is bounded passes the bound it was configured
 * with as `{rowsExaminedBound}`, and an executor with a transport passes how to
 * break it as `{transportFailures}`; see `QueryConformanceOptions`.
 */
export async function describeQueryConformance(
	label: string,
	factory: QueryExecutorFactory,
	options: QueryConformanceOptions = {},
): Promise<void> {
	const cases = await queryConformanceCases(factory, options);
	describe(label, () => {
		for (const [group, list] of byGroup(cases)) {
			describe(group, () => {
				for (const one of list) it(one.name, one.run);
			});
		}
	});
}

function byGroup(cases: readonly QueryConformanceCase[]): Map<string, QueryConformanceCase[]> {
	const groups = new Map<string, QueryConformanceCase[]>();
	for (const one of cases) {
		const list = groups.get(one.group) ?? [];
		if (list.length === 0) groups.set(one.group, list);
		list.push(one);
	}
	return groups;
}
