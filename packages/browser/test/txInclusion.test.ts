import {describe, expect, it} from 'vitest';
import type {Abi, IndexingSource, LogEvent} from '@etherfold/core';
import {createIndexerState, type EntityEventProcessorLike} from '../src/IndexerState.js';
import {generationOf} from './utils/fakeGeneration.js';

/**
 * The app-facing half of tx reconciliation: after indexing, an app asks whether
 * the state it is about to render already accounts for its own pending
 * transaction, so it knows whether to lay an optimistic update over it.
 *
 * The rule itself is `checkTxInclusion` in `@etherfold/core` and is unit-tested
 * there. What is asserted here is the WIRING: that the hook answers against the
 * cursor it is actually holding and the finality depth the indexer actually
 * runs with, neither of which a caller should have to keep a second copy of.
 */

const ADDRESS = '0x0000000000000000000000000000000000000001';
const SOURCE: IndexingSource<Abi> = {
	chainId: '1',
	contracts: [{abi: [] as unknown as Abi, address: ADDRESS, startBlock: 0}],
};

const TX = '0x00000000000000000000000000000000000000000000000000000000000000aa';

type State = {count: number};

function makeProcessor(): EntityEventProcessorLike<Abi, State, undefined> {
	let count = 0;
	return {
		getVersionHash: () => 'v1',
		getCodeFingerprint: () => undefined,
		state: {count: 0},
		configure: () => {},
		load: async () => undefined,
		process: async (events: LogEvent<Abi>[]) => {
			count += events.length;
			return {count};
		},
		reset: async () => {},
		clear: async () => {},
	};
}

/** A chain with exactly one log, in block 5, tip at block 10. */
function makeProvider() {
	return {
		async request(args: {method: string; params?: any}): Promise<any> {
			switch (args.method) {
				case 'eth_chainId':
					return '0x1';
				case 'eth_blockNumber':
					return '0xa';
				case 'eth_getLogs':
					return [
						{
							blockNumber: '0x5',
							blockHash: '0xb05',
							// as every supported node serves it (`execution-apis#639`): a range
							// holding a log without one is refused at the fetch boundary (ADR-0073)
							blockTimestamp: '0x6553f100',
							transactionIndex: '0x0',
							removed: false,
							address: ADDRESS,
							data: '0x',
							topics: [],
							transactionHash: TX,
							logIndex: '0x0',
						},
					];
				default:
					throw new Error(`unexpected method ${args.method}`);
			}
		},
	} as any;
}

describe('checkTxInclusion through the browser hook', () => {
	it('answers nothing before anything is indexed', async () => {
		const indexer = createIndexerState<Abi, State>(generationOf(makeProcessor()));
		expect(indexer.checkTxInclusion([{txHash: TX}])[TX]).toEqual({status: 'unknown', basis: 'not-synced'});
	});

	it('reports a transaction it has processed as included, and says where', async () => {
		const indexer = createIndexerState<Abi, State>(generationOf(makeProcessor()));
		await indexer.init({provider: makeProvider(), source: SOURCE});
		await indexer.indexToLatest();

		const verdict = indexer.checkTxInclusion([{txHash: TX}])[TX];
		expect(verdict.status).toBe('included');
		expect(verdict.basis).toBe('window-hit');
		// the block IN THE INDEXER'S view, which is the whole point: it is not
		// whatever block the app's own node reported for that transaction
		expect(verdict.blockNumber).toBe(5);
		expect(verdict.blockHash).toBe('0xb05');
	});

	it('reports a transaction it has never seen as absent, receipt or no receipt', async () => {
		const indexer = createIndexerState<Abi, State>(generationOf(makeProcessor()));
		await indexer.init({provider: makeProvider(), source: SOURCE});
		await indexer.indexToLatest();

		const other = '0x00000000000000000000000000000000000000000000000000000000000000bb';
		expect(indexer.checkTxInclusion([{txHash: other}])[other]).toEqual({status: 'absent', basis: 'window-miss'});
	});

	it('answers a whole pending set in one call', async () => {
		const indexer = createIndexerState<Abi, State>(generationOf(makeProcessor()));
		await indexer.init({provider: makeProvider(), source: SOURCE});
		await indexer.indexToLatest();

		const other = '0x00000000000000000000000000000000000000000000000000000000000000bb';
		const verdicts = indexer.checkTxInclusion([{txHash: TX}, {txHash: other}]);
		expect(verdicts[TX].status).toBe('included');
		expect(verdicts[other].status).toBe('absent');
	});
});
