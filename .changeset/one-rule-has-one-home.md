---
'@etherfold/core': patch
'@etherfold/processor-entities': minor
---

**Two rules that had two homes now have one** (ADR-0071).

**`Indexer` asks the registry, not its own array.** Whether a new generation FOLLOWS its stream was decided from the order of the container's in-memory `held` array — whatever order the caller passed its specs in, and not durable across a restart. It now asks the durable registry whether any OTHER generation is already registered on that stream.

Deliberately NOT `writerOf`, which looks like the unification and creates TWO WRITERS: `follows` is frozen per generation at add time (`readOnlyStream` is baked into the engine's config) while `writerOf` is a function of the whole record set at a moment, and `createdAt` is milliseconds with a processor-HASH tie-break — so two generations added in one millisecond can each see `writerOf` name themselves. Measured at 20/20 runs. No behaviour change on any path where the two agree, which is every path with a distinguishable `createdAt`.

**`NotBootstrappedReason` gains `unreadable-format`.** `bootstrapFromSnapshot` reported `'unreachable'` both for a fetch that failed and for a document that WAS fetched and is not an envelope this build reads. The remedies are opposite: a host that did not answer may answer next time, so retrying is right; a document this build cannot read means the app or the publisher is out of date and retrying never helps. This is the reason an app renders to a user. The stream-seed path — the deliberate analogue, with the same failover and refusal-as-data vocabulary — has split the two since it was written; this union drifted.

If you `switch` exhaustively on `NotBootstrappedReason`, add the new member. `pickReason` reports it above `unreachable` and below the two content checks: most specific first.
