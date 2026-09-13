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
