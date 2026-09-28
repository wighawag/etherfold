import {describe, expect, it} from 'vitest';
import {describeQueryConformance, HISTORY, subjectWith} from '../src/conformance/index.js';
import {DocumentCache, isTransportFailure, QUERY_ERROR_CODES} from '../src/index.js';
import {graphqlQueryHandler} from '../src/worker/index.js';
import {
	closePort,
	mainThreadHostExecutor,
	portOf,
	readerHostExecutor,
	terminateHost,
	workerHostExecutor,
	type WorkerExecutorOptions,
} from './workerHosts.js';

/**
 * THE WORKER EXECUTOR (ADR-0099): `workerExecutor` over the port to a host whose
 * entry injected `graphqlQueryHandler`, asked the whole query conformance suite,
 * byte for byte, against a dedicated-worker host and a SharedWorker host (the
 * real host code of `@etherfold/browser`, over real `MessagePort`s), and against
 * a READER under the tab election, which answers from the shared store it opened
 * for reading. The transport chapter is asked of each: a closed port and a
 * terminated host each resolve as the one transport-failure shape.
 *
 * The rows-examined bound is the IndexedDB accessor's, configured through the
 * handler and declared to the suite, exactly as for the in-process executor.
 */

const BOUND = 60;

const transportFailures = {'port-closed': closePort, 'host-gone': terminateHost};

function bounded(options: WorkerExecutorOptions = {}): WorkerExecutorOptions {
	return {...options, rowsExaminedBound: BOUND};
}

await describeQueryConformance(
	'workerExecutor over a dedicated-worker host, keeping everything',
	workerHostExecutor('dedicated-worker', bounded()),
	{rowsExaminedBound: BOUND, transportFailures},
);

await describeQueryConformance(
	'workerExecutor over a dedicated-worker host, claiming a 60-block window',
	workerHostExecutor('dedicated-worker', bounded({retention: {blocks: 60}, finalityDepth: 60})),
	{rowsExaminedBound: BOUND},
);

await describeQueryConformance(
	'workerExecutor over a dedicated-worker host, revert-only',
	workerHostExecutor('dedicated-worker', bounded({retention: 'revert-only'})),
	{rowsExaminedBound: BOUND},
);

await describeQueryConformance(
	'workerExecutor over a SharedWorker host, keeping everything',
	workerHostExecutor('shared-worker', bounded()),
	{rowsExaminedBound: BOUND, transportFailures},
);

await describeQueryConformance(
	'workerExecutor over a READER host under the tab election, keeping everything',
	readerHostExecutor(bounded()),
	{rowsExaminedBound: BOUND, transportFailures},
);

await describeQueryConformance(
	'workerExecutor over the main-thread host, keeping everything',
	mainThreadHostExecutor(bounded()),
	{rowsExaminedBound: BOUND, transportFailures: {'port-closed': closePort}},
);

describe('the worker host', () => {
	it('caches parsed documents: a repeated document is not parsed again', async () => {
		const documents = new DocumentCache();
		const factory = workerHostExecutor('dedicated-worker', {
			query: graphqlQueryHandler({documents}),
		});
		const {executor} = await subjectWith(factory, HISTORY);
		const request = {query: `{ pool(first: 10) { pool label } }`};
		const first = await executor(request);
		expect(documents.parsed).toBe(1);
		const second = await executor(request);
		expect(documents.parsed).toBe(1);
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
		// another document is parsed, once
		await executor({query: `{ pool(first: 1) { pool } }`});
		await executor({query: `{ pool(first: 1) { pool } }`});
		expect(documents.parsed).toBe(2);
		// a document that does not parse is refused from the cache too
		await executor({query: `{ pool(`});
		const refused = await executor({query: `{ pool(`});
		expect(refused.errors?.[0]?.extensions.code).toBe(QUERY_ERROR_CODES.invalidQuery);
		expect(documents.parsed).toBe(3);
	});

	it('keeps a bounded number of documents, evicting the least recently used', async () => {
		expect(() => new DocumentCache({max: 0})).toThrow(/at least 1/);
		const documents = new DocumentCache({max: 2});
		const {executor} = await subjectWith(
			workerHostExecutor('dedicated-worker', {query: graphqlQueryHandler({documents})}),
		);
		const a = {query: `{ pool(first: 1) { pool } }`};
		const b = {query: `{ pool(first: 2) { pool } }`};
		const c = {query: `{ pool(first: 3) { pool } }`};
		await executor(a);
		await executor(b);
		await executor(a); // a is now the most recently used
		await executor(c); // evicts b
		expect(documents.parsed).toBe(3);
		await executor(a);
		expect(documents.parsed).toBe(3);
		await executor(b);
		expect(documents.parsed).toBe(4);
	});

	it('refuses a query when its entry passed no handler, which the executor reads as a transport failure', async () => {
		const subject = await subjectWith(workerHostExecutor('dedicated-worker', {query: false}), HISTORY);
		await expect(portOf(subject).query({query: `{ pool(first: 1) { pool } }`})).rejects.toThrow(
			/answers no query: its entry passed no `query` handler/,
		);
		const result = await subject.executor({query: `{ pool(first: 1) { pool } }`});
		expect(isTransportFailure(result)).toBe(true);
		expect(result.errors?.[0]?.extensions).toEqual({code: QUERY_ERROR_CODES.transportFailure, reason: 'invalid-body'});
	});
});
