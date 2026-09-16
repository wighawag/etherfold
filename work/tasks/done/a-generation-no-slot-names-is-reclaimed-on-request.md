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

## Decisions

**The verb is an HTTP admin route (`POST /{indexer}/admin/reclaim-generations`) and NOT a sixth CLI verb.** ADR-0057 already decided this class of question and I followed it rather than re-opening it: a Cloudflare Worker is reachable only over HTTP, so a CLI verb serves no serverless deployment at all, and the command set is pinned at five names that denote *deployment intents* — a one-shot control action is not one. The blast-radius argument the task raises is real and is answered where ADR-0057 put the answer: the credential is `ADMIN_TOKEN`, which fails closed and is deliberately never the ingest token a log shipper holds, so the surface that DELETES state is the last one a fetcher can reach. Alternative considered: a CLI verb (cannot be reached remotely, cannot be misauthorised) — rejected because an affordance that exists on one deployment shape is not an affordance, and because the CLI still inherits the route by hosting the same app, so the operator of `run`/`index` gets it anyway. Touches: `IndexerRegistryEntry` (two new optional capabilities), `run` and `index` wiring, and the Worker host, which answers `501 reclaim-not-held` because it registers a bare receiver.

**Acceptance criterion 7 ("follows the rules every other command input obeys, ADR-0048") is satisfied by having NO input rather than by ADR-0048 literally.** ADR-0048 governs CLI flags and their environment fallbacks; with the verb on HTTP it has no flag to name. The verb takes no body at all (the rule decides which generations go, so there is nothing for a caller to name and nothing to get wrong), and it follows the refusal shapes this surface already established — `401` on the path guard, `404` for an unknown name, `501 <capability>-not-held`, in the `reconfigure-not-held` / `generations-not-held` family. The task prompt explicitly rebinds the criterion this way ("if you choose the route, it belongs on the admin credential and the refusal shapes there are already established").

**The SEE half WIDENS the existing `GET /{indexer}/admin/canonical-generation` instead of adding a second listing route.** That route already enumerates every generation; under ADR-0084 `canonical` is merely the first slot, so reporting the other two beside it is a widening of the same answer rather than a new resource. Alternative considered: a new `GET /{indexer}/admin/generations` pair with `POST .../reclaim` under it — rejected because it would leave two enumerations of one thing that can drift, which is the failure this repo consistently designs against; the cost is that the route's NAME now under-describes its body, which it arguably already did. The reclaim verb is a flat kebab segment like `reconfigure`, matching the established admin path shape.

**Reclaiming nothing answers `nothing-to-reclaim`, and a reclaim that was entirely held back answers `declined` — three outcomes, not an empty array.** "Nothing happened" had three causes an operator must tell apart, exactly as `ReconfigureReport`'s `unchanged` exists so a save that changed nothing reads as itself: reporting a full decline as "nothing to reclaim" would tell an operator whose disk is full that there was nothing to free, which is the false answer the verb exists to end. All three are `200` successes, because the verb ran. A per-generation deletion FAILURE is a `declined` entry with `reason: 'deletion-failed'` rather than a thrown call, on the same ground `dropReplaced` uses: the generation is still named by no slot, so nothing reads it and the next call tries again. Touches: the response shape any operator tooling reads, and the `ReclaimReport` type consumers of `@etherfold/core` see.

**The report NAMES rather than counts, and the message is built once in core.** Each reclaimed generation carries its identity, the stream reaped with it and how many records that subtree held (which is why `GenerationDeletion` gained `records`); each declined one carries the reason and what to do about it; `slots` carries what survives, from the same read the rule was decided on. The sentence is composed in the container and carried on the report, so a log line and the HTTP response say the same thing rather than two renderings that drift.

**It is not a collector, and I did not make it one.** Nothing calls `reclaim` on a timer, at `open`, or from any drive path; every call in the tree is a test or an operator route. The caps are untouched. If an automatic sweep is wanted, that is a separate decision (it deletes with nobody present) and ADR-0084 does not make it.
