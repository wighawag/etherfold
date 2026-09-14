---
title: 'An `index` process can never finish a processor upgrade: it registers the successor and nothing ever advances or promotes it'
slug: an-index-process-can-never-finish-a-processor-upgrade
observed: 2026-09-14
---

2026-09-14 — Noticed while scoping `the-cli-selects-its-promotion-policy`, which had to decide which commands own the new input. Restarting `etherfold index` with a changed processor opens the container with the successor beside the incumbent, but nothing ever carries it to level: `ReceivingIndexer.applyPolicyTo` returns immediately while `opened` is false, so a fold added by `open()` is never even ARMED as a candidate, and `packages/cli/src/indexCommand.ts` schedules no `rebuildMore` (only `driveCycles` in `src/index.ts` does, on `run`). So the incumbent stays canonical for ever, the successor stays at nothing, and a split deployment's only route to an upgraded fold is to delete a generation by hand. `run` has both halves and is unaffected.

Related and probably the same gap: `indexCommand.ts`'s module header (item 6) says "a batch naming a fold this process has not seen therefore CREATES a generation beside the live one", and no code path does that — `container.add` is called only by `open()` and by `packages/cli/src/reconfigure.ts`, which `index` does not wire up. Either the doc is stale or the receiving half is missing the affordance it claims.
