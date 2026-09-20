---
title: "The chain-facing `dropSuperseded` still documents and logs a stream reap that ADR-0087 made unreachable"
slug: drop-superseded-still-documents-a-reap-it-can-no-longer-perform
observed: 2026-09-20
---

2026-09-20 — Noticed while reconciling the stream-writer vocabulary in `CONTEXT.md` (ADR-0087's closing task); NOT fixed, because that task's fence excludes `packages/*/src`.

`Indexer.dropSuperseded` (`packages/core/src/container.ts`) opens its JSDoc with "Drop a superseded generation: its state store, its record, **and its stream if it was the last one folding it**", and its success log still carries a `, reaping the stream ${deletion.reaped} with it` branch. Neither can happen any more: it calls `this.registry.deleteGeneration(superseded.record)` with no options, and `reapStream` now defaults off (ADR-0087 removed every automatic reap), so `deletion.reaped` is always `undefined` there. The same reading applies to `dropReplaced` in that file, whose JSDoc also describes the drop as "a reap of its stream where no registered generation is left folding it".

The behaviour is correct; the prose and the log branch describe the retired rule. `docs/adr/0044-...` §amendment and `docs/adr/0055-...` likewise still state "deleting the writer hands the append duty to the next-oldest generation" without a pointer to ADR-0087, which is a frozen record rather than a defect, but a reader arriving from `CONTEXT.md`'s ADR-0044 citations meets it with no signpost.
