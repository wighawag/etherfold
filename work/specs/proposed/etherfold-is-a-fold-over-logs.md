---
title: 'Etherfold is a fold over logs, and eth_getLogs is the only data call it makes'
slug: etherfold-is-a-fold-over-logs
needsAnswers: true
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

<!-- open-questions -->
<!--
  TRANSIENT BLOCK, stripped by the apply rung on full resolution.
  The RELEASE question that used to be first is DECIDED and has moved into Implementation
  Decisions ("The minimum EDR version is stated and enforced"). All three below are policy.
-->

## Open questions

1. **When a log arrives with no `blockTimestamp`, where does the refusal happen?** Today `blockPointer` in `@etherfold/processor-entities` already refuses, at FOLD time, naming the block. Refusing at FETCH time instead names the NODE, which is the actual thing that is wrong, and fails one round trip in rather than after a whole range has been fetched and stored. Refusing at fold time keeps the check where the requirement is (a processor that never records a time axis arguably does not need one). Pick one, or state deliberately that both exist and why.

2. **Is `alwaysFetchTransactions` deleted, or deprecated for one release first?** Unlike timestamps this has NO replacement (see below), so deleting it removes a capability rather than moving it. Nothing in `examples/`, `platforms/` or `docs/` sets it and no processor in the repo reads `event.transaction`, so the known blast radius is zero, but the package is published and the flag is in the public type. A deprecation window costs one release and buys a signal from anyone actually using it.

3. **Does anything want `providerSupportsETHBatch` to survive?** Its only readers are the two fetchers this spec deletes, so it dies with them and the engine stops having an opinion about batch support at all. ADR-0002 explicitly records "Batch RPC IS allowed" as a correction to an earlier framing, so removing the flag needs that ADR's consequence updated rather than silently contradicted. If a future prefetch mechanism (the `extra` field sketched in `indexer.ts`) would want it back, say so now.

<!-- /open-questions -->

## Problem Statement

Etherfold describes itself as an engine that folds logs, and it very nearly is one. But two optional stream-config flags, `alwaysFetchTimestamps` and `alwaysFetchTransactions`, are the sole reason the engine ever calls anything other than `eth_getLogs`, and they cost far more than their size suggests:

- They are the ONLY callers of `eth_getBlockByHash` and `eth_getTransactionByHash` in the whole engine, and both are fetched **one hash at a time in a `for` loop** unless the provider advertises batch support. On a range with many event-bearing blocks that is the dominant cost of the cycle, and it is the exact shape of Ponder's issue #1907.
- They exist in TWO deployment shapes that must honour them identically (`IndexerGeneration` and the split `LogFetcher`), which is why `enrichEvents` was factored out in the first place. Two call sites, one shared helper, a block-timestamp cache bounded by the reorg window, and a `providerSupportsETHBatch` flag threaded through both: all of it exists to serve two booleans.
- They are hashed into the STREAM IDENTITY (`streamDigestOf`), because they change what is stored. So they are not merely a runtime option; they are part of the addressing scheme, and every reader of that digest has to reason about them.
- They put an optional `blockTimestamp` and an optional `transaction` on the processor-facing event type, so every processor author sees two fields that may or may not be populated depending on a config they did not set.

**The justification for the timestamp half has now expired.** `blockTimestamp` on the log was standardised in `ethereum/execution-apis#639` and served by geth, reth, besu, erigon, anvil and ethereumjs. The README, ADR-0002 and the `blockPointer` refusal message all name the same single holdout as the reason the fallback stays: Hardhat's EDR. That gap is closed. `NomicFoundation/edr#1644` merged on 2026-08-26 and added `blockTimestamp` to both `FullBlockLog` and `LogOutput` (the wire type behind `eth_getLogs`), closing `#1643`. Three documents in this repo now assert a fact that is no longer true.

**The justification for the transaction half never was a fallback at all.** `from`, `gasUsed` and `effectiveGasPrice` are not on a log, there is no standard proposing to put them there, and there will not be one. So `alwaysFetchTransactions` is not a compatibility shim awaiting obsolescence; it is a permanent second data source, of exactly the kind the README's own Caveats section tells processor authors not to use: "anything that needs an extra request per block or per transaction is expensive in the browser, so indexer processors are expected to not make use of such features."

