---
'@etherfold/core': patch
'@etherfold/processor-entities': minor
---

**Two rules that had two homes now have one** (ADR-0071).

**`Indexer` derives `follows` from the shared `writerOf`.** The registry defines a stream's writer as the oldest SURVIVING record by `createdAt` — durable, and what `ReceivingIndexer` has always used. The chain-facing container never imported it: it decided from the order of its own in-memory `held` array, which is whatever order the caller passed its specs in. They agree on the ordinary path, which is why nothing caught it, and they are still not the same rule — a host listing its specs differently after a reload would hand the append duty to a different engine than the registry names, with nothing reconciling the two. No behaviour change on the ordinary path; one rule instead of two on the rule that decides who may write a stream.

**`NotBootstrappedReason` gains `unreadable-format`.** `bootstrapFromSnapshot` reported `'unreachable'` both for a fetch that failed and for a document that WAS fetched and is not an envelope this build reads. The remedies are opposite: a host that did not answer may answer next time, so retrying is right; a document this build cannot read means the app or the publisher is out of date and retrying never helps. This is the reason an app renders to a user. The stream-seed path — the deliberate analogue, with the same failover and refusal-as-data vocabulary — has split the two since it was written; this union drifted.

If you `switch` exhaustively on `NotBootstrappedReason`, add the new member. `pickReason` reports it above `unreachable` and below the two content checks: most specific first.
