import type {EIP1193HttpNodeProvider} from 'eip-1193';
import {JSONRPCHTTPProvider} from '@eip-1193/jsonrpc-provider';

/**
 * A JSON-RPC provider over HTTP, built from a URL.
 *
 * Built here rather than per adapter, and it can be: this client is `fetch` and
 * timers, so it works unchanged in a Node process and in a serverless runtime.
 * That is not incidental to the design. A provider that needed a Node socket
 * would have put chain access on the list of things hosts do differently, and
 * there is supposed to be nothing on that list except when a cycle runs.
 *
 * A host that has its own provider (an injected one, a fake in a test, a
 * transport with different auth) passes it to `createFetcherHost` instead and
 * never reaches this.
 */
export function createJSONRPCProvider(
	url: string,
	options: {requestsPerSecond?: number} = {},
): EIP1193HttpNodeProvider {
	// Typed as what it is, a node over plain HTTP: the client declares
	// `implements EIP1193HttpNodeProvider`, so no cast is needed, and every
	// provider slot in etherfold (`EIP1193CoreProvider`) accepts it.
	return new JSONRPCHTTPProvider(
		url,
		options.requestsPerSecond !== undefined ? {requestsPerSecond: options.requestsPerSecond} : undefined,
	);
}