## Solution

Delete both, and make the claim explicit rather than aspirational: **the engine reads logs and nothing else.** After this, the entire chain-facing surface of `@etherfold/core` is `eth_getLogs`, plus `eth_blockNumber` for the tip and `eth_chainId` for the identity guard. There is no configuration that can make it call anything else, so there is nothing to reason about, nothing to hash into the identity for it, and no per-block or per-transaction cost that any deployment can accidentally opt into.

The timestamp axis survives intact, unconditionally and for free, because the node now puts it on the log. What changes is that a node which does not serve it is REFUSED rather than silently compensated for at a cost the operator did not choose. That refusal already exists in `blockPointer`; this spec removes the escape hatch its message currently recommends, and moves the check to wherever question 1 decides.

The transaction data does not survive. That is a capability removal and is presented as one.

## User Stories

1. As a processor author, I want `event.blockTimestamp` to be present always and without configuration, so that the time axis is a property of the engine rather than a flag I have to know to set.

2. As an operator, I want a node that does not serve `blockTimestamp` on logs to be refused with a message naming the node and the standard it does not implement, so that I fix my endpoint instead of silently paying for an extra request per block.

3. As an operator, I want no configuration anywhere that can cause a per-block or per-transaction request, so that the cost of a cycle is a function of the range and the log volume alone.

4. As a browser deployment, I want the engine's provider surface to be small enough to state in one sentence, so that the EIP-1193-only claim of ADR-0002 is checkable rather than approximately true.

5. As a maintainer, I want `enrichEvents`, `blockFetcherFor`, `transactionFetcherFor`, the block-timestamp cache and `providerSupportsETHBatch` gone, so that the two deployment shapes of ADR-0003 have one less shared obligation to keep in sync.

6. As a maintainer, I want the stream config to shrink to `{finality, parse}`, so that the identity digest covers fewer things and the two flags stop being part of the addressing scheme.

7. As an existing deployment that never set either flag, I want my stream identity to be UNCHANGED by this, so that upgrading does not fork a new stream and re-fetch my entire history.

8. As an existing deployment that DID set a flag, I want the digest change to be loud and the migration documented, so that a re-fetch is something I chose rather than something I discovered.

9. As a reader of the docs, I want the README caveat, ADR-0002's consequence paragraph and the `blockPointer` refusal message to stop naming a gap that is closed, so that three documents do not assert a stale external fact. (Landed already, ahead of this spec, as a pure factual correction that deletes nothing.)

10. As a maintainer, I want the thesis stated with its real scope ("every log the node's index returns"), so that the bloom-omission case does not turn a documented limitation into a broken promise.

11. As a Hardhat user on a version that bundles an older EDR, I want the requirement stated against the EDR VERSION with the override snippet beside it, so that I can satisfy it today instead of waiting for a Hardhat release.

12. As an operator, I want the refusal to name the likely CAUSE (an old node, a Hardhat bundling an older EDR, a forked node predating the change, or a stale EDR RPC cache) and not merely the missing field, so that I can act on it without reading the spec that produced it.

### Autonomy notes

`needsAnswers` IS set, and all three remaining questions are policy rather than fact: where a refusal lives, whether a public flag gets a deprecation window, and whether a config flag has a future constituency. None is hard, and none of them blocks the other work in the spec, so an answering pass should be quick.

The question that DID gate the whole spec, whether the replacement had actually shipped, is answered and recorded below rather than here.

`humanOnly` is NOT set, but note story 8: this is a BREAKING change to a published package and the changeset needs to say so.

## Implementation Decisions

### The two halves are decided separately, and only one of them is a swap

**Timestamps: a swap.** The replacement is strictly better (zero requests instead of one per event-bearing block), it is already the primary path in the code, and the fallback fires only when the field is absent. Deleting the fallback changes behaviour only against a node that does not serve the field, and the answer for that node is to refuse.

**Transactions: a removal.** There is no replacement and this spec does not invent one. If a processor genuinely needs `from` or `gasUsed`, the honest answers are outside the engine: index a chain whose events carry what you need, or run something that is not a browser-first log folder. Pretending otherwise is what produced a per-transaction round trip inside an engine whose stated constraint forbids exactly that.

