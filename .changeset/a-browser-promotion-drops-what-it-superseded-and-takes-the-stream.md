---
'@etherfold/core': minor
'@etherfold/browser': patch
---

**A promotion on the CHAIN-FACING container now FINISHES: the generation it superseded is discarded, and the stream changes hands in the same act** (ADR-0090, points 1 and 2).

Two things change on `Indexer` (the browser's container; the receiving container, the server and the CLI are untouched):

- **`dropOnPromotion` defaults to TRUE here.** It is a RUNTIME default, answered at this container's own constructor and passed to `resolvePromotionConfig` beside the policy, which still has no per-runtime default and must never grow one. A tab ships ONE processor, so the generation a promotion superseded is not un-promoted but absent from the build: it can never answer a read and never fetch, and keeping it spends the tightest caps in the system on a seat nothing can use. A drop takes the registry row and the state namespace, and NEVER the stream (ADR-0087).
- **The fetch duty moves with it.** Where the superseded generation FETCHED a stream the promoted one has been following, the promoted generation stops following and takes the stream (`IndexerGeneration.takeOverStream` swaps the read-only view for the keeper itself). That is safe at exactly this moment and at no other: under `on-catch-up` the promotion IS the event "the successor reached the incumbent's cursor", and under `immediate` the existing deferral has already waited for that same condition, so the new holder is provably at the writer's position and no append can be lost. There is still no continuous recomputation of who fetches (ADR-0044, amended).

**What this fixes:** a same-stream save loop in a browser tab. A developer editing a handler stays on one stream, so the drop was declined -- rightly, since dropping a stream's writer would have stranded its follower -- and the next save met `GenerationCapReachedError` with a generation no page reload could clear. Save, promote, save, promote, save now keeps working, with the caps unchanged and nothing evicted at the bound.

**The strand guard is NARROWED, not deleted.** It still declines wherever the hand-over cannot cover the case: where the fold that would fetch that stream next is not the one the promotion demonstrated anything about, and at every REGISTRATION, where nothing has reached any cursor at all.

`@etherfold/browser` carries no change of its own: it hosts this container, so the new behaviour arrives through it and its suites are what assert the save loop and the fetch duty end to end.

**If you embed this:** a promotion in a tab now discards what it superseded, so a same-session move BACK to it is gone (the way back in a browser was always to supply the old code, which derives the same identity and re-folds the stream already on disk). Pass `{promotion: {dropOnPromotion: false}}` to `openIndexer` / `createIndexerState` / `serveIndexerHost` to keep the old behaviour. `promotion` reports the resolved value, so a host reads what will actually happen.
