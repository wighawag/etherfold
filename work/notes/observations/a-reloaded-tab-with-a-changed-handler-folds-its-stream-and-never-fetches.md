---
title: 'A reloaded TAB with a changed handler becomes a follower of its own stream and never fetches, and the test that should catch it supplies code no app has'
slug: a-reloaded-tab-with-a-changed-handler-folds-its-stream-and-never-fetches
observed: 2026-09-20
---

2026-09-20 — Read off the code while reviewing `whoever-fetches-a-stream-writes-it-and-the-stream-outlives-every-fold` (ADR-0087), whose builder flagged the shape in its `## Decisions` and correctly declined to fix it there. **Not measured end to end.** The mechanism below is traced through the source; the last step (that a real reloaded tab makes zero chain reads) has NOT been run. Reproduce it before building anything.

ADR-0087 moved the FETCH off the generation on the receiving side (`run`, `build`, the server). It deliberately did not touch the chain-facing `Indexer` the browser runs, and ADR-0087's Consequences name only `run` and `build`. On that container the thing that fetches a stream genuinely IS a generation, which is ADR-0044's follower rule and is untouched. So the decision does not apply there as written — but **the defect class it exists to close appears to be reachable there, in the ordinary path.**

## The mechanism

1. `Indexer.add` derives `const follows = !!fetcher && !sameGeneration(fetcher, record)` where `fetcher` is `fetcherOf(...)` — the OLDEST surviving generation registered on the stream (`packages/core/src/container.ts`). That derivation is correct and is ADR-0071's fix; it is not what is wrong here.
2. `Indexer.indexMore()` advances each held entry by `entry.follows ? followMore() : indexMore()`. A follower re-folds the stored stream and fetches NOTHING. **So if every held entry is a follower, the container never fetches.**
3. A browser tab always opens holding exactly ONE fold. Both real entry points construct the container with a single-element list: `IndexerState.ts` (`generations: [generationSpecFor(...)]`) and `host/serve.ts` (`generations: [generationSpecOf(spec, recordState)]`).
4. Reload a tab after its handler code changed. Identity is derived from the code (ADR-0086), so this is a NEW generation, registered into `successor` beside the previous session's generation, which survives as `canonical` and is OLDER.
5. `fetcherOf` therefore names the PREVIOUS generation — which this tab holds no fold for, because the old handler's code is not in the new bundle. The tab's single fold is a FOLLOWER of a stream nothing in this process fetches.

The tab then re-folds the stored stream to wherever the previous session left it, is promoted on catch-up, answers reads, and reports healthy — with a UI attached to it and nothing about it looking wrong. That is the same silent failure ADR-0087 was written to close, and it is the one `aTabHoldsItsGenerationsInSlots.test.ts` calls "the worst failure this container has".

## Why the existing test does not catch it

`packages/browser/test/aTabHoldsItsGenerationsInSlots.test.ts` reloads with a changed processor and asserts "AND IT STILL FETCHES, which is the half the slot contents cannot say" — which is exactly the right assertion. But it opens the reloaded container with BOTH generations:

```ts
generations: [
  generationOver(await memoryStore(), processor, APP_IDENTITY),
  generationOver(await memoryStore(editedTo(3)), editedTo(3), identityFor(3)),
],
```

Holding the incumbent makes the incumbent the fetcher, so it fetches and the test passes. **A real app cannot supply that first element**: it is the PREVIOUS handler's code, which is not in the bundle that just loaded. This is precisely the argument ADR-0087 makes for the receiving side ("the previous processor's code is not in the build"), applied to the runtime nobody re-checked it against.

So the property is asserted under a configuration the production path never produces, which is worse than not asserting it: the suite reads as covering this and does not.

## What is NOT the problem

Not the same-processor reload, which IS fixed and is pinned (`a-reloaded-container-makes-its-canonical-generation-a-follower`, triaged FIXED). Not HMR: `an-hmr-update-reconfigures-the-tab-it-is-running-in` reconfigures the RUNNING tab, which still holds the incumbent fold, so the incumbent is still the fetcher. It is specifically a FULL PAGE LOAD of changed handler code — a deploy, or a hard refresh — which is the common case in production and the one HMR exists to avoid only during development.

## Worth deciding rather than assuming

Whether the answer is to extend ADR-0087's decision to the chain-facing container (split `IndexerGeneration`'s fetch from its fold, so a tab fetches regardless of which generation it holds) or something narrower for the reload case. The first is a real restructure of the browser engine that nothing has asked for, and ADR-0087 deliberately scoped itself away from it; the second risks re-deriving the hand-over the ADR measured as duplicating or holing. Either way it is ADR-gate material (hard to reverse, a real trade-off) and belongs in a decision before a task.

Separately, and cheaply: the reload test should be re-scoped to open with ONE generation, since that is the configuration a tab actually has. That change alone should turn this note into a measurement.
