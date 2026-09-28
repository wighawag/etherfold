import {asOfCases} from './cases/as-of.js';
import {orderingCases} from './cases/ordering.js';
import {predicateCases} from './cases/predicates.js';
import {relationCases} from './cases/relations.js';
import {rowsExaminedCases} from './cases/rows-examined.js';
import {ACCESSOR_ENTITIES} from './fixtures.js';
import type {
	AccessorConformanceCase,
	AccessorConformanceFailure,
	AccessorConformanceOptions,
	AccessorConformanceResult,
	AccessorFactory,
} from './types.js';

/**
 * Every case an accessor must pass, chosen against what its STORE claims and
 * what the backend declares.
 *
 * Parallel to `@etherfold/state-store-conformance`: a probe subject is built
 * once and its store's `capabilities` read, so the as-of chapter asks a store
 * what it said it could answer, and the rows-examined chapter asks the backend
 * the bound it declared (`AccessorConformanceOptions`). Everything else is asked
 * of everyone, because it is what makes one query mean one thing on a server
 * and in a browser (ADR-0099): every operator over every storage class, the null
 * rule, UTF-8 text order, numeric `u256` order, the id tie break and the limit,
 * and a page of parents' children bounded per parent.
 */
export async function accessorConformanceCases(
	factory: AccessorFactory,
	options: AccessorConformanceOptions = {},
): Promise<AccessorConformanceCase[]> {
	const probe = await factory(ACCESSOR_ENTITIES);
	const capabilities = probe.store.capabilities;
	return [
		...predicateCases(factory),
		...orderingCases(factory),
		...asOfCases(factory, capabilities),
		...relationCases(factory, capabilities),
		...rowsExaminedCases(factory, options),
	];
}

/**
 * Run every case and report what failed, without a test runner: so the suite
 * can be asserted ON (a deliberately broken accessor must fail the right cases),
 * and so a backend outside vitest can check itself. It does not stop at the
 * first failure.
 */
export async function runAccessorConformance(
	factory: AccessorFactory,
	options: AccessorConformanceOptions = {},
): Promise<AccessorConformanceResult> {
	const cases = await accessorConformanceCases(factory, options);
	const failures: AccessorConformanceFailure[] = [];
	for (const one of cases) {
		try {
			await one.run();
		} catch (error) {
			failures.push({group: one.group, name: one.name, error});
		}
	}
	return {passed: cases.length - failures.length, failures};
}
