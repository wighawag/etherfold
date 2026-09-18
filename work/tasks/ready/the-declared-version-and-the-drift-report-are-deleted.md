---
title: 'The declared `version`, the code fingerprint and the PROCESSOR DRIFT report are DELETED'
slug: the-declared-version-and-the-drift-report-are-deleted
spec: a-processor-is-a-bundle-and-its-hash-is-its-identity
blockedBy: [core-takes-its-identity-from-the-arrival, the-processor-packages-take-their-identity-from-the-arrival, the-browser-takes-its-identity-from-the-arrival, the-cli-server-and-examples-take-their-identity-from-the-arrival, no-suite-or-example-still-rests-on-the-declared-identity, a-module-handed-to-a-tab-is-identified-by-its-handler-sources]
covers: [7]
needsAnswers: true
---

## What to build

The CONTRACT step: the old form goes, now that no caller remains.

Delete the declared `version` field, `assertProcessorVersion`, `getVersionHash()` from the processor seam, `getCodeFingerprint()` and the `PROCESSOR DRIFT` report with its tests. Five migrate batches and the browser's module arrival have moved every caller AND every silent dependant, so this is a removal rather than a change.

> **RE-SCOPED 2026-09-18, after a measured build STOPPED on this task.** The body used to say "four migrate batches have already moved every caller". That was FALSE, and structurally rather than carelessly: hashing bytes requires HAVING bytes, and the three arrivals with no bytes were deliberately left on the declared path by those same four batches, each deferral written down at the time. Two of them had been handed to tasks that were themselves `blockedBy` THIS task, which deadlocked the family; those edges are now inverted, and `a-module-handed-to-a-tab-is-identified-by-its-handler-sources` is listed above as a dependency instead. The third had no owner at all and is now `no-suite-or-example-still-rests-on-the-declared-identity`. The measurement is in `work/notes/observations/the-adr-0086-contract-task-is-in-a-cycle-with-the-three-leaves-behind-it.md` and in the surface commit `0e500dd9` on `main`. CONFIRM the premise against the code before you build rather than trusting this paragraph: the check that actually proves it is whether anything still falls through `processorIdentityOf` to `getVersionHash()`.

**Say what this retires, because it will otherwise read as a revert.** `a-reload-that-changed-nothing-reports-processor-drift` shipped the drift report on 2026-09-16. It was the correct fix for an author-declared identity: the identity could LIE, so the core said so. ADR-0086 deletes the lie instead of reporting it, and drift stops being unreported and becomes UNREPRESENTABLE -- there is no declared identity left to disagree with the code. The feature is not being reversed, it is reaching the end of its life along with the thing it compensated for.

One part of the fingerprint SURVIVES, in a different role, and is not yours to delete: the browser's HMR arrival has no bytes to hash, so it derives its identity from the handler sources. That derivation is `a-module-handed-to-a-tab-is-identified-by-its-handler-sources`. What goes here is the fingerprint as a SECOND OPINION beside a declared identity; what stays is a derivation that IS an identity.

## Acceptance criteria

- [ ] `version`, `assertProcessorVersion` and `getVersionHash()` are gone from the published surface and from the tree.
- [ ] BOTH `utils/fingerprint.ts` (holding `processorCodeFingerprint`) AND the seam method `EventProcessor.getCodeFingerprint()` SURVIVE, in their new role. What dies is the fingerprint as a SECOND OPINION beside a declared identity -- the DRIFT REPORT, the persisted `ContextIdentifier.processorFingerprint` it compared against, and `onProcessorDrift` -- not the derivation itself, which is now the IDENTITY of the one arrival with no bytes. Its tests (`packages/core/test/processorFingerprint.test.ts` and its fixtures) stay with it: they cover the surviving derivation rather than the report, so removing them under the criterion below would delete live coverage.

  > **CORRECTED TWICE, so read this rather than the ADR's consequence list.** ADR-0086 says "`version`, `assertProcessorVersion`, `getCodeFingerprint()`, `utils/fingerprint.ts` and the `PROCESSOR DRIFT` report all go", and this criterion used to repeat it. That is now FALSE in two places, and the second was only settled when the browser arrival was actually built. `a-module-handed-to-a-tab-is-identified-by-its-handler-sources` (done, #167) names a tab's fold by calling the SEAM METHOD `processor.getCodeFingerprint()`, not the standalone function -- deliberately, because the seam is what delegates correctly through a WRAPPER (`VersionedStateEventProcessor` over `EntityEventProcessor`), whereas the standalone function applied to a wrapper would fingerprint the wrapper's own methods instead of the author's handlers, which is the hazard `packages/core/src/types.ts` already documents. So deleting the seam method takes the name away from the one arrival that has nothing else to be. Both that file and `types.ts` carry a note saying so; they were planted by that build for you. RECORD this deviation from ADR-0086 in your report, the way `utils/fingerprint.ts` already records its deviation from ADR-0008.

