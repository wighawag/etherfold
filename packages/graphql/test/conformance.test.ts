import {describeQueryConformance, type QueryExecutorFactory, type QuerySubject} from '../src/conformance/index.js';
import {executorToFetch, httpExecutor, type FetchFunction} from '../src/index.js';
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
 * The HTTP executor joins it here over the `fetch` shim (the in-process
 * executor, served as a `fetch` and read back through `httpExecutor`), so the
 * round trip through JSON text is checked to lose nothing, and the transport
 * chapter is asked of it: its `fetch` is broken three ways. Against a real
 * `/graphql` it is asked in `@etherfold/server` and by `etherfold serve`. The
 * worker executor (`a-worker-host-answers-graphql-over-its-port`) joins as it
 * lands.
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

/**
 * The in-process executor served as a `fetch` and read back through `httpExecutor`,
 * with a switch that BREAKS the fetch the way each transport failure happens: a
 * `500` (a server that failed), a `200` whose body is HTML (a captive portal), and
 * a rejected fetch (nothing answered).
 */
function overTheShim(factory: QueryExecutorFactory): QueryExecutorFactory {
	return async (declarations) => {
		const inner = await factory(declarations);
		const served = executorToFetch(inner.executor);
		const broken = new WeakMap<QuerySubject, FetchFunction>();
		const subject: QuerySubject = {
			store: inner.store,
			generation: inner.generation,
			executor: httpExecutor('http://in-process/graphql', {
				fetch: (input, init) => (broken.get(subject) ?? served)(input, init),
			}),
		};
		breakers.set(subject, (fetch) => broken.set(subject, fetch));
		return subject;
	};
}

const breakers = new WeakMap<QuerySubject, (fetch: FetchFunction) => void>();
const breakWith = (fetch: FetchFunction) => (subject: QuerySubject) => breakers.get(subject)!(fetch);

await describeQueryConformance('httpExecutor over the fetch shim, over SQLite', overTheShim(sqliteExecutor()), {
	transportFailures: {
		'http-status': breakWith(async () => new Response('{"success":false}', {status: 500})),
		'invalid-body': breakWith(async () => new Response('<html>a captive portal</html>', {status: 200})),
		network: breakWith(() => Promise.reject(new TypeError('fetch failed'))),
	},
});
