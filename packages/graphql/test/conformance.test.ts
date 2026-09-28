import {describeQueryConformance} from '../src/conformance/index.js';
import {indexedDBExecutor, sqliteExecutor} from './executors.js';

/**
 * THE SAME QUERY ANSWERS THE SAME ON BOTH BACKENDS (ADR-0099): the query
 * conformance suite asked of the in-process executor over a SQLite accessor and
 * over an IndexedDB accessor. Every case of the shared list must answer the
 * same BYTES on both; the retention refusal has one code (and one message)
 * everywhere; and the rows-examined bound is asserted PER EXECUTOR, because it
 * is a documented difference between deployments and not a parity rule: the
 * IndexedDB executor DECLARES the bound its accessor was configured with and is
 * asked to refuse past it with the accessor's code, the SQLite executor declares
 * none and is asked to answer the same queries.
 *
 * Once per retention claim on each backend, because the as-of and retention
 * cases ask a store what it said it could answer.
 *
 * The HTTP executor (`a-server-answers-graphql-over-http`) and the worker
 * executor (`a-worker-host-answers-graphql-over-its-port`) join this suite as
 * they land.
 */

/** Small, so the refusal cases stay cheap; the accessor's default (25,000) is its own package's to assert. */
const BOUND = 60;

await describeQueryConformance('the in-process executor over SQLite, keeping everything', sqliteExecutor());

await describeQueryConformance(
	'the in-process executor over SQLite, claiming a 60-block window',
	sqliteExecutor({retention: {blocks: 60}, finalityDepth: 60}),
);

await describeQueryConformance(
	'the in-process executor over SQLite, revert-only',
	sqliteExecutor({retention: 'revert-only'}),
);

await describeQueryConformance(
	'the in-process executor over IndexedDB, keeping everything',
	indexedDBExecutor({rowsExaminedBound: BOUND}),
	{rowsExaminedBound: BOUND},
);

await describeQueryConformance(
	'the in-process executor over IndexedDB, claiming a 60-block window',
	indexedDBExecutor({retention: {blocks: 60}, finalityDepth: 60, rowsExaminedBound: BOUND}),
	{rowsExaminedBound: BOUND},
);

await describeQueryConformance(
	'the in-process executor over IndexedDB, revert-only',
	indexedDBExecutor({retention: 'revert-only', rowsExaminedBound: BOUND}),
	{rowsExaminedBound: BOUND},
);
