---
'@etherfold/core': minor
---

`openIndexer` REFUSES an open whose own generation specs would displace one another, instead of holding an engine for a generation whose registry record it had just deleted.

`open` registers every spec into the `successor` slot before it builds any engine, and that slot holds at most one. With three distinct specs on a fresh registry the third displaced the second (its row and its state were deleted) while `open` still built an engine for it, so the container held a fold nothing in the registry named. Such an open now throws the new `OpenedSpecsDisplaceOneAnotherError`, naming both generations, BEFORE either is deleted: the earlier spec keeps its row, its slot and its state. A spec named twice still resolves to one generation, and a spec that replaces a successor an earlier session left pending still replaces it. The caps do not prevent it (the displaced record is dropped before the arriving one is created, so it reproduces under the browser's own caps); a browser tab is clear of it only because every browser host opens with one spec, while `openIndexer` takes several. See ADR-0084's amendment of 2026-09-26.

`EventProcessor.load` is now documented: it is handed the source the fold folds under and only that one, it may write (so it belongs to the advance path), and no cursor read goes through it. This documents what both containers already do, measured with a processor double that honours `source`; nothing about `load` changed.
