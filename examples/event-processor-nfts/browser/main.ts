import {createBrowserStateStore, createIndexerState, type GenerationContext} from '@etherfold/browser';
import {fromEntityProcessor, openForWriting} from '@etherfold/processor-entities';
import {createConnection} from '@etherplay/connect';
// Uncomment together with the ONE LINE marked below to run on the light store.
// import {PatchStateStore} from '@etherfold/state-store-patch';
import {abi, NFTProcessor, readableTokenID} from '../src/entities.js';

/**
 * An application that indexes ONE ACCOUNT's NFTs in a browser tab, reading
 * through that user's own wallet.
 *
 * There is no server anywhere in this file. The tab talks to an Ethereum node --
 * by default the node behind the wallet the user picked -- decodes the logs,
 * runs `NFTProcessor` over them and keeps the resulting rows in IndexedDB. The
 * same processor object a server would run against SQLite.
 *
 * Read `start()` first: the connection, the store (ONE line, and the only place
 * a backend is named), the hook, and the two subscriptions that draw it.
 *
 * ## The two wallet target steps, and why this example needs both
 *
 * Whose NFTs are being indexed decides how much of the wallet is needed:
 *
 * - **`?account=` given** (someone else's, e.g. vitalik.eth): the address is
 *   already known, so nothing about the user's accounts is needed. The wallet is
 *   only a NODE. That is `targetStep: 'WalletChosen'` + `selectWallet()`, which
 *   picks a wallet via EIP-6963 and routes reads through it WITHOUT ever calling
 *   `eth_requestAccounts`. No permission popup to look at a public chain.
 * - **no `?account=`** ("my NFTs"): the address IS the user's, so the accounts
 *   have to be requested. That is `targetStep: 'WalletConnected'` + `connect()`.
 *
 * Asking for accounts in the first case would be permission theatre: reading
 * public logs needs no account, and a demo that pops a connect dialog to show
 * someone ELSE's tokens teaches the wrong reflex.
 */

const params = new URLSearchParams(location.search);

