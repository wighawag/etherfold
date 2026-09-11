---
title: 'A generation that has loaded and not yet fetched publishes a NaN sync percentage'
slug: a-pre-fetch-cursor-publishes-a-nonsense-percentage
observed: 2026-09-11
---

Noticed while building `the-indexer-is-hosted-in-a-dedicated-worker`, and NOT fixed (out of that task's scope).

A container publishes its cursor once at load, before it has fetched anything, and that cursor is `lastToBlock: 0, latestBlock: 0`. `createIndexerState`'s `setLastSync` (`packages/browser/src/IndexerState.ts`) divides by `latestBlock` to compute `totalPercentage`, so what reaches `syncing.lastSync.totalPercentage` at that moment is `NaN` (and `syncPercentage` divides by a NEGATIVE `totalToProcess`, since `startingBlock` is the source's start block). An app binding a progress bar to either renders something meaningless until the first fetch lands.

The same `0 === 0` shape bit the browser worker case as a TEST bug on one engine out of three: a wait for `lastToBlock === latestBlock` returned before a single log had been fetched. That half is fixed in `packages/browser/browser/cut.ts` and `packages/browser/test/aHostFoldsAndATabAsksHowFar.test.ts` (both now name the fixture's tip); the percentage arithmetic above is untouched.

Probably belongs to `a-tab-sees-sync-progress-pushed-from-the-worker`, which owns where the derived progress figures live.
