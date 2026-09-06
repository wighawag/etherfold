---
'@etherfold/core': major
'@etherfold/browser': patch
'@etherfold/server': patch
---

**BREAKING: the kept-stream keeper seam now speaks `StoredLogEvent`, so a keeper that would persist a decoded event no longer compiles.** `StreamFetcher` and `StreamSaver` — and therefore `ExistingStream` and `StreamReader` — are declared over the raw log the node reported plus the reorg verdict the indexer derived, with `args` / `eventName` / `decodeError` structurally refused. The strip already happened at runtime; this is the seam saying so, which is what stops the rule drifting across implementations.

**What a third-party keeper implementor has to change.** Annotations, and nothing else: `saveNewEvents(source, {eventStream, lastSync})` receives `StoredLogEvent[]` and `StoredLastSync` instead of `LogEvent<ABI>[]` and `LastSync<ABI>`, and `fetchFrom` must hand back those same two shapes. Where a keeper reads its own storage back and cannot prove the shape to the compiler — a row from SQL, a record from IndexedDB — asserting the STORED type at that boundary is the sanctioned move and is what the shipped keepers do. What is NOT: widening the seam, or re-typing a keeper to `BaseLogEvent` or `EmittedLog`, both of which a decoded event satisfies, so either would compile while enforcing nothing.

**The cursor gets a stored variant, and `LastSync` is untouched.** `StoredLastSync` (with `StoredEventBlock`) is `LastSync` with the unconfirmed window's events narrowed the same way, and it is used by these two function types and nowhere else — the processor seam, the load path, the state keepers and the wire all still speak `LastSync<ABI>`. Core strips the window on the way into `saveNewEvents` exactly as it strips the batch, so a seam that still declared `LastSync<ABI>` there would have been promising an implementor a decoded half that is `undefined` at runtime. No keeper stores a window at all (ADR-0035, as amended), so the return side costs an implementation nothing.

**The stored type governs WRITES; READS tolerate a decoded half; nothing is migrated.** Segments written before this keep their `args` and `eventName` forever, are served rather than treated as damage, and are never rewritten — the re-decode drops and re-derives that half regardless (ADR-0034). Adopting the stricter type therefore costs an existing deployment no rebuild, which is pinned by a test that writes a segment the previous version's way and replays it end to end.

Also narrowed with them: `StreamSegment` is now `{events: StoredLogEvent[]}` and carries no ABI type parameter, since a segment holds nothing an ABI was needed for. `EmittedLog` keeps its own meaning and its own callers on the emission-append path, unchanged.
