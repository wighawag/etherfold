---
title: 'A processor IS a bundle, and the hash of its bytes is its identity'
slug: a-processor-is-a-bundle-and-its-hash-is-its-identity
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

## Problem Statement

A processor's identity is author-declared. `getVersionHash()` is the `version` field plus the entity and config declarations, and the core discards persisted state when it changes. An author who edits a handler and forgets to bump `version` gets state computed by the previous logic, served for ever and silently. ADR-0008 made that condition LOUD rather than impossible, and said so in as many words: "the residual risk is not eliminated, it is made loud". Everything built since has been a better report of a condition nobody could prevent.

There is a second problem with the same root, and it is the one that has started to bite. A processor that is only a MODULE PATH is not a thing a deployment can hold. It cannot be retained (so a `predecessor` can be reverted to but never resumed), it cannot be handed to another process, and it cannot be re-instantiated after a restart, because an entry point is not a unit: it imports an ABI, sibling modules and `node_modules`, and re-importing it against a different dependency tree yields something that is neither version while still claiming to be one.

## Solution

A processor IS a self-contained bundle, and the hash of those bytes is its identity. ADR-0086 records the decision and the reasoning; this spec builds it.

The declared `version` is DELETED, along with `assertProcessorVersion`, `getCodeFingerprint()`, `utils/fingerprint.ts` and the `PROCESSOR DRIFT` report. Drift does not become unreported, it becomes UNREPRESENTABLE: there is no declared identity left to disagree with the code.

The author bundles and the CLI stays dumb. A configuration naming a module path instead of a bundle is REFUSED at configuration resolution, naming the command that produces one. This is a migration rather than an addition, which is a deliberate reversal of what `a-processor-reaches-a-deployment-however-it-arrives` originally promised, and it costs nothing today because nothing is published (`CONTEXT.md`).

Identity moves OFF the processor object. A processor instantiated from bytes cannot know its own hash, so the hash belongs to the artifact and its loader, not to a method on the seam.

## User Stories

1. As an author, I want my handler edit to never be silently ignored, so that identity comes from what my code IS rather than from a field I must remember to change.
2. As an author, I want a comment or formatting edit NOT to create a new generation, so that a cosmetic change costs nothing.
3. As an author, I want the same source to produce the same identity on my laptop and in CI, whatever directory either checks out into, so that two machines never disagree about which generation they are.
4. As an author, I want to go on naming a PATH in my configuration, and to be refused at startup with the exact command to run when that path names an unbundled entry point rather than a bundle, so that the migration is a five-minute change rather than a mystery.
5. As an operator, I want a bundle that is not self-contained REFUSED at registration naming the unresolved import, so that a bare specifier fails there instead of at the first event it folds.
6. As a developer reading the seam, I want identity to live on the artifact rather than on the processor object, so that a processor built from bytes is not asked a question it cannot answer.
7. As a maintainer, I want `version`, `assertProcessorVersion`, `getCodeFingerprint()`, `utils/fingerprint.ts` and the `PROCESSOR DRIFT` report DELETED, so that the compensating machinery goes with the thing it was compensating for.
8. As a test author, I want to give a generation an identity by supplying BYTES, so that 41 declaration sites migrate without any of them running a bundler.
9. As a publisher of snapshots, I want a snapshot's `processor` label to be the bundle hash, so that the existing "a snapshot from another processor version is not a candidate" rule keeps working unchanged.
10. As a developer, I want ONE documented build command and a stated pinning rule, so that reproducibility is something I can follow rather than something I must discover.
11. As a runtime, I want to INSTANTIATE a processor from bytes, because that is the capability both retention and the pushed arrival rest on.
12. As a developer using HMR in a browser tab, I want to hand the running indexer a MODULE OBJECT and have it identified from its handler sources, because a dev server serves unbundled modules and there are no bytes to hash.
13. As a developer using HMR, I want a hot update that changed nothing to still report `unchanged`, so that the outcome stays meaningful on the one arrival where no bytes exist.

### Autonomy notes

Neither gate. ADR-0086 settles the direction, the bundler behaviour is MEASURED rather than assumed (see Implementation Decisions), and the migration path is known. Nothing here needs a human to drive the decomposition.

> **TASKED 2026-09-16.** The Implementation and Testing Decisions that stood here have moved into the eleven tasks this spec fanned out, and the durable rationale lives in ADR-0086. The measured esbuild behaviour that decided `--minify` is carried in `the-build-command-and-its-pinning-rule-are-documented`, and the 41-site migration strategy in the four `*-takes-its-identity-from-the-arrival` batches.

## Out of Scope

- **Pushing an artifact over HTTP**, which is `a-processor-artifact-is-pushed-to-a-running-deployment`. This spec makes the artifact and the instantiation; that one adds the wire.
- **Retaining an artifact per generation so a predecessor can resume**, which is `a-generation-retains-the-code-that-folds-it`. It depends on this spec and not the other way round.
- **WASM.** ADR-0085 records why.
- **A migration for existing deployments.** Nothing is published, so there is no persisted state to carry forward.

## Further Notes

This deletes a feature that landed on 2026-09-16 (`a-reload-that-changed-nothing-reports-processor-drift`, the `PROCESSOR DRIFT` report). That is the correct end of its life rather than a reversal: it was the right fix for an author-declared identity, and it dies with the thing it compensated for. Whichever task removes it should say so, or it will read as a revert.

ADR-0086 carries `status: accepted, not yet implemented`. Per `work/protocol/ADR-FORMAT.md` that line expires when the code lands, and the format doc warns specifically that "every task in a chain can see that it is not the last one while the actual last one has no way to know that it is". The task that lands the last piece of this spec must be told explicitly that removing the line is its job.
