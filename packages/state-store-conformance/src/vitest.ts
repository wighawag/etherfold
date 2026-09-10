import {describe, it} from 'vitest';
import {stateStoreConformanceCases} from './suite.js';
import type {ConformanceCase, StateStoreConformanceOptions, StateStoreFactory} from './types.js';

/**
 * Register the whole suite as vitest tests. One factory, one call:
 *
 * ```ts
 * await describeStateStoreConformance('the versioned-row store', (declarations) =>
 *   new VersionedStateStore(createTestDB(), declarations),
 * );
 * ```
 *
 * It is awaited at the top level of the test file, because the case list depends
 * on what the backend claims and the claim can only be read from a store. Vitest
 * collects a test file as an ES module, so the top-level await finishes before
 * collection does, and each case is registered as its own `it` -- which is the
 * point of the adapter: a failure is reported as the behaviour that broke rather
 * than as one opaque red suite.
 *
 * The optional third argument is what a backend can say BEYOND a factory: today
 * that is how to open a SECOND handle on one storage, which is what the
 * contention chapter needs and what a fresh-database-per-call factory cannot
 * express. See `StateStoreConformanceOptions`.
 */
export async function describeStateStoreConformance(
	label: string,
	factory: StateStoreFactory,
	options: StateStoreConformanceOptions = {},
): Promise<void> {
	const cases = await stateStoreConformanceCases(factory, options);

	describe(label, () => {
		for (const [group, list] of byGroup(cases)) {
			describe(group, () => {
				for (const one of list) it(one.name, one.run);
			});
		}
	});
}

/** Cases in the order they were declared, gathered under their group. */
function byGroup(cases: readonly ConformanceCase[]): Map<string, ConformanceCase[]> {
	const groups = new Map<string, ConformanceCase[]>();
	for (const one of cases) {
		const list = groups.get(one.group) ?? [];
		if (list.length === 0) groups.set(one.group, list);
		list.push(one);
	}
	return groups;
}
