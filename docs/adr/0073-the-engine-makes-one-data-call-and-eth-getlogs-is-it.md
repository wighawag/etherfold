---
status: accepted, not yet implemented
---

# The engine makes ONE data call, and `eth_getLogs` is it

`alwaysFetchTimestamps` and `alwaysFetchTransactions` are deleted, with the whole `enrichEvents` path under them. After this the engine's entire chain-facing surface is `eth_getLogs` for data, `eth_blockNumber` for the tip and `eth_chainId` for the identity guard, and no configuration can make it call anything else.

Decided now rather than after publication because the deletion is nearly free TODAY and gets more expensive every day (see "the identity property" below). `accepted, not yet implemented`: the tasks are staged, and nothing here ships in the change that records it.

## Why the two flags were not one decision

They look symmetric and are not, which is the thing worth writing down.

**Timestamps were a fallback for a gap that has closed.** `blockTimestamp` on the log is `ethereum/execution-apis#639`, served by geth >= 1.16.0, reth, besu, erigon, anvil and ethereumjs. The one implementation that did not serve it was Hardhat's EDR, which is why the README, ADR-0002, `blockPointer`'s refusal and the `blockTimestamp?` docstring all named it. `NomicFoundation/edr#1644` closed that, released in `@nomicfoundation/edr@0.20.0` on 2026-09-02. So the fallback has no remaining constituency: there is a replacement, it is strictly better (zero requests instead of one per event-bearing block), and it is already the primary path in the code.

**Transactions never were a fallback.** `from`, `gasUsed` and `effectiveGasPrice` are not on a log, no standard proposes putting them there, and none will. `alwaysFetchTransactions` was therefore a permanent second data source of exactly the kind ADR-0002's consequences forbid, and the README's own Caveats section tells processor authors not to use: "anything that needs an extra request per block or per transaction is expensive in the browser". Deleting it REMOVES A CAPABILITY, and that is stated rather than dressed as a migration. If a processor genuinely needs `from`, the honest answers are outside this engine.

They are deleted together because they are one deletion in the code. `enrichEvents` exists to serve both, and keeping either leaves the whole machinery standing: the per-hash fetch loops, the block-timestamp cache, the `providerSupportsETHBatch` flag, and the obligation on BOTH deployment shapes of ADR-0003 to honour the flags identically.

## The requirement is on the EDR VERSION, never on the Hardhat version

Ship the deletion and require `@nomicfoundation/edr >= 0.20.0`. Waiting for a Hardhat release was rejected, and the reason it COULD be rejected is the part that is not obvious from the release table.

No released Hardhat bundles it (3.16.0 ships edr 0.19.0), which reads like a dependency on Nomic's schedule. It is not: EDR is an ordinary npm dependency, so a project pulls it forward with a package-manager override (`pnpm.overrides`, npm `overrides`, yarn `resolutions`). Stating the requirement against the resolved EDR version turns an unbounded wait into a documented one-line workaround. An override does force a combination Hardhat did not test, so the docs say verify it rather than that it just works; the published 0.19 to 0.20 delta is narrow (interval-mining validation, one widened error field).

## The refusal is PERMANENT machinery, and it lives in two places

A log with no `blockTimestamp` stays reachable at any version, by two paths that do not improve with time: a node being FORKED may predate the spec change (EDR types the field `Option<u64>` precisely so a missing timestamp stays distinguishable from a real one, and passes it through rather than defaulting it), and EDR's on-disk RPC response cache is version-segmented, so entries written before the change keep answering without the field. So the refusal is not a transitional guard and must not be built as one.

It refuses in TWO places, deliberately, because there are two entry points:

- **At the fetch boundary**, naming the NODE. Every cause is node-level (an old node, a Hardhat bundling an older EDR, a forked node, a stale RPC cache), so the node is what an operator can act on, and it fails one round trip in rather than after a range has been fetched and stored.
- **At the fold**, in `blockPointer`, naming the BLOCK. This one cannot be dropped in favour of the first, because **a stream can reach the fold without passing the fetcher at all**: ADR-0063's seed install writes through the keeper seam, and a fixture reader (ADR-0059) replays a captured stream. A fetch-boundary check would never see either.

Neither guesses. A zero or interpolated timestamp does not fail, it answers confidently about the wrong block for as long as the store lives, and an as-of read has no way to tell a caller it was lied to.

## The identity property that makes this cheap, and that decides the timing

`resolveStreamConfig` omits keys whose value is `undefined`, and the stream digest is taken over the resolved config's canonical bytes. `streamIdentity.test.ts` already asserts that an absent flag leaves the digest unchanged.

So for **every deployment that never set either flag, removing the fields is digest-neutral**: same resolved config, same bytes, same digest, no stream fork, no re-fetch of history. Only a deployment that explicitly set one sees its digest move, and that deployment is the one being asked to migrate anyway.

That property is the whole timing argument. It holds only while the set of flag-setting deployments is small, and that set can only grow after publication. `@etherfold/core@0.7.0` went out on 2026-08-26, so the window is open and closing. It is also the first thing any implementing task must re-confirm, because if it has stopped holding, an innocuous-looking deletion silently orphans every stored stream in existence.

## What the claim does NOT mean

"A fold over logs" is a claim about the ENGINE's calls. It is NOT a guarantee that the fold sees every log on the chain, and the difference is real rather than pedantic. `eth_getLogs` is generally served from a `logsBloom`-derived index, so a log the bloom does not commit to is omitted with no error and nothing in the response signalling it: on Polygon block 74,614,768 an archive endpoint returned 848 logs where the same node's `eth_getTransactionReceipt` returned 8 more (`work/notes/findings/what-nodes-answer-when-a-getlogs-range-is-too-big.md`).

That meets ADR-0004 at its weakest point, since an absence there is an INFERENCE that reverts state, and a bloom-omitted log is a stable absence rather than a flapping one, so it is undetectable rather than noisy. The documented claim is therefore "every log the node's log index contains". The only known remedy is a receipt-based path, which is the per-transaction cost this ADR exists to remove, so it is out of scope by the same argument that motivates the decision.

## Consequences

- `providerSupportsETHBatch` is deleted with the fetchers it served, and its reach is wider than the engine: `@etherfold/fetcher-host` carries it and `platforms/nodejs-fetcher` documents `PROVIDER_SUPPORTS_ETH_BATCH` as a deployment environment variable, so this removes a documented operator knob from published packages rather than an internal flag. **ADR-0002's consequence bullet asserting "Batch RPC IS allowed (`providerSupportsETHBatch`)" becomes false and is updated in the same change.**
- `ProvidedStreamConfig` shrinks to `{finality, parse}`, so the identity digest covers less.
- `transaction?: LogTransactionData` leaves the processor-facing event type. `blockTimestamp?: number` STAYS and stays optional at the type level, because the wire genuinely does not guarantee it; what goes is the machinery that compensated for its absence.
- `alwaysFetchTransactions` is deleted outright, with no deprecation window and no migration path. The packages are published, but **backward compatibility with what has already been released is explicitly not an obligation of this project at its current stage**, so the question of a window does not arise and no consumer is being preserved. The changeset still describes the removal plainly, because a changeset is a factual record of what changed rather than a compatibility promise.
- `normalizeBlockTimestamp` and the hex/decimal quantity tolerance in `LogEventFetcher` are NOT deleted: reading the field off the log is the surviving path.