/** Ethereum mainnet, plus the endpoint used when no wallet serves the reads. */
const MAINNET = {
	id: 1,
	chainName: 'Ethereum',
	rpcUrls: {default: {http: [params.get('rpc') ?? 'https://rpc.mevblocker.io']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
	blockExplorerUrls: {default: {url: 'https://etherscan.io'}},
} as const;

/**
 * Whose tokens to index. Absent means "mine", which is what needs a connection.
 *
 * Vitalik is the default suggestion in the README rather than the default here,
 * because a demo that silently indexes a stranger's wallet is a worse first
 * impression than one that asks.
 */
const ACCOUNT = params.get('account')?.toLowerCase() as `0x${string}` | undefined;

/**
 * Which provider actually serves the reads.
 *
 * `wallet` (the default) is the point of the example: the chain is read through
 * the user's own node, so no third party learns what is being indexed. `endpoint`
 * exists because that honesty has a measurable price -- a browser extension that
 * RELAYS (Coinbase Wallet talks to `wss://www.walletlink.org/rpc` even as an
 * extension) turns a few thousand `eth_getLogs` into a slow crawl. Switching is
 * one query parameter, and the page reports which one it used.
 */
const VIA = params.get('via') === 'endpoint' ? 'endpoint' : 'wallet';

/** How far back to start. Small on purpose: a demo should finish while you watch it. */
const BLOCKS = Number(params.get('blocks') ?? 20000);

const el = (id: string) => document.getElementById(id) as HTMLElement;

/** `0x…` left-padded to a 32-byte topic, which is how an address is matched in a log topic. */
const asTopic = (address: string) => `0x000000000000000000000000${address.slice(2)}` as `0x${string}`;

/**
 * The block THIS page load first asked the node for.
 *
 * It is the only observable difference between "resumed" and "re-indexed": both
 * end on the same rows, so the state cannot tell you which happened. A tab that
 * resumed asks from inside the window a reorg can still reach; a tab that lost
 * its cursor asks from the start block.
 */
let firstFetchFrom: number | undefined;

async function start() {
	// ------------------------------------------------------------------
	// The wallet. `WalletChosen` when the account is already known, because
	// reading a public chain needs a node and not an identity.
	// ------------------------------------------------------------------
	const connection = ACCOUNT
		? createConnection({targetStep: 'WalletChosen', chainInfo: MAINNET, prioritizeWalletProvider: VIA === 'wallet'})
		: createConnection({targetStep: 'WalletConnected', chainInfo: MAINNET, prioritizeWalletProvider: VIA === 'wallet'});

	/**
	 * A wallet is needed only when it has something this page cannot get without
	 * it, and that is not always true here.
	 *
	 * With `?account=` the address is already known and the wallet is merely a
	 * node, so `?via=endpoint` needs NO wallet at all -- and a visitor with no
	 * extension installed must still be able to run the demo. Without `?account=`
	 * the address IS the wallet's, so there is no endpoint fallback to offer: that
	 * is the one case where a missing wallet is a dead end, and it says so.
	 */
	const needsWallet = !ACCOUNT || VIA === 'wallet';
	/**
	 * Typed FROM `waitForWallet` rather than restated here.
	 *
	 * The hand-written annotation used to be `{account?, walletName?}`, which is
	 * narrower than what `waitForWallet` actually resolves to, and the field it left
	 * out was `walletChainId` -- the one the chain-mismatch refusal below reads. The
	 * refusal still worked (the object really does carry it), but the compiler had
	 * been told the property does not exist, so nothing in the editor or in a build
	 * could tell that check from a typo. Deriving the type means the annotation can
	 * no longer disagree with the function.
	 */
	let state: Awaited<ReturnType<typeof waitForWallet>> = {};

	if (needsWallet) {
		if (ACCOUNT) {
			// picks via EIP-6963: auto-selects a single wallet, or rests at
			// `WalletToChoose` when several announced themselves. NOT `connect()`,
			// which is the upgrade path and pops `eth_requestAccounts`.
			await connection.selectWallet();
		} else {
			connection.connect();
		}
		state = await waitForWallet(connection);
		if (state.walletName === undefined && !ACCOUNT) {
			el('error').textContent =
				`no wallet announced itself, and without one this page does not know whose NFTs to show. Install a ` +
				`browser wallet, or name an account explicitly -- ?account=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 ` +
				`&via=endpoint reads vitalik.eth through a public endpoint with no wallet at all.`;
			return;
		}
	}

	const account: `0x${string}` | undefined = ACCOUNT ?? state.account;
	if (!account) return; // a picker is showing; its handler re-enters
	// Re-bound so the narrowing above survives into the closures below: TypeScript
	// does not carry a narrowed type into a function body, and every read of the
	// account happens inside one.
	const owner: `0x${string}` = account;

	/**
	 * The provider, from the connection rather than from `window.ethereum`.
	 *
	 * `connection.provider` is the "always on" wrapper: it routes through the
	 * chosen wallet when one is chosen and `prioritizeWalletProvider` is set, and
	 * falls back to the chain's endpoint otherwise, so this page has ONE provider
	 * whether or not a wallet ever appeared. `window.ethereum` was the old way and
	 * it is a single slot several extensions race for -- which is why picking a
	 * wallet by EIP-6963 is the wallet library's job and not this file's.
	 */
	const chosen: {request(args: {method: string; params?: unknown[]}): Promise<any>} = connection.provider as never;
	const provider = {
		async request(args: {method: string; params?: unknown[]}) {
			if (args.method === 'eth_getLogs' && firstFetchFrom === undefined) {
				firstFetchFrom = parseInt((args.params?.[0] as {fromBlock: string}).fromBlock.slice(2), 16);
			}
			return chosen.request(args);
		},
	};

	// ------------------------------------------------------------------
	// Refuse a chain mismatch rather than index nothing and look slow.
	// ------------------------------------------------------------------
	/**
	 * The wallet's chain comes from the CONNECTION STATE, not from asking the
	 * provider, and that distinction is the whole of this check.
	 *
	 * `connection.provider` is the always-on wrapper, and it is PINNED to the
	 * `chainInfo` it was built with -- so `eth_chainId` through it answers `1`
	 * whatever the wallet is actually set to. Checking it would compare a constant
	 * against itself and pass for a wallet sitting on Polygon, which is exactly the
	 * silent-wrong-chain failure this refusal exists to prevent. The connection
	 * reports the WALLET's own chain, and its own `invalidChainId` verdict.
	 */
	const walletChain = state.walletChainId;
	if (walletChain !== undefined && walletChain !== String(MAINNET.id)) {
		el('error').textContent =
			`this example indexes ERC-721 transfers on Ethereum mainnet (chain ${MAINNET.id}), but the selected ` +
			`wallet is on chain ${walletChain}. Switch it to Ethereum, or add ?via=endpoint to read through ` +
			`${MAINNET.rpcUrls.default.http[0]} instead. Indexing on the wrong chain would find no logs at all ` +
			`and look like a demo that is merely slow.`;
		return;
	}
	const chainId = String(MAINNET.id);

	/**
	 * The first block to index, REMEMBERED rather than recomputed.
	 *
	 * `startBlock` is part of the indexing source, and the source is hashed into
	 * the sync context: a start block that moved with the chain tip would make
	 * every reload a different deployment, the stored state would be discarded as
	 * stale, and the tab would index from scratch each time. Which would also make
	 * this demo's most interesting property -- that a reopened tab CONTINUES --
	 * impossible to see.
	 */
	const startBlockKey = `etherfold-nfts-start-${chainId}-${account}-${BLOCKS}`;
	let startBlock = Number(localStorage.getItem(startBlockKey));
	if (!Number.isFinite(startBlock) || startBlock <= 0) {
		const latest = parseInt(await provider.request({method: 'eth_blockNumber'}), 16);
		startBlock = Math.max(0, latest - BLOCKS);
		localStorage.setItem(startBlockKey, String(startBlock));
	}

	// ------------------------------------------------------------------
	// ONE LINE decides where the state lives. The processor does not change.
	// ------------------------------------------------------------------
	// A FACTORY rather than a value: an indexer holds any number of GENERATIONS --
	// a stream plus a fold over it -- one of which is canonical and answers every
	// read, and each folds into its OWN state. The hook calls this once per
	// generation; this app has one.
	// KEYED ON THE CONTEXT: the container hands this factory a `GenerationContext`
	// so each generation's state can be its own. Two generations under one
	// `databaseName` are one store by IndexedDB's own definition, and they collide
	// on the sync cursor as well as the rows, since that cursor lives under a fixed
	// key.
	// CLAIMED, because this tab INDEXES: building a store and becoming its writer
	// are two acts, and `openForWriting` is the second one (ADR-0077). It migrates
	// on the way, so this is the whole open.
	const createState = async (context: GenerationContext) =>
		openForWriting(
			await createBrowserStateStore(NFTProcessor.entities, {
				databaseName: `etherfold-nfts-${chainId}-${account}-${context.stream}`,
			}),
		);
	// ...or the light store instead: current state as a plain object, history as
	// immer reverse patches. It is memory-only by design (ADR-0023), so a reload
	// starts over rather than resuming -- which is the trade you are making.
	// const createState = async () =>
	// 	openForWriting(
	// 		await createBrowserStateStore(NFTProcessor.entities, {
	// 			backend: (entities) => new PatchStateStore(entities, {finalityDepth: 12}),
	// 		}),
	// 	);

	// Kept because the capability report below is read off the store this
	// generation was built over: what it CAN DO is what the one line above decides.
	let store!: Awaited<ReturnType<typeof createState>>;

	const indexer = createIndexerState({
		createState: async (context) => (store = await createState(context)),
		createProcessor: (state) => fromEntityProcessor(NFTProcessor)(state),
	});

	await indexer.init({
		// cast because `EIP1193ProviderWithoutEvents` enumerates every JSON-RPC method
		// it knows; the wrapper above forwards the three this app uses.
		provider: provider as never,
		// NO contract addresses: an account's tokens can be in any collection, so
		// this indexes every address and lets the TOPIC filter below do the
		// narrowing. That is also what makes the ERC-20 collision reachable -- see
		// `handleUnparsedEvent` in `../src/entities.ts`.
		source: {chainId, contracts: {abi, startBlock}},
		config: {
			stream: {
				parse: {
					parseAllEventsIrrespectiveOfAddresses: true,
					// ONE rule, two `match` entries OR'd: transfers OUT of the account and
					// transfers INTO it. `null` is the wildcard `eth_getLogs` defines, and
					// it is the only way to constrain the SECOND indexed argument, which is
					// what "transfers to me" is. No `contracts`, because this source names
					// no addresses at all: an account's tokens can be in any collection.
					filters: [{event: 'Transfer', match: [[asTopic(account)], [null, asTopic(account)]]}],
				},
			},
		},
	});

	// Described by what it CAN DO rather than by its class name: the capability
	// report is the thing an application is supposed to read at startup, and it is
	// the thing that changes when the one line above changes.
	const memoryOnly = (store.capabilities as {durability?: string}).durability === 'memory-only';
	el('where').textContent =
		`retention: ${store.capabilities.retention.kind}, ` +
		`as-of reads: ${store.capabilities.asOf ? 'yes' : 'no'}, ` +
		`survives a reload: ${memoryOnly ? 'NO (memory-only, ADR-0023)' : 'yes'}`;
	el('what').textContent = `NFTs of ${account} on chain ${chainId}, from block ${startBlock}`;
	el('via').textContent =
		VIA === 'wallet'
			? `${state.walletName ?? 'the chosen wallet'}${ACCOUNT ? ' (chosen, not connected)' : ' (connected)'}`
			: `${MAINNET.rpcUrls.default.http[0]} (?via=endpoint)`;

	/**
	 * Say, in words, whether this page load RESUMED or started again.
	 *
	 * Updated from the syncing store rather than from the state store, because a
	 * tab that resumed and found no new events produces no state update at all --
	 * which is exactly the case worth showing.
	 */
	function describePageLoad() {
		el('resume').textContent =
			firstFetchFrom === undefined
				? 'nothing fetched yet'
				: firstFetchFrom > startBlock
					? `resumed: the first fetch of this page load asked for block ${firstFetchFrom}, not ${startBlock}`
					: `indexed from the start block (${startBlock}): no cursor was found`;
	}

	indexer.syncing.subscribe((syncing) => {
		const sync = syncing.lastSync;
		el('progress').textContent = sync
			? `block ${sync.lastToBlock} / ${sync.latestBlock} (${sync.totalPercentage}%)`
			: 'waiting for the node...';
		describePageLoad();
		if (syncing.error) {
			el('error').textContent = `${syncing.error.id}: ${syncing.error.message}`;
		}
	});

	/**
	 * The read side.
	 *
	 * `indexer.state` holds a READ HANDLE rather than a state object: on this path
	 * the state is rows in a store, so a consumer asks questions of it instead of
	 * being handed all of it. `listCurrent` is the seam's one set read -- a prefix
	 * of the declared id plus a required limit -- and the reason `ownership` is
	 * keyed by OWNER first is that this question has to BE a prefix.
	 */
	async function render() {
		const view = indexer.state.$state;
		const transfers = (await view.getCurrent<{value: number}>('counter', {name: 'transfers'}))?.value ?? 0;
		const undecodable = (await view.getCurrent<{value: number}>('counter', {name: 'undecodable'}))?.value ?? 0;
		const listing = await view.listCurrent<{tokenAddress: string; tokenID: string}>('ownership', {owner}, 25);

		el('transfers').textContent = String(transfers);
		el('undecodable').textContent = undecodable
			? `${undecodable} log(s) matched Transfer but were not ERC-721 (almost certainly ERC-20) and were refused`
			: 'none so far';
		el('tokens').innerHTML = listing.rows
			.map((row) => `<li><code>${row.tokenAddress}</code> #<code>${readableTokenID(row.tokenID)}</code></li>`)
			.join('');
		el('truncated').textContent = listing.truncated ? '(showing the first 25)' : '';
	}

	indexer.state.subscribe(() => void render());
	await indexer.startAutoIndexing();
	await render();
}

/**
 * Wait until the connection is far enough along to index, drawing the wallet
 * picker while it is not.
 *
 * `WalletToChoose` is a resting step, not a failure: several wallets announced
 * themselves and the user has to say which. The buttons call `selectWallet(name)`
 * rather than `connect(name)` on the account-given path, for the reason at the
 * top of this file.
 */
function waitForWallet(connection: any): Promise<{
	account?: `0x${string}`;
	walletName?: string;
	/** The WALLET's chain, decimal, or `undefined` when no wallet is involved. */
	walletChainId?: string;
}> {
	return new Promise((resolve) => {
		let settled = false;
		/**
		 * Declared with `let` and a no-op BEFORE subscribing, which is not a style
		 * choice.
		 *
		 * A store subscription fires SYNCHRONOUSLY with the current value, so when the
		 * connection has already settled -- a single wallet auto-selected, a chain
		 * mismatch, no wallet at all -- the callback below runs DURING the
		 * `subscribe()` call, before its return value has been assigned. A `const
		 * unsubscribe = connection.subscribe(...)` that referenced `unsubscribe` from
		 * inside the callback would therefore hit the temporal dead zone and throw
		 * `Cannot access 'unsubscribe' before initialization` -- but ONLY on the
		 * already-settled paths, which is why it survives the paths a human clicks
		 * through and breaks the ones a returning user lands on.
		 */
		let unsubscribe: () => void = () => {};
		const stop = () => setTimeout(() => unsubscribe(), 0);
		unsubscribe = connection.subscribe(($c: any) => {
			if (settled) return;
			if ($c.step === 'WalletToChoose') {
				const wallets = $c.wallets ?? [];
				// ZERO wallets also rests here, and it is not a choice -- it is nothing to
				// choose from. Resolving empty lets the caller fall back to the endpoint
				// (or explain itself) rather than leaving an empty picker on screen.
				if (wallets.length === 0) {
					settled = true;
					stop();
					resolve({});
					return;
				}
				el('picker').innerHTML = 'Several wallets are installed. Which should read the chain? ';
				for (const wallet of wallets) {
					const button = document.createElement('button');
					button.textContent = wallet.info?.name ?? wallet.info?.rdns ?? 'wallet';
					button.onclick = () =>
						ACCOUNT ? connection.selectWallet(wallet.info?.name) : connection.connect(wallet.info?.name);
					el('picker').appendChild(button);
				}
				return;
			}
			if ($c.step === 'WalletChosen' || $c.step === 'WalletConnected' || $c.step === 'SignedIn') {
				settled = true;
				el('picker').innerHTML = '';
				stop();
				const raw = $c.wallet?.chainId;
				resolve({
					account: $c.account?.address?.toLowerCase(),
					walletName: $c.wallet?.provider?.info?.name ?? $c.mechanism?.name,
					// normalised to decimal: a wallet may report either form
					walletChainId:
						raw === undefined || raw === null
							? undefined
							: String(typeof raw === 'string' && raw.startsWith('0x') ? parseInt(raw, 16) : raw),
				});
			}
		});
	});
}

start().catch((error) => {
	el('error').textContent = `${error?.message ?? error}`;
	console.error(error);
});
