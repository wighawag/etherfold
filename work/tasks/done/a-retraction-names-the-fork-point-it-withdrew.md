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

## Decisions

**1. The retraction is distinguished by a `kind` tag on BOTH cases, and `StateMoved` becomes a discriminated union.** `StateApplied {kind:'applied', ...}` | `StateRetracted {kind:'retracted', ...}`. The criterion forbids inferring the case from a field being absent, and `'block' in moved` is exactly that inference, so the tag goes on both arms rather than only on the new one: a reader that reads `block` off a retraction then fails to compile instead of rendering a number that means the opposite of what it thinks. Alternatives considered: a separate `onStateRetracted` channel (two attach conventions for the three transport tasks to adapt, against ADR-0083's "one notification model"); an optional `forkPoint` beside an optional `block` (the forbidden shape). Cost: the append payload gained a fifth key, so the previous task's `Object.keys(...)` shape assertions were updated. Touches every downstream consumer of `StateMoved` — the three transport tasks and `the-receiving-container-publishes-what-it-applied`.

**2. A retraction carries `{forkPoint, coherence, generation}` and deliberately NO entity set and NO block.** `forkPoint` rather than `block` because the number means "the highest block that still stands", not "a block that was applied", and reusing `block` would let a reader's `if (block <= rendered) ignore` silently drop a retraction. No entity set because the honest answer would have to come back out of `revertTo`, which returns `void` on all four backends (the constraint this task is fenced by), and because a rotated token already says invalidate everything — a narrower retraction would also invite a reader to repair its cache by hand, which is what goes wrong at the next reorg. `generation` is kept so a retraction says whose answers moved, symmetrically with an append.

**3. The rotation lives INSIDE `publishRetraction`, not at the container call site, and the retraction carries the NEW token.** ADR-0083 said "one line at the point where the reason occurs"; I put that line in the publisher so the reason and the rotation cannot be separated by a future caller — the receiving container (next task) reuses this assembly, and a second call site that forgot to rotate would silently reintroduce the exact bug this task exists to close. Carrying the new token (rather than rotating after publishing) means a reader that RECEIVED the retraction invalidates everything once and then holds precisely the token the following appends carry, so it goes straight back to narrow invalidation. `rotate(reason)` stays public for the promotion task. Touches `the-promotion-policy`'s rotation task and the receiving-container task.

**4. The seam's channel is RENAMED: `setAppliedBlockReporter` → `setFoldReporter`, `AppliedBlockReporter` → `FoldReporter`, payload `AppliedBlock` → `FoldReport = AppliedBlock | Retraction`.** The task says the fork point should ride the channel that exists; once it does, a member named "applied block reporter" means two things, which is the coherence failure CONTEXT.md's conventions tell me to fix rather than build around ("nothing is published, so a breaking change costs a changeset"). Alternative considered: keep the name and widen only the payload (rejected: the name would lie at the one seam third parties implement); a second optional method `setRetractionReporter` (rejected: two slots for one channel, two things a wrapper can silently forget to forward, and the task explicitly says to ride the existing one). It touches `@etherfold/core`, `@etherfold/processor-entities`, `@etherfold/processor-sqlite` and the previous task's done-record/changeset prose, which I did not rewrite: my changeset names the rename instead.

**5. A state DISCARD still does NOT rotate the token, and I did not make it.** The previous task's decision 5 flagged that a reconfigure's rebuild republishes every replayed block and suggested the rotation tasks might want to rotate on a discard too. ADR-0083 names exactly two rotation reasons (a retraction, a promotion); a discard is neither, it is user-visible, and it belongs to whoever owns the promotion/reconfigure rotation. Flagging rather than doing it, so the omission is a decision and not an oversight.

**6. The core world helper was extracted to `test/utils/stateMovedWorld.ts` and shared with the previous task's test.** Two files now drive the same container with the same fold, and `streamCacheWorld.ts` sets the precedent that a second copy of the fake is a second definition of what the layer below reports. The shared fold gained the revert-then-report behaviour so it mirrors `applyEventStream`; `appendsIn()` narrows the union in the old assertions and REFUSES a retraction rather than filtering it, so a fold that never reverts publishing one is a failure and not a skip.

**7. I did NOT rename the two test FILES (`applied-block-report.test.ts`, `applied-block-relay.test.ts`) although their contents now cover both halves.** I tried, and `pnpm check:refs` died with an unhandled `ENOENT`: it enumerates `git ls-files` (the index) and reads each path, so a working-tree rename the agent cannot stage crashes the gate. Reverting the renames costs only a slightly stale file name; risking a gate crash costs a bounce. The latent script bug is captured in `work/notes/observations/check-refs-crashes-on-an-unstaged-rename.md` rather than fixed here.
