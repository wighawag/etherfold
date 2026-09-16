---
title: 'A generation no slot names is RECLAIMED on request, so a cap stops being the only instrument an operator has'
slug: a-generation-no-slot-names-is-reclaimed-on-request
spec: a-save-replaces-the-pending-successor
blockedBy: [a-successor-lands-in-a-durable-slot-that-holds-one]
covers: [8, 9]
---

## What to build

The operator half of ADR-0084, and the thing this system has never had.

A cap REFUSES at its bound and never evicts, which is sound and is currently the ONLY mechanism an operator has. When it fires they are told what they could delete and given nothing to delete it with, so the remedy is hand-written SQL or a deleted database. Ponder, which has no cap at all, ships `db list` and `db prune` for exactly this, and the contrast is instructive: a refusal is a good backstop and a poor interface.

Slots make the missing verb expressible for the first time. A generation that no slot names, and that is not canonical, is garbage by definition rather than by an operator's judgement about digests and timestamps. So: a way to SEE what a deployment holds, slot by slot, and a way to RECLAIM what nothing names.

Reclaiming reuses the drop that already exists (the registry row, the state namespace, the stream reaped when no registered generation is left folding it, declined while another held fold still follows the stream). What is new is the verb and the rule for choosing, not the deletion.

## Acceptance criteria

- [ ] An operator can SEE what a deployment holds: each slot, what it names, and any generation no slot names, without matching digests by eye.
- [ ] An operator can RECLAIM every generation no slot names, in one action, and get back what was freed.
- [ ] A generation ANY slot names is never reclaimed, including `predecessor`. Asserted directly, since this verb deletes data and that is the property that makes it safe.
- [ ] Reclaiming is DECLINED, and says so, where dropping would strand a fold still following the stream that generation writes, exactly as the existing drop declines.
- [ ] The caps are UNCHANGED. This gives an operator an instrument; it does not raise a bound or make refusal less likely.
- [ ] Reclaiming nothing is a success that SAYS it reclaimed nothing, distinguishable from having done work.
- [ ] The surface follows the rules every other command input obeys (ADR-0048), rather than inventing a second shape for one verb.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`a-successor-lands-in-a-durable-slot-that-holds-one`. Hard dependency: "a generation no slot names" is not a question that can be asked before slots exist.

## Prompt

The goal is that an operator who is told a cap has been reached, or who simply wants the disk back, has something to run.

Read **ADR-0084**, especially the consequence about the cap ceasing to be load-bearing without being removed, and the collection rule (a generation no slot names, and that is not canonical, is garbage). Then read the generation registry's existing deletion surface and the drop path in the receiving container, which already handles the namespace, the stream reaping and the decline; and ADR-0053 for why deleting a generation is a namespace `DROP`. ADR-0048 governs how a command input is named and refused.

The decision most likely to be got wrong is where this lives. It is tempting to make it an HTTP route beside the pointer move, since that is where an operator already acts on generations. Weigh that against a CLI verb, which cannot be reached remotely and cannot be misauthorised, and note that the two are not equivalent in blast radius: this verb DELETES state, while the pointer move is reversible. Decide explicitly and say why; if you choose the route, it belongs on the admin credential and the refusal shapes there are already established.

The second: do not let this become a garbage COLLECTOR. It is a verb an operator runs, not a sweep that fires on a timer or at open. An automatic reclaim is a different decision with a different risk profile (it deletes without anyone present) and ADR-0084 does not make it. If you believe it should be automatic, that is a report, not a build.

The third: reporting what was freed matters more than it looks. An operator runs this because something refused or because a disk is full, so "reclaimed three generations" without naming them or saying what came back leaves them exactly as uncertain as before.

The seam to test at is a container over a real database holding a canonical generation, a pending successor, a predecessor and at least one generation no slot names, asserting on which survive and on what the disk shows afterwards.

Done means: an operator can see the slots, reclaim what nothing names, cannot reclaim a revert target, and is told what happened.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise -- route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. Where the verb lives and why, and what it answers when it reclaims nothing, are both such decisions. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.
