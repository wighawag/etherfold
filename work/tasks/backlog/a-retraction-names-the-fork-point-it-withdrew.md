---
title: 'A retraction names the fork point it withdrew'
slug: a-retraction-names-the-fork-point-it-withdrew
spec: a-reader-learns-when-the-state-moved
blockedBy: [the-fold-publishes-what-it-just-changed]
covers: [4, 6, 15]
---

## What to build

A reorg withdraws data, and a reader that is only ever told "there is more" renders the abandoned branch for ever. Make the withdrawal a first-class case of the signal, and make a MISSED withdrawal self-correcting.

Two halves, and the second is the one that is easy to skip:

**The retraction is explicit and it names a FORK POINT**, not a set of blocks. The vocabulary already exists throughout this project — the emission stream records what was applied and what was taken back, `removed: true` markers, a fold that honours those verdicts on replay — so whatever crosses the boundary should be recognisable as the same idea rather than a new one.

**The coherence token rotates when a retraction happens**, and that is what makes best-effort delivery SAFE rather than merely cheap. Without it the model does not compose: a reader misses the retraction, receives the next ordinary append, invalidates narrowly using its entity names, and the dead-branch rows survive indefinitely, because the stale entities are the ones the ABANDONED branch touched and those are generally not in the next block's changed-set. With the token rotated, the very next notification already carries a different one, so the reader invalidates everything and converges. One field buys the whole property.

A constraint that is load-bearing and easy to get wrong: **produce the retraction from what the fold already has, and do NOT widen the `StateStore` seam to get it.** Know where each half lives before you start, because they are not in the same package: core DETECTS the reorg and emits the withdrawal markers into the stream, while the numeric fork point is derived from those markers one package down, in the same apply path that collects the mutations and calls `revertTo`. That is the same path the previous task's relay already runs through, so the fork point can ride the channel that exists rather than needing a new one. `revertTo(keepUpTo)` returns `void` on the interface. The IndexedDB and SQLite implementations do walk their version indexes and could report what they touched, but adding a return value there is a breaking change across four backends plus the conformance suite, for information the fold already has above the seam. The entity-level detail is not needed anyway: a rotated token means invalidate everything, which is the correct answer after a revert.

## Acceptance criteria

- [ ] A reorg publishes a retraction naming the fork point it reverted to, distinguishable at the type level from an ordinary append rather than inferred from a field being absent.
- [ ] The coherence token published after a retraction differs from the one published before it.
- [ ] A reader that MISSES the retraction and receives only the next append still converges: it sees a changed token, invalidates everything, and no longer holds abandoned-branch rows. Asserted by deliberately dropping the retraction, not by asserting a message shape.
- [ ] The reorg case is tested by CAUSING a reorg through the existing reorg test machinery, not by hand-constructing a retraction message.
- [ ] `StateStore`, `WritableStateStore` and `revertTo` are unchanged; no backend and no conformance case is touched.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`the-fold-publishes-what-it-just-changed`, which defines the signal and the token this rotates. It is also the same module, so building these in parallel would conflict.

## Prompt

The goal is that a reorg cannot leave a reader rendering the branch the chain abandoned, even when the reader was not listening at the moment it happened.

Read `work/specs/tasked/a-reader-learns-when-the-state-moved.md` and **ADR-0083**. The paragraph you are implementing is the one explaining why best-effort delivery and an explicit retraction do not compose on their own, and why the token is what closes it. That argument is the reason this task exists; if you find yourself building per-client buffering or redelivery instead, you have reversed the decision.

Where to look: `@etherfold/core`'s `indexer.ts` holds the revert path and the reorg handling, and `container.ts` holds the publication surface the previous task extended. The **emission stream** and its `removed` markers are the existing vocabulary for "what was applied and what was taken back" — read them so the retraction reads as the same idea. `CONTEXT.md` describes the reorg and revert vocabulary, and reserves **consumer** for a FEED reader, so do not use that word for an app or a reader tab.

The constraint stated in "What to build" is the one most likely to be violated in good faith: `revertTo` returns `void` at the seam, and widening it looks like the tidy way to learn which rows moved. It is not in scope, it is a breaking change to four backends and the conformance suite, and the information is unnecessary because a rotated token means invalidate everything. If you conclude the task genuinely cannot be done without widening the seam, that is a needs-attention signal, not a licence to widen it.

The seam to test at is the existing reorg tests in core: cause a real reorg over the conformance workload, subscribe as a reader, and assert on what a reader can conclude. Then run the same case with the retraction notification dropped on the floor and assert the reader still converges.

Done means: a reorg publishes an explicit retraction naming its fork point, the token moves, and a reader that never saw the retraction is nonetheless correct one notification later.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. How the retraction is distinguished at the type level, and what a retraction carries besides the fork point, are both such decisions. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.
