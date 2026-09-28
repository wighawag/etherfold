import {describe, it} from 'vitest';
import {accessorConformanceCases} from './suite.js';
import type {AccessorConformanceCase, AccessorConformanceOptions, AccessorFactory} from './types.js';

/**
 * Register the whole suite as vitest tests. One factory, one call, awaited at
 * the top level of the test file (the case list depends on what the store
 * claims, which is read from a probe):
 *
 * ```ts
 * await describeAccessorConformance('the SQLite accessor', (declarations) => {
 *   const store = new VersionedStateStore(createTestDB(), declarations);
 *   return {store, accessor: store.accessor()};
 * });
 * ```
 *
 * A bounded backend passes the bound it was configured with as
 * `{rowsExaminedBound}`; see `AccessorConformanceOptions`.
 */
export async function describeAccessorConformance(
	label: string,
	factory: AccessorFactory,
	options: AccessorConformanceOptions = {},
): Promise<void> {
	const cases = await accessorConformanceCases(factory, options);
	describe(label, () => {
		for (const [group, list] of byGroup(cases)) {
			describe(group, () => {
				for (const one of list) it(one.name, one.run);
			});
		}
	});
}

function byGroup(cases: readonly AccessorConformanceCase[]): Map<string, AccessorConformanceCase[]> {
	const groups = new Map<string, AccessorConformanceCase[]>();
	for (const one of cases) {
		const list = groups.get(one.group) ?? [];
		if (list.length === 0) groups.set(one.group, list);
		list.push(one);
	}
	return groups;
}
