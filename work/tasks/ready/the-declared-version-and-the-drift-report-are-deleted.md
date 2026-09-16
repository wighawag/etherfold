---
title: 'The declared `version`, the code fingerprint and the PROCESSOR DRIFT report are DELETED'
slug: the-declared-version-and-the-drift-report-are-deleted
spec: a-processor-is-a-bundle-and-its-hash-is-its-identity
blockedBy: [core-takes-its-identity-from-the-arrival, the-processor-packages-take-their-identity-from-the-arrival, the-browser-takes-its-identity-from-the-arrival, the-cli-server-and-examples-take-their-identity-from-the-arrival]
covers: [7]
---

## What to build

The CONTRACT step: the old form goes, now that no caller remains.

Delete the declared `version` field, `assertProcessorVersion`, `getVersionHash()` from the processor seam, `getCodeFingerprint()`, `utils/fingerprint.ts` and the `PROCESSOR DRIFT` report with its tests. Four migrate batches have already moved every caller, so this is a removal rather than a change.

**Say what this retires, because it will otherwise read as a revert.** `a-reload-that-changed-nothing-reports-processor-drift` shipped the drift report on 2026-09-16. It was the correct fix for an author-declared identity: the identity could LIE, so the core said so. ADR-0086 deletes the lie instead of reporting it, and drift stops being unreported and becomes UNREPRESENTABLE -- there is no declared identity left to disagree with the code. The feature is not being reversed, it is reaching the end of its life along with the thing it compensated for.

One part of the fingerprint SURVIVES, in a different role, and is not yours to delete: the browser's HMR arrival has no bytes to hash, so it derives its identity from the handler sources. That derivation is `a-module-handed-to-a-tab-is-identified-by-its-handler-sources`. What goes here is the fingerprint as a SECOND OPINION beside a declared identity; what stays is a derivation that IS an identity.

## Acceptance criteria

- [ ] `version`, `assertProcessorVersion`, `getVersionHash()`, `getCodeFingerprint()` and `utils/fingerprint.ts` are gone from the published surface and from the tree.
- [ ] The `PROCESSOR DRIFT` report, its `ProcessorDriftReport` type, its `strictProcessorDrift` fail-stop and its tests are gone. The phrase `PROCESSOR DRIFT` appears nowhere in the tree, because the condition it named cannot occur.
- [ ] `ReconfigureReport`'s `unchanged` arm no longer carries a `drift` field, and the three outcomes are still three.
- [ ] The whole tree is green with no caller left behind: this is the fan-in, and it is where the wide refactor is finally verified as a whole.
- [ ] The derivation the HMR arrival needs is NOT deleted with the rest, and the task that owns it is named where a reader will find it.
- [ ] `CONTEXT.md`'s glossary no longer describes a declared version, a code fingerprint or a drift report as live, since it currently describes all three.
- [ ] A changeset accompanies the change (`pnpm changeset`), and it states plainly that this retires a feature shipped days earlier and why that is its correct end rather than a reversal.

## Blocked by

All four migrate batches. This is the fan-in of a wide refactor: it cannot start until no caller of the old form remains, and that is exactly what the four batches guarantee.

## Prompt

The goal is that the compensating machinery goes with the thing it was compensating for, leaving one way to identify a processor.

Read **ADR-0086** in full, then `docs/adr/0008-*.md`, which this partly supersedes and which is honest about what it bought ("the residual risk is not eliminated, it is made loud"). Then `packages/core/src/utils/fingerprint.ts` before you delete it: it records why folding the fingerprint into the identity was refused, and ADR-0086 is the answer to that argument rather than a contradiction of it. Then `work/tasks/done/a-reload-that-changed-nothing-reports-processor-drift.md`, the feature you are removing.

The decision most likely to be got wrong is deleting the derivation the HMR arrival needs along with everything else. The two are the same CODE and different ROLES: a second opinion beside a declared identity (delete) versus the identity itself where no bytes exist (keep). Check what `a-module-handed-to-a-tab-is-identified-by-its-handler-sources` requires before you remove the file, and if the sequencing means that task has not landed yet, leave what it needs and say so in your report.

The second: be thorough about the report's REACH rather than just its definition. It touched the reconfigure endpoint's answer, the admin route's response body, the container's `onProcessorDrift`, the stream builder, the generation rebuild and `CONTEXT.md`'s glossary. A deletion that leaves the glossary describing a live drift report has not finished.

The third: do not soften the changeset. A reader seeing a feature deleted days after it landed will assume a mistake unless the note says otherwise, so state the reasoning: the report was right for a declared identity, and the declared identity is gone.

The seam to test at is the whole tree. This is the fan-in where the refactor is verified as a whole, so the acceptance gate doing what it always does IS the test, plus removing the drift suites rather than leaving them asserting a condition that can no longer happen.

Done means: one way to identify a processor, nothing left reporting a disagreement that cannot exist, and a changeset that explains itself.
