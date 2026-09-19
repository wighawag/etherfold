---
title: 'A restarted `run` with a changed processor re-fetches the WHOLE chain history instead of re-folding the stored stream'
slug: a-restarted-run-refetches-the-whole-chain-instead-of-refolding-the-stored-stream
observed: 2026-09-19
---

2026-09-19 — Measured while reproducing `a-restarted-deployment-hands-over-the-write-duty-it-cannot-discharge` (a `run` stood up as `packages/cli/test/theDeploymentSelectsItsPromotionPolicy.test.ts` does, stopped, re-run over the same libSQL handle with an edited bundle).

The restarted successor is NOT a follower: `ReceivingIndexer.add` derives `follows` from `this.folds.some(...)` — this process's in-memory array, which is empty at `open` — so it gets a receiver and fetches from the chain starting at `defaultFromBlock`. The `eth_getLogs` ranges the fake chain recorded begin at the source's `startBlock` (1000000) even though `_emissions` already holds the whole history under that stream digest. So a processor-only upgrade taken by RESTART costs a full re-fetch, where the same upgrade taken through `POST /{indexer}/admin/reconfigure` costs a local scan (ADR-0008, ADR-0044). This is the receiving twin of the in-memory-array source ADR-0071 §1 condemned and fixed in `packages/core/src/container.ts`.

Not fixed here, and it is not a one-line change: `packages/cli/src/folding.ts` takes `container.ingestion`, whose getter THROWS for a follower ("the first fold held on a stream is never a follower"), and `driveCycles` skips `rebuildMore` entirely under `stopAtTip`, so `build` would fold nothing at all.
