---
title: 'A fetch range narrower than the finality depth wedges the cursor forever'
slug: a-fetch-narrower-than-finality-never-advances
observed: 2026-09-11
---

Noticed while building `a-tab-sees-sync-progress-pushed-from-the-worker`, and NOT fixed (out of that task's scope).

Configuring `fetch.maxBlocksPerFetch` at or below `stream.finality` leaves the fold asking for the same range for ever. A cycle rewinds by the unconfirmed window before it fetches (`getFromBlock`, `packages/core/src/internal/engine/utils.ts`), so with `finality: 3` and `maxBlocksPerFetch: 2` a cursor at 103 asks for 102..103, applies nothing new, and asks for 102..103 again: measured at 50+ identical `eth_getLogs` ranges in three seconds against the fixture chain, with `lastToBlock` frozen. Nothing refuses it and nothing says so; a host in that state reports `catching-up` truthfully for ever.

It is a configuration a deployment can plausibly reach (a public node that refuses wide ranges, plus a chain with a deep finality), and the remedy is a refusal at config resolution naming both numbers, in the shape `pair-compaction` and `retention` already use for a depth below the floor.