Bundling them in one spec is deliberate: they are one deletion in the code (`enrichEvents` and everything under it), and separating them would leave the machinery standing for one flag.

### The minimum EDR version is stated and enforced, and the Hardhat lag is NOT a blocker

DECIDED: ship the deletion, state a minimum node requirement, and refuse below it. The alternative of waiting for a Hardhat release is rejected, and the reason it can be rejected is the part worth writing down, because the release table alone looks like it forbids this.

The facts, verified 2026-09-08. `NomicFoundation/edr#1644` (closing `#1643`) merged 2026-08-26 and released in **`@nomicfoundation/edr@0.20.0` on 2026-09-02**. No released Hardhat bundles it: 3.16.0 ships edr 0.19.0, and the preceding releases track 0.14.2 / 0.15.0 / 0.15.0 / 0.17.0 / 0.19.0. Read naively that says a Hardhat user is stuck until Nomic bumps, on a schedule this project does not control.

**It does not, because EDR is an ordinary npm dependency and its version is overridable.** A Hardhat 3.16.0 project can pull edr 0.20.0 with a package-manager override (`pnpm.overrides` in `package.json`, npm `overrides`, yarn `resolutions`), so the requirement this spec imposes is on the EDR VERSION RESOLVED, never on the Hardhat version. That turns a dependency on someone else's release schedule into a documented one-line workaround, which is a cost a user can pay today rather than a wait they cannot shorten.

So the stated requirement is **`@nomicfoundation/edr >= 0.20.0`**, expressed against EDR and not against Hardhat, and the docs carry the override snippet next to it.

Two honest caveats to carry with that advice rather than to bury:

