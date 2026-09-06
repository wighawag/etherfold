# The stream cursor contract is four properties, and WHERE the cursor lives is the keeper's

> **AMENDED — READ THE AMENDMENT AT THE END FIRST.** The body below records the design as first decided and is kept for its reasoning; three of its claims were later withdrawn. Current answers: the contract is **THREE** properties, the seam is **THREE** keeper operations, and there is **no filesystem keeper**. The filename's "four-properties" is left alone deliberately, as a stable reference other documents cite.

The cached event stream is stored as an append-only run of ordinal SEGMENTS that are never rewritten, so a save costs its batch rather than the history. Each keeper must then answer where the sync CURSOR lives, and we decided that the shared rule is a CONTRACT of four properties rather than a storage layout: exactly ONE authoritative cursor per stream; a save is atomic in the CURSOR-AHEAD direction (a cursor may never claim coverage the stored events lack); no unconfirmed WINDOW accumulates on a sealed segment; and an empty save costs nothing proportional to the history. A keeper satisfies those however its substrate allows, and the two shipped keepers deliberately differ.

## Why this is a decision and not an implementation detail

The obvious move is to pick ONE layout and put every keeper on it, and we tried that for four review rounds. It fails in both directions. The filesystem has no multi-file transaction, so a cursor kept in a separate file is a second thing that must agree with the segments, and making that safe costs orphan discard, truncation to a committed event count, and integers whose only job is to compensate for the missing capability: every blocking defect those four rounds found was in that machinery and nowhere else. IndexedDB, meanwhile, HAS an atomic multi-key write, so forcing it onto the filesystem's layout would make it pay a tail rewrite on every empty save for a hazard it does not have.

So the contract is shared and the placement is not:

- **The filesystem keeps the cursor IN THE OPEN TAIL, stripped on seal.** One key is one write, so property 2 holds by CONSTRUCTION with no transaction, no ordering rule and no recovery. The tail exists for THAT and nothing else, which is why no other substrate should inherit it: it costs a rewrite of up to a threshold's worth of events on every save, including the empty ones a head-following indexer makes on every poll. Sealing rewrites the outgoing tail with its `unconfirmedBlocks` EMPTIED, which gives property 3. The price is property 4: an empty save still rewrites the tail. That price is bounded by the SEAL THRESHOLD and never by the history, and it is tunable.
- **IndexedDB keeps a separate CURSOR RECORD and NO OPEN TAIL: one segment per batch, committed with the cursor in ONE `setMany` transaction.** Property 2 holds through the transaction, property 3 is VACUOUS (no segment ever held a cursor), and property 4 is free. Because there is no tail, a save writes exactly its BATCH and never rewrites anything, so a segment is immutable from birth and an empty save writes only the small cursor record. A tail here would buy nothing but fewer records and would cost a rewrite per save.
- **A SQL keeper takes the IndexedDB shape**, with a cursor ROW updated in the same transaction as its segment insert, and likewise no tail. The server's ADR-0006 emission-stream table is the concrete case.

## Consequences

