// A few JSON-RPC calls against a local dev chain (anvil), with no dependency: anvil's
// accounts are unlocked, so `eth_sendTransaction` signs for us.

export const RPC = process.env.ETH_NODE_URI ?? 'http://127.0.0.1:8545';

export async function rpc(method, params = []) {
	const res = await fetch(RPC, {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
	});
	const body = await res.json();
	if (body.error) throw new Error(`${method}: ${body.error.message}`);
	return body.result;
}

/** Send a transaction from one of anvil's unlocked accounts and wait for its receipt. */
export async function send(tx) {
	const hash = await rpc('eth_sendTransaction', [tx]);
	for (;;) {
		const receipt = await rpc('eth_getTransactionReceipt', [hash]);
		if (receipt) {
			if (receipt.status !== '0x1') throw new Error(`transaction ${hash} reverted`);
			return receipt;
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

/** ABI-encode an address or a uint256 as one 32-byte word. */
export const word = (value) =>
	(typeof value === 'string' && value.startsWith('0x') ? value.slice(2) : BigInt(value).toString(16))
		.toLowerCase()
		.padStart(64, '0');
