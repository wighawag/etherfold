---
title: 'A generation that has loaded and not yet fetched publishes a NaN sync percentage'
slug: a-pre-fetch-cursor-publishes-a-nonsense-percentage
observed: 2026-09-11
---

Noticed while building `the-indexer-is-hosted-in-a-dedicated-worker`, and NOT fixed (out of that task's scope).

A container publishes its cursor once at load, before it has fetched anything, and that cursor is `lastToBlock: 0, latestBlock: 0`. `createIndexerState`'s `setLastSync` (`packages/browser/src/IndexerState.ts`) divides by `latestBlock` to compute `totalPercentage`, so what reaches `syncing.lastSync.totalPercentage` at that moment is `NaN` (and `syncPercentage` divides by a NEGATIVE `totalToProcess`, since `startingBlock` is the source's start block). An app binding a progress bar to either renders something meaningless until the first fetch lands.

The same `0 === 0` shape bit the browser worker case as a TEST bug on one engine out of three: a wait for `lastToBlock === latestBlock` returned before a single log had been fetched. That half is fixed in `packages/browser/browser/cut.ts` and `packages/browser/test/aHostFoldsAndATabAsksHowFar.test.ts` (both now name the fixture's tip); the percentage arithmetic above is untouched.

Probably belongs to `a-tab-sees-sync-progress-pushed-from-the-worker`, which owns where the derived progress figures live.

**RESOLVED 2026-09-12.** `setLastSync` now derives its figures through `derivedProgress` -- the same function the port already published from -- so the hook and a tab holding a port share ONE derivation instead of two that disagreed. Below a learnt tip the fields read `0` ("nothing known yet") rather than `NaN` or a full bar; `100` was rejected because with no tip an empty span and a finished one are indistinguishable, and telling an app it is done before a single log is asked for is the worse of the two lies. Pinned by `packages/browser/test/progressIsHonestBeforeTheFirstFetch.test.ts`.
