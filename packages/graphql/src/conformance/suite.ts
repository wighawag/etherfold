import {assertBytes} from './bytes.js';
import {QUERY_PARITY_CASES} from './cases/parity.js';
import {retentionCases} from './cases/retention.js';
import {rowsExaminedCases} from './cases/rows-examined.js';
import {transportCases} from './cases/transport.js';
import {answersHistory, extensions, QUERY_ENTITIES, subjectWith} from './fixtures.js';
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
	const takenAt = options.snapshotTakenAt;
	if (takenAt !== undefined && (!Number.isSafeInteger(takenAt) || takenAt < 0 || takenAt >= FIRST_WRITTEN_BLOCK)) {
		throw new Error(
			`snapshotTakenAt must be a block number below ${FIRST_WRITTEN_BLOCK}, the lowest block a case writes, got ` +
				`${JSON.stringify(takenAt) ?? String(takenAt)}`,
		);
	}
	const probe = await factory(QUERY_ENTITIES);
	const capabilities = probe.store.capabilities;
	const history = answersHistory(capabilities);
	return [
		...QUERY_PARITY_CASES.filter((one) => history || !one.asOf).map((one) =>
			parityCase(factory, takenAt === undefined ? one : fromSnapshot(one, takenAt)),
		),
		...retentionCases(factory, capabilities),
		...rowsExaminedCases(factory, options, capabilities),
		...transportCases(factory, options),
	];
}

/** The lowest block any case writes: a snapshot a subject starts from must be cut below it. */
const FIRST_WRITTEN_BLOCK = 10;

/**
 * A case as it is asked of a store bootstrapped to `takenAt`
 * (`QueryConformanceOptions.snapshotTakenAt`): one that writes NOTHING, and so
 * expects an answer pinned to no block, is pinned to the snapshot's cut instead,
 * the tip such a store holds before anything is written. Every other case writes
 * above the cut and is asked exactly as it is.
 */
function fromSnapshot(one: QueryParityCase, takenAt: number): QueryParityCase {
	if (one.history.length > 0) return one;
	return {
		...one,
		name: `${one.name} (a store bootstrapped to block ${takenAt} holding no row: pinned to that block)`,
		expected(generation) {
			const expected = one.expected(generation);
			if (expected.extensions?.block !== null) {
				throw new Error(`the case "${one.name}" writes nothing but does not expect an answer pinned to no block`);
			}
			return {...expected, extensions: extensions(generation, takenAt)};
		},
	};
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
