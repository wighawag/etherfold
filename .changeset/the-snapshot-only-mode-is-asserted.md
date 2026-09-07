---
'@etherfold/browser': patch
---

**The snapshot-only mode is now a named, asserted configuration**: a generation whose state comes from a published state snapshot and which keeps NO stream at all (`keepStream` absent). It is what the reference deployment ran and what most browser apps should reach for, and until now it worked by accident: nothing named it and nothing tested it, so an author choosing it was guessing.

No runtime code changed in this package, and no behaviour changed anywhere. `keepStream` was already optional, the engine already answered `'skipped'` when there was nothing to save, and `bootstrapFromSnapshot` already shipped. What landed is `test/snapshotOnlyMode.test.ts`, which NAMES the mode (`snapshotOnlyClient`) and asserts it end to end against the neighbouring mode -- the same published snapshot and the same events WITH an IndexedDB keeper under them -- across a first run, a reorg inside the finality window and a reload.

The load-bearing claim is proved by READING KEYS rather than by asserting a call did not happen: after each run there is no segment and no cursor record at the address a keeper would have used, and the whole `['stream', ...]` keyspace is byte-for-byte what it was before the run, which is what catches a write under a name the case never chose.

What the mode COSTS is deliberately not documented here: a snapshot-seeded generation is a leaf (ADR-0028's retention floor, and no stream beneath it to re-fold), so a later processor-only change waits for a republished snapshot instead of being free.
