# @etherfold/core

The engine. It fetches a contract's logs, decides what a reorg did to them, and drives an `EventProcessor` over the result. It stores nothing itself.

It names no host and no database: a browser tab, a Node process and a Worker all run this same code, and WHERE the derived state lives arrives from outside (the storage seam is [`@etherfold/state-store`](https://github.com/wighawag/etherfold/tree/main/packages/state-store), reached through [`@etherfold/processor-entities`](https://github.com/wighawag/etherfold/tree/main/packages/processor-entities)).

<!-- provider-surface: the paragraph below is CHECKED against `ENGINE_PROVIDER_METHODS` by `test/theEngineDeclaresItsMethodSet.test.ts`. Every `eth_*` method it names must be declared and every declared method must be named, so keep method names out of the prose here unless they are part of the claim (an ADR is where the history of a deleted call belongs). -->

**The whole provider surface, and it is checked rather than promised.** The engine asks an EIP-1193 provider for four things and nothing else: `eth_getLogs` for the logs, `eth_blockNumber` for the tip, `eth_chainId` for the identity guard, and `eth_getBlockByNumber` at `earliest` once per load, when a source declares a `genesisHash`. One of those is a DATA call and the rest are identity and tip, which is what ADR-0073 means by a fold over logs; the block read is the genesis probe, so nothing here costs a request per block or per transaction. No configuration widens it: the engine holds its provider behind `declaredMethodsOnly`, so anything outside `ENGINE_PROVIDER_METHODS` is refused at the call rather than paid for, and a reintroduced per-block call fails in CI instead of turning up in a profile months later.


## When you want this package, and when you do not

Most applications never import it directly:

| you are | use |
| --- | --- |
| indexing in a browser tab | [`@etherfold/browser`](https://github.com/wighawag/etherfold/tree/main/packages/browser), which wraps this in observable stores |
| indexing on a server, from a terminal | [`etherfold`](https://github.com/wighawag/etherfold/tree/main/packages/cli), the CLI |
| writing the processor itself | [`@etherfold/processor-entities`](https://github.com/wighawag/etherfold/tree/main/packages/processor-entities) |
| hosting the two halves of a split deployment yourself | here |

Take this package directly when you are building the host: a runtime this repo does not ship an adapter for, a test harness that drives the engine, or a deployment that splits fetching from folding.

## The two shapes it comes in

**One process, one source, one processor, one state: `IndexerGeneration`.** This is the client engine, and what [`@etherfold/browser`](https://github.com/wighawag/etherfold/tree/main/packages/browser) is built on. It holds the sync cursor, the unconfirmed-block window and the optional cached stream, and it opens `load()` with `eth_chainId`, so it is the shape for a host that can talk to a chain. One stream plus one fold over it is a **generation**, which is what the name says; `Indexer` is the container that holds several of them and points at the one that answers reads.

```ts
import {IndexerGeneration} from '@etherfold/core';

const indexer = new IndexerGeneration(provider, eventProcessor, {
	chainId: '1',
	contracts: [{abi, address: '0x…', startBlock: 21000000}],
});

await indexer.load(); // adopt or discard whatever the processor already had
const lastSync = await indexer.indexMore(); // one batch; call it until `lastToBlock` reaches `latestBlock`
```

**Two halves, one wire: `LogFetcher` and `StreamBuilder`** (ADR-0003, ADR-0004). The fetcher is stateless and chain-facing; the stream-builder is chain-free, authoritative about where the next range must start, and derives every reorg. The transport between them is a dependency rather than a second implementation:

```ts
import {createDirectIngestion, createHttpIngestion, LogFetcher, StreamBuilder} from '@etherfold/core';

const builder = new StreamBuilder(eventProcessor, source, {stream: {}});

// combined: both halves in one process, no network in between
const fetcher = new LogFetcher(provider, source, createDirectIngestion(builder));

// split: the same fetcher, pushing to an indexer-server elsewhere
const remote = new LogFetcher(provider, source, createHttpIngestion({endpoint, token}));

await fetcher.fetchAndPush();
```

`fetchAndPush()` is ONE cycle and says nothing about when the next one runs; scheduling is [`@etherfold/fetcher-host`](https://github.com/wighawag/etherfold/tree/main/packages/fetcher-host). What crosses is a `WireBatch` (`{context, fromBlock, toBlock, latestBlock, logs}`) and it always holds EVERY log in its range: truncation is expressed by LOWERING `toBlock`, never by sending part of one. A batch that does not start at the receiver's `expectedFromBlock` comes back as `UnexpectedFromBlockError` (`409` over HTTP), which is the one refusal a sender recovers from by re-sending; everything else is a `400` no block number fixes.

## What else is in here

- **The reorg model.** `removed: true` markers for retracted events, `unconfirmedBlocks` pruned past the finality window, and `ReorgCause` (`contradiction` = the same height now carries a different hash, `absence` = a block we held simply is not in the re-delivered range). The two are counted apart because a rising rate of the absence kind means truncation or misconfiguration rather than chain activity.
- **`checkTxInclusion`.** Whether the state you are about to render already accounts for a transaction, answered from the unconfirmed window and nothing else. An app laying an OPTIMISTIC update over indexed state needs it, because a non-idempotent update applied on top of state that already contains it is counted twice. The receipt cannot answer it: a reorg can re-include the same transaction in a different block.
- **The cached-stream seam.** `ExistingStream` plus `createSegmentedStream`, which turns a five-operation port into an append-only run of segments: one immutable segment per batch at the next ordinal, so a save costs its batch and not the history, and a write that would leave a HOLE is refused. [`@etherfold/browser`](https://github.com/wighawag/etherfold/tree/main/packages/browser) supplies the IndexedDB port.
- **Stream fixtures.** `captureStream` records a real chain's logs; `replayFixtureInto` plays them back through a processor and `replayStream` serves them as a read-only `StreamFixtureReader`, which is how the conformance workload replays 31,332 real logs with no node in sight. A fixture is deliberately NOT an `ExistingStream`: its events are decoded once at capture, while the keeper seam stores what the node said (ADR-0059).
- **Source identity.** A configuration change is answered with TWO verdicts and never one: does the cached STREAM survive it, and does the derived STATE. A renamed non-indexed parameter is the case that proves they differ, since `topic0` hashes types and not names, so the fetch is untouched and the decode is not. Per-event live block ranges (`RangedAbiEvent`) are what let an upgrade APPEND an event without invalidating either. See `CONTEXT.md` for the full vocabulary.

## What is deliberately not here

Storage of the derived state, in any form. A processor persists through its `StateStore`, which writes the sync cursor in the same transaction as the block it describes (ADR-0027); this package has had no persistence seam of its own since the `KeepState` family went with the free-form processor path (ADR-0037).

Logging goes through [`named-logs`](https://github.com/wighawag/named-logs) (`logs('@etherfold/core')`), never `console.*`, so a host decides what is printed.

## Tests

`pnpm --filter @etherfold/core test`, vitest.
