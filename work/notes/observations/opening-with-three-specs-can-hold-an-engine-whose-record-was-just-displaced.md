---
title: 'Opening a container with three specs on one stream can leave it holding an engine whose registry record was displaced mid-open'
slug: opening-with-three-specs-can-hold-an-engine-whose-record-was-just-displaced
observed: 2026-09-20
---

2026-09-20, noticed while restructuring `Indexer.open` into two phases for ADR-0088, and NOT verified by running it.

`open` registers each spec through `registry.create(wanted, {slot: 'successor'})`, and `successor` holds at most one: with three new generations on a fresh registry the first takes `canonical`, the second takes `successor`, and the third DISPLACES the second, deleting its row and its state (`replaceTheSuccessor` -> `dropReplaced`). `open` then builds an engine for every spec it was given, including the displaced one, so the container would hold a fold whose registry record no longer exists. `stopDriving` cannot remove it, because at that point nothing is held yet.

This predates the two-phase split and is unchanged by it (before, the second spec's engine was built and pushed, then deleted from the registry a moment later, which is the same end state). It is likely unreachable in the tab that motivated the ADR: `BROWSER_GENERATION_CAPS` is two generations, so a third registration meets the cap and is refused first. `openIndexer` takes an arbitrary `generations` list and core's caps are the caller's, so it looks reachable from `@etherfold/core` directly.

Seen at `packages/core/src/container.ts` (`open`, `registerGeneration`, `replaceTheSuccessor`). Out of scope for the task that noticed it, which narrows which generation FETCHES a stream and touches neither the slot rule nor the caps.
