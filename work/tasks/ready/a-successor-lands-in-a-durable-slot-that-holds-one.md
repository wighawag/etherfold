---
title: 'A successor lands in a DURABLE SLOT that holds exactly one, so a second save replaces the first'
slug: a-successor-lands-in-a-durable-slot-that-holds-one
spec: a-save-replaces-the-pending-successor
blockedBy: []
covers: [1, 2, 6, 10]
---

## What to build

The foundation of ADR-0084: a generation is held by a durable named SLOT, and `canonical` is merely the first one.

Today the registry holds generations keyed by content and exactly one durable pointer at them, `canonical`. Everything else about a generation's PURPOSE is in memory. That is why a second save adds a successor instead of replacing the first once the process has restarted, and why a deployment whose `version` is generated at build time accumulates one generation per deploy until a cap refuses it at start-up, which is a failure to START and not a degradation.

Give the registry three durable slots: `canonical` (what answers reads, unchanged), `successor` (the generation being built beside it, holding AT MOST ONE) and `predecessor` (what a revert returns to). A slot is an ASSIGNMENT pointing at a generation, exactly as the canonical pointer already is, and it is deliberately NOT part of `GenerationId`, so the same content under two slots stays one generation. Registering into an occupied `successor` REPLACES its occupant, whatever stream either sits on, and the replaced generation is dropped as `a-successor-that-was-never-canonical-is-superseded` already drops one.

This task delivers the slot and the replacement, end to end, through the receiving container. Promotion arming, collection of unslotted generations, and the chain-facing twin each follow in their own task.

## Acceptance criteria

- [ ] Registering a successor while one is already pending REPLACES it, so a run of N changes leaves the incumbent plus ONE successor.
- [ ] That holds ACROSS A RESTART: a fresh process that registers a successor replaces the one it finds in the slot, having registered nothing itself and remembered nothing. This is the property the whole ADR exists for and it is what distinguishes this from the in-memory rule already shipped.
- [ ] The incumbent goes on answering reads throughout, and `canonical` is never touched by a replacement.
- [ ] A generation a revert needs is never replaced: `predecessor` is assigned on promotion and a replacement into `successor` cannot reach it. Asserted directly, since this is the property that makes the rule safe.
- [ ] A slot is an assignment, not an identity: registering content that some slot already names does not create a second generation or a second fold.
- [ ] A replacement is REPORTED, naming what was dropped, what took its place and why it was safe, so an operator watching a dev loop sees bounded churn rather than silent deletion.
- [ ] The in-memory machinery this makes redundant is DELETED rather than left beside the slot: what the abandoned-successor predicate inferred, the slot now reads.
- [ ] The generation caps are UNCHANGED, and a deployment that registers repeatedly no longer approaches them.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

- None. It can start immediately.

## Prompt

The goal is that a developer, or a redeploy, can register a successor as often as they like and the deployment holds one.

Read **ADR-0084** in full: it is the decision this task implements, it explains why the fact must be durable (with the pointer at C and a newer generation N, "N was never canonical" and "N was canonical and the pointer was reverted away from it" are indistinguishable from the rows), and it argues the naming, including why `staging` was rejected. Then read `work/tasks/done/a-successor-that-was-never-canonical-is-superseded.md`, whose in-memory rule this supersedes and whose drop mechanics (the registry row, the state namespace, the stream reaped when nothing is left folding it, the decline while another held fold follows the stream) you should REUSE rather than rewrite. ADR-0053 is why deleting a generation is a namespace `DROP`; ADR-0046 and ADR-0057 are the recorded reasoning about `everCanonical` and drop-on-promotion that this changes the ground of.

The decision most likely to be got wrong is where the slot lives. It is an assignment beside the record, like the canonical pointer, and NOT a field inside `GenerationId`: putting it in the identity would make the same content under two slots into two generations, two namespaces and two folds of one stream. The registry already knows how to hold and move one durable named pointer; this is three of them, and the migration story is deliberately absent because nobody runs these packages (`CONTEXT.md`).

The second: `predecessor` must be ASSIGNED, by the promotion that creates one, and never inferred. Inferring it is the same non-derivable question again. A promotion moves `canonical` forward and assigns what it moved off to `predecessor`; a revert moves `canonical` back to what `predecessor` names. If you find yourself deriving which generation a revert would want, stop, because that is the fact that does not exist.

The third: delete what this replaces. The in-memory set of successors-added-here, and the ever-canonical set insofar as it existed to answer this question, should GO rather than sit beside the slot agreeing with it most of the time. ADR-0084 claims this change is a net deletion of machinery; make that true. If a part of the ever-canonical set is still earning its keep for telling a promotion from a revert, say which part and why in your report.

The seam to test at is the container with a registry over a real database, registering successors in a row and asserting on what the registry holds, on what a revert can still reach, and crucially on a SECOND CONTAINER opened over the same substrate, which is how the restart property is asserted without a process boundary.

Done means: several changes in a row leave one successor, a restart between two of them still leaves one, the incumbent and the revert target are untouched, and the code that used to infer this is gone.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise -- route the task to needs-attention with the discrepancy as the reason.

ADR-0084 carries `status: accepted, not yet implemented`. That line is a claim about the code and it expires: the LAST task in this family removes it. This is not that task (arming, collection and the chain-facing twin follow), so leave it in place.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. How a slot is represented and assigned durably, what happens when a replacement's drop fails, and what remains of the in-memory sets, are all such decisions. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.
