import {BlockNotRetainedError, retainedRange, type StateStoreCapabilities} from '@etherfold/state-store';
import {QUERY_ERROR_CODES} from '../../errors.js';
import type {QueryResult} from '../../executor.js';
import {answersHistory, block, cases, extensions, HISTORY, subjectWith} from '../fixtures.js';
import {assertBytes} from '../bytes.js';
import type {QueryConformanceCase, QueryExecutorFactory} from '../types.js';

const GROUP = 'the retention refusal has one code everywhere';

/** The query every case asks, and where its one field sits in it. */
const AS_OF_10 = `{ pool(block: 10, first: 10) { pool } }`;

/**
 * The seam's `BlockNotRetainedError` as every executor serialises it: the code
 * `block-not-retained`, the requested block, and the seam's own message, which
 * the SEAM builds (so it is the same bytes on every backend) from what the store
 * claims. Built here with the seam's own constructor rather than copied, so the
 * suite states the message a store's claim implies and not one backend's.
 */
function refused(generation: string, pinned: number, error: BlockNotRetainedError): QueryResult {
	return {
		data: null,
		errors: [
			{
				message: error.message,
				locations: [{line: 1, column: 3}],
				path: ['pool'],
				extensions: {code: QUERY_ERROR_CODES.blockNotRetained, requested: error.requested},
			},
		],
		extensions: extensions(generation, pinned),
	};
}

/**
 * Selected against what the store CLAIMS, as the store and accessor suites
 * select their as-of chapters: a store answering no history refuses every
 * `block`, and a store claiming a window refuses a `block` below it. Either way
 * the refusal is the seam's, with the same code and the same bytes on every
 * executor (ADR-0099), never an answer from the tip. A store keeping everything
 * has nothing to refuse, and its as-of answers are in the parity list.
 */
export function retentionCases(
	factory: QueryExecutorFactory,
	capabilities: StateStoreCapabilities,
): QueryConformanceCase[] {
	const retention = capabilities.retention;

	if (!answersHistory(capabilities)) {
		return cases(GROUP, {
			'a store answering no history refuses a block with block-not-retained, and still answers the tip': async () => {
				const {executor, generation} = await subjectWith(factory, HISTORY);
				assertBytes(
					await executor({query: AS_OF_10}),
					refused(generation, 11, new BlockNotRetainedError(10, undefined, 'no-historical-reads', retention)),
				);
				assertBytes(await executor({query: `{ pool(first: 1) { pool } }`}), {
					data: {pool: [{pool: 'a'}]},
					extensions: extensions(generation, 11),
				});
			},
		});
	}

	if (retention.kind !== 'window') return [];

	const tip = 11 + retention.blocks + 10;
	return cases(GROUP, {
		'below the claimed window a block is refused with block-not-retained, never answered from the tip': async () => {
			const subject = await subjectWith(factory, HISTORY);
			// move the tip far enough that block 10 falls out of the window
			await subject.store.applyBlock(block(tip), []);
			assertBytes(
				await subject.executor({query: AS_OF_10}),
				refused(
					subject.generation,
					tip,
					new BlockNotRetainedError(10, retainedRange(retention, tip), 'outside-window', retention),
				),
			);
		},
	});
}
