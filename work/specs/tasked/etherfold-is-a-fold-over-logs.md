---
title: 'Etherfold is a fold over logs, and eth_getLogs is the only data call it makes'
slug: etherfold-is-a-fold-over-logs
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **TASKED.** The technical detail that was here has moved: WHAT to build is in the tasks (`spec: etherfold-is-a-fold-over-logs`), and the durable WHY is `docs/adr/0073-the-engine-makes-one-data-call-and-eth-getlogs-is-it.md`, which also records the three questions this spec launched with and how they were answered (where the refusal lives, no deprecation window, `providerSupportsETHBatch` goes).

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

7. As a maintainer, I want to KNOW whether removing a stream-config field moves the stream digest, so that a full re-index is something recorded rather than something discovered while debugging.

8. ~~As an existing deployment that DID set a flag, I want the digest change to be loud and the migration documented.~~ **WITHDRAWN.** Backward compatibility with what has already been released is not an obligation of this project at its current stage, so there is no migration to document and no consumer to preserve. Story 7 survives in weakened form (know the answer, do not engineer around it) for the practical reason that an unexplained re-index is confusing, not for a compatibility reason. Numbering is kept so `covers:` references stay stable.

9. As a reader of the docs, I want the README caveat, ADR-0002's consequence paragraph and the `blockPointer` refusal message to stop naming a gap that is closed, so that three documents do not assert a stale external fact. (Landed already, ahead of this spec, as a pure factual correction that deletes nothing.)

10. As a maintainer, I want the thesis stated with its real scope ("every log the node's index returns"), so that the bloom-omission case does not turn a documented limitation into a broken promise.

11. As a Hardhat user on a version that bundles an older EDR, I want the requirement stated against the EDR VERSION with the override snippet beside it, so that I can satisfy it today instead of waiting for a Hardhat release.

12. As an operator, I want the refusal to name the likely CAUSE (an old node, a Hardhat bundling an older EDR, a forked node predating the change, or a stale EDR RPC cache) and not merely the missing field, so that I can act on it without reading the spec that produced it.

### Autonomy notes

Launched with three policy questions and `needsAnswers: true`; all three are answered and the flag is cleared. `humanOnly` is NOT set. Note that this is a BREAKING change to published packages, so the changeset must say so.

`humanOnly` is NOT set, but note story 8: this is a BREAKING change to a published package and the changeset needs to say so.

## Out of Scope

- **Any replacement for transaction data.** Named as removed, not migrated. The `extra` / prefetch sketch in `indexer.ts` is a different mechanism with different problems (it versions the stream and a version bump means re-indexing from scratch) and is not opened here.
- **The receipt-based path** that would recover bloom-omitted logs. It is a per-transaction cost, which is the thing this spec exists to remove.
- **The `eth_chainId` and `eth_blockNumber` calls.** They are identity and tip, not data, and `work/specs/proposed/the-indexing-loop-is-round-trip-bound.md` owns whether they can be reduced.
- **Making the fetcher smarter about range caps.** Same neighbouring spec, informed by the same finding.

## Further Notes

**On the timing, which is the strongest argument for doing this now.** Every item here is a breaking change to a published type or to the identity digest. The digest-neutrality property above means the change is nearly free TODAY, for everyone who never set a flag. It stays free only while the set of deployments that DID set one is small, and that set can only grow after publication. This is the cheapest this deletion will ever be.

**On the pleasing symmetry of the gating fact.** The README's caveat, ADR-0002's consequence and `blockPointer`'s error message all name Hardhat's EDR as the reason the fallback survives. That gap was closed by `NomicFoundation/edr#1644`, which was authored from this project's own maintainer account and merged on 2026-08-26. The blocker was removed upstream by the person blocked by it, and this spec is the downstream half of that work: the fallback was built for one node, that node now serves the field, so the fallback has no remaining constituency.
