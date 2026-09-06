---
'@etherfold/core': patch
---

`StoredLogEvent` is exported: the shape of what the stream stores, which is the raw log the node reported plus the reorg flag the indexer derived, and nothing an ABI made of those bytes.

`args` / `eventName` are one ABI's reading of a log and `decodeError` is one ABI's failure to read it, so all three are a CACHE that `LogEventFetcher.reparse` re-derives on read against the source running now (ADR-0034). The new type says so rather than merely omitting them: it is `BaseLogEvent` intersected with `{args?: never; eventName?: never; decodeError?: never}`, so a parsed event, a parsing failure and the `LogEvent` union are each REFUSED where it is expected.

It is a distinct name rather than a reuse of `BaseLogEvent`, which is the supertype every decoded event extends and therefore enforces nothing: a decoded `LogEvent[]` is assignable to a `BaseLogEvent[]`, and excess-property checks fire only on fresh object literals, so a keeper declared over the supertype could receive, hold and persist decoded events in silence. `EmittedLog` is untouched and both survive with a stated relation, in the new type's docstring: `EmittedLog` is the server's emission-row shape, free of an ABI type parameter and permissive, while this one is what a `keepStream` keeper persists, carries `extra` and `removedStreamID`, and refuses a decoded event.

ADDITIVE: nothing has narrowed. `LogEventFetcher.reparse` widened to accept a stored array as readily as a decoded one -- it dropped the decoded half before decoding either way, so its runtime behaviour is unchanged and it still returns decoded events, because a READ produces `LogEvent`s. The keeper seam still declares what it declared before; moving it onto the stored type is a follow-on change.

The type governs WRITES from here on. Segments written before it existed still hold their decoded half forever, no migration rewrites them, and a read tolerates that half and ignores it.
