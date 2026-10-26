import type {
	EIP1193CoreProvider,
	EIP1193HttpNodeProvider,
	EIP1193NodeProvider,
	EIP1193Provider,
	EIP1193WalletProvider,
} from 'eip-1193';
import type {JSONRPCHTTPProvider} from '@eip-1193/jsonrpc-provider';
import {describe, expect, it} from 'vitest';
import type {FetcherHostDependencies} from '../src/host.js';
import type {createJSONRPCProvider} from '../src/provider.js';

/**
 * A fetcher host takes whatever provider its deployment holds, and builds an HTTP node one otherwise.
 *
 * The engine it drives asks for eth_getLogs, eth_blockNumber, eth_chainId and eth_getBlockByNumber
 * only, so the slot is `EIP1193CoreProvider`. The type it replaced, `EIP1193ProviderWithoutEvents`,
 * is the WALLET surface since eip-1193 0.7.0 and rejected a provider typed as a node, which is what
 * a server-side host holds: put it back and the node lines stop compiling.
 *
 * These are assignability checks: they fail `pnpm typecheck`, not the test run.
 */

// Typed placeholders (`declare const` would emit nothing and throw at the first read).
const wallet = undefined as unknown as EIP1193WalletProvider;
const windowWallet = undefined as unknown as EIP1193Provider;
const node = undefined as unknown as EIP1193NodeProvider;
const httpNode = undefined as unknown as EIP1193HttpNodeProvider;
const jsonRpc = undefined as unknown as JSONRPCHTTPProvider;

type ProviderSlot = NonNullable<FetcherHostDependencies['provider']>;

describe('the provider slot accepts every kind of provider', () => {
	it('accepts a wallet, a node, an HTTP node and the JSON-RPC client', () => {
		const slots = [wallet, windowWallet, node, httpNode, jsonRpc] satisfies ProviderSlot[];
		expect(slots).toHaveLength(5);
	});

	it('builds an HTTP node provider, which the slot accepts and which is not a wallet', () => {
		const built = undefined as unknown as ReturnType<typeof createJSONRPCProvider>;
		const asHttpNode: EIP1193HttpNodeProvider = built;
		const asCore: EIP1193CoreProvider = built;
		const slot: ProviderSlot = built;
		// Never called; the check is the @ts-expect-error line.
		// @ts-expect-error a node over HTTP does not serve wallet_*
		const notPromised = () => built.request({method: 'wallet_switchEthereumChain', params: [{chainId: '0x1'}]});
		expect([asHttpNode, asCore, slot, notPromised]).toHaveLength(4);
	});
});
