---
title: 'A SERVER deployment retains the CODE that folds each generation, so a predecessor can be resumed and not merely read'
slug: a-generation-retains-the-code-that-folds-it
taskedAfter: [a-processor-is-a-bundle-and-its-hash-is-its-identity]
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **TASKED 2026-09-22, as a NODE spec.** Implementation and testing detail moved into the four tasks `a-generation-keeps-the-bundle-that-folds-it`, `a-revert-resumes-folding`, `an-upgrading-restart-keeps-the-incumbent-folding` and `a-generation-says-whether-it-can-run-here`; the durable rationale moved into ADR-0092. Why there is no browser half is ADR-0089, and why there is no Cloudflare Worker half is ADR-0091.

## Problem Statement

An operator upgrades a deployment, the new processor turns out to be wrong, and they revert. The pointer moves back, the old state answers reads exactly as it did before, and the deployment never advances again.

The reason is that a generation is a stream plus a fold over it, and the FOLD is code. A redeployed process is built with the new processor only, so it holds no engine for the generation it just reverted to. Reads still work, because reads resolve the canonical pointer to a table namespace and need no engine (ADR-0053). Folding does not.

ADR-0084 made this sharper rather than causing it. `predecessor` is now a DURABLE slot, kept precisely so the fact survives a restart. The code that would activate what the slot names is the one thing that does not survive a restart, so the registry now durably promises a way back to something a redeployed process is structurally unable to run. The state after such a revert is also inverted: the container holds an engine for the generation the operator rejected and none for the one it now serves, so it goes on folding what was refused while serving, frozen, what was chosen.

The same missing engine costs something smaller but more frequent on the ordinary upgrade: a restart with a changed processor freezes the incumbent's answers for the whole catch-up, because nothing can advance it.

## Solution

A generation retains the CODE that folds it, as a self-contained bundle stored beside its state, so that holding a generation means holding something runnable rather than something readable.

The artifact format is not new: ADR-0085 already decided that a processor may be a "pre-bundled, content-addressed ARTIFACT, instantiated without touching the filesystem, with the hash of the received bytes serving as the processor's `version`". That decision was made to let a processor be PUSHED to a running deployment. This spec uses the same artifact for a second purpose, RETENTION, and the two reinforce each other: the property that makes an artifact safe to receive over a wire (it is self-contained, it is addressed by its content) is the property that makes it safe to store and re-instantiate later.

Bundling is REQUIRED rather than optional. Optional bundling produces two classes of generation, resumable and frozen, differing in a way an operator cannot see until the moment they need the difference, which is worse than either uniform answer.

Note what cannot substitute for a bundle: retaining the author's source FILE. A processor module is an entry point, not a unit; it imports an ABI, sibling modules and `node_modules`. Re-importing a saved V1 entry point inside a process whose dependencies are now V2's yields neither version, while `getVersionHash()` would still report V1. That is an identity that lies, which is the failure the fingerprint work exists to make impossible.

## User Stories

1. As an operator whose upgrade went wrong, I want to revert and have the deployment RESUME indexing, so that the revert is a recovery rather than a freeze at a known-good point.
2. As an operator, I want to know, before I revert, whether the generation I am reverting to can actually run here, so that I am not choosing between two states I cannot tell apart.
3. As an operator restarting a deployment with a changed processor, I want the incumbent to go on folding while the successor catches up, so that the upgrade window is not a period of stale answers.
4. As a developer, I want the thing my deployment stores for a generation to be the same kind of thing ADR-0085 lets me push to it, so that there is one representation of "a processor" rather than two.
5. As an operator reclaiming disk, I want a generation's retained code to go when the generation goes, so that retention has the same lifecycle as the thing it belongs to and cannot leak.
6. As an operator holding a `predecessor`, I want to know that retention pins exactly one extra artifact and not an unbounded history, so that the revert promise has a bounded cost I can reason about.
7. WITHDRAWN (ADR-0089). This was the browser story: the per-generation artifact cost known and bounded at `BROWSER_GENERATION_CAPS`, so retention did not push a tab into a storage failure. A tab retains no artifacts, because it holds no `predecessor` and cannot instantiate retained bytes without a service worker. Kept as a numbered entry rather than renumbered, so the stories below keep the numbers anything already refers to at an arbitrary write.
8. As a developer reading the code, I want "this generation is frozen because its code is gone" to be an expressible and REPORTED state if it can occur at all, so that a stalled deployment says why rather than merely stalling.

### Autonomy notes

Neither flag. The spec launched with four open questions about how bundling reaches an author; all four are now ANSWERED and recorded under Implementation Decisions, and the identity question they turned on is decided by ADR-0086. Nothing here needs a human to drive the tasking, so no `humanOnly` either.

## Out of Scope

- **The promotion trigger's inability to read an unheld generation's cursor** (once recorded as an observation, since retired; landed per ADR-0084 amendment of 2026-09-19 and pinned by `packages/core/test/aSuccessorIsPromotedOverAnIncumbentNoFoldHereHolds.test.ts`). It looks like the same missing-engine fact and it is not: the trigger needs a NUMBER, which is a row addressed by an identity the registry already holds. It is fixed by a cursor seam beside `dropState` and must NOT wait for this spec.
- **The stored-stream gap on restart** (the task `a-restarted-deployment-hands-over-the-write-duty-it-cannot-discharge`, named by slug rather than by path because its folder changes when it lands), where the one-writer rule names an incumbent the process holds no fold for and nothing appends. Retained code would dissolve it as a side effect, but it is a defect with its own fix and should not be parked behind a feature -- so it is tasked separately and carries the measurement itself.
- **Pushing a processor over the wire**, which is ADR-0085 and `a-processor-reaches-a-deployment-however-it-arrives`. This spec consumes that artifact format; it does not extend the delivery story.
- **Migrating existing deployments.** Nothing is published (`CONTEXT.md`), so there is no persisted state to carry forward.
