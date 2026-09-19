---
title: 'A restarted `run` with a changed processor re-fetches the WHOLE chain history instead of re-folding the stored stream'
slug: a-restarted-run-refetches-the-whole-chain-instead-of-refolding-the-stored-stream
observed: 2026-09-19
---

2026-09-19 — Measured while reproducing `a-restarted-deployment-hands-over-the-write-duty-it-cannot-discharge` (a `run` stood up as `packages/cli/test/theDeploymentSelectsItsPromotionPolicy.test.ts` does, stopped, re-run over the same libSQL handle with an edited bundle).

The restarted successor is NOT a follower: `ReceivingIndexer.add` derives `follows` from `this.folds.some(...)` — this process's in-memory array, which is empty at `open` — so it gets a receiver and fetches from the chain starting at `defaultFromBlock`. The `eth_getLogs` ranges the fake chain recorded begin at the source's `startBlock` (1000000) even though `_emissions` already holds the whole history under that stream digest. So a processor-only upgrade taken by RESTART costs a full re-fetch, where the same upgrade taken through `POST /{indexer}/admin/reconfigure` costs a local scan (ADR-0008, ADR-0044). This is the receiving twin of the in-memory-array source ADR-0071 §1 condemned and fixed in `packages/core/src/container.ts`.

Not fixed here, and it is not a one-line change: `packages/cli/src/folding.ts` takes `container.ingestion`, whose getter THROWS for a follower ("the first fold held on a stream is never a follower"), and `driveCycles` skips `rebuildMore` entirely under `stopAtTip`, so `build` would fold nothing at all.

## Update — 2026-09-19: the obvious fix was built, and it is worse than the defect

The narrow fix this note implies (derive `follows` from the registry so the restarted generation re-folds the stored stream) was BUILT and MEASURED, and then stopped. It does what this note asks: the restarted deployment re-folds to the previous tip and asks the node for not one `eth_getLogs` range at or below it.

It also makes the deployment stop indexing the chain FOR EVER. The restarted deployment asks the node for `["eth_chainId"]` and nothing else -- zero `eth_getLogs`, zero `eth_blockNumber` -- because a follower has no receiver, so `liveIngestions()` is empty and the fetch side has nowhere to push. It re-folds, is promoted by `on-catch-up`, serves reads and reports healthy. Today's behaviour is EXPENSIVE but live; with that fix alone it is CHEAP and DEAD, which is the worse failure.

So this note stays open, and its fix is not the one-liner it looks like: the re-fetch cannot be removed until the FETCH itself moves off the generation's indexing loop (ADR-0087). The patch and the numbers are kept at `docs/spikes/a-restarted-generation-re-folds-its-stream-instead-of-re-fetching-the-chain/` so it is not paid for twice.
