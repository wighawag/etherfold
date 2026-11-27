// ---------------------------------------------------------------------------
// THE GATE of the safe lane (etherfold ADR-0007), read from the chain's node:
// the `finalized` tag, or `latest - depth` on a chain without one. The indexer
// does not decide it; the consumer does.
// ---------------------------------------------------------------------------

async function rpc(
	doFetch: typeof fetch,
	url: string,
	method: string,
	params: unknown[],
	signal: AbortSignal | undefined,
): Promise<unknown> {
	const response = await doFetch(url, {
		...(signal ? {signal} : {}),
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
	});
	if (!response.ok) throw new Error(`${method}: the node answered ${response.status}`);
	const body = (await response.json()) as {result?: unknown; error?: {message?: string}};
	if (body.error) throw new Error(`${method}: ${body.error.message ?? 'an error'}`);
	return body.result;
}

/**
 * A gate from an EIP-1193-style JSON-RPC endpoint. With a `depth` it is
 * `latest - depth` (going below the chain's own finality is a decision to record,
 * ADR-0007); without one it is the `finalized` block. The consumer's `signal`
 * (its per-call timeout) is passed to `fetch`.
 */
export function rpcGate(options: {
	url: string;
	depth?: number;
	fetch?: typeof fetch;
}): (context?: {signal?: AbortSignal}) => Promise<number> {
	const doFetch = options.fetch ?? fetch;
	return async ({signal} = {}) => {
		if (options.depth !== undefined) {
			const latest = Number(await rpc(doFetch, options.url, 'eth_blockNumber', [], signal));
			return Math.max(0, latest - options.depth);
		}
		let block: unknown;
		try {
			block = await rpc(doFetch, options.url, 'eth_getBlockByNumber', ['finalized', false], signal);
		} catch (error) {
			// an aborted read says nothing about the tag
			if (signal?.aborted) throw error;
			throw new Error(
				`the node does not answer the finalized block (${error instanceof Error ? error.message : String(error)}): set a depth for this chain instead`,
			);
		}
		const number = (block as {number?: string} | null)?.number;
		if (typeof number !== 'string')
			throw new Error('the node has no finalized block yet: set a depth for this chain instead');
		return Number(number);
	};
}