- **PRESENCE is "the read-cursor operation returns something"**, never "a tail exists". On the cursor-record keeper an empty first save writes no segment and a legacy adoption writes nothing at all, so a tail-shaped presence check reports absent and the indexer clears a perfectly good stream.
- **The SEGMENT RECORD is shared even though the cursor is not.** A segment is `{events, extent}`, the extent being the SCANNED extent `{lastFromBlock, lastToBlock, latestBlock}` current after those events. The shared segmentation helper reads that and never a segment's `lastSync`; a keeper MAY additionally carry its cursor inside the tail record, and a keeper whose segments carry no cursor at all is conforming rather than deficient. Without this the two keepers cannot share one helper.
- **A stream is addressed HIERARCHICALLY, and that is what makes the rest simple.** The address is `['stream', <indexer-name>, <streamDigest>, <ordinal>]` for a segment and `['stream', <indexer-name>, <streamDigest>, 'cursor']` for a cursor record, with the canonical pointer beside them at `['canonical', <indexer-name>]`. The leading literal is what keeps the two in one keyspace without either being a prefix of the other. On IndexedDB those are ARRAY keys (`idb-keyval` takes `IDBValidKey`, which includes arrays), on the filesystem they are DIRECTORIES (`<folder>/stream/<name>/<digest>/<ordinal>.json`), and on SQL they are columns. An earlier design packed the same components into one delimited STRING, and every rule below that looks like defensive machinery was a consequence of that one choice: an anchored regex, a documented cross-chain corruption hazard (`stream_tag_1` is a prefix of `stream_tag_10_0`), a temp-file name that must not parse as an ordinal, and a cursor key that must be *rejected* by the pattern. Hierarchical addressing deletes the class: enumeration is a SCOPED listing (the digests under a name; the ordinals under a digest), and comparing key ELEMENTS cannot confuse chain `1` with chain `10`. Note `chainId` is deliberately absent: it is already inside the stream digest via the block-0 skeleton entry, so putting it in the address was duplication rather than protection.
- **The cursor is addressed WITHIN its stream's subtree**, wherever a keeper chooses to put it. That is the invariant that replaces an operation: a scoped delete of the subtree removes the cursor along with the segments, on every substrate, so `clear` needs no special step and cannot orphan one. An earlier draft added a `clear-cursor` operation precisely because the flat-key design keyed the cursor OUTSIDE the enumerable pattern, so enumerate-and-delete could not reach it; that hazard does not exist here, and the invariant is easier to hold than the operation was to remember.
- **The seam is FOUR keeper-supplied operations**: commit-segment-with-cursor, read-cursor, write-cursor-only, and **seal-segment**. Sealing is a TAIL-STRATEGY concept and not a universal one: only a keeper that keeps an OPEN TAIL has anything to seal. The tail keeper batches into one open segment and rewrites it per save (its threshold counted in EVENTS, so the test is deterministic), then seals it by emptying its window; a keeper with a transaction keeps NO tail, writes one segment per batch, never rewrites anything, and implements seal-segment as a no-op that is never invoked. It has to be a keeper operation rather than a helper-issued write, because a helper that stripped by writing the segment itself would rewrite a key the other keeper asserts is never written again. Sealing is a TAIL-STRATEGY concept and not a universal one: only a keeper that keeps an OPEN TAIL has anything to seal. The tail keeper batches into one open segment and rewrites it per save (its threshold counted in EVENTS, so the test is deterministic), then seals it by emptying its window; a keeper with a transaction keeps NO tail, writes one segment per batch, never rewrites anything, and implements seal-segment as a no-op that is never invoked. It has to be a keeper operation rather than a helper-issued write, because a helper that stripped by writing the segment itself would rewrite a key the other keeper asserts is never rewritten.

- **The SCANNED EXTENT on a sealed segment has exactly ONE READER: the truncation recovery.** It is why property 3 is narrow (strip the WINDOW, keep the three block numbers and the context) rather than "strip the whole `lastSync`": a truncated prefix must still be able to say where it got to. If the recovery is ever replaced by a plain clear, the extent goes with it.
- **`clear` deletes the stream's whole SUBTREE**, which is one scoped operation rather than a sequence with an ordering rule. Because the cursor lives inside that subtree, there is no window in which segments are gone and a cursor survives claiming coverage of them: the flat-key design needed a cursor-first ordering rule precisely to close that window, and hierarchical addressing closes it by construction. On the filesystem this is removing a directory; on IndexedDB a `delMany` over the keys under `[<name>, <digest>]`; on SQL a delete of that stream's rows. What survives from the old rule is only its PROPERTY, which is still worth asserting: an interrupted `clear` must never leave a cursor claiming coverage the surviving events lack. A consequence to state rather than hide: `clear` is therefore TWO operations on that keeper, so it is not atomic there — what is guaranteed is that the reachable interrupted state is the SAFE one.
- **If a recovery leaves NO segment at all, the stream is GONE rather than empty-but-present**: it removes the stream's SUBTREE, which takes the cursor with it, so presence reads FALSE and the next load takes the indexer's clear branch. This needs saying precisely because presence is the CURSOR: when presence was "a tail exists" the case was self-evident, and now the cursor-record keeper would otherwise read PRESENT with zero events and a cursor claiming block 0 upward, which is the worst state this design has.
- **The truncation recovery has an ORDER**, and it is the helper's on every keeper: read the surviving top segment's extent, compose a cursor from it plus the pre-recovery `context` with an empty window, write-cursor-only, THEN delete from the gap upward. Deleting first leaves a window where the cursor describes segments that are gone, and afterwards the ordinals are contiguous again so the gap can never be re-detected. The order is invisible on the filesystem (its surviving tail already IS the cursor) and observable on IndexedDB, which is why it is stated once, centrally, rather than discovered per keeper.
- **The recovered cursor's EMPTY unconfirmed window is safe, and this is why** — recorded because two drafts re-derived it wrongly and one of them nearly shipped. A recovered cursor never drives a scan with an empty window: the surviving prefix is REPLAYED first, and `generateStreamToAppend` rebuilds `unconfirmedBlocks` from the replayed events. So nothing needs the window that was stripped.
- **Do NOT truncate the recovered prefix to a segment boundary below `latestBlock - finality`.** A draft added that to avoid a duplication hazard that does not exist (previous bullet). It is not merely unnecessary, it is destructive: the indexer scans to head, so a head-era segment has `lastToBlock == latestBlock` and NO segment satisfies the horizon test — it would delete every segment of a user's cached history. Recorded so it is not re-derived a third time.
- **Immutability is scoped to "while it remains sealed".** The truncation recovery deliberately makes a formerly-sealed segment the new TAIL, which the next save then appends to, so the flat claim that no write ever targets a sealed segment's key is true only outside that path. Recorded here because the spec this came from states it flatly and now sits in a TERMINAL folder that cannot be amended: a later design (prefix sharing is the named one) must read the scoped form, not the frozen one.
- **The contract is what a conformance test asserts**, against the KEEPER and never against a layout, following ADR-0020's precedent of testing each backend against its own claim.

