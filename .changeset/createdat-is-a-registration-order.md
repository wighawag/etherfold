---
'@etherfold/core': patch
'etherfold': patch
---

**A generation's `createdAt` is now strictly increasing within a registry, so two generations can never tie** (ADR-0072).

It was a bare `Date.now()` — milliseconds — and `byAge` broke a tie on the processor HASH. `writerOf` names a stream's writer as the oldest surviving generation registered on it, so two generations registered in the same millisecond were ordered by hash rather than by registration, and a SUCCESSOR could be named the writer of a stream its incumbent already wrote. Measured on `ReceivingIndexer` with a frozen clock: **two folds with `writesStream: true`**, against one for the same fixtures named the other way round. That is the one-writer rule (ADR-0044) broken by a clock resolution, and consecutive `add` calls land in one millisecond routinely.

`create` takes `max(Date.now(), newest + 1)` inside the same commit that writes the record. No new field and no durable-format change: `createdAt`'s own contract was already "ORDERING only, never identity", and a value nudged forward to stay ordered is more faithful to that than a raw clock reading.

**The CLI now reads `RebuildReport.stopped`.** It called `rebuildMore()` and discarded the result, so ADR-0070's `retryCanAdvance` had no consumer in this repository — the exact loop that ADR is about. A follower that cannot advance is now reported once, by reason, and stays quiet while it can.
