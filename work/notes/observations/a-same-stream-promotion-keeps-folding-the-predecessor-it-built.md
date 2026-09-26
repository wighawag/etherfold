---
title: 'A same-stream promotion on a receiving host keeps FOLDING the superseded generation it built, so an engine runs for what `predecessor` names'
slug: a-same-stream-promotion-keeps-folding-the-predecessor-it-built
observed: 2026-09-26
---

2026-09-26, seen while building `an-arrival-of-the-predecessor-re-arms-it-as-successor`. On `ReceivingIndexer.movePointer` (`packages/core/src/receivingContainer.ts`), a promotion onto the SAME stream stops folding the superseded generation only where this process instantiated it from stored bytes (`instantiatedHere`); a fold `add` built in this process (an upload to a running `node`, the configured fold of a `run`) goes on being folded as `predecessor` ("the retention it always had"). So within one `node` session, upload v1, upload v2, promote: v1 is `predecessor` with a live engine that nothing reads, which is the state ADR-0092 says a predecessor should not have. After a restart it is not instantiated, so the gap is session-only. The re-arm task asserts "no engine for `predecessor`" in the restart shape and leaves this retention untouched; whether a same-stream promotion should always stop the superseded fold (on hosts with `instantiateGeneration`, so a revert still folds) is undecided.
