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

## Update — 2026-09-20: the conclusion above is REFUTED for the trigger it names, and a different trigger is the live hypothesis

Reviewed against the source before this note was acted on. **Steps 1 to 4 of the mechanism are individually correct. The conclusion does not follow**, because the note never checked what happens at `open`. In neither configuration a tab can be in does the described reload produce a silent stall:

- **The default configuration cannot reach it at all.** Both real entry points default to a MEMORY registry -- `spec.registry ?? (await openMemoryGenerationRegistry(BROWSER_GENERATION_CAPS))` at `IndexerState.ts:1202` and `host/serve.ts:374` -- and `packages/core/src/generation/memory.ts` says plainly that it "does NOT do is survive a reload". So on reload the registry is EMPTY, the sole fold takes `canonical`, `fetcherOf` names itself, `follows` is false, and the tab fetches. Nothing in `packages/*/src` or `docs/` ever passes the durable `openGenerationRegistryOnIndexedDB`; only tests do.
- **With a durable registry it is a LOUD REFUSAL, not a silent stall.** `Indexer.open` ends in `resolveCanonical` (`container.ts:1718-1733`), which THROWS `CanonicalGenerationNotHeldError` when the registry's canonical is not among the held folds. That error's own JSDoc names this exact case: "reachable today only across a restart against a DURABLE registry whose pointer was moved by an earlier session". The container refuses to open rather than coming up healthy and idle.

**The remedy this note proposed is also wrong.** Re-scoping `aTabHoldsItsGenerationsInSlots.test.ts` to open with ONE generation does not merely turn it red -- it makes it THROW, for the reason above. The test holds both generations because that is the only way that container opens, which is a constraint rather than an oversight.

**The live hypothesis, same epistemic status as the original note -- read off source, NOT run.** The silent stall does look reachable on a one-generation tab, by a different trigger: reload after a PROMOTION. Session 1 adds successor B beside A and B is promoted on catch-up; `dropOnPromotion` defaults to false (`generation/promotion.ts:94`) and a generation `predecessor` names is untouchable (`registry.ts:545-548`), so A survives as `predecessor`. Session 2 reloads with B's code only. B is already slotted `canonical`, so `resolveCanonical` succeeds and nothing is displaced -- but `fetcherOf` names A, which is older and unheld, so B `follows`, and the container opens, folds, answers reads, reports healthy and fetches nothing. That is this note's failure mode, reached by "reload after a promotion" rather than "reload with a changed handler", and it is the sibling the fixed reload note names as still open: "what happens when the generation `writerOf` names is not HELD".

So the signal stands and the trigger was mis-identified. The task raised from this note is scoped to establish which of the three outcomes is real, and carries all of them.

## Update -- 2026-09-20: RUN. The `## Update` above is confirmed: trigger B stalls, trigger A refuses, and the default cannot reach either

Measured end to end by `the-reloaded-tab-stall-is-measured-on-the-configuration-a-tab-actually-has`. Both halves of this note were read off source and not run; this is the run. Evidence, the harness and the raw output: `docs/spikes/the-reloaded-tab-stall-is-measured-on-the-configuration-a-tab-actually-has/`. The decision it produced: **ADR-0088**.

- **The default configuration cannot reach it** -- confirmed. On a memory registry the reload registers afresh, `follows` is false, and the tab asks `{eth_chainId: 2, eth_blockNumber: 1, eth_getLogs: 1}` over `102..107` and lands on the tip. Nothing in `packages/*/src`, `examples/`, `platforms/` or `docs/` passes the durable registry.
- **Trigger A (changed handler, durable registry, one fold) is a LOUD REFUSAL** -- confirmed. `CanonicalGenerationNotHeldError`, before any chain read at all. A refusal is a different bug class from a stall and is recorded as one.
- **Trigger B (reload after a promotion) IS the silent stall** -- confirmed, and this is the finding. One `eth_chainId` (the load handshake), zero `eth_blockNumber`, zero `eth_getLogs`, for ever. The tab sits at `lastToBlock 105` while the node is at 107, its stored stream is frozen at 105, and the host's own pacing rule reports it `at-tip` because a follower never asks for a block number. Identical whether the tab's own state survives the reload or not.
- **The existing test's two-generation configuration is NOT reachable** -- confirmed, with the entry points named (`IndexerState.ts:1207`, `host/serve.ts:379`, both one-element lists). It is a CONSTRAINT: with one fold that container throws rather than failing, which is why it holds both.
- **The remedy this note originally proposed was measured too.** The one-line narrow fix (`follows` also requires the fetcher to be HELD) removes the stall, keeps core and browser green, and leaves no duplicate and no hole -- because on this runtime the fold replays the stored stream before it fetches, so it lands on the coverage. But it reads `this.held` MID-`open`, so listing the same two folds the other way round gives TWO fetchers, two identical `eth_getLogs`, and one log stored twice. That order dependence, not the ahead/behind timing ADR-0087 names, is the hazard a narrow fix has to escape.
