---
title: "A fold's cursor is read with the SOURCE it folded, so a filter-change successor can be seen to catch up"
slug: a-folds-cursor-is-read-with-the-source-it-folded
blockedBy: []
reason: 'Superseded and folded in. Its premise is false (auto-promotion is NOT broken today: neither implementation of `load` uses `source` to choose a cursor, so `cursorOf` already answers correctly and a filter-change successor is already promoted), so its end-to-end criterion could never go red first. The real, latent contract correction it identified is now a criterion of `promotion-arms-from-the-slot-so-a-restart-can-finish-an-upgrade`, which rewrites the same function. See `work/notes/observations/the-source-argument-to-load-is-inert-so-the-cursor-defect-is-latent.md`.'
covers: []
---

## What to build

A one-pair fix to a read that silently disables auto-promotion for one of the two reconfigure shapes.

`ReceivingIndexer.cursorOf` reads a fold's progress with `fold.processor.load(this.options.source, fold.streamConfig)`: the fold's OWN stream config, paired with the CONTAINER's source. For the common reconfigure, a processor change, those agree and nothing is wrong. For a FILTER or SOURCE change, a fold added with its own source, they do not: the pair used to read is one that fold never folded under, so the load answers nothing (or answers for a context that is not this fold's), `cursorOf` returns `undefined`, and the fold reads as "has not loaded" for ever.

That value is not decorative. `settlePromotion` compares `cursorOf` across folds to decide when a successor has reached the incumbent's cursor, so a successor that always reads `undefined` is never ready and `on-catch-up` never promotes it. The reconfigure story's second shape therefore registers a generation that catches up invisibly and never takes over, with nothing reported.

Read the cursor with the pair the fold ACTUALLY folded under. The fold already carries what is needed; this is a correction to which source is passed, not a new mechanism.

## Acceptance criteria

- [ ] A fold added with its OWN source reports a cursor that reflects its real progress, rather than reading as never-loaded.
- [ ] A successor on a changed source is seen to CATCH UP, so `on-catch-up` promotes it. Asserted end to end through the promotion trigger, since that is the behaviour the bug removes, not through `cursorOf` in isolation.
- [ ] The processor-change shape (successor on the same source) is unaffected, so the common path behaves exactly as it does today.
- [ ] The guard that a loaded state whose recorded processor differs is not treated as this fold's progress is PRESERVED. This fix changes which source is read with, not what counts as a valid read.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

- None. It can start immediately, and it is independent of the slot work (ADR-0084), which does not touch this read.

## Prompt

The goal is that a successor created by a filter change can be observed to catch up, so the promotion that is already built actually fires for it.

Read `work/notes/observations/a-folds-cursor-is-read-against-the-containers-source.md`, which is where this was spotted and which states the consequence but did not investigate it. Then read `cursorOf` in `@etherfold/core`'s receiving container and its one caller, `settlePromotion`, so you can see why an `undefined` cursor is silently fatal rather than merely missing. ADR-0044 is why a fold may hold a source of its own at all.

FIRST establish whether the observation is still true and whether the fold carries its own source to read with. The fold spec accepts a `source`, and the container resolves one per fold; confirm where it survives on the held fold rather than assuming a field name. If it does NOT survive, that is the actual bug and it is a slightly larger one: say so in your report and fix the retention, because a fold that cannot say what it folded under cannot be read correctly by anyone.

The decision most likely to be got wrong is scope. It is tempting, having found one place that pairs a container-level source with a fold-level config, to go and fix every such pairing. Do not: correct the read that feeds the promotion trigger, and if you find others, note them in your report rather than changing them, since each has its own callers and its own meaning.

The second: do not make an unreadable cursor look like zero. `undefined` means "this fold has not loaded", which is a different claim from "level at block 0", and the promotion comparison depends on that distinction. Keep it.

The seam to test at is the container with a real registry and real state, adding a successor with its own source and driving the rebuild until the pointer moves. A test that asserts `cursorOf` returns a number proves the read, not the behaviour; assert the promotion.

Done means: a filter-change successor catches up, is seen to catch up, and is promoted, while the processor-change path is untouched.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise -- route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. Where the fold's own source is read from, and what you did about any other container-source-with-fold-config pairing you found, are both such decisions. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.
