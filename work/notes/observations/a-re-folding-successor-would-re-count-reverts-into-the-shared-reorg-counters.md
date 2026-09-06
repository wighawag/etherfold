---
title: 'A re-folding successor would re-count reverts into the per-indexer reorg counters'
kind: observation
noticedBy: a-changed-context-creates-a-successor-instead-of-clearing (2026-09-06)
relates: [the-rebuild-replays-the-local-stream-in-bounded-chunks, a-changed-context-creates-a-successor-instead-of-clearing]
---

## What was noticed

The emission APPEND has a one-writer rule and the reorg COUNT does not, and only the first of the two
is bounded by the generation model. `ReceivingIndexer` now withholds `appendEmissions` from a
generation that is not its stream's writer (ADR-0052/ADR-0044), but `recordReorg` is handed to every
generation's receiver, and the counters it writes are per NAMED INDEXER in `_meta`
(`packages/cli/src/reorgCounters.ts`, ADR-0050) rather than per generation.

So a successor that re-folds a stream containing retractions will count those same reverts again, on
top of the numbers the incumbent already recorded, and `/status` will report an absence/contradiction
rate that no chain activity produced. Nothing is corrupted: the counters are operational, best-effort
and never read back into the fold. It is not reachable today either, because nothing yet drives a
successor through a re-fold.

Captured rather than fixed: it belongs to `the-rebuild-replays-the-local-stream-in-bounded-chunks`,
which is what will first drive a second generation over an already-counted history, and deciding
whether the counters become per generation, or a re-fold simply does not count, is that task's call.
