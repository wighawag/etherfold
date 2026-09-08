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

  The engine's whole chain-facing surface is four of that interface's methods: `eth_getLogs` for the logs, `eth_blockNumber` for the tip, `eth_chainId` for the identity guard, and `eth_getBlockByNumber` at block `0x0` once per load when a source declares a `genesisHash`. One data call, the rest identity and tip, and no configuration adds a fifth: the engine holds its provider behind the declared set and refuses anything else, so a per-block or per-transaction request cannot come back unnoticed ([ADR-0073](docs/adr/0073-the-engine-makes-one-data-call-and-eth-getlogs-is-it.md)).

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

**Block timestamps are no longer one of those features, and the engine now REQUIRES them on the log.** `blockTimestamp` is part of the log object itself, standardised in [`ethereum/execution-apis#639`](https://github.com/ethereum/execution-apis/pull/639) and served by go-ethereum (>= 1.16.0), reth, besu, erigon, anvil, ethereumjs and [`@nomicfoundation/edr@0.20.0`](https://github.com/NomicFoundation/edr/releases/tag/%40nomicfoundation%2Fedr%400.20.0) (released 2026-09-02, [`edr#1644`](https://github.com/NomicFoundation/edr/pull/1644) closing [`edr#1643`](https://github.com/NomicFoundation/edr/issues/1643)), so a processor reads `event.blockTimestamp` for free and the engine spends no request per block on it. There is no fallback any more: `stream.alwaysFetchTimestamps` is DELETED, and a fetched range holding a log with no readable `blockTimestamp` is REFUSED at the fetch boundary, naming the node and what to do about it ([ADR-0073](docs/adr/0073-the-engine-makes-one-data-call-and-eth-getlogs-is-it.md)). **So `@nomicfoundation/edr >= 0.20.0` is a minimum requirement rather than a recommendation.** The field stays optional on the WIRE nonetheless, because a node can still answer without it at any EDR version: one FORKING a remote that predates the spec change passes the absence through rather than defaulting it, and EDR's on-disk RPC response cache keeps replaying an absence it recorded that way until its `rpc_cache` is dropped.

**The requirement is on the EDR VERSION, never on the Hardhat version, so you are not waiting for a Hardhat release.** No published Hardhat bundles EDR 0.20 yet: as of 2026-09-08, `hardhat@3.16.0` pins `@nomicfoundation/edr` at exactly `0.19.0` and the `hh2` line pins `0.12.0-next.23`. That reads like a dependency on somebody else's schedule and is not one, because EDR is an ordinary npm dependency: pull it forward in your own project with a package-manager override, in whichever of these files your package manager reads.

pnpm 11 and later, in `pnpm-workspace.yaml`:

```yaml
overrides:
  '@nomicfoundation/edr': '>=0.20.0'
```

pnpm 10, in `package.json` (pnpm 11 ignores this one, printing `The "pnpm" field in package.json is no longer read by pnpm`, so a project spanning both majors keeps the two in step):

```json
{"pnpm": {"overrides": {"@nomicfoundation/edr": ">=0.20.0"}}}
```

npm, in `package.json`:

```json
{"overrides": {"@nomicfoundation/edr": ">=0.20.0"}}
```

yarn, in `package.json`:

```json
{"resolutions": {"@nomicfoundation/edr": ">=0.20.0"}}
```

**Verify that combination in your project rather than reading this as a promise that it just works.** An override forces a pairing Hardhat did not ship and did not test, which is a small risk rather than no risk, so run your own test suite on it before you rely on it. The published 0.19 to 0.20 delta is narrow: the two behaviour changes to look at are interval mining now validating its range (`1 <= min <= max`, so a `[0, 0]` or `[0, N]` configuration that never worked as written is rejected when the provider is created) and the `function` field of `InlineConfigDirectiveError` widening to `string | undefined`, and the rest of that release is additions and fixes. EDR's RPC response cache also moves to `rpc_cache/v2` in 0.20.0, so the first run after the override refetches what it had cached.

**"A fold over logs" is a claim about the ENGINE's calls, and it is not a promise that the fold sees every log on the chain.** What is claimed is completeness with respect to the node's LOG INDEX: every log `eth_getLogs` returns for a range is folded, and no second data call goes out to look for more. That index is generally derived from each block's `logsBloom`, so a log the bloom does not commit to can be left out of the answer with no error and nothing in the response signalling the omission. The captured case is Polygon's state-sync logs: on block 74,614,768 an archive endpoint returned 848 logs for the block, while the same node's `eth_getTransactionReceipt` for the state-sync transaction returned 8 more, and an indexed source had 856 (`work/notes/findings/what-nodes-answer-when-a-getlogs-range-is-too-big.md`, section 3, which carries the numbers, the endpoint, the reproducing calls and their provenance: they are a third party's captures, dated, and we have not re-run them; it also varies by node). This lands on the weakest point of the reorg model rather than on a cosmetic one: an absence is an INFERENCE that reverts state ([ADR-0004](docs/adr/0004-log-fetcher-wire-contract-receiver-authoritative-cursor.md)), and a bloom-omitted log is a STABLE absence rather than a flapping one, so it never presents as a noisy reorg, it presents as a log that never existed. The only known remedy is reading receipts, which is the per-transaction cost a browser deployment cannot pay and the one ADR-0073 exists to remove, so the scope is stated here rather than closed. If you index a chain that can emit logs outside the bloom, Polygon being the case we captured, check what your own endpoint returns for such a block before relying on the fold being complete.

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
