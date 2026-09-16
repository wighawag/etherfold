---
title: 'Promotion arms from the SLOT, so a restart can finish an upgrade and a revert still cannot be undone'
slug: promotion-arms-from-the-slot-so-a-restart-can-finish-an-upgrade
spec: a-save-replaces-the-pending-successor
blockedBy: [a-successor-lands-in-a-durable-slot-that-holds-one]
covers: [4, 5]
needsAnswers: true
---

## What to build

The correctness cliff ADR-0084 exists to remove, now that the fact it needs is durable.

A generation registered at `open` can never be promoted. Not late: never. `open()` adds the fold the host was built with and only THEN sets `opened`; `add()` ends in `applyPolicyTo`, whose first line returns while `!opened`; and `settlePromotion` returns immediately on an empty candidate set. So a developer who restarts with a changed processor gets a successor that catches up and sits there for ever, with nothing reported and no policy value that changes it.

The gate is RIGHT and must not simply be removed. Its recorded reasoning is that applying the policy at open would let `immediate` promote whatever the host happened to be built with, and let `on-catch-up` undo a revert recorded in a previous session. That second hazard is real: after a revert the pointer sits on an older generation while a newer one is still registered, so arming every non-canonical generation at open would re-promote exactly what an operator deliberately reverted away from.

Slots answer it. Arm what `successor` names; never arm what `predecessor` names. The question stops being "how did this fold arrive" and becomes "what is this fold FOR", which is now a durable fact rather than an inference. Narrow the gate to that, and let the in-memory candidate set go, since the candidate for promotion IS what the slot names.

## Acceptance criteria

- [ ] A successor registered at `open` is promoted when it catches up, so restarting with a changed processor finishes the upgrade instead of stalling for ever.
- [ ] A restart after a deliberate REVERT does NOT re-promote the generation that was reverted away from, under any policy value. This and the criterion above are the pair that makes the narrowing safe, and neither is sufficient alone.
- [ ] `immediate` still does not promote the fold a host was merely built with when that fold is already canonical: a host starting normally does not move its own pointer for no reason.
- [ ] The three policy values become observable on every path that can hold a successor, not only through the reconfigure endpoint, so the input added by `the-cli-selects-its-promotion-policy` means the same thing however the successor arrived.
- [ ] The in-memory armed-candidate set is DELETED, not left agreeing with the slot: promotion reads the slot.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`a-successor-lands-in-a-durable-slot-that-holds-one`. A hard dependency rather than a sequencing preference: without the slot there is no durable way to tell a pending successor from a generation a revert returned to, which is the entire content of this change.

## Prompt

The goal is that the promotion policy means one thing regardless of how a successor arrived, without reopening the hazard the current gate protects against.

Read **ADR-0084**, particularly the third of its four symptoms, which is this one, and the consequence describing the narrowing. Then read the `opened` flag in `@etherfold/core`'s receiving container together with the comment above it, which states the reasoning you must preserve, and `applyPolicyTo` and `settlePromotion` beneath it. `generation/promotion.ts` maps a policy to one of promote, arm or wait and is shared with the chain-facing twin; ADR-0046 is the revert reasoning that the gate is protecting.

The decision most likely to be got wrong is treating this as "delete the gate". The gate's two hazards are distinct and only one of them is dissolved by slots. Arming from `predecessor` would undo a revert, and that is the one the slot fixes. Promoting the host's own canonical fold under `immediate` is the other, and it is still wrong, so the rule is not "arm anything with a slot" but specifically "arm what `successor` names, and never what `canonical` or `predecessor` names". Say in your report which hazard each clause of your condition rules out; if a clause rules out nothing, it should not be there.

The second: the policy must still be able to say WAIT. `manual` means the pointer moves only when asked, and a successor sitting armed in a slot must not creep forward because the slot exists. The slot says what a generation is for; the policy still says when.

The third: this is the task that makes `the-cli-selects-its-promotion-policy` honest. Check its tests. Several of them may currently assert through the reconfigure endpoint because that was the only path where the policy spoke; where a shorter path now exists, the test should say so, but do not weaken an end-to-end assertion into a unit one just because it got easier.

The seam to test at is a deployment stood up the way the CLI tests stand one up, restarted over the same substrate with a changed processor, plus a revert case driven to a restart. Those two cases are the deliverable.

Done means: an upgrade finishes across a restart, a revert survives one, `manual` still waits, and promotion no longer consults how a fold arrived.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise -- route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. Which hazard each clause of the arming condition rules out, and whether ADR-0046 or ADR-0057 needed a pointer to this change, are both such decisions. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.
