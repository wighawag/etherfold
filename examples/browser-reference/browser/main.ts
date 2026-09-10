import {createBrowserStateStore, createIndexerState, type GenerationContext} from '@etherfold/browser';
import {fromEntityProcessor, openForWriting} from '@etherfold/processor-entities';
import {createConnection} from '@etherplay/connect';
import {abi, tokenProcessor} from '../src/processor.js';

/**
 * THE REFERENCE WIRING: one contract, indexed in a browser tab, read as stores.
 *
 * Everything a template needs and nothing else. Read it top to bottom; it is
 * meant to be read in one sitting and copied.
 *
 *   1. the wallet, and WHICH object to ask for the chain (not the obvious one)
 *   2. the store: one line, and the only place a backend is named
 *   3. the hook, and the two subscriptions that draw the page
 *   4. `checkTxInclusion`: whether the state already accounts for a tx you sent
 *   5. hot reload, both axes
 *
 * There is no server. The tab talks to the node behind the user's own wallet,
 * decodes the logs itself, and keeps the rows in IndexedDB.
 *
 * Four things in here are load-bearing and easy to get wrong. Each is marked
 * HAZARD where it appears, and two of them are bugs that actually shipped in
 * this repository and were caught only by driving a real browser.
 */

/** The chain this app indexes. A mismatch is REFUSED rather than indexed emptily. */
const CHAIN = {
	id: 1,
	chainName: 'Ethereum',
	rpcUrls: {default: {http: ['https://rpc.mevblocker.io']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

const CONTRACT = '0x0000000000000000000000000000000000000099' as const;
const START_BLOCK = 0;

const el = (id: string) => document.getElementById(id) as HTMLElement;

async function start() {
	// =====================================================================
	// 1. THE WALLET
	// =====================================================================
	const connection = createConnection({
		targetStep: 'WalletChosen',
		chainInfo: CHAIN,
		prioritizeWalletProvider: true,
	});

	await connection.selectWallet();
	const wallet = await waitForWallet(connection);

	if (!wallet.chosen) {
		el('error').textContent = 'no wallet announced itself (EIP-6963), so there is no node to read the chain through.';
		return;
	}

	/**
	 * HAZARD 2 -- THE PINNED PROVIDER. The one most likely to bite a template.
	 *
	 * `connection.provider` is the always-on wrapper: it routes through the chosen
	 * wallet when there is one and falls back to the chain's own endpoint when
	 * there is not, so an app has ONE provider either way. That convenience has a
	 * sharp edge: the wrapper is PINNED to the `chainInfo` it was constructed
	 * with, so `connection.provider.request({method: 'eth_chainId'})` answers
	 * `CHAIN.id` WHATEVER the wallet is actually set to.
	 *
	 * A chain check written against it therefore compares a constant with itself
	 * and passes for a wallet sitting on Polygon, which is exactly the
	 * silently-wrong-chain failure such a check exists to prevent. That bug
	 * shipped here, reviewed and built green, and indexed a mainnet address
	 * against a Polygon node.
	 *
	 *   ASK THE CONNECTION STATE for the real chain:  $connection.wallet.chainId
	 *   NEVER ASK THE PROVIDER:                       connection.provider
	 *
	 * The provider is for READS (`eth_getLogs`, `eth_blockNumber`). It is not an
	 * authority on what the wallet is pointed at.
	 */
	if (wallet.chainId !== undefined && wallet.chainId !== String(CHAIN.id)) {
		el('error').textContent =
			`this app indexes chain ${CHAIN.id}, but the wallet is on chain ${wallet.chainId}. ` +
			`Indexing on the wrong chain finds no logs at all and merely looks slow.`;
		return;
	}

	// The provider is only ever used to READ. `EIP1193ProviderWithoutEvents`
	// enumerates every JSON-RPC method it knows; this app uses three of them.
	const provider = connection.provider as never;

	// =====================================================================
	// 2. THE STORE -- one line, and the only place a backend is named
	// =====================================================================
	// IndexedDB is the browser default (ADR-0024): versioned rows, and the sync
	// cursor written in the same transaction as the block it describes, so a tab
	// that is closed mid-index reopens consistent.
	//
	// It is a FACTORY and not a value, because an indexer holds any number of
	// GENERATIONS -- a stream plus a fold over it -- one of which is canonical and
	// answers every read, and each folds into its own state. The hook calls this
	// once per generation.
	// KEYED ON THE CONTEXT, which is what keeps each generation's state its own.
	// The container hands the factory a `GenerationContext` precisely so the
	// storage location can be derived from it: two generations sharing one
	// `databaseName` are one store by IndexedDB's own definition, and they would
	// collide on the sync cursor as well as on the rows, because that cursor lives
	// under a fixed key.
	// CLAIMED, because this tab INDEXES: building a store and becoming its writer
	// are two acts, and `openForWriting` is the second one (ADR-0077). A tab that
	// only rendered would open the same store and never call it, and the type is
	// what stops it writing. `openForWriting` migrates, so this is the whole open.
	const createState = async (context: GenerationContext) =>
		openForWriting(
			await createBrowserStateStore(tokenProcessor.entities, {
				databaseName: `reference-${CHAIN.id}-${CONTRACT}-${context.stream}`,
			}),
		);

	// The store the CANONICAL generation was built over, kept because the
	// live-reload below rebuilds a processor over the SAME store: a hot reload
	// replaces the author's object, not the tab's IndexedDB connection.
	let store!: Awaited<ReturnType<typeof createState>>;

	// =====================================================================
	// 3. THE HOOK, AND THE TWO SUBSCRIPTIONS
	// =====================================================================
	const indexer = createIndexerState({
		createState: async (context) => (store = await createState(context)),
		createProcessor: (state) => fromEntityProcessor(tokenProcessor)(state),
	});

	await indexer.init({
		provider,
		source: {chainId: String(CHAIN.id), contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}]},
		config: {stream: {finality: 12}},
	});

	/**
	 * `syncing` is the cursor and the progress. `state` is the data.
	 *
	 * On the entity path `state.$state` is a READ HANDLE rather than a value: the
	 * state is rows in a store, so you ask it questions instead of being handed
	 * all of it. `subscribe` tells you WHEN to re-ask.
	 *
	 * The subscriptions are attached at the BOTTOM of this function, not here, and
	 * that is hazard 1 again -- see the note at the `subscribe` calls.
	 */
	async function render() {
		const view = indexer.state.$state;
		const transfers = (await view.getCurrent<{value: number}>('counter', {name: 'transfers'}))?.value ?? 0;
		el('transfers').textContent = String(transfers);
	}

	// =====================================================================
	// 4. TX INCLUSION -- the finality pairing
	// =====================================================================
	/**
	 * Transactions this tab sent and has not yet seen reflected in indexed state.
	 *
	 * A template that tracks pending transactions needs this before it lays an
	 * OPTIMISTIC update over indexed state: applied on top of a state that already
	 * contains it, a non-idempotent update (a counter, a balance, an append) is
	 * counted twice.
	 *
	 * The caller's own RECEIPT cannot answer this, which is the part worth
	 * internalising. A block HEIGHT is a local opinion about a chain rather than
	 * an identity, and the receipt's block HASH is the wrong identity: a reorg can
	 * re-include the same transaction in a different block, so comparing hashes
	 * reports "not indexed" for a transaction that IS indexed -- producing exactly
	 * the double count it was meant to prevent. The question is about the
	 * INDEXER'S OWN chain, so only the indexer answers it.
	 *
	 * Three statuses and not two: `'unknown'` is a real answer, and collapsing it
	 * into either of the others is what makes a wrong UI.
	 */
	const pending = new Map<string, {minedAtBlock?: number}>();

	async function refreshPending(): Promise<void> {
		if (pending.size === 0) {
			el('pending').textContent = 'none';
			return;
		}
		const verdicts = indexer.checkTxInclusion([...pending].map(([txHash, {minedAtBlock}]) => ({txHash, minedAtBlock})));
		const lines: string[] = [];
		for (const [txHash, verdict] of Object.entries(verdicts)) {
			if (verdict.status === 'included') {
				// The indexed state already accounts for it: DROP the optimistic
				// overlay. Applying it now would count the effect twice.
				pending.delete(txHash);
				lines.push(`${short(txHash)}: included at block ${verdict.blockNumber} (${verdict.basis})`);
			} else {
				// 'absent' or 'unknown': KEEP the overlay. Dropping it on 'unknown'
				// makes the effect briefly vanish from the UI.
				lines.push(`${short(txHash)}: ${verdict.status} (${verdict.basis}) -- overlay kept`);
			}
		}
		el('pending').textContent = lines.join('\n');
	}

	/** Call this when you send a transaction; pass `minedAtBlock` once you have a receipt. */
	function trackTransaction(txHash: string, minedAtBlock?: number) {
		pending.set(txHash, {minedAtBlock});
		void refreshPending();
	}

	// =====================================================================
	// 5. HOT RELOAD -- both axes
	// =====================================================================
	/**
	 * AXIS ONE: the developer edited the reducer, and the bundler handed this tab
	 * a new processor module.
	 *
	 * THE TRAP: the core decides whether the state survives by comparing VERSION
	 * HASHES, and a version hash is `${version}-${hash({entities, config})}`.
	 * Handler code is in none of that. So an edited handler under an unchanged
	 * `version` is NOT a change the core can see: `updateProcessor` skips the swap
	 * entirely and keeps the OLD processor object running. Your edit does not take
	 * effect, and the only complaint is a `named-logs` warning most apps never
	 * route anywhere.
	 *
	 * Two ways to make an edit land, and they cost the same thing:
	 *   - bump `version` in the processor (the honest one -- see src/processor.ts)
	 *   - `updateProcessor(next, {force: true})` (when you cannot bump it)
	 *
	 * Either way the state is DISCARDED and rebuilt from the start block, because
	 * the core cannot know which part of the state your edit invalidated, and
	 * "all of it" is the only answer that cannot be wrong.
	 */
	if (import.meta.hot) {
		import.meta.hot.accept('../src/processor.js', async (module) => {
			if (!module) return;
			const next = module.tokenProcessor as typeof tokenProcessor;
			const outcome = await indexer.updateProcessor(fromEntityProcessor(next)(store));
			el('reload').textContent = outcome.stateDiscarded
				? 'processor swapped: state discarded, rebuilding'
				: 'processor NOT swapped: same version hash, so the edit is not running. Bump `version`.';
		});
	}

	/**
	 * AXIS TWO: the contract was redeployed.
	 *
	 * On a local chain these apps deploy behind a PROXY, so a redeploy does NOT
	 * move the address. What moves is the implementation, and therefore the
	 * GENERATED ABI -- and the ABI is hashed into the indexing source, so handing
	 * the new source to `updateIndexer` is enough. It discards and re-indexes.
	 * `reset()` is NOT also needed; calling it would be a second full rebuild.
	 *
	 * If the ABI did NOT change, nothing is discarded, and that is correct rather
	 * than a gap: the same signatures over the same address still mean what the
	 * indexed rows say they mean.
	 *
	 * The case that looks like it needs a third branch -- an implementation that
	 * changed what its events MEAN while keeping their signatures -- does not,
	 * because it cannot happen without a PROCESSOR change. New meaning has to be
	 * implemented by new handler code, and writing that is the developer's job.
	 * So it travels AXIS ONE: bump `version`, and the swap discards and re-indexes.
	 * There is no `reset()` special case and nothing for this function to detect.
	 *
	 *   - ABI changed at the same address .......... updateIndexer({source})
	 *   - event MEANING changed ..................... edit the processor, bump `version`
	 *   - genesis hash changed (a different chain) . reload the page
	 *
	 * That last one is why a template's deployments store forces `location.reload()`
	 * only on a genesis change: a different chain invalidates the provider, the
	 * cursor and the store at once, and no in-place reconfigure covers that.
	 *
	 * THE ONE THING A REBUILD DOES NOT DO FOR YOU. A discard replays the WHOLE
	 * history, including blocks the previous implementation wrote. So a handler
	 * that merely implements the new meaning silently reinterprets pre-upgrade
	 * events under post-upgrade rules. The upgrade block is YOUR knowledge, and
	 * spending it is ordinary handler code -- `event.blockNumber` is on every
	 * event:
	 *
	 *     const weight = event.blockNumber >= UPGRADE_BLOCK ? next : previous;
	 *
	 * A local chain restarted with each deploy never meets this. A chain that keeps
	 * its history always does.
	 */
	async function onRedeploy(next: {abi: typeof abi; address: `0x${string}`; startBlock: number}) {
		const outcome = await indexer.updateIndexer({
			source: {chainId: String(CHAIN.id), contracts: [next]},
		});
		// `stateDiscarded` is one bit: WHETHER the fold went. `sourceInvalidation` is
		// the verdict it was collapsed from -- which half died (the raw log STREAM, the
		// STATE folded out of it, or both) and from which BLOCK. Read it rather than
		// hashing the source yourself: a second derivation is a second answer, and it
		// can disagree with the one the indexer acted on.
		const verdict = outcome.sourceInvalidation;
		const from =
			verdict && !verdict.state.valid ? ` from block ${verdict.state.invalidFromBlock} (${verdict.state.reason})` : '';
		el('reload').textContent = outcome.stateDiscarded
			? `new ABI at the same address: state discarded${from}, re-indexing from the start block`
			: 'the source hashes the same, so nothing was discarded. If the MEANING changed, call reset().';
	}

	// =====================================================================
	// 6. SUBSCRIBE LAST
	// =====================================================================
	/**
	 * HAZARD 1 AGAIN, and the reason these two calls are at the BOTTOM.
	 *
	 * `subscribe` invokes your callback SYNCHRONOUSLY, with the current value,
	 * before it returns. So a callback that touches anything declared after the
	 * `subscribe` call reaches into the temporal dead zone and throws.
	 *
	 * This is not hypothetical and it is not only about the `unsubscribe` handle
	 * below: while writing THIS FILE these two subscriptions sat up in section 3,
	 * where `refreshPending` closed over a `const pending` declared in section 4,
	 * and the page died on load with `Cannot access 'pending' before
	 * initialization`. It typechecked perfectly. It was caught by
	 * `verify/reference.spec.ts` opening a real browser (ADR-0030).
	 *
	 * The rule that falls out: WIRE FIRST, SUBSCRIBE LAST.
	 *
	 * Note also the ORDER the hook publishes in, which is a guarantee and not an
	 * accident: within one update it sets `syncing` BEFORE `state`. So the cursor
	 * can be one statement ahead of the rows and never behind, and that direction
	 * is the safe one -- an optimistic overlay dropped a moment early flickers, one
	 * dropped late is counted twice. A subscriber that reads both after an update
	 * sees them agree.
	 */
	indexer.syncing.subscribe((syncing) => {
		const sync = syncing.lastSync;
		el('progress').textContent = sync
			? `block ${sync.lastToBlock} / ${sync.latestBlock} (${sync.syncPercentage}%)`
			: 'waiting for the node...';
		if (syncing.error) el('error').textContent = `${syncing.error.id}: ${syncing.error.message}`;
		void refreshPending();
	});

	indexer.state.subscribe(() => void render());

	await indexer.startAutoIndexing();

	// Exposed so the browser verification can drive the paths a human cannot
	// click: a redeploy, and a transaction whose inclusion has to be checked.
	Object.assign(window as never, {__reference: {indexer, onRedeploy, trackTransaction}});
}

/**
 * HAZARD 1 -- THE SYNCHRONOUS SUBSCRIPTION.
 *
 * A store subscription fires SYNCHRONOUSLY with the current value. So when the
 * connection has ALREADY settled -- a single wallet auto-selected, a chain
 * mismatch, no wallet at all -- the callback below runs DURING the
 * `subscribe()` call, before that call has returned.
 *
 * Which means this, the obvious way to write it, is a bug:
 *
 *     const unsubscribe = connection.subscribe(($c) => {
 *         if (settled($c)) { unsubscribe(); resolve($c); }   // <-- throws
 *     });
 *
 * `unsubscribe` is a `const` in the temporal dead zone when the callback runs,
 * so every already-settled path throws `Cannot access 'unsubscribe' before
 * initialization`. The paths a human CLICKS through (a wallet picker, an
 * accounts prompt) resolve asynchronously and work fine, which is why this
 * survives casual manual testing and breaks for the returning user.
 *
 * The fix is the three lines below: declare with `let`, initialise to a no-op,
 * and defer the actual call so unsubscribing during the synchronous dispatch is
 * safe too.
 */
type ConnectionSnapshot = {step: string; wallet?: {chainId?: string}; wallets?: readonly unknown[]};

function waitForWallet(connection: {
	subscribe(run: (value: ConnectionSnapshot) => void): () => void;
}): Promise<{chosen: boolean; chainId?: string}> {
	return new Promise((resolve) => {
		let settled = false;
		let unsubscribe: () => void = () => {};
		const stop = () => setTimeout(() => unsubscribe(), 0);

		unsubscribe = connection.subscribe((state) => {
			if (settled) return;

			// Resting at the picker with ZERO wallets is not a choice, it is nothing
			// to choose from: resolve rather than leave an empty picker on screen.
			if (state.step === 'WalletToChoose' && (state.wallets ?? []).length === 0) {
				settled = true;
				stop();
				resolve({chosen: false});
				return;
			}
			if (state.wallet) {
				settled = true;
				stop();
				resolve({chosen: true, chainId: state.wallet.chainId});
			}
		});
	});
}

const short = (hash: string) => `${hash.slice(0, 10)}...`;

start().catch((err) => {
	el('error').textContent = `${(err as Error)?.message ?? err}`;
});
