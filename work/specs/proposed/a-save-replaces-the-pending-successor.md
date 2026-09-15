---
title: 'A save replaces the pending successor, instead of adding one that nobody retires'
slug: a-save-replaces-the-pending-successor
taskedAfter: [a-change-reaches-a-running-deployment]
---

> Launch snapshot -- records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

## Problem Statement

A developer saves a file, their watcher calls the reconfigure endpoint, and a successor is registered beside the incumbent. That works, and it is what `a-change-reaches-a-running-deployment` built. Then they save again.

Nothing in the durable record says the first successor has been abandoned. The rule that drops it is narrowed to what one PROCESS registered since it opened, because the durable fact it would need does not exist, so the moment the process restarts the record is empty again and nothing is collected. Meanwhile the advice every processor author is given is to GENERATE the version so it changes whenever the code does, which means every build is a new identity and every restart registers another generation. `maxGenerations` is four and a cap REFUSES rather than evicting, at open, where an operator reads it. So a deployment that redeploys per commit stops STARTING on about the fourth deploy, and the only remedy is deleting generations by hand.

It bites hardest in a browser tab, which is the shape that restarts most. `BROWSER_GENERATION_CAPS` is two of each, a page reload is a fresh process with an empty memory, and a developer reloads a tab constantly. So the in-process rule protects exactly the case that does not need protecting and misses the one that does.

There is a second failure with the same root. A generation that arrives at `open` is never armed for promotion, because the policy deliberately does not speak for the fold a host was built with, so a developer who restarts with a changed processor gets a successor that never catches up and never takes over, silently, for ever. The gate causing that is correct in intent: it exists so that a restart cannot undo a revert recorded in a previous session. It is blunt only because nothing durably distinguishes "a generation we deliberately reverted away from" from "a generation that should take over when ready".

Both are the same missing idea: the registry records THAT a generation is not canonical and never WHY.

## Solution

A generation is held by a durable named slot, and `canonical` is simply the one that already exists (ADR-0084). A reconfigure registers into `successor`, which holds at most one, so a second save REPLACES the first pending successor rather than adding a second. Because the slot is in the registry, this survives a restart and a page reload: a freshly started process registering into `successor` replaces what it finds there, having remembered nothing. A generation no slot names is collectable, so the count is bounded by what is wanted rather than by a cap that refuses.

The same fact fixes promotion. Auto-promotion arms what `successor` names and never what `predecessor` names, so the restart path gets the documented "takes over when it has caught up" behaviour while a deliberate revert still cannot be undone by restarting.

## User Stories

1. As a developer iterating on handlers, I want my second save to replace my first pending successor, so that I can change my mind as often as I like without an operator deleting anything.
2. As a developer, I want the incumbent to go on answering every read while the successor catches up, so that saving never costs me an outage, exactly as it does not today.
3. As a developer working in a browser tab, I want reloading the page not to accumulate a generation, so that a two-generation cap survives an afternoon of reloads.
4. As a developer who restarts the process instead of calling the endpoint, I want my successor to still take over when it has caught up, so that the promotion policy means the same thing however the successor arrived.
5. As an operator who has deliberately reverted, I want restarting the deployment NOT to re-promote the generation I reverted away from, so that the way back holds across a restart.
6. As an operator redeploying per commit, I want each deploy to replace the pending successor rather than add one, so that my fourth deploy starts.
7. As an operator, I want to ask what each slot holds, and to promote or revert by naming a slot, so that I am not matching generation digests by eye.
8. As an operator, I want a generation that no slot names to be collectable, so that the disk comes back without my computing which of four digests is safe to delete.
9. As an operator, I want a reclaim verb rather than only a refusal that names what I could delete, so that the cap stops being the only instrument I have.
10. As an author of a deployment that has a disk and a declared version, I want nothing about my setup to change, so that this is an addition rather than a migration.

## Implementation Decisions

Deferred to ADR-0084, which carries the rationale: a slot is an assignment and never part of `GenerationId`; the default is the `successor` slot rather than one slot per identity; the collection rule is that a generation no slot names is garbage; and the naming is argued there, including why `staging` was rejected (it collides with this repo's own staging position for `work/tasks/backlog/`, and a staging ENVIRONMENT is one you deliberately do not auto-promote, which is the opposite of this slot's defining property).

Three things this spec adds on top of it. The safety property to assert directly is that replacing what `successor` holds cannot touch `canonical` or `predecessor`, which under slots is a statement about one slot rather than a conjunction of three in-memory facts. The in-memory abandoned-successor predicate and the in-memory armed-candidate set both collapse into the slot, so this is a net DELETION of machinery rather than an addition. And the caps are deliberately KEPT, because `BROWSER_GENERATION_CAPS` guards a storage quota whose overflow surfaces as an error at an arbitrary write, which is worse than a refusal at registration; what they need beside them is the reclaim verb of story 9.

**No migration, because there is nothing to migrate.** A registry predating slots would hold generations no slot names, and `predecessor` could not be reconstructed for them, since which generation a revert would want is precisely the fact that was never recorded. That is moot: nobody runs these packages and every consumer is a repository we own, which `CONTEXT.md` carries as a standing convention. Build the correct shape; write no upgrade path for persisted state that does not exist.

## Testing Decisions

The seam is the one those tasks already established: a container over a real database with real per-generation namespaces, plus a deployment stood up the way the CLI tests stand one up, so the claim under test is "this running deployment replaced its pending successor" rather than "this function returned an object". Four properties are worth asserting end to end because prose cannot settle them: a RESTART between two saves replaces rather than accumulates; a burst of saves leaves canonical plus one; a successor that arrived at open is promoted when it catches up; and a restart after a deliberate revert does NOT re-promote what was reverted away from. The last two are one test apart and are the whole reason the promotion gate can be narrowed safely.

## Out of Scope

**How the processor REACHES the deployment.** Pushing it as an artifact, and the browser's HMR arrival, are `a-processor-reaches-a-deployment-however-it-arrives`. This spec is about what happens once a successor is registered, whatever registered it.

**Changing what an identity is.** Switching to a hash of the built artifact belongs after this spec, and deliberately so: it trades a dependency on author discipline (which fails as a false negative and silently ignores a change) for one on build determinism (which fails as a false positive and re-folds an identical commit). The false positive is the better failure, but only once it is cheap, and before slots it is not, because a spurious identity consumes a cap slot and a few of them stop the process starting.

**Removing the generation caps.** Argued against in ADR-0084's consequences. The caps stop being load-bearing here; they should not stop existing.

**Multi-tenant config grammar.** `the-combined-run-holds-several-named-indexers` owns it, and its cost is ADR-0048's one-name-per-input rule rather than anything here.

## Further Notes

The external corroboration is worth recording, because it says the generation model is right rather than merely ours. Ponder reaches the same shape from the opposite direction: each deployment gets its own database schema, the old one keeps serving while the new one backfills, and a set of Postgres VIEWS in a static schema is flipped to the new tables once it is ready. That is a canonical pointer promoted on catch-up, implemented across two processes instead of inside one container. Where it differs is instructive rather than damning: they accumulate schemas without bound and hand the operator `db list` and `db prune`, while we refuse at a cap and offer no verb. This spec is how the count gets bounded without the refusal, and story 9 is the verb.
