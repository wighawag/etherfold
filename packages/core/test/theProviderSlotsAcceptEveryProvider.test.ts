import type {
	ClientMethods,
	EIP1193CoreProvider,
	EIP1193HttpNodeProvider,
	EIP1193NodeProvider,
	EIP1193Provider,
	EIP1193WalletProvider,
	RequestRPC,
} from 'eip-1193';
import {describe, expect, it} from 'vitest';
import type {Indexer, IndexerOptions} from '../src/container.js';
import type {IndexerGeneration} from '../src/indexer.js';
import type {LogFetcher} from '../src/logFetcher.js';
import type {MethodDeclaringProvider, declaredMethodsOnly} from '../src/providerSurface.js';
import type {captureStream} from '../src/stream/capture.js';

/**
 * Every slot that takes a provider accepts a browser wallet, a JSON-RPC node and a plain HTTP node.
 *
 * The engine asks for four methods (`ENGINE_PROVIDER_METHODS`: eth_getLogs, eth_blockNumber,
 * eth_chainId, eth_getBlockByNumber), all of which every provider serves, and ADR-0002 runs it
 * against a wallet in a browser while the CLI and the fetcher host run it against a node. So every
 * slot is typed `EIP1193CoreProvider` (eip-1193 >= 0.7.1). The type it replaced,
 * `EIP1193ProviderWithoutEvents`, is the WALLET surface since eip-1193 0.7.0, and it rejected a
 * provider typed as a node although the engine never calls a wallet-only method: put it back on any
 * slot below and the node and HTTP node lines stop compiling.
 *
 * These are assignability checks: they fail `pnpm typecheck`, not the test run.
 */

// Typed placeholders: only their types matter. `declare const` would emit nothing, and vitest would
// throw a ReferenceError at the first read.
const wallet = undefined as unknown as EIP1193WalletProvider;
const windowWallet = undefined as unknown as EIP1193Provider;
const node = undefined as unknown as EIP1193NodeProvider;
const httpNode = undefined as unknown as EIP1193HttpNodeProvider;
const clientOnly = undefined as unknown as RequestRPC<ClientMethods>;

type ContainerSlot = IndexerOptions<[]>['provider'];
type GenerationSlot = ConstructorParameters<typeof IndexerGeneration<[]>>[0];
type GenerationReinitSlot = Parameters<IndexerGeneration<[]>['reinit']>[0];
type GenerationUpdateSlot = NonNullable<Parameters<IndexerGeneration<[]>['updateIndexer']>[0]['provider']>;
type ContainerUpdateSlot = NonNullable<Parameters<Indexer<[]>['updateIndexer']>[0]['provider']>;
type LogFetcherSlot = ConstructorParameters<typeof LogFetcher<[]>>[0];
type CaptureSlot = Parameters<typeof captureStream<[]>>[0];
type GuardSlot = Parameters<typeof declaredMethodsOnly>[0];

describe('the provider slots accept every kind of provider', () => {
	it('accepts a wallet, a node and an HTTP node in every slot', () => {
		const slots = {
			container: [wallet, windowWallet, node, httpNode] satisfies ContainerSlot[],
			generation: [wallet, windowWallet, node, httpNode] satisfies GenerationSlot[],
			generationReinit: [wallet, windowWallet, node, httpNode] satisfies GenerationReinitSlot[],
			generationUpdate: [wallet, windowWallet, node, httpNode] satisfies GenerationUpdateSlot[],
			containerUpdate: [wallet, windowWallet, node, httpNode] satisfies ContainerUpdateSlot[],
			logFetcher: [wallet, windowWallet, node, httpNode] satisfies LogFetcherSlot[],
			capture: [wallet, windowWallet, node, httpNode] satisfies CaptureSlot[],
			guard: [wallet, windowWallet, node, httpNode] satisfies GuardSlot[],
		};
		expect(Object.keys(slots)).toHaveLength(8);
	});

	it('still refuses something that cannot serve the logs', () => {
		// @ts-expect-error a provider without eth_getLogs cannot feed the fold
		const slot: ContainerSlot = clientOnly;
		expect(slot).toBeUndefined();
	});

	it('promises a guarded provider as the core surface and nothing beyond it', () => {
		const guarded = undefined as unknown as MethodDeclaringProvider;
		const core: EIP1193CoreProvider = guarded;
		// These closures are never called; the checks are the @ts-expect-error lines.
		const notPromised = [
			// @ts-expect-error eth_subscribe is not served over plain HTTP, so it is not promised
			() => guarded.request({method: 'eth_subscribe', params: ['newHeads']}),
			// @ts-expect-error wallet_* is not served by a node, so it is not promised
			() => guarded.request({method: 'wallet_switchEthereumChain', params: [{chainId: '0x1'}]}),
		];
		expect(core).toBeUndefined();
		expect(notPromised).toHaveLength(2);
	});
});
