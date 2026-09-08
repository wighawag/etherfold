---
title: 'The fold packs blocks into round trips, instead of paying one per block'
slug: the-fold-packs-blocks-into-round-trips
taskedAfter: [measure-the-indexing-loop-before-optimising-it]
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

## Problem Statement

On a network-backed state store, the fold pays a round trip per BLOCK and a round trip per handler read, and nothing overlaps anything.

`applyEventStream` loops blocks; per block it runs the handlers, whose reads go through the seam to the store, and then calls `applyBlock`, which is one `batch()`. A block carries a median of 7 mutations. So against a remote SQL backend at 30ms RTT, a backfill spends a full round trip to write about 7 rows, plus a round trip for each handler read that the block's own staging area cannot answer, which on the real stratagems capture was roughly three quarters of them (16,871 of 66,113 served from staging).

The fix for the write half is already written and unreachable. `SQLiteStateStore.applyBlocks` packs blocks into batches via `planBatches`, and its own docstring states the thesis: "Backfill is bound by round-trips, not by SQLite work, so packing blocks is the difference that matters there." It is not on the `StateStore` interface and its only caller anywhere is its own unit test.

Two structural properties block simply wiring it up, and both encode correctness the project has already paid for: the cursor's atomicity contract, and read-your-writes being scoped to one block.

## Solution

Put block packing on the seam, widen the staging window so packing is safe, and batch the reads a block will make before its handlers run.

The read half needs no profiling machinery, which is the one place this project is better placed than the prior art: the fold holds the entire block's decoded events before any handler runs, and entity ids are derived from event args, so the candidate read set is computable directly rather than predicted from recorded history.

## User Stories

1. As an operator on a remote SQL backend, I want the fold to pack several blocks into one round trip, so that a backfill is not paying one network round trip per seven rows.

2. As an operator, I want the reads a block's handlers will make issued as ONE batched prefetch before the handlers run, so that a block with K distinct entity reads costs one round trip instead of K.

3. As a processor author, I want `update` not to pay a blocking read the store could have avoided, so that the most common write shape is not the most expensive one.

4. As a backend author, I want block packing to be ONE seam method with a usable default, so that implementing it costs a line rather than an optimisation project.

5. As an operator, I want a crash mid-pack to leave the cursor and the state agreeing on restart, so that packing cannot introduce the wedge the per-block cursor contract exists to prevent.

6. As a maintainer, I want the state produced at any pack size to be IDENTICAL to the state produced at pack size 1, so that the whole correctness claim is one assertion rather than an argument.

7. As a maintainer, I want the in-memory staging window's memory bounded and its bound observable, so that the trade is managed rather than discovered.

8. As a maintainer, I want every change here gated by the existing conformance suite and the reorg tests, so that a throughput win cannot buy speed with correctness.

9. As a maintainer, I want it stated which deployment each change serves, so that a benchmark from a server on remote SQL is never read as a claim about a browser on IndexedDB, where the cost is the storage write path rather than a network hop.

### Autonomy notes

Neither gate is set. The spec launched with two open questions and both are resolved: the staging window's bound is decided below as a provisional default the measurement tunes, and pipelining is dropped to Out of Scope rather than carried as a permanently-gated story.

`taskedAfter: [measure-the-indexing-loop-before-optimising-it]` is KEPT, but note what it does and does not mean. It is not that the fold work needs justifying: one network round trip per seven rows is indefensible whatever fraction of total time it turns out to be. It is that the measurement sets the staging default and orders this work against its siblings, and it is short. Drop the edge if you would rather build the two in parallel.

Stories 1 and 4 change the `StateStore` interface, which third-party backends implement and `-conformance` polices, so the changeset must describe it as breaking.

## Decided already

Two questions this spec launched with are settled, and are recorded here rather than left open.

**Block packing goes ON the seam, required, with a shared default implementation.** The seam has no optional methods today (`applyBlock` and `prune` have optional ARGUMENTS, not optional presence), and `StateStoreCapabilities` is used for behavioural variation such as `asOf` and retention, never for method presence. Making this optional would introduce both the first optional method and a second code path through the most correctness-critical loop in the project. The obligation on other backends is near-zero if a shared default helper loops `applyBlock`: correct, unoptimised, one line per backend. Conformance gains one case, that packing N blocks produces state identical to N single applications.

**The staging window is bounded in MUTATIONS, with a block count as a secondary valve, and it FLUSHES EARLY on overflow.** A block carries a median of 7 mutations but bursts to 457, so a block count alone is a 60x-variance proxy for memory and would either waste the window or blow it. On overflow the pack is flushed and a new one started, never refused: an early flush is only LESS PACKING, and less packing is never wrong.

Provisional defaults, chosen to be obviously safe rather than optimal: **2,000 mutations or 64 blocks, whichever binds first.** At the median the block cap binds in the ordinary case and the mutation cap catches a burst.

What makes it safe to fix a number now rather than waiting: **story 6 pins correctness independently of the bound.** State produced at any pack size must be IDENTICAL to state produced at pack size 1, so the bound is pure tuning. A wrong value costs throughput or memory and can never cost correctness, which is exactly the property that turns this from a blocking design question into a default the measurement later adjusts. Any task building this should treat the numbers as placeholders and say so in the code.

**Every block carries its OWN cursor, and the cursor write joins that block's statement group.** One cursor for the whole pack is UNSAFE, and this is the subtle part: `planBatches` emits MULTIPLE batches, so blocks can land in batch 1 while a single trailing cursor rides batch 3. A crash between them leaves state ahead of the cursor, and `cursor.ts` is explicit about the cost: the restart replays a block the store already holds, `applyBlock` refuses it as the caller bug it normally is, and the indexer wedges until a human intervenes. Not self-healing. With the cursor riding its own block's statements, batch boundaries stop mattering and last-write-wins within a batch is correct. `applyEventStream` already computes a per-block cursor for every non-final block; the packing entry point simply does not take it today.

## Out of Scope

- **The measurement itself.** `measure-the-indexing-loop-before-optimising-it`, which this spec is `taskedAfter`.
- **The fetcher's round trips and range hints.** `the-fetcher-reads-the-hints-providers-already-send`, independent and not blocked by anything here.
- **Deleting the per-hash enrichment loop.** Owned by `etherfold-is-a-fold-over-logs` and already tasked. Deleting that loop is strictly better than parallelising it, so no story here proposes making it concurrent.
- **Coalescing a row's versions across blocks.** Versioned rows must emit one version per block per entity or as-of reads between those blocks stop answering. Staging saves ROUND TRIPS, never rows.
- **Pipelining cycle N+1's fetch against cycle N's fold.** It was story 8 and it is REMOVED rather than deferred, because a permanently-gated story inside an otherwise committed spec is the mis-scope `TASKING-PROTOCOL` 2a exists to catch. It has the largest blast radius of anything considered here and its value is entirely conditional on the two halves being comparably expensive: if one dominates by an order of magnitude, overlapping them buys almost nothing. The measurement's build plan (`measure-the-indexing-loop-before-optimising-it`, story 9) is where it gets re-proposed WITH A NUMBER, and the rough trigger to look for is the two halves landing within about 3x of each other. Recorded here so it is a decision rather than an omission.

- **Multi-threading the fold.** Plausibly right eventually, much larger than anything here, and every item in this spec is a prerequisite for knowing whether it would help.
- **Out-of-order or concurrent handler execution driven by static analysis of processor code.** Ponder built this, suffered repeated regressions, called it complex and fragile, and deleted it. Our position is worse on that axis because the handler seam is public API and a processor is meant to run unchanged in a tab and on a server. Event order is a guarantee we keep.
