---
'@etherfold/state-store': minor
'@etherfold/state-store-sqlite': minor
'@etherfold/state-store-conformance': minor
'@etherfold/processor-entities': minor
---

A state snapshot is format 2 (ADR-0095), and one round-trips out of a build database into a fresh store.

`@etherfold/state-store`: `ENTITY_SNAPSHOT_FORMAT` is 2 and format 1 is removed, not kept beside it (it was never published); a format-1 or unknown document is refused with `SnapshotFormatError`. A snapshot is now a DOCUMENT: gzipped, newline-delimited records, the first line its `SnapshotHead` (`{format, processor, savedAt, takenAt, floor, cursor}`, which gains `floor`), then each entity's declaration once, then the rows live at the floor block as column-ordered arrays and the changes of every later block up to the cut. `encodeSnapshot(head, declarations, blocks)` writes one as a pull stream and `readSnapshot(document)` opens one, reading only its head until asked for its blocks. `SnapshotAwareStateStore.bootstrap` takes the document (bytes, a `ReadableStream`, an async iterable of chunks, or an opened `SnapshotReader`) and installs it streamed, replaying each block through `applyBlock` with the cursor on the last, so it holds at most one block's mutations and never the document; the installed store's floor is the head's `floor`. Rows written under a declaration the store does not share are refused before anything is written. `StateSnapshot` is now `{head, document}`. The `snapshotOrigin` marker keeps a format number of its own, so a document format change no longer makes a bootstrapped store refuse to open.

`@etherfold/state-store-sqlite`: `VersionedStateStore.liveRowsAsOf(at)` reads every row live as of a block, entity by entity and a page at a time, under the as-of predicate and retention refusal every as-of read has; `getBlockAtOrBelow(number)` answers the highest recorded block at or below a height; and `produceStateSnapshot(store, {at, processor, cursor})` writes one generation's state as of a cut as a format-2 document (history `none`), pointed at the highest recorded block at or below the cut, returning `{head, document}`.

`@etherfold/state-store-conformance`: the snapshot cases install format-2 documents (built by the real encoder, `snapshotDocument` in the fixtures), and two cases are added: a format-1 document is refused, and a document carrying blocks above its floor is replayed with the cursor on the last.

`@etherfold/processor-entities`: `createSnapshot` takes the processor's `entities`, is async and returns `{head, document}`; `snapshotHead` is removed (the head is `snapshot.head`). `bootstrapFromSnapshot` reads a bare-URL mirror's head from the first line of its body and cancels the losers, reads a separate head URL as JSON, and installs the winner as it downloads; an error status is `unreachable`, a document or head that is not format 2 is `unreadable-format`. `readSnapshot` and `SnapshotDocument` are re-exported.
