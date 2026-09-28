import {expect} from 'vitest';
import {QUERY_ERROR_CODES} from '../../errors.js';
import {isTransportFailure, TRANSPORT_FAILURE_REASONS, type TransportFailureReason} from '../../executor.js';
import {cases, HISTORY, subjectWith} from '../fixtures.js';
import type {QueryConformanceCase, QueryConformanceOptions, QueryExecutorFactory} from '../types.js';

const GROUP = 'a transport failure has one shape';

/**
 * The third parity rule (ADR-0099): whatever a transport meets (an HTTP 500, a
 * body that is not JSON, a network error, a closed port, a dead worker host),
 * the executor normalises it to ONE shape, and RESOLVES with it rather than
 * rejecting, so an app writes one error path. Asked of every failure an
 * executor's deployment declares it can be broken into
 * (`QueryConformanceOptions.transportFailures`); an in-process executor has no
 * transport and declares none.
 */
export function transportCases(
	factory: QueryExecutorFactory,
	options: QueryConformanceOptions,
): QueryConformanceCase[] {
	const declared = Object.entries(options.transportFailures ?? {}) as [
		TransportFailureReason,
		NonNullable<NonNullable<QueryConformanceOptions['transportFailures']>[TransportFailureReason]>,
	][];
	const entries: Record<string, () => Promise<void>> = {};
	for (const [reason, breakTransport] of declared) {
		if (!TRANSPORT_FAILURE_REASONS.includes(reason)) {
			throw new Error(
				`a transport failure's reason is one of ${TRANSPORT_FAILURE_REASONS.join(', ')}, got ${JSON.stringify(reason)}`,
			);
		}
		entries[`${reason}: resolved as the one transport-failure shape, never a rejection`] = async () => {
			const subject = await subjectWith(factory, HISTORY);
			await breakTransport(subject);
			const result = await subject.executor({query: `{ pool(first: 1) { pool } }`});
			expect(isTransportFailure(result)).toBe(true);
			expect(Object.keys(result)).toEqual(['errors']);
			const [error] = result.errors!;
			expect(Object.keys(error!)).toEqual(['message', 'extensions']);
			expect(typeof error!.message).toBe('string');
			const {status, ...rest} = error!.extensions as {status?: unknown};
			expect(rest).toEqual({code: QUERY_ERROR_CODES.transportFailure, reason});
			if (reason === 'http-status') expect(Number.isInteger(status)).toBe(true);
			else expect(status).toBeUndefined();
			expect(JSON.parse(JSON.stringify(result))).toEqual(result);
		};
	}
	return cases(GROUP, entries);
}
