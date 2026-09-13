---
title: 'A promotion rotates the coherence token'
slug: a-promotion-rotates-the-coherence-token
spec: a-reader-learns-when-the-state-moved
blockedBy: [a-retraction-names-the-fork-point-it-withdrew]
covers: [10]
---

## What to build

When the canonical pointer moves, a different fold answers reads. From a reader's point of view that is indistinguishable from "everything you hold may be wrong", so it gets the same treatment as a retraction: the coherence token rotates, and the reader invalidates everything.

That sameness is deliberate and is the whole content of this task. A promotion and a reorg have nothing in common mechanically, but they have exactly one thing in common for a reader, which is that narrow invalidation is no longer sufficient. Giving them one signal means one comparison and one code path in every reader ever written, instead of two concepts an app author has to learn the difference between. It also follows the convention this project already holds for a generation, which is rendered so that a reader compares the value and never parses it.

The notification already carries a `generation` field, added by the root task; what this task owes is that the field is CORRECT across a pointer move, so a re-read after a promotion cannot be silently served by a different lineage than the one the reader was rendering while believing it was the same one. The field is beside the token and not folded into it, because the token is never parsed and so names nothing, while this is a value a reader renders and compares.

Small task. It is separate from the retraction task because the setups share nothing: one needs a reorg, the other needs two generations and a pointer move.

## Acceptance criteria

- [ ] A promotion rotates the coherence token, so the next notification after a pointer move carries a different one than the last notification before it.
- [ ] The `generation` field names the generation that now answers, from the first notification after the move onwards, and named the previous one before it.
- [ ] A reader that re-reads on a changed token after a promotion is answered by the generation the notification named, not by the retired one.
- [ ] Ordinary appends within one generation still do not move the token, so the previous task's stability property is not regressed (assert it, since this is the change most likely to break it).
- [ ] There is ONE rotation mechanism, shared with the retraction case, rather than a second event kind for the promotion case. (The `generation` field is not a second mechanism: it is carried on every notification, not only this one.)
- [ ] Tested by promoting between two real generations, using the existing promotion test machinery.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`a-retraction-names-the-fork-point-it-withdrew`, which introduces token rotation. This is the second reason to rotate and must reuse the first one's mechanism rather than add a parallel one. They also touch the same module, so serialising them avoids a conflict.

## Prompt

The goal is that a reader cannot keep rendering state from a generation that is no longer the one answering.

Read `work/specs/tasked/a-reader-learns-when-the-state-moved.md` and **ADR-0083**, in particular the decision that the token changes on a promotion "deliberately the same mechanism" as on a retraction, and the note on why `generation` is carried BESIDE the token rather than folded into it. The temptation is to give the promotion its own event kind because it is a different thing; resist it, because a reader does not care that it is a different thing, and two kinds means every app handles both.

Where to look: `@etherfold/core`'s `container.ts` owns generations, the canonical pointer and the promotion policy, and it already fires a pointer-moved notification BEFORE the state notification that applies the move — read the comment explaining why that order exists, because your rotation has to sit correctly with respect to it. A reader told the other way round would answer one notification's worth of questions about the new generation from the retired one's cursor. `GenerationContext` and the way a generation is rendered for comparison are the existing vocabulary for naming the generation in the payload.

Related existing behaviour worth understanding before you touch it: `publishDiscard` covers the fold that was thrown away, and `onStateUpdated` publishes an indirect handle rather than a value precisely so that a reader holding it follows the pointer. This task is the notification-side counterpart of that design, not a replacement for it.

The seam to test at is the existing promotion tests in core, with a reader subscribed across the pointer move.

Done means: a promotion moves the token, the notification says which generation now answers, and a plain append still leaves the token alone.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. Where the rotation fires relative to the existing pointer-moved notification is such a decision. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.

## Decisions

**1. A promotion PUBLISHES nothing; it rotates the token the next notification carries.** The acceptance criterion is phrased as "the next notification after a pointer move carries a different one", and a pointer move has no block to name and no fold that applied anything, so an `'applied'` notification manufactured at the move would claim a block application that did not happen (and a `'promoted'` kind is the second kind the task explicitly forbids). Alternatives considered: publishing an `'applied'` naming the new canonical generation's cursor (rejected: `StateApplied.block` is documented as "the block that was just applied", and a reader's `if (block <= rendered) ignore` would drop it); a third union case (rejected by the task and ADR-0083). **Residual, stated rather than discovered**: on a chain that then goes quiet, an out-of-heap reader is not told until the next block moves. That is the same best-effort limit ADR-0083 already accepts, and in-heap readers are still told at once by `onStateUpdated`, which `applyAtNotification` fires. Touches every future transport task and `the-receiving-container-publishes-what-it-applied`, which inherit "a promotion is not an event".

**2. The rotation fires BEFORE `onPromoted` and before the state notification, and AFTER the registry write.** Both of those callbacks are a reader being told to re-read, so a rotation after either would let one notification's worth of questions about the new generation be answered under the retired one's token, which is the exact failure the task's prompt names. After the registry write, so a `moveCanonicalTo` that throws does not invalidate every reader's cache for a move that did not happen. Alternative considered: rotating at the top of `movePointerTo` (rejected: rotates on a failed move).

**3. It sits at the POINTER MOVE (`movePointerTo`), not at the `promote` verb, so a REVERT and a policy-driven promotion rotate too.** Coherence check: `promote` is the human/operator verb, while `movePointerTo` is the one place the *canonical pointer* moves (`immediate` at `add`, `on-catch-up` at `settlePromotion`, `manual` at `promote`, and the backwards move CONTEXT.md calls a *revert*). A reader can see nothing of a move except that a different fold answers, so gating the rotation on the direction or on which caller asked would make the token mean two different things depending on who moved the pointer. A case pins the automatic `on-catch-up` path so the claim is tested and not just asserted. Touches `theCanonicalPointerMovesBack` behaviour (a revert now rotates) and the promotion policy paths.

**4. A `promote` naming the generation that is already canonical rotates NOTHING.** It is inside the existing `superseded !== entry` guard, which is also what `onPromoted` uses, so the two agree. Nothing a reader holds became suspect, and rotating would charge every reader a full re-read for a lineage change that did not happen. It is a user-visible default (`promote` is a public verb), hence recorded rather than buried.

**5. The RECEIVING container is deliberately NOT given this rotation, and I did not add one.** It moves a pointer too (`ReceivingIndexer.movePointer`) but holds no `StateMovedPublisher` at all: publishing from it is `the-receiving-container-publishes-what-it-applied`'s task, per ADR-0083's status. Flagging it so the omission reads as a decision rather than an oversight: whoever builds that publisher owes the same one-line rotation at that pointer move.

**6. Two additive changes to the shared test world (`test/utils/stateMovedWorld.ts`), used by two other tasks' test files.** `reportingFold` gained a `rows` getter (two folds over one stream otherwise produce identical rows, so a read could not say which generation answered — the same problem `promotion.test.ts` solves by MARKING what a fold produces), and `openWorld` gained an optional `promotion` option defaulting to the existing `{policy: 'manual'}`. Both are additive; no existing case changed, and the whole core suite (1133 tests) is green.