Recorded from `work/specs/tasked/appending-to-the-stream-costs-the-batch.md`, whose implementation detail lives in its two tasks.

### Amended: the window is not stored, so property 3 and the seal are withdrawn

Three things in the original are WRONG in their premise rather than their reasoning, and the
correction removes machinery rather than adding it. The title's "four properties" is left as the
stable reference; the contract is now THREE.

**Property 3 ("no unconfirmed WINDOW accumulates per sealed segment") is WITHDRAWN, because the
window should not be stored by a stream keeper AT ALL.** The property was a careful rule for managing
data that nothing reads. Evidence already in the repo settles it: `captureStream` persists
`unconfirmedBlocks: []` and `replayStream` returns `[]` (`packages/core/src/stream/capture.ts`,
`stream/fixture.ts`) — a shipped, tested capture-and-replay path that stores no window and works. (It
was a third implementation of this same `ExistingStream` seam when this was written; the fixture has
since LEFT the seam for a reader type of its own, ADR-0059, which changes what it is an example OF and
not what it evidences: an empty window loses nothing.) The window has two homes that ARE read (`KeepState.save` takes
`{state, lastSync}`; the entity path's `serializeLastSync` is `JSON.stringify` of the whole
`LastSync`, written in the block's transaction per ADR-0027), while the stream's copy is read by
nobody: `promiseToFeed` takes only the three block numbers and `generateStreamToAppend` rebuilds the
window from the replayed events. A keeper stores the SCANNED EXTENT and the context, and returns
`unconfirmedBlocks: []`.

**`seal-segment` goes with it**, and so does the seal itself. Sealing existed ONLY to strip the
window on the one keeper that stored it inside its open tail. No stored window, no strip, no seal, no
threshold, no "a SEAL is safe to fail" ordering rule. The seam is THREE operations:
commit-segment-with-cursor, read-cursor, write-cursor-only.

**The FILESYSTEM keeper is withdrawn entirely, and with it the TAIL strategy this ADR was half
about.** `keepStreamOnFile` had zero callers, the CLI never used `@etherfold/fs` (it has its own
`keepState`), and the package's only consumer is a fixture loader. The open tail existed to make a
save ONE write on a substrate with no transaction; with that substrate gone, so is the tail. The
remaining keeper writes ONE SEGMENT PER BATCH and never rewrites anything, so a segment is immutable
from birth and an empty save writes only the cursor record.

**Also withdrawn: the per-segment SCANNED EXTENT and the prefix-keeping gap recovery.** The original
kept the contiguous prefix beneath a gap and resumed from it, which required an extent on every
segment (with exactly one reader, that recovery), an ordered write-then-delete sequence, a rule for
carrying the `context` forward, and a separate no-survivors branch. It is replaced by ONE rule:
anything that is not a complete, contiguous stream with a cursor is CLEARED and rebuilt — with one
case explicitly OUTSIDE it, because collapsing it in is a live bug: a cursor with NO segments is the
ordinary state of a stream that has been scanned and found nothing, which an empty save writes and a
deployment whose contracts have not emitted yet stays in. Clearing that would wipe the cursor on every
reload and re-scan from the start block forever. The
justification for keeping a prefix was that a full re-index can be impossible on a public node, which
is true and is the SEEDING spec's problem to solve properly rather than this keeper's to hedge
against; the source spec's story 5 always permitted the cheap branch ("or be rebuilt deliberately and
visibly"). A segment is therefore `{events}` and the cursor record is the only thing holding the
block numbers and the context.

**What SURVIVES, and is the durable part of this ADR:** that the contract is a set of PROPERTIES
rather than a storage layout; that cursor PLACEMENT is the keeper's, subject to the cursor living
within its stream's subtree; that the address is HIERARCHICAL, which is what deleted the anchored
pattern, the cross-chain hazard, the temp-name rule and `clear-cursor`; and that an inconsistent stream is CLEARED rather than repaired. A SQL keeper and an OPFS keeper are
the expected next consumers, and they inherit exactly those.
