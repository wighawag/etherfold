---
'@etherfold/core': minor
'@etherfold/server': minor
---

A processor upgrade costs a LOCAL SCAN: a successor catches up by REPLAYING the stored emission stream, in bounded chunks against a durable checkpoint, and the canonical pointer moves once at the end.

**`GenerationRebuild` (`@etherfold/core`, `generation/rebuild.ts`) is the driver**, and it is platform-neutral: a Node cron, a CLI loop, a browser idle callback and a Cloudflare queue can each drive it. One call does a bounded amount of work and REPORTS whether it finished, which is the shape `prune` and `compactEmissionPairs` already have (ADR-0022) — never a side effect of a write.

```ts
const [report] = await indexer.rebuildMore({maxEmissions: 500});
// {generation, fromBlock, toBlock, scanned, replayed, retracted, highWater, complete, absent}
while (!report.complete) {
	/* re-invoke; a serverless host enqueues itself instead of looping */
}
```

**The CHECKPOINT is the successor's own sync cursor, and there is no second durable value.** A chunk is applied through `EventProcessor.process`, which persists the `LastSync` describing each block in the SAME transaction as that block (ADR-0027), so "the state and the checkpoint commit together" is the guarantee the storage seam already makes rather than one this driver arranges. `GenerationRebuild` holds NO position between calls: a new process, a new isolate or a new container over the same database resumes from what the store committed.

**A chunk is a budget in EMISSIONS, cut on a BLOCK boundary, and always ending ABOVE the fold's own position (ADR-0056).** The stored stream is `seq`-ordered and a reorg puts an application, its retraction and its replacement at ONE block at arbitrarily separated `seq` values, so a chunk ending mid-block would leave rows below its own resume point and skip them for ever. And a resume point REACHES BACK over the reorg window, so a budget spent inside blocks the fold already covers would cut the chunk where the fold already is and the same chunk would be asked for for ever — hence `ReplayChunkQuery.foldedThrough`. The budget is therefore advisory in those two places, both bounded by something else, and `RebuildReport.scanned` says how many rows were really read. `DEFAULT_MAX_EMISSIONS_PER_CHUNK` is 2000.

**"Caught up" is measured against the stream's own COVERAGE CLAIM**, which moves on every batch including the quiet ones (ADR-0055), and therefore in the same space the promotion trigger already compares in. The emission `seq` high-water is READ and REPORTED on every chunk (`RebuildReport.highWater`) as the honest size of what is being folded, but it is not the predicate: see ADR-0056 for why it cannot be one without a second durable checkpoint.

**`storedEmissionReplaySource` (`@etherfold/server`) is the read it consumes**: the same `_emissions` rows as `storedEmissionStream`, in bounded slices, over the coverage claim (ADR-0055) so a fold resumes past a quiet range rather than at its last log. It is read-only by construction — the port has no write on it at all — which is the one-writer rule (ADR-0044) as a type rather than as a no-op.

**`ReceivingIndexer` now DETERMINES follower-or-receiver from the stream, and never from a flag** (ADR-0044). A fold on a stream the container already holds is a FOLLOWER: no receiver (a stream is ONE address on the wire), a `GenerationRebuild` instead, and `HeldFold.follows` reports it. `ReceivingIndexerOptions.replay` supplies the stream to re-fold, and a container given none REFUSES such a fold rather than registering a generation that could never advance. `HeldFold.ingestion` is consequently optional; `liveIngestions()` is unchanged for callers, and `ReceivingIndexer.ingestion` still answers for the fold a host opened with.

**The pointer moves ONCE, at the end, and the generation left behind is RETAINED.** `ReceivingIndexer` applies the promotion policy (`promotion`, defaulting to `on-catch-up` with nothing dropped, as in every runtime) and exposes `promote(id)`, which no policy value gates. The TRIGGER is lifted rather than copied: `readyForPromotion` and `promotionOnAdd` are new exports of `generation/promotion.ts` and both containers now go through them, so there is one answer to "when does the pointer move on its own". `immediate` together with `dropOnPromotion` is REFUSED on this runtime, because the deferred drop that setting requires is not built here and accepting it would discard a complete state for one that has proved nothing.

**`batchStreamForDelivery` (internal) is the delivery cut, now shared by the engine and the rebuild.** A replayed stream can carry an application, its retraction and the replacement at one block; handing all three to a single `process()` call reverts to the fork and then applies two blocks at the same height, which is a primary-key collision and not a fold. `IndexerGeneration.promiseToFeed` keeps its notifications, cancellation window and pacing and now takes the cut from this one function.
