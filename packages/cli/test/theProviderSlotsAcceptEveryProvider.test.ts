import type {EIP1193HttpNodeProvider, EIP1193NodeProvider, EIP1193Provider, EIP1193WalletProvider} from 'eip-1193';
import type {JSONRPCHTTPProvider} from '@eip-1193/jsonrpc-provider';
import {describe, expect, it} from 'vitest';
import type {FetchDependencies, IndexingDependencies, UploadContext} from '../src/index.js';

/**
 * The CLI's provider slots take whatever a caller or a test hands over.
 *
 * The engine asks for eth_getLogs, eth_blockNumber, eth_chainId and eth_getBlockByNumber only, so
 * every slot is `EIP1193CoreProvider`. The type it replaced, `EIP1193ProviderWithoutEvents`, is the
 * WALLET surface since eip-1193 0.7.0 and rejected a provider typed as a node, which is what a CLI
 * holds: put it back and the node lines stop compiling.
 *
 * These are assignability checks: they fail `pnpm typecheck`, not the test run.
 */

// Typed placeholders (`declare const` would emit nothing and throw at the first read).
const wallet = undefined as unknown as EIP1193WalletProvider;
const windowWallet = undefined as unknown as EIP1193Provider;
const node = undefined as unknown as EIP1193NodeProvider;
const httpNode = undefined as unknown as EIP1193HttpNodeProvider;
const jsonRpc = undefined as unknown as JSONRPCHTTPProvider;

type IndexingSlot = NonNullable<IndexingDependencies['provider']>;
type FetchSlot = NonNullable<FetchDependencies['provider']>;
type UploadSlot = UploadContext['provider'];

describe('the provider slots accept every kind of provider', () => {
	it('accepts a wallet, a node, an HTTP node and the JSON-RPC client in every slot', () => {
		const slots = {
			indexing: [wallet, windowWallet, node, httpNode, jsonRpc] satisfies IndexingSlot[],
			fetch: [wallet, windowWallet, node, httpNode, jsonRpc] satisfies FetchSlot[],
			upload: [wallet, windowWallet, node, httpNode, jsonRpc] satisfies UploadSlot[],
		};
		expect(Object.keys(slots)).toHaveLength(3);
	});
});
