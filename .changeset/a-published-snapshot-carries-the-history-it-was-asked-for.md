---
'@etherfold/state-store': minor
'@etherfold/state-store-sqlite': minor
'@etherfold/processor-entities': patch
'@etherfold/server': minor
'etherfold': minor
---

A published state snapshot carries the history it was asked for (ADR-0095).

`@etherfold/state-store-sqlite`: `produceStateSnapshot(store, {at, processor, history})` takes `history: 'none' | 'all' | <depth>` (a `SnapshotHistory`, default `'none'`). `none` puts the floor at the cut; a depth `N` puts it `N` blocks below the cut, clamped at the first block the generation recorded; `all` puts it there. Like the cut, a floor on a height carrying no logs points at the highest recorded block at or below it. The document then carries the rows live at the floor and every later recorded block's changes up to the cut, read off the version ranges by the new `VersionedStateStore.changesAt(block)` (a block's NET change: one upsert or delete per id it touched) over `recordedBlocksBetween(after, upTo)`. A floor below what the database still retains is refused with `HistoryNotRetainedError`, naming both blocks, rather than shortened: `VersionedStateStore.retainedFrom()` answers the higher of the handle's configured retention floor and the floor the database's last prune pass ran at, so a publisher that opens a database another process pruned is not fooled by its own `unbounded` handle. A depth that is not a whole number of blocks is refused.

`@etherfold/state-store`: `recordedPruneFloor(record)` reads the floor a prune pass recorded. `SnapshotAwareStateStore.bootstrap` over a store that already carries a snapshot origin wipes it first (`revertTo(-1)`) once the new document's head and floor are checked, so an install a download cut short part-way (the floor and some later blocks, no cursor) is replaced by the next boot's install instead of refusing it for offering blocks the store already holds.

`@etherfold/processor-entities`: documentation of what a part-way download leaves, now that a snapshot may carry several blocks.

`@etherfold/server`: `producePublication` takes `history` and reports it on the `ProducedPublication`; a history below what the database retains is refused as `history-not-retained`.

`etherfold`: `etherfold publish --history <all|blocks|none>` (default `none`) chooses how much history the published snapshot carries, and the report prints it with the floor. Every other command refuses the flag by name, and a value that is not `all`, `none` or a whole number of blocks is refused.