- [ ] The `undefined` FINGERPRINT case is settled deliberately, because this task is what makes it reachable. `getCodeFingerprint()` returns `string | undefined`, and a processor whose handlers have no readable source (all bound, or behind a proxy) answers `undefined`. Today such a fold in a tab falls back to the declared hash; once that is gone it has NO identity at all. Decide what happens -- refuse the arrival, or name it some other way -- and say which and why. Do NOT let it silently become `undefined` flowing into `GenerationId.processor`.
- [ ] The `PROCESSOR DRIFT` report, its `ProcessorDriftReport` type, its `strictProcessorDrift` fail-stop and its tests are gone. The phrase `PROCESSOR DRIFT` appears nowhere in the tree, because the condition it named cannot occur.
- [ ] `ReconfigureReport`'s `unchanged` arm no longer carries a `drift` field, and the three outcomes are still three.
- [ ] The whole tree is green with no caller left behind: this is the fan-in, and it is where the wide refactor is finally verified as a whole.
- [ ] The derivation the HMR arrival needs is NOT deleted with the rest, and the task that owns it is named where a reader will find it.
- [ ] `CONTEXT.md`'s glossary no longer describes a declared version, a code fingerprint or a drift report as live, since it currently describes all three.
- [ ] A changeset accompanies the change (`pnpm changeset`), and it states plainly that this retires a feature shipped days earlier and why that is its correct end rather than a reversal.
- [ ] The PENDING changeset that announces the feature being retired (`.changeset/a-reload-that-changed-nothing-reports-processor-drift.md`) is dealt with deliberately and the choice is stated. Nothing has been released, so that changeset is still unconsumed and would otherwise ship a release note announcing a `PROCESSOR DRIFT` report that does not exist. Decide whether it is deleted or amended, and say which and why.

## Blocked by

All FIVE migrate batches, plus `a-module-handed-to-a-tab-is-identified-by-its-handler-sources`. This is the fan-in of a wide refactor: it cannot start until no caller of the old form remains, and until nothing silently RESTS on it either.

The four original batches moved every site that SOURCES an identity. `no-suite-or-example-still-rests-on-the-declared-identity` moves the CLI suites and the `etherfold` example off the run-time FALLBACK, which a textual sweep cannot see. `a-module-handed-to-a-tab-is-identified-by-its-handler-sources` gives the browser's module arrival an identity of its own, which it must have before `getVersionHash()` can go, because a tab receives an already-built processor and has no bytes to hash.

What is deliberately NOT a blocker: `a-path-naming-an-unbundled-entry-point-is-refused` stays blocked on THIS task, and correctly so. Until the declared path is gone an unbundled entry point is a legitimate configuration and refusing it would be wrong. That edge is a real design dependency, unlike the two that were inverted.

## Prompt

The goal is that the compensating machinery goes with the thing it was compensating for, leaving one way to identify a processor.

Read **ADR-0086** in full, then `docs/adr/0008-*.md`, which this partly supersedes and which is honest about what it bought ("the residual risk is not eliminated, it is made loud"). Then `packages/core/src/utils/fingerprint.ts` before you delete it: it records why folding the fingerprint into the identity was refused, and ADR-0086 is the answer to that argument rather than a contradiction of it. Then `work/tasks/done/a-reload-that-changed-nothing-reports-processor-drift.md`, the feature you are removing.

The decision most likely to be got wrong is deleting the derivation the HMR arrival needs along with everything else. The two are the same CODE and different ROLES: a second opinion beside a declared identity (delete) versus the identity itself where no bytes exist (keep). Check what `a-module-handed-to-a-tab-is-identified-by-its-handler-sources` requires before you remove the file, and if the sequencing means that task has not landed yet, leave what it needs and say so in your report.

The second: be thorough about the report's REACH rather than just its definition. It touched the reconfigure endpoint's answer, the admin route's response body, the container's `onProcessorDrift`, the stream builder, the generation rebuild and `CONTEXT.md`'s glossary. A deletion that leaves the glossary describing a live drift report has not finished.

The third: do not soften the changeset. A reader seeing a feature deleted days after it landed will assume a mistake unless the note says otherwise, so state the reasoning: the report was right for a declared identity, and the declared identity is gone.

The seam to test at is the whole tree. This is the fan-in where the refactor is verified as a whole, so the acceptance gate doing what it always does IS the test, plus removing the drift suites rather than leaving them asserting a condition that can no longer happen.

Done means: one way to identify a processor, nothing left reporting a disagreement that cannot exist, and a changeset that explains itself.
