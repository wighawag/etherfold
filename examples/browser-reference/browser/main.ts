import {connectToIndexerHost, createPortReadSurface, dedicatedWorkerHost, type HostProgress} from '@etherfold/browser';
import {createConnection} from '@etherplay/connect';
import {abi, tokenProcessor} from '../src/processor.js';

/**
 * THE REFERENCE WIRING: one contract, indexed in a worker, read from a tab.
 *
 * Everything a template needs and nothing else. Read it top to bottom; it is
 * meant to be read in one sitting and copied, together with the one file beside
 * it, `indexer.worker.ts`, which is where the indexer RUNS.
 *
 *   1. the wallet, and WHICH object to ask for the chain (not the obvious one)
 *   2. the worker, and the port this tab holds to it
 *   3. the reads, and the two subscriptions that draw the page
 *   4. `checkTxInclusion`: whether the state already accounts for a tx you sent
 *   5. hot reload, both axes
 *
 * There is no server. The worker reads the chain through the user's own wallet,
 * decodes the logs itself, and keeps the rows in IndexedDB. This tab never folds
 * a block: it holds a PORT to the worker (ADR-0082), hands it the wallet and the
 * settings, and reads what the worker indexed.
 *
 * Three things in here are load-bearing and easy to get wrong. Each is marked
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
	 * authority on what the wallet is pointed at. The check is made HERE, before a
	 * worker exists, so a wallet on the wrong chain starts no indexer at all.
	 */
	if (wallet.chainId !== undefined && wallet.chainId !== String(CHAIN.id)) {
		el('error').textContent =
			`this app indexes chain ${CHAIN.id}, but the wallet is on chain ${wallet.chainId}. ` +
			`Indexing on the wrong chain finds no logs at all and merely looks slow.`;
		return;
	}

	// =====================================================================
	// 2. THE WORKER, AND THE PORT THIS TAB HOLDS TO IT
	// =====================================================================
	/**
	 * The indexer is HOSTED (ADR-0082): `indexer.worker.ts` owns the store and the
	 * loop, and what this tab gets back is a PORT, which carries reads, control and
	 * pushed status, and nothing that could write.
	 *
	 * The app writes the `new Worker(new URL(...), {type: 'module'})` line itself,
	 * because the URL has to be a literal the bundler can see: that is what makes
	 * the worker entry, and the processor it imports, part of the build. It is a
	 * FACTORY and not a worker, because browsers evict workers and the port starts
	 * another one when that happens; the fold resumes from the cursor in the store.
	 *
	 * THE WALLET CROSSES AS A PORT. A provider is an object with methods, so it
	 * cannot be cloned into a worker, and the worker has no `window` to find a
	 * wallet on. So this tab SERVES the wallet's provider on a `MessageChannel` and
	 * transfers the other end (`@eip-1193/over-port`): every request the worker
	 * makes passes through this tab as a message, while the fold stays in the
	 * worker. A node's refusals keep their `code` and `data` on the way, so a range
	 * hint reads the same as from a local provider. It is the same pinned
	 * `connection.provider` as above, and still only for reads.
	 *
	 * THE SETTINGS are the cloneable half of what the worker folds: the contract
	 * and its ABI, and the stream config. They live in the tab because they are
	 * what the TAB knows (after a redeploy, only the tab has the new ABI); the
	 * worker entry holds only code, and waits for them.
	 */
	const indexer = connectToIndexerHost(
		dedicatedWorkerHost(() => new Worker(new URL('./indexer.worker.ts', import.meta.url), {type: 'module'})),
		{
			// `EIP1193ProviderWithoutEvents` enumerates every JSON-RPC method it knows;
			// the port needs only its `request`.
			provider: connection.provider as never,
			settings: {
				source: {chainId: String(CHAIN.id), contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}]},
				config: {stream: {finality: 12}},
			},
			// A host that REFUSED what this tab handed it (a setting its entry also
			// gives, differently) folds nothing for us, so say so rather than show a
			// page that is merely slow.
			onConnect: (outcome) => {
				if (!outcome.accepted) el('error').textContent = `${outcome.error.name}: ${outcome.error.message}`;
			},
		},
	);

	// =====================================================================
	// 3. THE READS, AND THE TWO SUBSCRIPTIONS
	// =====================================================================
	/**
	 * The store's reads, TYPED from the processor's own entity declarations and
	 * answered by the worker from the store its canonical generation folds into.
	 * The declarations are checked against the worker's on the first read, so a
	 * tab and a worker from two different builds disagree loudly, not quietly.
	 *
	 * Every read is a round trip, so you ASK: the state is rows in a store, and
	 * the port tells you WHEN to re-ask (`onStateMoved`, subscribed below).
	 *
	 * The subscriptions are attached at the BOTTOM of this function, not here, and
	 * that is hazard 1 again -- see the note at the `subscribe` calls.
	 */
	const reads = createPortReadSurface(indexer, tokenProcessor.entities);

	async function render() {
		const counter = await reads.counter.getCurrent({name: 'transfers'});
		el('transfers').textContent = String(counter?.value ?? 0);
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
	 *
	 * Across the port it is one round trip for the whole pending set, answered from
	 * where the fold is at that moment, so it is ASKED AGAIN whenever the progress
	 * push says the fold moved, which is exactly when the answer can have changed.
	 */
	const pending = new Map<string, {minedAtBlock?: number}>();

	async function refreshPending(): Promise<void> {
		if (pending.size === 0) {
			el('pending').textContent = 'none';
			return;
		}
		const verdicts = await indexer.checkTxInclusion(
			[...pending].map(([txHash, {minedAtBlock}]) => ({txHash, minedAtBlock})),
		);
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
	 * AXIS ONE: the developer edited the reducer.
	 *
	 * The processor is CODE, and code runs where the fold runs: it is imported by
	 * `indexer.worker.ts`, and the edit is taken THERE. Under Vite a module worker
	 * is an HMR client of its own, so the worker's own `import.meta.hot.accept`
	 * is handed the edited module and folds it as a new generation BESIDE the live
	 * one, which goes on answering every read until the edit has caught up. No page
	 * reload, and no blank app while it catches up.
	 *
	 * HAZARD 3 -- AN IMPORTER THAT DOES NOT ACCEPT. This tab imports the processor
	 * module too (for the ABI and the entity declarations the reads are typed
	 * from), and Vite propagates an update through EVERY importer: one that does
	 * not accept it turns the save into a full page reload, and the worker never
	 * gets its warm swap (measured:
	 * `work/notes/findings/a-module-worker-receives-hmr-under-vite.md`). So the tab
	 * ACCEPTS it and does nothing with it, because the fold is not here. (The reads
	 * go on using the declarations this tab loaded with, which is right as long as
	 * the edit is to a handler; an edited entity declaration needs a page reload.)
	 */
	if (import.meta.hot) {
		import.meta.hot.accept('../src/processor.js', () => {
			// the worker takes it; see `indexer.worker.ts`
		});
	}

	/**
	 * What the worker's hot update DID, which reaches this tab on the progress push
	 * because the tab did not make the call: the same three verdicts the main
	 * thread's `reconfigureFromHotUpdate` answers. Rendered in section 6.
	 */
	function renderHotUpdate(report: NonNullable<HostProgress['hotUpdate']>['report']) {
		switch (report.outcome) {
			case 'registered':
				el('reload').textContent =
					`processor edited: folding beside the live state, which keeps answering until the edit catches up ` +
					`(${report.generation.processor})`;
				return;
			case 'unchanged':
				el('reload').textContent =
					'nothing changed: the handlers are the fold already running, so the warm state was kept.';
				return;
			case 'failed':
				el('reload').textContent = `that save did not build, and nothing changed: ${report.message}`;
				return;
		}
	}

	/**
	 * AXIS TWO: the contract was redeployed.
	 *
	 * On a local chain these apps deploy behind a PROXY, so a redeploy does NOT
	 * move the address. What moves is the implementation, and therefore the
	 * GENERATED ABI -- and the ABI is hashed into the indexing source, so handing
	 * the new source to `reconfigure` is enough. A source is DATA, so unlike the
	 * processor it crosses the port.
	 *
	 * A reconfigure is not an outage. The new source is a new GENERATION, folding
	 * BESIDE the live one into a store of its own (the worker keys each store on
	 * `context.stream`), and the live one goes on answering every read until the
	 * new one has caught up; then the canonical pointer moves to it (`on-catch-up`,
	 * the default promotion policy) and `onStateMoved` tells this tab to re-read.
	 * `reset()` is NOT needed, and there is none on the port.
	 *
	 * If the ABI did NOT change in any way the source hashes, nothing is added
	 * (`added: false`), and that is correct rather than a gap: the same signatures
	 * over the same address still mean what the indexed rows say they mean.
	 *
	 * The case that looks like it needs a third branch -- an implementation that
	 * changed what its events MEAN while keeping their signatures -- does not,
	 * because it cannot happen without a PROCESSOR change. New meaning has to be
	 * implemented by new handler code, and writing that is the developer's job.
	 * So it travels AXIS ONE: edit the handler, and the worker folds the edit
	 * beside the live state. There is nothing for this function to detect.
	 *
	 *   - ABI changed at the same address .......... reconfigure({source})
	 *   - event MEANING changed ..................... edit the processor's handler
	 *   - genesis hash changed (a different chain) . reload the page
	 *
	 * That last one is why a template's deployments store forces `location.reload()`
	 * only on a genesis change: a different chain invalidates the provider, the
	 * cursor and the store at once, and no in-place reconfigure covers that.
	 *
	 * THE ONE THING A REBUILD DOES NOT DO FOR YOU. A new generation replays the
	 * WHOLE history, including blocks the previous implementation wrote. So a
	 * handler that merely implements the new meaning silently reinterprets
	 * pre-upgrade events under post-upgrade rules. The upgrade block is YOUR
	 * knowledge, and spending it is ordinary handler code -- `event.blockNumber` is
	 * on every event:
	 *
	 *     const weight = event.blockNumber >= UPGRADE_BLOCK ? next : previous;
	 *
	 * A local chain restarted with each deploy never meets this. A chain that keeps
	 * its history always does.
	 */
	async function onRedeploy(next: {abi: typeof abi; address: `0x${string}`; startBlock: number}) {
		const {generation, added} = await indexer.reconfigure({
			source: {chainId: String(CHAIN.id), contracts: [next]},
		});
		// `follows` says what the new generation COSTS: a generation that follows
		// re-folds logs already stored, and one that does not asks the node for its
		// history again (a new event is a new topic, so its logs were never fetched).
		el('reload').textContent = !added
			? 'the source hashes the same, so the running generation already folds it: nothing was added.'
			: generation.follows
				? 'new source: re-folding the stored logs beside the live state, which keeps answering until it catches up'
				: 'new ABI at the same address: re-indexing from the start block beside the live state, which keeps answering until it catches up';
		return generation.record;
	}

	// =====================================================================
	// 6. SUBSCRIBE LAST
	// =====================================================================
	/**
	 * HAZARD 1 AGAIN, and the reason these calls are at the BOTTOM.
	 *
	 * A subscription may invoke your callback before the code after it has run:
	 * `onProgress` hands a listener where the fold is as soon as the worker
	 * answers, and a store's `subscribe` does it SYNCHRONOUSLY, before it returns.
	 * So a callback that touches anything declared after the call reaches into the
	 * temporal dead zone and throws.
	 *
	 * This is not hypothetical and it is not only about an `unsubscribe` handle:
	 * while writing THIS FILE these subscriptions sat up in section 3, where
	 * `refreshPending` closed over a `const pending` declared in section 4, and the
	 * page died on load with `Cannot access 'pending' before initialization`. It
	 * typechecked perfectly. It was caught by `verify/reference.spec.ts` opening a
	 * real browser (ADR-0030).
	 *
	 * The rule that falls out: WIRE FIRST, SUBSCRIBE LAST.
	 *
	 * The two pushes answer different questions, which is why there are two.
	 * `onProgress` is how far the fold has got (a STATE, handed to you at once on
	 * subscribing) and drives the progress line and the pending verdicts.
	 * `onStateMoved` is WHAT MOVED (an EVENT, silent until the fold next applies a
	 * block, a reorg retracts one, or the canonical pointer moves to a new
	 * generation): it is the signal to RE-READ, and it is the ONLY one this tab
	 * re-reads on. A generation switch is announced like the rest, at once and with
	 * no block to wait for, so a quiet chain does not leave the page showing the
	 * generation it replaced. Because it is silent on attaching, the first read is
	 * made once, by hand, right after it.
	 */
	let hotUpdatesShown = 0;
	indexer.onProgress((progress: HostProgress) => {
		el('progress').textContent =
			progress.lastToBlock !== undefined && progress.latestBlock !== undefined && progress.latestBlock > 0
				? `block ${progress.lastToBlock} / ${progress.latestBlock} (${progress.syncPercentage}%)`
				: 'waiting for the node...';
		// A host that STOPPED says why, rather than leaving a number that stopped moving.
		if (progress.failure) el('error').textContent = `${progress.failure.name}: ${progress.failure.message}`;
		// A hot update the WORKER took (axis one), counted so a repeated verdict is news.
		if (progress.hotUpdate && progress.hotUpdate.count !== hotUpdatesShown) {
			hotUpdatesShown = progress.hotUpdate.count;
			renderHotUpdate(progress.hotUpdate.report);
		}
		void refreshPending();
	});

	indexer.onStateMoved(() => void render());
	void render();

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
