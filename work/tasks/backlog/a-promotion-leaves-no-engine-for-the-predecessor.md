---
title: 'A promotion leaves NO live engine for the generation it superseded, however that generation arrived'
slug: a-promotion-leaves-no-engine-for-the-predecessor
blockedBy: []
covers: []
---

## What to build

ADR-0092 says a `predecessor` needs no engine: nobody reads it and it is not catching up, and a revert instantiates it again from its stored bundle. Today that holds only for a superseded generation this process INSTANTIATED from stored bytes (`instantiatedHere` in `ReceivingIndexer.movePointer`) and for a promotion onto ANOTHER stream on a host that fetches its own streams. A fold `add` built in this process (an upload to a running `node`, the configured fold of a `run`) goes on being folded as `predecessor` after a same-stream promotion. So within one `node` session, upload v1, upload v2, promote: v1 is `predecessor` with a live engine nothing reads. This is the observation `a-same-stream-promotion-keeps-folding-the-predecessor-it-built`. The maintainer decided on 2026-09-26: v1 must not keep a live engine.

**The rule.** On a host that can rebuild a generation from stored bytes (it injects `instantiateGeneration`: the CLI's `run`, `build`, `index` and `node`), a PROMOTION stops folding the generation it superseded, however it arrived and whichever stream either is on. It is RETAINED: registered, with its state and its stored bundle, named by `predecessor`, so a revert is still one write and instantiates it again (as a revert already does for an `instantiatedHere` fold). A host with NO `instantiateGeneration` (the server package's hosts, a test world) keeps today's retention, because there stopping the fold would turn every revert into a freeze.

- `drop-on-promotion` is unchanged (it deletes instead).
- The cross-stream branch added by `a-successor-on-a-new-stream-is-fetched-by-its-own-writer` (`fetchesItsOwnStreams`) keeps working: on a fetching host the old stream's fetcher still stops once nothing reads it. A push-fed host with `instantiateGeneration` (the split `index`) stops folding the superseded generation on the SAME stream, which costs nothing because the new canonical generation still reads that stream; measure what it does on ANOTHER stream and keep the push-fed guarantee `a-successor-on-a-new-stream-is-fetched-by-its-own-writer` asserted (its stream still accepts pushes) unless you show it is not reachable.
- Check the re-arm path (`an-arrival-of-the-predecessor-re-arms-it-as-successor`): an arrival naming the predecessor that is no longer held must instantiate it and re-arm it, and its tests must still pass.

## Acceptance criteria

- [ ] On a running `node`: upload v1, upload v2, v2 is promoted in-process; v1 is `predecessor` and this process holds NO fold for it (asserted on the container's held folds and on the admin listing's `folding`).
- [ ] The same for a `run` whose configured fold is superseded by a promotion in-process.
- [ ] A revert onto that predecessor instantiates it from its stored bundle and it folds again (asserted end to end).
- [ ] A host with no `instantiateGeneration` keeps folding the superseded generation after a promotion, as today (asserted).
- [ ] The re-arm suites and the push-fed cross-stream assertion still pass.
- [ ] ADR-0092 carries a dated amendment; ADR-0084's and ADR-0087's amendments and CONTEXT.md say what is now true. Grep `docs/adr/` and `CONTEXT.md` for "retention it always had" and similar claims.
- [ ] The observation `a-same-stream-promotion-keeps-folding-the-predecessor-it-built` is DELETED.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

None -- can start immediately.

## Prompt

The goal is that a node runs engines only for the generations someone reads or that are catching up.

Read ADR-0092 and all its amendments, ADR-0084's amendments, ADR-0087's 2026-09-26 amendment, ADR-0094.

The seam: `ReceivingIndexer.movePointer` in `@etherfold/core` (its branches for a revert, `dropOnPromotion`, the cross-stream promotion, and `instantiatedHere`), and `stopDriving`.

The decisions most likely to be got wrong: stopping the fold on a host that cannot instantiate it again (every revert there would freeze); and breaking the push-fed guarantee on another stream.

Done means: after any promotion on a CLI host, the predecessor has state and bytes and no engine, and a revert brings the engine back.

FIRST, check this task against current reality. If a same-stream promotion already stops the superseded fold, route to needs-attention with the measurement.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do not write the done record, the commit message or the PR body yourself.
