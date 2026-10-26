import type {EIP1193HttpNodeProvider, EIP1193NodeProvider, EIP1193Provider, EIP1193WalletProvider} from 'eip-1193';
import type {ProviderOverPort} from '@eip-1193/over-port';
import {describe, expect, it} from 'vitest';
import type {HostedIndexerSpec} from '../src/host/serve.js';
import type {createIndexerState} from '../src/IndexerState.js';

/**
 * The provider a tab or a host hands over may be a wallet, a JSON-RPC node or a plain HTTP node.
 *
 * The engine asks for eth_getLogs, eth_blockNumber, eth_chainId and eth_getBlockByNumber only
 * (`ENGINE_PROVIDER_METHODS` in `@etherfold/core`), so every slot is `EIP1193CoreProvider`. The type
 * it replaced, `EIP1193ProviderWithoutEvents`, is the WALLET surface since eip-1193 0.7.0 and
 * rejected a host built from an RPC URL: put it back and the node lines stop compiling.
 *
 * These are assignability checks: they fail `pnpm typecheck`, not the test run.
 */

// Typed placeholders (`declare const` would emit nothing and throw at the first read).
const wallet = undefined as unknown as EIP1193WalletProvider;
const windowWallet = undefined as unknown as EIP1193Provider;
const node = undefined as unknown as EIP1193NodeProvider;
const httpNode = undefined as unknown as EIP1193HttpNodeProvider;
const overPort = undefined as unknown as ProviderOverPort;

type IndexerState = ReturnType<typeof createIndexerState<[], void>>;
type InitSlot = Parameters<IndexerState['init']>[0]['provider'];
type UpdateSlot = NonNullable<Parameters<IndexerState['updateIndexer']>[0]['provider']>;
type HostSlot = NonNullable<HostedIndexerSpec<[], void>['provider']>;

describe('the provider slots accept every kind of provider', () => {
	it('accepts a wallet, a node and an HTTP node in init and updateIndexer', () => {
		const slots = {
			init: [wallet, windowWallet, node, httpNode] satisfies InitSlot[],
			updateIndexer: [wallet, windowWallet, node, httpNode] satisfies UpdateSlot[],
		};
		expect(Object.keys(slots)).toHaveLength(2);
	});

	it('accepts a wallet, a node, an HTTP node and the provider a tab sends over a port in a host', () => {
		const slots = [wallet, windowWallet, node, httpNode, overPort] satisfies HostSlot[];
		expect(slots).toHaveLength(5);
	});
});
