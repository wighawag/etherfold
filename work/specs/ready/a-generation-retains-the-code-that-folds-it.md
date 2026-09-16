---
title: 'A generation retains the CODE that folds it, so a predecessor can be resumed and not merely read'
slug: a-generation-retains-the-code-that-folds-it
taskedAfter: [a-processor-is-a-bundle-and-its-hash-is-its-identity]
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

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
7. As a browser app developer, I want the per-generation artifact cost to be known and bounded at `BROWSER_GENERATION_CAPS`, so that adding this does not push a tab into a storage failure at an arbitrary write.
8. As a developer reading the code, I want "this generation is frozen because its code is gone" to be an expressible and REPORTED state if it can occur at all, so that a stalled deployment says why rather than merely stalling.

### Autonomy notes

Neither flag. The spec launched with four open questions about how bundling reaches an author; all four are now ANSWERED and recorded under Implementation Decisions, and the identity question they turned on is decided by ADR-0086. Nothing here needs a human to drive the tasking, so no `humanOnly` either.

## Implementation Decisions

Made at launch, in answer to the shape of the problem:

- **Bundling is REQUIRED, not optional.** Two classes of generation, resumable and frozen, differ invisibly until the moment the difference matters. One uniform answer is worth the build step.
- **The bytes live in the DATABASE, beside the generation's state.** One namespace then holds everything a generation is, which is the same grouping ADR-0053 already chose for state, and it means a generation's storage is reclaimed by one mechanism rather than two. It also keeps the artifact on the substrate the deployment already has, rather than introducing a filesystem dependency on a runtime (a Worker) that has none.
- **A bundle dies with its generation.** `reclaim` (`a-generation-no-slot-names-is-reclaimed-on-request`) takes the artifact with the row and the state namespace, exactly as it already takes the state. Nothing retains an artifact whose generation no slot names.
- **Retention is therefore bounded by the slots.** `canonical`, `successor` and `predecessor` pin at most three artifacts, so `predecessor` retention costs exactly one extra bundle rather than an unbounded history. That is the same bound ADR-0084 already established for state, which is the point: the code follows the generation, so it inherits the generation's lifecycle rather than needing one of its own.
- **The browser cost is ACCEPTED**, subject to story 7's measurement. At `BROWSER_GENERATION_CAPS` of two this is at most two artifacts in a tab. The number is a DELIVERABLE of the build rather than a question blocking it: only building it answers it, and nothing here turns on the answer.
- **A retained bundle is instantiated ON DEMAND, not at open.** Loading every slotted generation at open would mean three live engines where there are three occupied slots, which in a browser tab is three times the memory for two generations nobody is currently reading. The `predecessor`'s bundle is instantiated when a revert actually moves the pointer onto it, which is the moment its answers start mattering and the only moment it needs to fold.
- **The AUTHOR bundles, and the CLI stays dumb.** No bundler in the CLI's dependency tree and no build step on its start path. It also keeps the identity a function of an artifact the author produced and can reproduce, rather than of whatever the CLI happened to bundle with.
- **`esbuild` is the documented default**, as one command producing a single ESM file. `rollup` is named as the alternative where output stability matters more than speed. `tsup` is deliberately not recommended: it is esbuild with a wrapper and adds no determinism.
- **The bundle is MINIFIED.** Minification strips comments, so a comment-only edit does not move the identity, which is exactly the spurious re-fold worth avoiding once the hash IS the identity (ADR-0086). The cost, that minified output shifts more between bundler versions, is bounded by the pinning rule below.
- **What is pinned is the bundler VERSION AND ITS FLAGS**, not merely the tool. Output is a function of both, so a documented build command and a lockfile entry are together the reproducibility guarantee. ADR-0086 makes this load-bearing rather than advisory: a non-deterministic build means state is never reused.
- **etherfold VERIFIES that a bundle is self-contained** and refuses one that is not. A bundle still importing a bare specifier is not a bundle, and it would otherwise fail later, at retention or at instantiation, far from the cause. A scan for unresolved bare imports at registration is cheap and turns a late mystery into an early refusal.
- **A deployment with no bundle is REFUSED at configuration resolution**, before anything opens a database, naming the missing artifact and the command that produces it. Under ADR-0086 a processor that is not a bundle has no identity at all, so there is nothing to register rather than something to register in a degraded state. There is no transition period: nothing is published (`CONTEXT.md`), so a clean break costs nobody anything.

