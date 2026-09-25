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

## Decisions

- **Where the injected seam lives: on `ReceivingIndexerOptions`, not on `GenerationRegistryPort`.** It sits beside `dropState` and `readStateCursor` in spirit, but those two belong to the registry and are built in `@etherfold/server`, which does not use the loader. Turning bytes into a fold needs `foldPartsFor` (CLI) and `loadProcessorArtifact` (`@etherfold/utils`). So the seam is a container option, and the CLI's `openFolding` is the one host that supplies it, so `core` never imports `utils`. I considered adding it to the port; that would have made the registry build processors. The seam returns the same spec `add` takes, minus `bundle`. This touches the next task, `an-upgrading-restart-keeps-the-incumbent-folding`, which should reuse this seam when it instantiates the canonical generation at open.
- **A failed instantiation refuses the pointer move.** Instantiation happens before the pointer is written. Any failure (no stored bundle, the loader refuses the bytes, the bytes hash to a different identity than the generation's, the fold reads a different stream, or the factories throw) raises `GenerationInstantiationError`. The pointer, the folds and the stream writer are then exactly as before. The admin route maps this to `409 generation-cannot-fold`, the same status `reconfigure-failed` uses. I considered moving the pointer and reporting loudly instead. I rejected it because that leaves the inverted state the spec calls a defect: serving a generation frozen at a known point while still folding the rejected one. This adds a new user-visible refusal code on the admin route.
- **The instantiated identity is checked, not trusted.** The CLI hands back the loader's hash of the stored bytes, and the container refuses if it differs from the record's identity. That way stored code can never fold under a name it doesn't hash to.
- **The rejected generation stops folding on a revert, but only when the new canonical generation is folded here.** On a move that is not a promotion, the generation left behind is dropped from this process's in-memory folds. It is not deleted from the registry and keeps its state, bundle and `predecessor` slot. The condition matters: without it, a host that cannot instantiate would lose its only fold on the stream, and the stream would stop being fetched. Behaviour after a promotion is unchanged: the superseded generation still folds unless drop-on-promotion is set. The next task's criterion "the incumbent stops being folded after the pointer leaves it" is left to it. I removed the "keeps folding" wording from the move's log line, since it is no longer always true.
- **The seam is optional.** In-memory test worlds and many server tests have no stored bytes to load. A container without the seam keeps the old behaviour, moving the pointer onto a generation it cannot fold, but now logs an error that nothing folds what answers reads. The one production host (the CLI) always supplies it. Making it required was the alternative; it would have forced a loader into roughly 15 test setups that store synthetic bytes.
- **A generation on a different stream is refused, not resumed.** The resumed fold uses the container's source unless the host's spec says otherwise, so a generation from a filter change, whose stream the host cannot name from the bytes alone, fails the stream-digest check and the revert gets a 409. I considered resolving the source from the bundle's `contractsData`, but that needs the chain provider and is beyond this task.
