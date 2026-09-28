import {describe, expect, it} from 'vitest';
import {
	isTransportFailure,
	QUERY_ERROR_CODES,
	TRANSPORT_FAILURE_REASONS,
	transportFailure,
	type QueryExecutor,
	type QueryResult,
} from '../src/index.js';

/**
 * The executor contract (ADR-0099) is defined HERE so the HTTP and worker
 * executors implement it rather than invent it: a function from a request to a
 * result that never rejects, and ONE shape every transport failure normalises
 * to, whatever the transport could or could not return.
 */
describe('the transport-failure shape', () => {
	it('is one result shape for every reason, carrying the code and the reason and nothing an indexer said', () => {
		expect([...TRANSPORT_FAILURE_REASONS]).toEqual([
			'http-status',
			'invalid-body',
			'network',
			'port-closed',
			'host-gone',
		]);
		for (const reason of TRANSPORT_FAILURE_REASONS) {
			const result = transportFailure(reason, `it failed: ${reason}`);
			expect(result).toEqual({
				errors: [{message: `it failed: ${reason}`, extensions: {code: QUERY_ERROR_CODES.transportFailure, reason}}],
			});
			expect(isTransportFailure(result)).toBe(true);
			// no data and no extensions: nothing answered, so no generation can be reported
			expect('data' in result).toBe(false);
			expect('extensions' in result).toBe(false);
			// it is JSON, as every result is
			expect(JSON.parse(JSON.stringify(result))).toEqual(result);
		}
	});

	it('carries the HTTP status when there was one', () => {
		expect(transportFailure('http-status', 'the server answered 500', {status: 500})).toEqual({
			errors: [
				{
					message: 'the server answered 500',
					extensions: {code: QUERY_ERROR_CODES.transportFailure, reason: 'http-status', status: 500},
				},
			],
		});
	});

	it('is told apart from an answer, including an answer that carries errors', () => {
		const answered: QueryResult = {
			data: null,
			errors: [{message: 'no', extensions: {code: QUERY_ERROR_CODES.blockNotRetained}}],
			extensions: {generation: 'g', block: 1},
		};
		expect(isTransportFailure(answered)).toBe(false);
		expect(isTransportFailure({data: {}, extensions: {generation: 'g', block: 1}})).toBe(false);
	});

	it('refuses a reason outside the contract', () => {
		expect(() => transportFailure('teapot' as never, 'x')).toThrow(/reason/);
	});

	it('types an executor as a function from a request to a result', async () => {
		const executor: QueryExecutor = async () => transportFailure('network', 'unreachable');
		const result = await executor({query: '{ __typename }', variables: {}, operationName: undefined});
		expect(isTransportFailure(result)).toBe(true);
	});
});
