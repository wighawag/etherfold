# browser-reference

The minimal wiring for indexing **one contract in a browser tab**, in the shape a template wires once and every app on it inherits: EIP-1193 from the user's own wallet, IndexedDB for the state, results consumed as stores, and both hot-reload axes.

Read [`browser/main.ts`](./browser/main.ts). It is the example; everything else here exists to check it.

```sh
pnpm --filter browser-reference browser         # run it
pnpm --filter browser-reference typecheck       # also run by the acceptance gate
pnpm --filter browser-reference verify:browser  # drive it in a real Chromium
```

## What it covers

- **The wallet**, and which object to ask for the chain. `connection.provider` is pinned to the `chainInfo` it was built with, so it answers your own chain id whatever the wallet is set to; the chain check has to read the connection STATE.
- **The store**: one line, and the only place a backend is named.
- **The hook**, and the two subscriptions that draw the page — attached last, because a subscription fires synchronously and a callback that reaches forward throws.
- **`checkTxInclusion`**: whether the indexed state already accounts for a transaction you sent, which your own receipt cannot tell you.
- **Hot reload, both axes**: an edited processor (a module a dev server hands the tab is named by a derivation over its handler sources, so an edit takes effect and a save that changed nothing says so) and a redeployed contract (same address behind a proxy, new ABI).

## What it does not cover

Deliberately, so it stays readable in one sitting: no wallet picker for multiple EIP-6963 wallets, no endpoint fallback for a visitor with no wallet, no snapshot bootstrap, no retention or pruning policy, no reorg display, no framework. [`event-processor-nfts`](../event-processor-nfts) is the fuller demo — a real ERC-721 on mainnet, a wallet picker, an ERC-20 collision handled through `handleUnparsedEvent`, and a light-store variant one line away.

It also indexes a contract that does not exist on any public chain. That is the point of `verify/`: the wallet and the chain are injected into the page, so the reference's real wiring runs against a deterministic chain with **no RPC endpoint, no extension and no funded account**, and every claim it makes is checkable by anyone, offline.

## Why the browser run matters

Two bugs in this repository's other browser example were written, reviewed and **built green**, and were found only by driving a real Chromium. Type-checking would have caught neither. A third — the synchronous-subscription trap — was reintroduced while writing *this* file, and was caught the same way. Building green is not evidence about browser behaviour; see [ADR-0030](../../docs/adr/0030-every-workspace-directory-is-typechecked-browser-execution-is-not-a-gate.md).
