---
title: 'A revert RESUMES folding, because the generation reverted to is instantiated from its stored bundle'
slug: a-revert-resumes-folding
spec: a-generation-retains-the-code-that-folds-it
blockedBy: [a-generation-keeps-the-bundle-that-folds-it]
covers: [1]
---

## What to build

ADR-0092, the headline. An operator upgrades a Node deployment, the new processor is wrong, and they revert. Today the pointer moves back, the old state answers reads, and **the deployment never advances again**, because the process holds no engine for the generation it just reverted to. After this task, moving the pointer onto a generation this container holds no fold for instantiates that generation from its stored bundle, and it FOLDS.

**Instantiation is injected by the host.** The loader lives in `@etherfold/utils`, which depends on `@etherfold/core`, so the receiving container cannot call it. The host (the CLI's folding wiring) supplies how stored bytes become a fold, the same way it already supplies `dropState` and `readStateCursor`. Everything a fold needs beyond the processor (its state, named from the generation's identity) is already the host's convention; reuse it rather than re-deriving it.

**The moment is the pointer move, not open.** ADR-0092: a bundle is instantiated when its generation has to fold. A `predecessor` has to fold from the moment a revert makes it canonical. Do not instantiate every stored generation at open.

**A failed instantiation must not leave the deployment worse than it was.** If the stored bytes cannot become a fold (they should always be able to, but a test can make them not), the revert must say so rather than silently holding a canonical generation nothing folds. Whether the pointer move is refused or completes with a loud report is yours to decide; record which in `## Decisions`.

## Acceptance criteria

- [ ] **End to end, as the spec demands and not at a seam:** a deployment is upgraded, RESTARTED so that only the new processor is in its build, reverted, and then observed to ADVANCE past where the reverted generation stood. A test asserting only that bytes were loaded proves the loading, not the recovery.
- [ ] The rejected generation stops being folded once the pointer leaves it, or the task records why it deliberately keeps it; the spec's problem statement names "the container holds an engine for the generation the operator rejected and none for the one it now serves" as a defect.
- [ ] Nothing is instantiated at open by this task; the instantiation happens at the pointer move.
- [ ] A failed instantiation is reported, and does not leave a canonical generation silently unfolded.
- [ ] The resume test uses ONE small, real bundle fixture, built once and committed, in the manner of the committed stream fixture; every other test keeps synthetic bytes.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

ADR-0092's status line STAYS; `a-generation-says-whether-it-can-run-here` owns removing it.

## Blocked by

- `a-generation-keeps-the-bundle-that-folds-it` -- the bytes must be stored before they can be instantiated.

## Prompt

The goal is that a revert on a Node deployment is a recovery rather than a freeze at a known-good point.

Read ADR-0092, then ADR-0057 (the revert is an authenticated admin route) and ADR-0084 (what `predecessor` names, and its 2026-09-19 amendment on how a restart finishes an upgrade, which built a cursor seam you will sit beside). ADR-0085's loader is how bytes become a processor; it lives in `@etherfold/utils`.

The seams: the receiving container's pointer move, the host wiring in the CLI that builds folds, and the loader. The spec's end-to-end shape is the test that matters; `packages/cli/test/aRestartFinishesTheUpgrade.test.ts` already stands a deployment up, stops it and re-runs it over the same substrate with a changed processor, and is the closest prior art.

The decision most likely to be got wrong is proving that bytes were loaded instead of proving the deployment advances. The second is reaching into `@etherfold/utils` from `core`.

Done means: upgrade, restart with only new code, revert, and the deployment advances.

FIRST, check this task against current reality: its blocker will have landed by the time you claim it, and the shape of the stored-bytes port is its to decide, so build on what it actually did. If it landed differently than this task assumes, route to needs-attention with the discrepancy.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT, in particular where the injected seam lives and what a failed instantiation does. Do not write the done record, the commit message or the PR body yourself.
