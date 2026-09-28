import {assertBytes} from './bytes.js';
import {QUERY_PARITY_CASES} from './cases/parity.js';
import {retentionCases} from './cases/retention.js';
import {rowsExaminedCases} from './cases/rows-examined.js';
import {transportCases} from './cases/transport.js';
import {answersHistory, QUERY_ENTITIES, subjectWith} from './fixtures.js';
import type {
	QueryConformanceCase,
	QueryConformanceFailure,
	QueryConformanceOptions,
	QueryConformanceResult,
	QueryExecutorFactory,
	QueryParityCase,
} from './types.js';

/**
 * Every case an executor must pass, chosen against what its STORE claims and
 * what its deployment declares.
 *
 * Parallel to `@etherfold/state-store-conformance` and the accessor suite: a
 * probe subject is built once and its store's `capabilities` read, so the as-of
 * and retention cases ask a store what it said it could answer, and the
 * rows-examined chapter asks the deployment the bound it declared
 * (`QueryConformanceOptions`). Everything else is asked of everyone and must
 * answer the SAME BYTES (`QUERY_PARITY_CASES`), which is what makes one GraphQL
 * document mean one thing against a server and a browser worker (ADR-0099).
 */
export async function queryConformanceCases(
	factory: QueryExecutorFactory,
	options: QueryConformanceOptions = {},
): Promise<QueryConformanceCase[]> {
	const probe = await factory(QUERY_ENTITIES);
	const capabilities = probe.store.capabilities;
	const history = answersHistory(capabilities);
	return [
		...QUERY_PARITY_CASES.filter((one) => history || !one.asOf).map((one) => parityCase(factory, one)),
		...retentionCases(factory, capabilities),
		...rowsExaminedCases(factory, options, capabilities),
		...transportCases(factory, options),
	];
}

/** One entry of the shared list as a case: its history applied, its request asked, its bytes compared. */
export function parityCase(factory: QueryExecutorFactory, one: QueryParityCase): QueryConformanceCase {
	return {
		group: one.group,
		name: one.name,
		async run() {
			const {executor, generation} = await subjectWith(factory, one.history);
			assertBytes(await executor(one.request), one.expected(generation));
		},
	};
}

/**
 * Run every case and report what failed, without a test runner: so the suite
 * can be asserted ON (a deliberately wrong executor must fail the right cases),
 * and so an executor outside vitest can check itself. It does not stop at the
 * first failure.
 */
export async function runQueryConformance(
	factory: QueryExecutorFactory,
	options: QueryConformanceOptions = {},
): Promise<QueryConformanceResult> {
	const cases = await queryConformanceCases(factory, options);
	const failures: QueryConformanceFailure[] = [];
	for (const one of cases) {
		try {
			await one.run();
		} catch (error) {
			failures.push({group: one.group, name: one.name, error});
		}
	}
	return {passed: cases.length - failures.length, failures};
}