- **An override forces a combination the host did not ship or test.** Judging the risk needs the actual delta, so state it rather than hand-waving: 0.20.0's breaking-flavoured changes are narrow (interval-mining now rejects `[0, 0]` and `min > max` ranges it could never honour, and `InlineConfigDirectiveError.function` widened to `string | undefined`), and the Base chain-config removal landed earlier in 0.19.0 which Hardhat 3.16.0 already ships. So a 0.19.0 to 0.20.0 override looks low-risk on the published notes, and "looks low-risk" is the honest strength of that claim. The docs should say verify it in your project, not that it just works.
- **The requirement is not only about versions.** Two paths yield a timestamp-less log even against edr 0.20.0, and neither improves with time: a node being FORKED may predate the spec change (the field is `Option<u64>` exactly so a missing timestamp stays distinguishable from a real one, and EDR's release note is explicit that it is passed through rather than defaulted), and EDR's on-disk RPC response cache had to be version-segmented to `rpc_cache/v2`, so a cache written before the change keeps answering without the field until that directory is dropped. This is why the refusal of question 1 is PERMANENT machinery rather than a transitional guard, and why its message must name the likely cause rather than only the missing field.

### The identity property that makes this cheap, and which must be verified before anything is deleted

`resolveStreamConfig` omits keys whose value is `undefined` (asserted today: `Object.keys(resolveStreamConfig({alwaysFetchTimestamps: undefined}))` equals `['finality']`), and the digest is taken over the resolved config's canonical bytes. `streamIdentity.test.ts` already asserts `digestOf(SOURCE, {alwaysFetchTransactions: undefined})` equals `digestOf(SOURCE)`.

So for **every deployment that never set either flag, removing the fields is digest-neutral**: same resolved config, same bytes, same digest, no stream fork, no re-fetch of history. Only a deployment that explicitly set one sees its digest move, and that deployment is the one being asked to migrate anyway.

This is the single most important property in the spec and it is the first thing a task should confirm still holds, because if it does not, an innocuous-looking deletion silently orphans every stored stream in existence.

### What is deleted

The whole `enrichEvents` path: the function, `blockFetcherFor`, `transactionFetcherFor`, `getBlockData` / `getTransactionData` and their multi-hash variants, `BlockTimestampCache` and its reorg-window pruning, the `getBlocks` / `getTransactions` bound methods on the indexer, the corresponding calls in `LogFetcher`, `providerSupportsETHBatch` (question 3), the two `ProvidedStreamConfig` fields, and `transaction?: LogTransactionData` from the event type.

`blockTimestamp?: number` STAYS on the event type and stays optional at the type level, because the wire genuinely does not guarantee it; what goes is the machinery that compensated for its absence. Whether the optionality is then narrowed at a boundary is question 1.

### What must NOT be deleted with it

`normalizeBlockTimestamp` and the hex/decimal quantity handling in `LogEventFetcher`: reading the field off the log is the surviving path, and it has to keep tolerating both encodings and an absent field without inventing a value. The existing refusal to guess (`blockPointer`: "a wrong timestamp breaks the time axis silently") is the behaviour this spec strengthens, not the behaviour it removes.

### Scope of the claim, stated honestly

"A fold over logs" is a claim about the ENGINE's calls, not a guarantee about completeness of the chain's logs. `work/notes/findings/what-nodes-answer-when-a-getlogs-range-is-too-big.md` records a captured case (Polygon state-sync logs) where a node's `eth_getLogs` omits logs that its own `eth_getTransactionReceipt` returns, with no error and no signal, because they are not committed to the block's `logsBloom`. The documented claim is therefore "every log the node's log index contains", and the receipt-based remedy is named as out of scope for the reason the README already gives about per-transaction cost. Better to write the boundary down now than to have a Polygon user discover it as a bug in the fold.

## Testing Decisions

- **The digest-neutrality test comes first and is the gate**: for a config that sets neither flag, the stream digest before and after the deletion is byte-identical. Assert against a recorded digest value, not against a re-computation, so the test cannot pass by both sides changing together.
- **A stored stream written before the change loads after it**, with no fork and no clear, for the never-set-a-flag case. This is the real-world version of the above and it is what protects existing users.
- **A node that does not serve `blockTimestamp` is refused**, with the refusal asserted on its message naming the standard AND the minimum EDR version, and asserted at whichever boundary question 1 picks.
- **A node that serves it is unaffected**: the existing `blockTimestampFromLog.test.ts` case "keeps the log timestamp even without `alwaysFetchTimestamps`, for free" is the one that should survive essentially unchanged, since it already describes the post-deletion world.
- **No test may use a fake provider that answers `eth_getBlockByHash`**, after the change, for the fold path. A test double that still offers the method would let a reintroduced call pass unnoticed; better, assert that the provider is never asked for anything outside the allowed method set. That assertion is the durable guard for this whole spec and is worth more than any individual deletion test.
- The conformance-workload-stratagems test currently sets `{finality: 12, alwaysFetchTimestamps: true}` and will need its fixture logs to carry `blockTimestamp` instead.

## Out of Scope

- **Any replacement for transaction data.** Named as removed, not migrated. The `extra` / prefetch sketch in `indexer.ts` is a different mechanism with different problems (it versions the stream and a version bump means re-indexing from scratch) and is not opened here.
- **The receipt-based path** that would recover bloom-omitted logs. It is a per-transaction cost, which is the thing this spec exists to remove.
- **The `eth_chainId` and `eth_blockNumber` calls.** They are identity and tip, not data, and `work/specs/proposed/the-indexing-loop-is-round-trip-bound.md` owns whether they can be reduced.
- **Making the fetcher smarter about range caps.** Same neighbouring spec, informed by the same finding.

## Further Notes

**On the timing, which is the strongest argument for doing this now.** Every item here is a breaking change to a published type or to the identity digest. The digest-neutrality property above means the change is nearly free TODAY, for everyone who never set a flag. It stays free only while the set of deployments that DID set one is small, and that set can only grow after publication. This is the cheapest this deletion will ever be.

**On the pleasing symmetry of the gating fact.** The README's caveat, ADR-0002's consequence and `blockPointer`'s error message all name Hardhat's EDR as the reason the fallback survives. That gap was closed by `NomicFoundation/edr#1644`, which was authored from this project's own maintainer account and merged on 2026-08-26. The blocker was removed upstream by the person blocked by it, and this spec is the downstream half of that work: the fallback was built for one node, that node now serves the field, so the fallback has no remaining constituency.
