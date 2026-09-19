---
title: '`run` and `build` drive the folds they HOLD rather than one receiver captured at open, and `build` settles before it exits'
slug: run-and-build-drive-the-folds-they-hold-rather-than-one-captured-receiver
blockedBy: []
covers: []
---

## What to build

The first piece of ADR-0087, and the largest. It is a RESTRUCTURE of the CLI's fetch assembly that changes no behaviour on its own: it makes `run` and `build` able to drive whatever folds the container holds, including a fold that is a FOLLOWER, which they structurally cannot do today.

Two independent things block that, and both are in the CLI rather than in core.

**The assembly captures ONE receiver at open.** `packages/cli/src/folding.ts` returns `streamBuilder: container.ingestion`, and `packages/cli/src/index.ts` wires that single captured value into the fetcher host as `createDirectIngestion(streamBuilder)`. `container.ingestion` is a getter over the OPENING fold, and it THROWS whenever that fold has no receiver -- "the opening fold of this ReceivingIndexer has no receiver, which `open` cannot produce: the first fold held on a stream is never a follower." That assertion is true today only because of the defect the next task fixes, so the assembly rests on a bug. The receiving container already answers the right question (`liveIngestions`, which reconciles and returns the live contexts), and the SERVER's ingest route already routes on it. The combined process is the one place that still captures.

**`build` folds nothing in the gap where a rebuild would run.** `driveCycles` (`packages/cli/src/index.ts`) wraps its whole rebuild-and-settle block in `if (!stopAtTip)`, and `stopAtTip` is exactly `command === 'build'`. So a `build` advances no follower and settles no pointer, ever.

**That second half is already an open defect in its own right, and this task discharges it** (`work/notes/observations/a-rerun-build-registers-a-successor-and-exits-without-ever-settling-the-pointer.md`, which this task carries rather than points at). Re-run `build` over a database it already wrote with CHANGED processor bytes and it is a different identity, so the container registers a SUCCESSOR beside the existing canonical generation, exactly as a restarted `run` does. `build` then folds that successor to the tip and EXITS with the canonical pointer still naming the OLD generation. The artifact it publishes therefore serves the old fold, with a fully caught-up newer one sitting in the database beside it. `run` is unaffected; its loop settles every cycle.

The observation left two things to decide rather than assume, and they are this task's to decide: whether a `build` should settle once before it exits (it HAS an exit, which is the same argument that already gives it `pruneHeldUntilComplete` there), and whether the docstring's "never adds a second" should instead be made true by REFUSING. Decide both deliberately and say which you chose.

## Acceptance criteria

- [ ] The fetch assembly no longer reads a receiver that can throw: `run` and `build` resolve what they feed from the folds the container currently holds, so an opening fold with no receiver is an ordinary state rather than a crash.
- [ ] A deployment whose live ingestion CHANGES while it runs is followed rather than pinned to the value captured at open, asserted rather than asserted-by-construction.
- [ ] `build` advances every follower it holds and settles the canonical pointer before it exits, so a re-run `build` with changed processor bytes exits with the pointer on the generation it just folded, not on the old one.
- [ ] The artifact a re-run `build` emits serves the fold it just built: asserted end to end over a database `build` already wrote, with changed bytes, by reading through the canonical pointer after the process exits.
- [ ] `build` still STOPS at the tip and still runs its retention pass to completion; the settle does not turn the one-shot into a loop, and a `build` stopped from outside still skips the work an exit was the argument for.
- [ ] `run` is behaviourally unchanged: it already settled every cycle, and this must not give it a second settle or a second rebuild per cycle.
- [ ] The stale claim in `build`'s docstring ("it opens the container with one fold and exits, so it never adds a second and never promotes") is made TRUE or CORRECTED, deliberately, and which was chosen is stated.
- [ ] Nothing here changes which generation is a FOLLOWER or which one WRITES: this task only makes the assembly able to hold one. A diff that touches `follows` or `writesStream` derivation is out of scope and belongs to the task that owns it.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

None -- can start immediately.

This is deliberately FIRST, and the ordering was measured rather than reasoned about. ADR-0087 presents the `follows` derivation fix ahead of this restructure; taken in that order it does not work. Patching `ReceivingIndexer.add` to derive `follows` from the registry and running the suite gives **25 failing CLI tests**, and 17 of them fail with the exact assertion above -- `the opening fold of this ReceivingIndexer has no receiver` -- across `aRestartFinishesTheUpgrade`, `anIndexProcessAdvancesItsSuccessor`, `aGenerationNoSlotNamesIsReclaimed` and `aChangedContextCreatesASuccessor`. The derivation fix cannot be green until this lands, so this is the EXPAND step and the derivation fix is the MIGRATE step. (Measured in a throwaway clone and reverted; no source change was left behind.)

## Prompt

The goal is that the combined `run` and the one-shot `build` can drive whatever folds their container holds, including a fold that re-folds a stored stream instead of fetching one, and that a `build` never exits with its pointer on a generation it did not just fold.

Read the CLI's fetch assembly -- where `openFolding` builds the container and hands something to the fetcher host, and where the drive loop decides what happens in the gap between cycles. Then read how the SERVER's ingest route answers the same question, because it already does this correctly: it asks the container which contexts are LIVE at the moment a batch arrives rather than remembering one. ADR-0044 is why a generation on a shared stream folds the stored stream instead of fetching, and ADR-0087 is the decision this task is the first piece of; read ADR-0087's consequence "`run` and `build` must be able to hold a follower as their opening fold", which is this task in one sentence.

The decision most likely to be got wrong is the SHAPE of the fix. The direct-ingestion target takes one `LogIngestion` and answers `expectedFromBlock` from it, with a comment saying the asker's context is deliberately ignored because "there is exactly one receiver in this shape". Under ADR-0087 that stops being true. Decide whether the target resolves per ask from the container, whether the existing helper is widened or joined by a sibling, and what a process with NO live receiver at all should answer -- that is a real state once a restarted deployment's only fold is a follower, and answering it wrongly is a silent stall rather than an error. Say what you chose.

The second: do not let the settle you add to `build` become a loop. `build` exists to reach the tip and exit, and its exit is what makes its database a publishable artifact. A settle that waits for a successor to catch up would make the one-shot unbounded. Work out what `build` can honestly promise -- advance what it holds by the bounded work it already has, settle once, exit -- and say what it does NOT promise.

The third, on the docstring: check it before acting on it. If a re-run `build` really does register a second generation, the docstring is false and you may either make it true by refusing or correct it to describe what happens. Refusing is a behaviour change an operator will meet, so prefer the correction unless you can argue the refusal; either way, state it.

The seam to test at is the CLI's own command tests, which already stand a deployment up over a real handle, stop it, and re-run it over the same one with an edited bundle.

Done means: the assembly no longer depends on a getter that throws, a re-run `build` exits with its pointer settled, `run` is unchanged, and the docstring says something true.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). The measurement in "Blocked by" was taken against the tree this task was written on; re-take it if the code has moved, and if what you find contradicts this body, say so and build what is right rather than what is written here. Four builders in this family were right to contradict their own task text.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT: the shape of the resolved ingestion target, what a process with no live receiver answers, what `build`'s settle promises and refuses, and what you did about the docstring. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.
