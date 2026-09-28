# browser-reference

The minimal wiring for indexing **one contract in a browser app**, in the shape a template wires once and every app on it inherits: the indexer in a dedicated worker, EIP-1193 from the user's own wallet handed to it as a port, IndexedDB for the state, results read across the port (typed reads by id, and a GraphQL query the worker answers), and both hot-reload axes.

Read [`browser/main.ts`](./browser/main.ts), the tab's side, then [`browser/indexer.worker.ts`](./browser/indexer.worker.ts), where the indexer runs. They are the example; everything else here exists to check them.

```sh
pnpm --filter browser-reference browser         # run it
pnpm --filter browser-reference typecheck       # also run by the acceptance gate
pnpm --filter browser-reference verify:browser  # drive it in a real Chromium
```

## What it covers

- **The wallet**, and which object to ask for the chain. `connection.provider` is pinned to the `chainInfo` it was built with, so it answers your own chain id whatever the wallet is set to; the chain check has to read the connection STATE.
- **The worker and the port** ([ADR-0082](../../docs/adr/0082-the-indexer-is-hosted-and-a-tab-holds-a-port-to-its-host.md)): the worker entry holds the code (the store factory and the processor) and waits; the tab connects, hands it the wallet's provider as a `MessagePort` and the cloneable settings (the source and the stream config), and the fold starts in the worker. Nothing indexes on the main thread.
- **The store**: one line, in the worker entry, and the only place a backend is named.
- **The reads, and the two pushes that draw the page** (`onProgress`, `onStateMoved`), attached last, because a listener may be called before the code after it has run and a callback that reaches forward throws.
- **A GraphQL query, answered by the worker** ([ADR-0099](../../docs/adr/0099-one-query-runs-against-a-worker-and-a-server-through-an-accessor-seam.md)): the worker entry opts in with `query: graphqlQueryHandler()`, and the tab runs one document through `workerExecutor(indexer)`, a filtered, ordered list of accounts with each one's holdings nested (the `holding` entity declares `account` as its parent, ADR-0098). It is re-run on `onStateMoved` like every other read. Swapping `workerExecutor` for `httpExecutor(url)` runs the same document against a hosted indexer's `/graphql`. The typed read surface stays for the counter, read by id, because it costs nothing; GraphQL costs the worker about 48 KiB gzipped (see [the guide](../../docs/guide/indexing-in-a-browser-app/index.md#querying-the-state-the-read-surface-or-graphql)).
- **`checkTxInclusion`**: whether the indexed state already accounts for a transaction you sent, which your own receipt cannot tell you.
- **Hot reload, both axes**: an edited processor (the worker is an HMR client of its own under Vite, so the worker entry's `import.meta.hot.accept` hands the edited module to `host.reconfigureFromHotUpdate`, which folds it as a new generation beside the live one, named by a derivation over its handler sources, with no page reload; the verdict reaches the tab on `progress.hotUpdate`) and a redeployed contract (same address behind a proxy, new ABI: `reconfigure({source})` folds a new generation beside the live one). Either way the live generation keeps answering until the new one catches up. The tab imports the processor module too, so it accepts the update as well: an importer that does not accept it turns every save into a page reload.

## What it does not cover

Deliberately, so it stays readable in one sitting: no wallet picker for multiple EIP-6963 wallets, no endpoint fallback for a visitor with no wallet, no snapshot bootstrap, no retention or pruning policy, no reorg display, no framework. [`event-processor-nfts`](../event-processor-nfts) is the fuller demo — a real ERC-721 on mainnet, a wallet picker, an ERC-20 collision handled through `handleUnparsedEvent`, and a light-store variant one line away.

It also indexes a contract that does not exist on any public chain. That is the point of `verify/`: the wallet and the chain are injected into the page, so the reference's real wiring (worker included) runs against a deterministic chain with **no RPC endpoint, no extension and no funded account**, and every claim it makes is checkable by anyone, offline.

## Why the browser run matters

Two bugs in this repository's other browser example were written, reviewed and **built green**, and were found only by driving a real Chromium. Type-checking would have caught neither. A third — the synchronous-subscription trap — was reintroduced while writing *this* file, and was caught the same way. Building green is not evidence about browser behaviour; see [ADR-0030](../../docs/adr/0030-every-workspace-directory-is-typechecked-browser-execution-is-not-a-gate.md).
