---
'@etherfold/state-store': minor
'@etherfold/state-store-patch': patch
'@etherfold/state-store-conformance': minor
'@etherfold/processor-entities': patch
---

`@etherfold/state-store`: `SnapshotAwareStateStore.bootstrap` now REPLACES whatever the store held, not only a previous install. Once the document's head and floor have been checked (so a refused document still changes nothing), it clears the document's cursor key and wipes the store (`revertTo(-1)`) before writing the floor. A store that indexed itself and is behind the snapshot (which `bootstrapFromSnapshot` installs over) used to get the floor's live rows laid on top of its own: a row the chain had deleted before the floor survived as a stale row, and a floor at or below the store's own tip was refused by `applyBlock`. Clearing the cursor means a download cut short over such a store leaves no cursor, so the next boot installs again rather than indexing on from the old cursor over the snapshot's rows.

`@etherfold/state-store-patch`: `revertTo(keepUpTo < 0)`, the wipe, no longer needs reverse patches: it empties the store even after a prune, where it used to throw `RevertBeyondPatchHistoryError`. This is what lets a snapshot install (and `EntityEventProcessor.reset()`) wipe a long-running patch store.

`@etherfold/state-store-conformance`: three new cases in "bootstrapping from a snapshot": an install over a pruned self-indexed store answers every read as a fresh install of the same document does (with and without history, including a floor at or below the store's own tip), and a document refused before a write leaves the self-indexed store exactly as it was.

`@etherfold/processor-entities`: documented that `bootstrapFromSnapshot` replaces a store that is behind rather than catching it up.