## Testing Decisions

The claim worth asserting is the one the problem statement opens with, and it must be driven end to end rather than at a seam: a deployment is upgraded, restarted so that only the new code is in the build, reverted, and then observed to ADVANCE. A test that asserts an artifact was stored proves the storage, not the recovery.

The second is the bound: a run of reconfigurations leaves at most as many artifacts as there are occupied slots, and `reclaim` takes the artifacts of the generations it takes. The existing `aGenerationNoSlotNamesIsReclaimed` and `aSuccessorLandsInADurableSlot` suites already stand deployments up over a real database with slots occupied, and are the natural place for it.

The third is the upgrade window (story 3): during a restart-upgrade, the incumbent's cursor MOVES while the successor catches up, rather than sitting frozen.

Prior art for the round trip is ADR-0085's own instantiation path, and for the storage shape the per-generation state namespace.

### How the repo's own 41 declaration sites migrate, which is the part a tasker will get wrong

Around 41 files in this repository construct a processor with a declared `version`, and ADR-0086 deletes that field. They must NOT each grow a bundler step, and they must NOT get a test-only escape hatch that becomes a production one.

The answer falls out of the design rather than needing a mechanism. Identity is `hash(bytes)`, so **a test supplies BYTES, not a bundle**. Synthetic bytes give a stable, distinct identity, which is all the registry, slot, cap, promotion and reclaim suites ever needed from `version`: they assert on WHICH generation, never on what the code does. Those sites migrate by replacing a version string with a bytes literal, and nothing else changes.

Exactly one class of test needs more: the resume round trip (a generation is retained, a process is restarted without that code in its build, and the retained bundle is instantiated and FOLDS). That needs bytes that really instantiate, so it needs one small real bundle fixture, built once and committed, in the manner of the committed stream fixture.

Stating this here because a tasker who misses it has two failure modes, and both are expensive: cutting a task that puts a build step in 41 places, or inventing a way to declare an identity without bytes, which is the deleted `version` growing back under another name.

## Out of Scope

- **The promotion trigger's inability to read an unheld generation's cursor** (`work/notes/observations/the-promotion-trigger-cannot-be-evaluated-with-no-held-incumbent.md`). It looks like the same missing-engine fact and it is not: the trigger needs a NUMBER, which is a row addressed by an identity the registry already holds. It is fixed by a cursor seam beside `dropState` and must NOT wait for this spec.
- **The stored-stream gap on restart** (`work/notes/observations/a-restarted-deployment-appends-nothing-to-its-stored-stream.md`), where the one-writer rule names an incumbent the process holds no fold for and nothing appends. Retained code would dissolve it as a side effect, but it is a defect with its own fix and should not be parked behind a feature.
- **Pushing a processor over the wire**, which is ADR-0085 and `a-processor-reaches-a-deployment-however-it-arrives`. This spec consumes that artifact format; it does not extend the delivery story.
- **Migrating existing deployments.** Nothing is published (`CONTEXT.md`), so there is no persisted state to carry forward.

## Further Notes

The observation this spec came from is `work/notes/observations/a-predecessor-can-be-reverted-to-but-not-resumed.md`, which records the asymmetry (a durable slot naming something the process cannot run) and the two-step remedy that exists today but is written down nowhere: revert to take bad answers out of service immediately, then redeploy the old build to resume folding. If this spec is NOT built, that remedy should at least be documented, and the revert's promise should say that it preserves STATE rather than the ability to run.

Worth noticing that the value here is not only the revert. Requiring a self-contained artifact per generation also makes the code fingerprint and the version hash describe a thing that actually exists and is retained, which is a firmer footing than describing a module that was imported once and is gone.
