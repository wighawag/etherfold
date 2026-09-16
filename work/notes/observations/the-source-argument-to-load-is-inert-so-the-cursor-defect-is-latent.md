---
title: 'The `source` argument to `load` is inert in every implementation, so the `cursorOf` defect is LATENT and not live'
slug: the-source-argument-to-load-is-inert-so-the-cursor-defect-is-latent
observed: 2026-09-16
---

2026-09-16 — Measured while driving `a-folds-cursor-is-read-with-the-source-it-folded`, which routed to needs-attention on this. It is recorded here because the measurement is the useful part and a stopped build leaves no diff to carry it.

`a-folds-cursor-is-read-against-the-containers-source` states the consequence conditionally — "the visible consequence **would be** on the PROMOTION trigger" — and the task written from it read that as an observed fact, asserting that a filter-change successor "catches up invisibly and never takes over". It does take over, today, on unmodified main.

`EventProcessor.load(source, streamConfig)` has exactly two implementations: `EntityEventProcessor.load` (`packages/processor-entities/src/EntityEventProcessor.ts`) and `VersionedStateEventProcessor.load` (`packages/processor-sqlite/src/VersionedStateEventProcessor.ts`, which delegates to it). Neither uses `source` to decide which cursor it answers. `EntityEventProcessor.load` assigns `this.source = source` to a field whose own declaration comment says "Kept for the context a future rebuild/upgrade path will need; not read on the hot path", and that assignment is the ONLY occurrence of `this.source` in the file. The cursor is then read from the processor's own per-generation store (`store.readCursor(SYNC_CURSOR_KEY)`), which ADR-0053 namespaces per generation and which is source-independent. So `ReceivingIndexer.cursorOf` returns the fold's real `lastToBlock` even when handed a source that fold never folded under, and `on-catch-up` promotes a filter-change successor end to end.

Measured both directions at the seam the task named (container, real registry, real state): an incumbent folded to block 110 and canonical, a successor added with its own source on a different contract address, fed on its own wire to 110, settled — the pointer MOVES against unmodified main. The same scenario with a deliberately source-honouring processor double, one that answers `undefined` from `load` for a source it never folded under, does NOT promote.

So the mismatch in `cursorOf` is real as a CONTRACT violation and inert as a BEHAVIOUR: it bites only a processor that honours the `source` argument, and none exists. That distinction is what the task needs before it can be rebuilt, because it changes what the change IS — hardening a latent defect against the seam contract, which cannot be demonstrated red-then-green without a source-honouring double, rather than repairing an auto-promotion that was never broken. Landing it as written would put a false claim in the release notes and in the done record.

Two things noticed beside it, neither investigated:

- `cursorOf` is a READ that calls `load`, and `load` MUTATES its processor (`this.source = source`, `this.finality = streamConfig.finality`, and `ensureMigrated()`). Today the first is inert because nothing reads the field, which is precisely why the confusion was invisible; a read path that writes the container's source onto a fold that folded another is the shape the whole thing came from.
- The fold's own source DOES survive and is reachable: `add` resolves it and remembers it as `FoldOrigin.source` in the `origins` WeakMap, populated for every fold including the one `open()` adds, and surviving `handOverTheWire` because that mutates the fold in place. It is NOT on the public `HeldFold`, which carries `streamConfig` and no source — so whether a fix reads the WeakMap (widening a structure whose stated purpose is remembering what an ENGINE half needs rebuilt) or adds a field to the published type is an open choice, not a detail.
