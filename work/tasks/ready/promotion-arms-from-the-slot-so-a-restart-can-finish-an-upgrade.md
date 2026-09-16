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

> **RE-SCOPED 2026-09-16, after a measured build STOPPED on this task.** The first launch of this task said the only things stopping a successor registered at `open` from being promoted were the `opened` gate and the in-memory candidate set, which is what ADR-0084's third symptom says. An agent implemented exactly that narrowing, measured it, and the pointer still never moved. There are THREE parts, not one, and all three are in scope here because none of the others is sufficient alone. The measurement and the reasoning are in `work/notes/observations/the-promotion-trigger-cannot-be-evaluated-with-no-held-incumbent.md`, which is READ-FIRST for this task. `needsAnswers` stays set until a human clears it.

A generation registered at `open` can never be promoted. Not late: never. `open()` adds the fold the host was built with and only THEN sets `opened`; `add()` ends in `applyPolicyTo`, whose first line returns while `!opened`; and `settlePromotion` returns immediately on an empty candidate set. So a developer who restarts with a changed processor gets a successor that catches up and sits there for ever, with nothing reported and no policy value that changes it.

**Part one, the gate.** The gate is RIGHT and must not simply be removed. Its recorded reasoning is that applying the policy at open would let `immediate` promote whatever the host happened to be built with, and let `on-catch-up` undo a revert recorded in a previous session. That second hazard is real: after a revert the pointer sits on an older generation while a newer one is still registered, so arming every non-canonical generation at open would re-promote exactly what an operator deliberately reverted away from. Slots answer it. Arm what `successor` names; never arm what `predecessor` names. The question stops being "how did this fold arrive" and becomes "what is this fold FOR", which is now a durable fact rather than an inference.

**Part two, the trigger cannot be EVALUATED in the restart shape.** `settlePromotion` reads `const current = this.folds.find(fold => sameGeneration(fold.record, canonical))` and returns when there is none. On a redeploy the container holds exactly one fold, the new one, and the old processor's code is not in the build, so a fold for the incumbent is unbuildable by construction. The trigger's target is `cursorOf(current)`, which goes through `fold.processor.load(...)`.

That is an INCONSISTENCY rather than a missing capability, and seeing it that way is what keeps this task small. The comparison does not need to run the incumbent: it needs one number, `lastToBlock`, which is a row read as `store.readCursor('lastSync')` and decoded by `parseStoredCursor`, in a store addressed by `tableNamespace: generationDigestOf(id)` -- derived from the generation IDENTITY, which the registry still has after a restart. Nothing in that is handler logic. The read tier ALREADY resolves a generation's state this way, with no engine at all, and the container's own module JSDoc and `promote`'s docstring both state that rule deliberately. `cursorOf` is the one read that still goes through the processor, which is why it alone breaks on a restart. Make it follow the rule the rest of the runtime already follows.

**Part three, nothing CALLS the settle in the restart shape on `run`.** `settlePromotion` has exactly two callers: `applyPolicyTo` (once, at `add`) and `rebuildMore`. The CLI gates `rebuildMore` on `container.followers().length > 0`, and a restart-shape successor is NOT a follower, because `add` computes `follows` from "do I already hold a fold on this stream" and at `open` the fold list is empty. So the trigger is not merely blocked, it is never reached.

## Acceptance criteria

- [ ] A successor registered at `open` is promoted when it catches up, so restarting with a changed processor finishes the upgrade instead of stalling for ever. Asserted END TO END on a restarted deployment, since a build that satisfied every other criterion here and left this one unreachable is exactly what happened last time.
- [ ] A restart after a deliberate REVERT does NOT re-promote the generation that was reverted away from, under any policy value. This and the criterion above are the pair that makes the narrowing safe, and neither is sufficient alone.
- [ ] `immediate` still does not promote the fold a host was merely built with when that fold is already canonical: a host starting normally does not move its own pointer for no reason.
- [ ] `manual` still WAITS. A successor sitting armed in a slot must not creep forward because the slot exists: the slot says what a generation is FOR, the policy still says WHEN.
- [ ] The cursor of a generation this container holds NO FOLD for can be read, through the same kind of injected seam `dropState` already uses and for the same stated reason (the registry cannot know the namespace convention, so whoever named the tables supplies it). Every host that constructs a registry port supplies it.
- [ ] Reading that cursor NEVER requires the generation's processor, and nothing in this change retains, re-imports or reconstructs past processor code. That is a separate question and is explicitly out of scope here (see the Prompt).
- [ ] An unreadable cursor stays `undefined` and never reads as zero, so "has not loaded" remains distinguishable from "level at block 0" in the comparison.
- [ ] A slotted successor is DRIVEN on `run`, so the settle is actually reached in the restart shape rather than gated out by a follower check that a restart-shape successor cannot satisfy.
- [ ] The three policy values become observable on every path that can hold a successor, not only through the reconfigure endpoint, so the input added by `the-cli-selects-its-promotion-policy` means the same thing however the successor arrived.
- [ ] The in-memory armed-candidate set is DELETED, not left agreeing with the slot: promotion reads the slot.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`a-successor-lands-in-a-durable-slot-that-holds-one`, which has LANDED. A hard dependency rather than a sequencing preference: without the slot there is no durable way to tell a pending successor from a generation a revert returned to, which is the entire content of this change.

