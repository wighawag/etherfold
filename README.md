![Indexing Anywhere](https://raw.githubusercontent.com/wighawag/etherfold/main/preview-grey.png)

A modular indexer system for [ethereum](https://ethereum.org) and other blockchain following the same [RPC standard](https://ethereum.org/en/developers/docs/apis/json-rpc/).

Git Repo: https://github.com/wighawag/etherfold

You can find some demoes in the <a href="https://wighawag.github.io/etherfold/examples/#home" target="_blank">examples folder</a>

And here is the [Documentation Website](https://wighawag.github.io/etherfold/)

## See it index, in one command

```sh
pnpm --filter event-processor-nfts browser
```

Opens a tab that indexes an ERC-721 collection off a real chain, with no server and no database to provision: one processor, its state in IndexedDB, and a reload that CONTINUES from its cursor instead of starting again. [`examples/event-processor-nfts`](https://github.com/wighawag/etherfold/blob/main/examples/event-processor-nfts/README.md) says what to expect and how to swap the storage backend in one line.

The same processor file, on a server, into SQLite — not a port of it, the file itself:

```sh
pnpm --filter event-processor-nfts build
NFT_CONTRACT=0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d NFT_START_BLOCK=21000000 \
  pnpm --filter event-processor-nfts build:db -n https://rpc.mevblocker.io
```

`etherfold build --store sqlite --db <libsql url>` runs the processor into versioned rows and exits at the tip. There is ONE way to author a processor (ADR-0037), so the module hands over the processor itself and the operator names only where the state goes.

To keep that database CURRENT and answer over it, swap one word: `etherfold run` is the same assembly that follows the chain instead of stopping at the tip, and serves `/status` (health, reorg counters, and a cursor that advances) on the port you name. One process, no split to think about.

Every folding shape counts the reorgs it concluded, and all three write the same two numbers into the database they fold into: `run`, `build` and `index` alike, through one writer (`docs/adr/0050`). A `contradiction` is PROOF -- the same block height now carries a different hash -- and is ordinary chain activity; an `absence` is an INFERENCE, a block we held that is simply not in the re-delivered range, which is indistinguishable from a node that under-delivered it. Both revert state, so they are never folded into one number: a rising absence rate says "your logs are being truncated or your filter is wrong", not "the chain reorged" (`docs/adr/0004`). `serve` reports what its database holds, so a read tier answers the same numbers its writer does, and a database `build` emitted carries them too.

## Main features:

- written in typescript, run both in a browser context and node
- modular : you can use the part you want
- designed to run in-browser and relies only on [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193)

<!-- provider-surface: the paragraph below is CHECKED against `ENGINE_PROVIDER_METHODS` by `packages/core/test/theEngineDeclaresItsMethodSet.test.ts`. Every `eth_*` method it names must be declared and every declared method must be named, so keep method names out of the prose here unless they are part of the claim (an ADR is where the history of a deleted call belongs). -->

  The engine's whole chain-facing surface is four of that interface's methods: `eth_getLogs` for the logs, `eth_blockNumber` for the tip, `eth_chainId` for the identity guard, and `eth_getBlockByNumber` at `earliest` once per load when a source declares a `genesisHash`. One data call, the rest identity and tip, and no configuration adds a fifth: the engine holds its provider behind the declared set and refuses anything else, so a per-block or per-transaction request cannot come back unnoticed ([ADR-0073](docs/adr/0073-the-engine-makes-one-data-call-and-eth-getlogs-is-it.md)).

- one processor, several storage backends behind one seam: SQLite on a server, versioned rows in IndexedDB in a tab, or a light patch store
- as-of reads and an explicit retention window, so a historical question gets an answer or a refusal and never a tip read
- Supports Reorg
- Supports caching

## The packages

One engine, one way to author a processor, and then a choice of where the state lives and who runs the loop. Read down the column that describes your deployment; each package's own README says when to reach for it instead of its neighbours.

| | |
| --- | --- |
| **the engine** | [`@etherfold/core`](https://github.com/wighawag/etherfold/tree/main/packages/core) -- fetch logs, derive reorgs, drive a processor. Stores nothing |
| **authoring a processor** | [`@etherfold/processor-entities`](https://github.com/wighawag/etherfold/tree/main/packages/processor-entities) -- entity declarations plus `on<EventName>` handlers, naming no backend |
| **where the state lives** | [`@etherfold/state-store`](https://github.com/wighawag/etherfold/tree/main/packages/state-store) is the seam; the backends are [`-sqlite`](https://github.com/wighawag/etherfold/tree/main/packages/state-store-sqlite) (a server), [`-indexeddb`](https://github.com/wighawag/etherfold/tree/main/packages/state-store-indexeddb) (the browser default) and [`-patch`](https://github.com/wighawag/etherfold/tree/main/packages/state-store-patch) (light, memory-only). A new one earns its place by passing [`-conformance`](https://github.com/wighawag/etherfold/tree/main/packages/state-store-conformance) |
| **running it in a tab** | [`@etherfold/browser`](https://github.com/wighawag/etherfold/tree/main/packages/browser) -- observable stores, auto-indexing, in-place reconfigure |
| **running it from a terminal** | [`etherfold`](https://github.com/wighawag/etherfold/tree/main/packages/cli) -- `run` follows, folds and answers HTTP in one process; `build` folds to the tip and exits; `fetch` is the chain-facing half of a split deployment and `index` the half that receives its pushes and owns the database; `serve` is the READ tier over a database written elsewhere: it answers `/status` (health, schema version, reorg counters and the cursor) and hosts no ingestion |
| **running it as a service** | [`@etherfold/server`](https://github.com/wighawag/etherfold/tree/main/packages/server) is the host-free HTTP app; [`platforms/nodejs`](https://github.com/wighawag/etherfold/tree/main/platforms/nodejs) and [`platforms/cf-worker`](https://github.com/wighawag/etherfold/tree/main/platforms/cf-worker) are the hosts |
| **splitting fetching from folding** | [`@etherfold/fetcher-host`](https://github.com/wighawag/etherfold/tree/main/packages/fetcher-host) decides when a fetch cycle runs; [`platforms/nodejs-fetcher`](https://github.com/wighawag/etherfold/tree/main/platforms/nodejs-fetcher) is the Node adapter behind `etherfold fetch` |
| **richer reads on a SQL backend** | [`@etherfold/processor-sqlite`](https://github.com/wighawag/etherfold/tree/main/packages/processor-sqlite) -- the same processor, plus caller-supplied SQL and block addressing |
| **loading a processor by path** | [`@etherfold/utils`](https://github.com/wighawag/etherfold/tree/main/packages/utils) -- what a host uses to turn `-p ./processor.js` into a processor and its source |

`archive/` is retired code kept only as reading material: outside the workspace globs, and not built, tested, versioned or published.

## Why ?

The main reason for building `etherfold` is to have the indexing be performed in a fully decentralised manner: in the client.

This obviously does not scale for all use-case: try indexing all ERC20/ERC721 and the amount of log to fetch is too big to be useful, in a browser context.

But for some use case it is actually possible and efficient. This is the case where the amount of event is bounded or its scale rate is limited.

It is for example possible to instead of indexing all ERC721, to simply index the ERC721 of the current account.

## Caveats

Due to the limitation of EIP-1193 (no batch request), anything that needs an extra request per block or per transaction is expensive in the browser, so indexer processors are expected to not make use of such features.

Using them would work in a server environment where results can be cached across load-balanced instances, but in a browser environment where each user would have its own instance, they would slow down the indexing too much.

**Block timestamps are no longer one of those features.** `blockTimestamp` is now part of the log object itself, standardised in [`ethereum/execution-apis#639`](https://github.com/ethereum/execution-apis/pull/639) and served by go-ethereum (>= 1.16.0), reth, besu, erigon, anvil and ethereumjs, so a processor can read `event.blockTimestamp` for free. The last holdout was Hardhat's EDR ([edr#1643](https://github.com/NomicFoundation/edr/issues/1643)), and it is now implemented: [`edr#1644`](https://github.com/NomicFoundation/edr/pull/1644) shipped in `@nomicfoundation/edr@0.20.0` (released 2026-09-02). Hardhat itself has not bumped to it yet (3.16.0 still bundles edr 0.19.0), but that is not a wait: EDR is an ordinary dependency, so a Hardhat project can pull it forward with a package-manager override (`pnpm.overrides`, npm `overrides`, yarn `resolutions`) pinning `@nomicfoundation/edr` to `0.20.0`. The field stays optional on the WIRE nonetheless, because two cases survive any version bump: a node being FORKED that predates the spec change keeps the field absent rather than defaulting it, and EDR's on-disk RPC cache is version-segmented, so entries written before the change keep answering without it. There is no longer a fallback for those: `stream.alwaysFetchTimestamps` is DELETED, and a fetched range holding a log with no readable `blockTimestamp` is REFUSED at the fetch boundary, naming the node and what to do about it (ADR-0073). The engine reads the timestamp off the log and makes no other data call, so `@nomicfoundation/edr >= 0.20.0` is a minimum requirement rather than a recommendation.

Having said that an hybrid approach is possible where a server index and the in-browser indexer exists only as a backup when every server instances are unavailable expect for a cache (which could even be shared across user in p2p manner).

It is also worth noting that for an indexer to work, it needs to index all events and depending on the games or applications, this might not fit in memory or in browser storage qutoa. For such case, there is no other option to have that handled by a remote service.

## Usage

install `@etherfold/browser` and `@etherfold/processor-entities`

```
npm i @etherfold/browser @etherfold/processor-entities
```

A processor is **entity declarations plus one handler per event**, and it names no backend: the same object indexes into IndexedDB in a tab and into SQLite on a server. Here is one, for a contract that emits `MessageChanged(address user, string message)`:

```ts
import type {EntityProcessor} from '@etherfold/processor-entities';

const abi = [
	{
		anonymous: false,
		inputs: [
			{indexed: true, name: 'user', type: 'address'},
			{indexed: false, name: 'message', type: 'string'},
		],
		name: 'MessageChanged',
		type: 'event',
	},
] as const;

export const greetings: EntityProcessor<typeof abi> = {
	// REQUIRED, and ideally generated so it changes whenever a handler does. The indexer
	// discards state computed by a previous version by comparing it; if you edit a handler
	// and forget to bump it, the indexer says so at load time (an error-level drift report,
	// plus the `onProcessorDrift` callback). Set `strictProcessorDrift: true` in the indexer
	// config to refuse to start instead of merely reporting.
	version: '1.0.1',

	// `{name, id, fields}` per entity is the whole schema an author writes: the store owns
	// the layout, the version columns, the as-of read and the reorg revert.
	entities: [{name: 'greeting', id: ['user'], fields: {message: 'text'}}],

	// one handler per event, over a MutationContext with read-your-writes inside the block
	async onMessageChanged(state, event) {
		state.set('greeting', {user: event.args.user.toLowerCase()}, {message: event.args.message});
	},
};
```

Indexing it in a browser tab is two more lines. The first names WHERE the state lives, which is the only deployment decision here; the second wires the hook. Both are FACTORIES rather than values: an indexer holds any number of **generations** (a stream plus a fold over it), one of which is canonical and answers every read, and each folds into its own state — so the hook is what calls these, once per generation.

```ts
import {createBrowserStateStore, createIndexerState} from '@etherfold/browser';
import {fromEntityProcessor} from '@etherfold/processor-entities';

const indexer = createIndexerState({
	// versioned rows in IndexedDB: the browser default, decided on measurement (ADR-0024)
	createState: () => createBrowserStateStore(greetings.entities, {databaseName: 'greetings'}),
	createProcessor: (store) => fromEntityProcessor(greetings)(store),
});

await indexer.init({
	provider: (window as any).ethereum,
	source: {chainId: '11155111', contracts: [{abi, address: '0x21d3…', startBlock: 3040661}]},
});

// index on a timer; `indexMore` / `indexMoreAndCatchupIfNeeded` are the manual forms, and
// calling one on every `newHeads` subscription message is better than a timer
await indexer.startAutoIndexing();

// `indexer.state` publishes a READ HANDLE, because the state is rows in a store rather than
// an object: ask it questions instead of being handed all of it
indexer.state.subscribe(async (view) => {
	const mine = await view.getCurrent<{message: string}>('greeting', {user: account});
	render(mine?.message);
});

// and `indexer.syncing` publishes the cursor and the progress
indexer.syncing.subscribe(($syncing) => showProgress($syncing.lastSync?.syncPercentage ?? 0));
```

`.withHooks(react)` turns those observables into React hooks (`useState`, `useSyncing`, `useStatus`).

A runnable version of all of this, against a real chain, is [`examples/event-processor-nfts`](https://github.com/wighawag/etherfold/blob/main/examples/event-processor-nfts/README.md); [`examples/browser-reference`](https://github.com/wighawag/etherfold/blob/main/examples/browser-reference) is the minimal wiring with both hot-reload axes.
