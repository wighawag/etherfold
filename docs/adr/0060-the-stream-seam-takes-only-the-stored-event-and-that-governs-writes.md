# The kept-stream seam takes only the STORED event, and that governs WRITES

`StreamFetcher` and `StreamSaver` — and so `ExistingStream`, `StreamReader` and every keeper in the tree — are declared over `StoredLogEvent`: the raw log the node reported plus the reorg verdict the indexer derived, with `args` / `eventName` / `decodeError` structurally REFUSED (ADR-0034: the decoded half is a cache, re-derived on read against the source running now). The strip already happened at runtime, once, in core; this is the seam SAYING so, so that a keeper which would persist a decoded event fails to compile instead of relying on each implementor to remember a rule.

Two things about it would surprise a reader who found only the types, and both are decided here rather than left to be inferred.

## The type governs WRITES; a READ tolerates a decoded half; nothing is migrated

Segments written before this narrowed carry `args` and `eventName` forever. No migration rewrites them, and none should: the re-decode drops and re-derives that half on every replay regardless, so the stored copy reaches nothing, and rewriting it would charge every existing deployment a write pass to delete bytes that are already ignored.

So the three-part rule, stated as one:

- **WRITES narrow from here on.** Nothing this version hands a keeper carries a decoded half.
- **READS tolerate one and ignore it.** A segment carrying `args` is served, not treated as damage — the keeper's damage rules are about a segment that is not a segment (a gap in the ordinals, a value that does not parse), and an extra key on an event is not that. The keeper asserts the stored type at its own storage-readback boundary, which is the sanctioned place for an assertion and what those keepers already did.
- **Nothing on disk is rewritten**, so adopting the stricter type costs an existing deployment no rebuild.

The consequence to state plainly, because it is the uncomfortable half: the stored type then describes what goes IN and not what is guaranteed to be on disk. That is the trade. The alternative — a migration that rewrites every segment — buys a type that is true of the bytes, at the price of a write pass over the whole history to remove fields nothing reads, on a substrate where a browser tab may be evicted mid-pass. It is not worth it, and "read tolerantly, write strictly" is the ordinary shape of a format that narrowed. Pinned by `packages/core/test/anOldSegmentStillReplays.test.ts`, which writes a segment the previous version's way and replays it end to end.

## The cursor gets a SECOND type on this seam, and `LastSync` is not forked

The saver takes a batch AND a `LastSync`, whose `unconfirmedBlocks` hold events; core strips those on the way in exactly as it strips the batch. But `LastSync` is SHARED — the processor seam, the load path, the state keepers and the wire all speak it — so narrowing it in place was never on the table.

The two candidates were:

- **(a) Leave the seam's window typed `LastSync<ABI>`** and document that the compile-time refusal covers the batch only. Cost: one permanent conversion at the save boundary, and a seam that PROMISES an implementor a decoded half which is `undefined` at runtime.
- **(b) Give the seam its own `StoredLastSync`** (with `StoredEventBlock`), used by these two function types and nothing else. Cost: one more cursor-shaped type on the public surface.

**(b) was chosen**, and the deciding argument is not the conversion but the promise. Under (a) the seam's own type would lie about the value a keeper receives: an implementor reading `unconfirmedBlocks[].events[].args` would find a declared, non-optional field that is always absent — a defect of exactly the class this whole change exists to remove, re-introduced one field deeper. A type that lies is worse than an extra type.

`LastSync` itself is untouched for every other caller, which was the constraint. What (b) costs at the seam it saves in the engine: there is no cast at the save boundary at all, and the previous task's temporary assertion is simply deleted rather than re-documented as permanent.

The RETURN direction moves with it, so the two agree: `fetchFrom` hands back a `StoredLastSync` too. That costs no shipped keeper anything, because no keeper stores a window at all (ADR-0035, as amended — the stream's copy is read by nobody and `generateStreamFromReplay` rebuilds it by walking the events), so every implementation returns an empty one.

Where the two cursor types MEET is the indexer's three `fetchFrom` call sites, and the meeting is a CONSTRUCTION rather than a cast (`cursorFromStream`): the engine takes the stream's three block numbers and its context, sets `lastFromBlock` to the block it asked for — which all three paths already did, by mutating the object the keeper returned — and gives the resulting `LastSync` an EMPTY window. Nothing is lost, because a replay ignores the window it is handed and rebuilds it from the events (ADR-0042). The alternative was widening `IndexerGeneration.replay`'s parameter to a union of the two cursor types, which would have spread a second cursor shape through `_feed` and the public replay API to express something neither of them reads.

## What must NOT be reached for

Two escape hatches would make any implementation compile while enforcing nothing, because a decoded event satisfies both: `BaseLogEvent`, the supertype every decoded event extends, and `EmittedLog`, the permissive emission-row alias the server's append path speaks. Neither is an acceptable annotation for a seam type or for a keeper's declared shape, and `EmittedLog` is not to be re-pointed at `StoredLogEvent`: they name different seams and only one of them refuses anything (see `StoredLogEvent`'s docstring for the relation).

The known hole is unchanged and is stated in that docstring: a value whose STATIC type has already been widened to the supertype still assigns. The guard is at the SEAM — what a keeper declares it takes and hands back — and not through a widening.

## Consequences

- **`StreamSegment` is `{events: StoredLogEvent[]}` and carries no ABI type parameter.** The decoded half is what an ABI was needed FOR; a stored segment holds none.
- **A consumer of what `fetchFrom` returned is WIDENED, never asserted at the call site.** `LogEventFetcher.reparse` already was; the follower's `emissionMarkOf` and `hasAlreadyFolded` are widened here, because they read the raw half alone and are asked about both shapes.
- **The refusal is a TYPE claim and is asserted as one**, at the seam and not merely at the type alias: `packages/core/test/storedLogEvent.test.ts` refuses a decoded fetcher, a decoded window, a decoded saver and a decoded `ExistingStream` with `@ts-expect-error` comments `pnpm typecheck` evaluates. Note the trap it records: the browser tests pass their keeper through as `never` at several call sites, so those tests passing proves nothing about the compile-time half.
- **Read-only on this seam is still ONE thing** (`readOnlyStream`, ADR-0044), and a captured fixture is still not an implementation of it (ADR-0059). Neither is reopened here.
