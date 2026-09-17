import {describe, expect, it} from 'vitest';
import type {Abi, IndexingSource, LogEvent} from '@etherfold/core';
import {IndexerGeneration} from '@etherfold/core';
import {createIndexerState, type EntityEventProcessorLike} from '../src/IndexerState.js';
import {generationOf} from './utils/fakeGeneration.js';
import {identityOf} from './utils/processorIdentity.js';

const CHAIN_ID_HEX = '0x1';

function makeProvider(chainIdHex: string = CHAIN_ID_HEX) {
	return {
		async request(args: {method: string; params?: any}): Promise<any> {
			switch (args.method) {
				case 'eth_chainId':
					return chainIdHex;
				case 'eth_blockNumber':
					return '0x0';
				case 'eth_getLogs':
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
		// The DECLARED path, still on the seam until the contract task removes it and
		// deliberately NOT what names anything here: every spec below supplies the
		// identity its arrival derived, so this value is read by nobody.
		getVersionHash: () => 'declared-version-never-read',
		// required on `EventProcessor`: a fake that omits it is a fake that would
		// lose drift detection without anybody noticing
		getCodeFingerprint: () => undefined,
		state: {count: 0},
		configure: () => {},
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

describe('createIndexerState - dispose() (teardown / leak prevention)', () => {
	it('exposes a dispose() method', async () => {
		const indexer = createIndexerState<Abi, State>(generationOf(makeProcessor(), identityOf('the-tab')));
		expect(typeof (indexer as any).dispose).toBe('function');
	});

	it('stops the auto-index loop so no further ticks fire after dispose()', async () => {
		let indexMoreCalls = 0;
		const indexer = createIndexerState<Abi, State>(generationOf(makeProcessor(), identityOf('the-tab')), {
			// The fifth argument is the identity the generation was REGISTERED under, and
			// forwarding it is what keeps the engine answering to the name the registry
			// filed (ADR-0086).
			createIndexer: (provider, processor, source, config, processorIdentity) => {
				const real = new IndexerGeneration<Abi, State>(provider, processor, source, config, {processorIdentity});
				const realIndexMore = real.indexMore.bind(real);
				real.indexMore = (async (...args: any[]) => {
					indexMoreCalls++;
					return (realIndexMore as any)(...args);
				}) as any;
				return real;
			},
		});
		await indexer.init({provider: makeProvider(), source: SOURCE});

		// start the loop with a very short interval so ticks keep re-arming quickly
		await indexer.startAutoIndexing(0.01);
		expect(indexer.syncing.$state.autoIndexing).toBe(true);

		// let a few ticks happen
		await new Promise((r) => setTimeout(r, 60));

		// dispose must clear the timer AND mark autoIndexing false
		await (indexer as any).dispose();
		expect(indexer.syncing.$state.autoIndexing).toBe(false);

		const callsAfterDispose = indexMoreCalls;

		// wait well past several intervals: a leaked self-re-arming setTimeout would keep calling
		// indexMore. After dispose it must not increase.
		await new Promise((r) => setTimeout(r, 100));
		expect(indexMoreCalls).toBe(callsAfterDispose);
	});

	/**
	 * The stores this hook holds are DETACHED from the engine by `dispose()`.
	 *
	 * Asserted by DRIVING the engine's callbacks afterwards rather than by reading
	 * them back, because WHICH object holds the hook's closures is not the same on
	 * the two shapes: on a bare generation the hook attaches to the engine, and on
	 * the container the engine forwards to the container and the container is what
	 * the hook attached to. The invariant is the same on both and is what the leak
	 * was about -- after `dispose()` nothing the engine reports may still reach the
	 * `syncing` and `status` stores -- so it is the invariant that is asserted, not
	 * the object graph that carries it.
	 */
	it('detaches the indexer callbacks (onLoad / onLastSyncUpdated / onStateUpdated) on dispose()', async () => {
		let captured!: IndexerGeneration<Abi, State>;
		const indexer = createIndexerState<Abi, State>(generationOf(makeProcessor(), identityOf('the-tab')), {
			createIndexer: (provider, processor, source, config, processorIdentity) => {
				captured = new IndexerGeneration<Abi, State>(provider, processor, source, config, {processorIdentity});
				return captured;
			},
		});
		await indexer.init({provider: makeProvider(), source: SOURCE});

		// wire the callbacks (setupIndexing sets them)
		await indexer.indexMore();
		expect(captured.onLoad).toBeDefined();
		expect(captured.onLastSyncUpdated).toBeDefined();
		expect(captured.onStateUpdated).toBeDefined();
		expect(indexer.syncing.$state.lastSync).toBeDefined();

		await (indexer as any).dispose();

		// the engine may still hold a callback -- what it must no longer do is reach
		// this hook's stores through one
		await captured.onLoad?.('Loading');
		captured.onLastSyncUpdated?.({
			context: {source: SOURCE, config: {} as never},
			lastToBlock: 999,
			latestBlock: 999,
			nextStreamID: 1,
			unconfirmedBlocks: [],
		} as never);

		expect(indexer.syncing.$state.lastSync).toBeUndefined();
		expect(indexer.status.$state.state).toBe('Idle');
	});
});
