# @etherfold/browser

Index a chain **in the tab**, with no server and no database to provision, and publish the result as observable stores a UI can subscribe to.

It is [`@etherfold/core`](https://github.com/wighawag/etherfold/tree/main/packages/core) plus the three things a browser application needs on top of the engine: a place for the state to live that survives a reload, a loop that keeps indexing, and stores that tell a component when to re-read.

## When you want this package

| you are | use |
| --- | --- |
| indexing inside a tab, client-side, over EIP-1193 | here |
| indexing on a server, into libSQL, from a terminal | [`etherfold`](https://github.com/wighawag/etherfold/tree/main/packages/cli) |
| writing the processor itself | [`@etherfold/processor-entities`](https://github.com/wighawag/etherfold/tree/main/packages/processor-entities) |
| driving the engine yourself, in a runtime with no adapter | [`@etherfold/core`](https://github.com/wighawag/etherfold/tree/main/packages/core) |

## Minimal usage

Two lines beyond the processor. The first names WHERE the state lives, which is the only deployment decision here; the second wires the hook. You hand over the two FACTORIES rather than their results: an indexer holds any number of **generations** (a stream plus a fold over it), one of which is canonical and answers every read, and each folds into its own state — so the hook is what calls these, once per generation.

```ts
import {createBrowserStateStore, createIndexerState} from '@etherfold/browser';
import {fromEntityProcessor} from '@etherfold/processor-entities';

const indexer = createIndexerState({
	// versioned rows in IndexedDB: the browser default, decided on measurement (ADR-0024)
	createState: () => createBrowserStateStore(myProcessor.entities, {databaseName: 'my-app'}),
	createProcessor: (store) => fromEntityProcessor(myProcessor)(store),
});

await indexer.init({
	provider: window.ethereum,
	source: {chainId: '11155111', contracts: [{abi, address: '0x…', startBlock: 3040661}]},
	config: {stream: {finality: 12}},
});

// `state` publishes a READ HANDLE, because the state is rows in a store rather
// than an object: ask it questions instead of being handed all of it
indexer.state.subscribe(async (view) => {
	render((await view.getCurrent<{value: number}>('counter', {name: 'transfers'}))?.value ?? 0);
});

// `syncing` publishes the cursor and the progress; `status` publishes the phase
indexer.syncing.subscribe(($syncing) => showProgress($syncing.lastSync?.syncPercentage ?? 0));

await indexer.startAutoIndexing(); // or call indexMoreAndCatchupIfNeeded() on each new head
```

`indexMore`, `indexToLatest` and `indexMoreAndCatchupIfNeeded` are the manual forms; calling one of them on every `newHeads` message is better than a timer. `.withHooks(react)` turns the three observables into React hooks (`useState`, `useSyncing`, `useStatus`); the stores are otherwise plain `subscribe` + `$state`, so Svelte and a hand-rolled loop both work.

## Choosing where the state lives

`createBrowserStateStore` is the ONE place a backend is named, and swapping it changes nothing about the processor:

```ts
// the default: versioned rows in IndexedDB, resumed from the cursor after a reload
const store = await createBrowserStateStore(entities, {databaseName: 'my-app'});

// the light store instead: current state as an object, history as immer reverse patches
const store = await createBrowserStateStore(entities, {
	backend: (declarations) => new PatchStateStore(declarations, {retention: 'revert-only', finalityDepth: 12}),
});
```

**Whether a RELOAD keeps the state is a property of the backend, and it is knowable in advance.** The sync cursor lives behind the storage seam and is written in the same transaction as the block it describes (ADR-0027), so a tab closed mid-index reopens consistent on [`@etherfold/state-store-indexeddb`](https://github.com/wighawag/etherfold/tree/main/packages/state-store-indexeddb). [`@etherfold/state-store-patch`](https://github.com/wighawag/etherfold/tree/main/packages/state-store-patch) is memory-only by design and reports `durability: 'memory-only'` in its capabilities, so an app that cares can read that at startup rather than discover it from an empty tab.

**What you say you KEEP is what the tab keeps.** `retention` defaults to `unbounded`, and a store that states a floor instead — `{blocks: N}` beside a `finalityDepth`, or `revert-only` beside one — has the versions below that floor physically deleted, because the indexing cycle schedules the prune ([ADR-0022](https://github.com/wighawag/etherfold/blob/main/docs/adr/0022-pruning-is-a-call-the-host-schedules-not-a-side-effect-of-a-write.md): a prune is a call a host makes and never a side effect of applying a block). Each pass is bounded (`createIndexerState(..., {pruneBudget})`) and the next cycle picks up what it could not finish, so a long-lived tab reclaims steadily rather than stalling on one delete. The live version of an entity survives however old it is. Size a window against the chain rather than against how much history it feels like: event-bearing blocks on the real measured stream are median 429 apart, so 64 blocks is roughly one of them.

**Reorg safety and NO history is `revert-only`, not a small window.** `createBrowserStateStore(entities, {retention: 'revert-only', finalityDepth: 12})` says exactly that: superseded versions survive only as long as a reorg revert needs them (the finality depth is that floor, so revert keeps working), and the store reports `capabilities.asOf === false`, so an app that does need history learns it at startup rather than from a refused read mid-session. A short window is a different request that looks like the same one: retention counts BLOCK NUMBERS and never updates ([ADR-0019](https://github.com/wighawag/etherfold/blob/main/docs/adr/0019-retention-is-block-numbers-and-an-unretained-read-is-refused.md)), and with event-bearing blocks median 429 apart (max 1,226,194), `{blocks: 64}` typically holds exactly one of them, the tip's, and often none. That buys a store that refuses almost every historical read while looking configured for history. `revert-only` is a `retention` setting, so the IndexedDB default takes it too; the light store is `revert-only` by construction ([ADR-0023](https://github.com/wighawag/etherfold/blob/main/docs/adr/0023-the-patch-store-is-memory-only-and-refuses-a-revert-it-cannot-complete.md)).

`openAndBootstrap` in [`@etherfold/processor-entities`](https://github.com/wighawag/etherfold/tree/main/packages/processor-entities) starts a tab from state somebody else already computed, instead of replaying the chain from the start block. Open the store through it (or through `openSnapshotAware`) on EVERY boot, not just the one that installs a snapshot: a bootstrapped store has no history below the snapshot's block and must keep saying so.

## Reconfiguring without an outage

Both axes are in-place calls that report whether the state survived, so a caller holding a copy knows to replace it:

- **the processor changed** (a handler was edited): `indexer.updateProcessor(fromEntityProcessor(next)(store))`, where `store` is the one this generation's `createState` opened — keep the reference your factory built, or reopen the same `databaseName`. The core compares the processor's DECLARED `version`, so an edited handler under an unchanged version is not a change it can see and the swap is SKIPPED. Bump `version` (or pass `{force: true}`) to make an edit take effect. A processor whose code moved under an unchanged `version` is reported at load time as an error-level drift report, and `config: {strictProcessorDrift: true}` turns that report into a refusal to start.
- **the contract changed** (a redeploy, a new ABI): `indexer.updateIndexer({source})`. The ABI is hashed into the source, so a changed one discards and re-indexes by itself. `reset()` as well would be a second full rebuild.

Both return a `ReconfigureOutcome`: `{stateDiscarded}` for the caller that only has to re-seed its own copy, plus `sourceInvalidation` — the verdict that bit was collapsed from, which names WHICH half stopped being valid (the raw log stream, the state folded out of it, or both) and FROM WHICH block. It is `undefined` on `updateProcessor` and `reset`, which ask no source question. `examples/browser-reference` is the worked version of this, with both axes wired to a live-reload.

## Two more things a browser app tends to need

- **`indexer.checkTxInclusion(...)`** answers whether the state you are about to render already accounts for a transaction. An app laying an OPTIMISTIC update over indexed state needs it: applied on top of state that already contains it, a non-idempotent update is counted twice. Its own receipt cannot answer that, because a reorg can re-include the same transaction in a different block.
- **`keepStreamOnIndexedDB(name)`**, passed as `createIndexerState(..., {keepStream})`, caches the raw fetched logs so a state rebuild replays from IndexedDB instead of re-fetching every log. It is an append-only run of segments: a save costs its batch and not the history, and an inconsistent stream is cleared and re-fetched rather than repaired.

## A second tab takes the store: this one becomes a reader

Every mutation is checked against a claim inside the transaction that writes it ([ADR-0075](https://github.com/wighawag/etherfold/blob/main/docs/adr/0075-every-mutating-path-carries-a-writer-token-checked-in-the-transaction-that-writes.md)), so a tab that loses the race writes NOTHING. What it does about that is **demote itself to a reader**: it stops fetching, drops the in-memory cursor that is now a lie, and goes on answering reads from the store the other tab is writing, so the data on screen stays correct ([ADR-0078](https://github.com/wighawag/etherfold/blob/main/docs/adr/0078-a-demotion-lives-where-the-store-does-and-an-advance-that-answers-nothing-is-how-a-driver-learns.md)).

It is a state change and not an error: `syncing.demotion` carries `{reason, reading}` (beside `streamSeed`, deliberately not inside `error`), the auto-index loop stops and is not re-armed, and an advance answers `undefined` — which means demoted and means nothing else. `indexer.demoteToReader('lease-lost')` is the same path for an app that elects one indexing tab itself; it is not the inverse of `promote`, which moves the canonical pointer between generations. Getting the write duty back is `dispose()` plus a fresh `init` over a store built fresh, because a store that lost is never re-claimed.

## Tests

`pnpm --filter @etherfold/browser test` (vitest, on `fake-indexeddb`) and `pnpm --filter @etherfold/browser test:browser` (playwright, in a real engine).