## Prompt

The goal is that the promotion policy means one thing regardless of how a successor arrived, without reopening the hazard the current gate protects against.

READ FIRST: `work/notes/observations/the-promotion-trigger-cannot-be-evaluated-with-no-held-incumbent.md`, which is the measured account of why the obvious version of this task does not work. Then **ADR-0084**, particularly the third of its four symptoms, which is this one and which names only the first of the three parts. Then the `opened` flag in `@etherfold/core`'s receiving container together with the comment above it, which states the reasoning you must preserve, and `applyPolicyTo` and `settlePromotion` beneath it. Read the receiving container's MODULE JSDoc, rule 1 of "two rules of the chain-facing container that deliberately do NOT come over", and `promote`'s docstring: both state that a generation answers with no engine at all, and they are the licence for part two. `generation/promotion.ts` maps a policy to one of promote, arm or wait and is shared with the chain-facing twin; ADR-0046 is the revert reasoning that the gate is protecting; ADR-0053 is why a generation's state is a table namespace.

The decision most likely to be got wrong is treating part one as "delete the gate". The gate's two hazards are distinct and only one of them is dissolved by slots. Arming from `predecessor` would undo a revert, and that is the one the slot fixes. Promoting the host's own canonical fold under `immediate` is the other, and it is still wrong, so the rule is not "arm anything with a slot" but specifically "arm what `successor` names, and never what `canonical` or `predecessor` names". Say in your report which hazard each clause of your condition rules out; if a clause rules out nothing, it should not be there.

The second: do not let part two grow into processor retention. It is tempting, on finding that the container cannot run the incumbent, to make it able to -- by saving the module, re-importing it, or receiving it as bytes. Do not. The comparison needs a NUMBER, and the number is a row addressed by an identity the registry holds. Retaining code is a real and separate question (`work/notes/observations/a-predecessor-can-be-reverted-to-but-not-resumed.md` records why it is not free, and why a saved source FILE is not equivalent to a saved bundle), and it is not this task's to answer. If you find yourself importing anything, stop.

The third: part three is a one-line gate on `run` and it is NOT the same decision as `an-index-process-advances-the-successor-it-registered`. That task owns where a rebuild gets its turn against the INGEST path on `index`, which has no driver at all; `run` already has a cycle, and all that is wanted here is that a slotted successor is driven by it rather than gated out by a follower check it cannot satisfy. Do not design `index`'s scheduling here.

The fourth: MEASURE the end-to-end criterion rather than inferring it. The previous build satisfied the arming rule perfectly and the pointer still never moved. Stand a deployment up the way the CLI tests do, stop it, re-run it over the same substrate with a changed processor, and drive it until the pointer moves or you can say exactly what stopped it.

The seam to test at is a deployment stood up the way the CLI tests stand one up, restarted over the same substrate with a changed processor, plus a revert case driven to a restart. Those two cases are the deliverable.

Also check `the-cli-selects-its-promotion-policy`'s tests. Several of them may currently assert through the reconfigure endpoint because that was the only path where the policy spoke; where a shorter path now exists, the test should say so, but do not weaken an end-to-end assertion into a unit one just because it got easier.

Done means: an upgrade finishes across a restart, a revert survives one, `manual` still waits, and promotion no longer consults how a fold arrived.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise -- route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. Which hazard each clause of the arming condition rules out, the shape of the cursor-reading seam and which hosts supply it, and whether ADR-0046 or ADR-0057 needed a pointer to this change, are all such decisions. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.
