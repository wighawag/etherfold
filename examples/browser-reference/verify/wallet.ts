/**
 * A wallet and a chain, injected into the page before the app loads.
 *
 * This is what makes the reference CHECKABLE rather than merely readable. It
 * announces itself over EIP-6963 exactly as a browser extension does, so
 * `@etherplay/connect` discovers it through its real code path, and it serves a
 * fixed set of logs, so what the app indexes is the same on every run and on
 * every machine. No RPC endpoint, no extension, no funded account.
 *
 * The one parameter that matters is `walletChainId`. Setting it to something
 * other than the app's chain is how the PINNED-PROVIDER hazard becomes an
 * assertion instead of a comment: a wallet on the wrong chain must be refused,
 * and it can only be refused by an app that asked the connection state rather
 * than the provider -- because the provider, being pinned, answers the app's own
 * chain id either way.
 */

export type FakeChainOptions = {
	/** What the WALLET is set to. Differs from the app's chain to test the refusal. */
	walletChainId: number;
	/** How many `Transfer` logs the contract has emitted. */
	transfers: number;
	/** Block of the last log, used to place a transaction inside the unconfirmed window. */
	tipBlock: number;
};

declare global {
	interface Window {
		__fake: FakeChainOptions;
		/**
		 * How many times the page's wallet was asked each method. The indexer runs in
		 * a WORKER, which has no `window` and so no wallet of its own: a count here is
		 * the wallet's provider being served to the worker by this tab.
		 */
		__walletRequests: Record<string, number>;
	}
}

/**
 * Installed by `page.addInitScript`, so it runs before any application module.
 *
 * Written as one self-contained function on purpose: `addInitScript` serialises
 * it into the page, so it cannot close over anything from the test file.
 */
export function installFakeWallet(options: FakeChainOptions): void {
	const CONTRACT = '0x0000000000000000000000000000000000000099';
	const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
	const ACCOUNT = '0x0000000000000000000000000000000000000011';
	// Tokens are MINTED (from the zero address) to two accounts in turn, so the
	// holdings the query layer is asked about differ per account: the wallet's own
	// account holds the odd ids, the other one the even ids.
	const ZERO = '0x0000000000000000000000000000000000000000';
	const OTHER = '0x0000000000000000000000000000000000000022';
	const hex = (n: number) => `0x${n.toString(16)}`;
	const topic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;

	// One log per block, from block 1, minting token `i + 1`. Deterministic, so
	// the counter and the holdings the page shows are numbers the test can assert.
	const logs: Record<string, unknown>[] = [];
	for (let i = 0; i < options.transfers; i++) {
		logs.push({
			blockNumber: hex(i + 1),
			blockHash: `0x${(i + 1).toString(16).padStart(64, '0')}`,
			transactionIndex: '0x0',
			removed: false,
			address: CONTRACT,
			data: `0x${(i + 1).toString(16).padStart(64, '0')}`,
			topics: [TRANSFER_TOPIC, topic(ZERO), topic(i % 2 === 0 ? ACCOUNT : OTHER)],
			// A transaction hash the test can ask `checkTxInclusion` about.
			transactionHash: `0x${(i + 1).toString(16).padStart(64, '0')}`,
			logIndex: '0x0',
			blockTimestamp: hex(1_700_000_000 + i * 12),
		});
	}

	const requests: Record<string, number> = {};

	const provider = {
		async request(args: {method: string; params?: any}): Promise<any> {
			requests[args.method] = (requests[args.method] ?? 0) + 1;
			switch (args.method) {
				// The WALLET's own chain. This is what the connection state reports,
				// and it is the answer the pinned wrapper does NOT give.
				case 'eth_chainId':
					return hex(options.walletChainId);
				case 'eth_accounts':
				case 'eth_requestAccounts':
					return [ACCOUNT];
				case 'eth_blockNumber':
					return hex(options.tipBlock);
				case 'eth_getLogs': {
					const from = parseInt(args.params[0].fromBlock.slice(2), 16);
					const to = parseInt(args.params[0].toBlock.slice(2), 16);
					return logs.filter((log) => {
						const n = parseInt((log.blockNumber as string).slice(2), 16);
						return n >= from && n <= to;
					});
				}
				default:
					throw new Error(`fake wallet: unexpected method ${args.method}`);
			}
		},
		on() {},
		removeListener() {},
	};

	const detail = Object.freeze({
		info: Object.freeze({
			uuid: '11111111-2222-3333-4444-555555555555',
			name: 'Fake Wallet',
			icon: 'data:image/svg+xml;base64,PHN2Zy8+',
			rdns: 'dev.etherfold.fake',
		}),
		provider,
	});

	const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {detail}));
	window.addEventListener('eip6963:requestProvider', announce);
	announce();

	// Some code paths still reach for the legacy slot.
	(window as unknown as {ethereum: unknown}).ethereum = provider;
	window.__fake = options;
	window.__walletRequests = requests;
}
