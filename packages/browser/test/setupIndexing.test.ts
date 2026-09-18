import {describe, expect, it} from 'vitest';
import type {Abi, IndexingSource, LastSync, LogEvent} from '@etherfold/core';
import {createIndexerState, type EntityEventProcessorLike} from '../src/IndexerState.js';
import {generationOf} from './utils/fakeGeneration.js';
import {identityOf} from './utils/processorIdentity.js';

// chainId '1' as the 0x-hex the provider returns
const CHAIN_ID_HEX = '0x1';

function makeProvider(overrides: {failChainId?: boolean} = {}) {
	return {
		async request(args: {method: string; params?: any}): Promise<any> {
			switch (args.method) {
				case 'eth_chainId':
					if (overrides.failChainId) {
						throw new Error('provider boom');
					}
					return CHAIN_ID_HEX;
				case 'eth_blockNumber':
					return '0x0';
				case 'eth_getLogs':
					// no events
					return [];
				default:
					throw new Error(`unexpected method ${args.method}`);
			}
		},
	} as any;
}

type State = {count: number};

function makeProcessor(): EntityEventProcessorLike<Abi, State, undefined> {
	return {
		getCodeFingerprint: () => undefined,
		state: {count: 0},
		configure: () => {},
		// no persisted state -> fresh sync, successful load
		load: async () => undefined,
		process: async () => ({count: 0}),
		reset: async () => {},
		clear: async () => {},
	};
}

const SOURCE: IndexingSource<Abi> = {
	chainId: '1',
	contracts: [{abi: [] as unknown as Abi, address: '0x0000000000000000000000000000000000000001', startBlock: 0}],
};

describe('createIndexerState - setupIndexing error handling', () => {
	it('does NOT set a FAILED_TO_LOAD error after a successful load', async () => {
		const indexer = createIndexerState<Abi, State>(generationOf(makeProcessor(), identityOf('the-tab')));
		await indexer.init({provider: makeProvider(), source: SOURCE});

		// indexMore() calls setupIndexing() internally
		await indexer.indexMore();

		// Regression: previously a `finally` block set this error on every call, even success.
		expect(indexer.syncing.$state.error).toBeUndefined();
		expect(indexer.syncing.$state.loading).toBe(false);
	});

	it('reports an error when loading actually fails', async () => {
		const indexer = createIndexerState<Abi, State>(generationOf(makeProcessor(), identityOf('the-tab')));
		await indexer.init({provider: makeProvider({failChainId: true}), source: SOURCE});

		await expect(indexer.indexMore()).rejects.toBeTruthy();

		// On genuine failure the syncing store should surface an error.
		expect(indexer.syncing.$state.error).toBeDefined();
	});
});
