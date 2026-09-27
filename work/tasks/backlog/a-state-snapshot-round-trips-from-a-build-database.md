---
title: 'A state snapshot round-trips from a build database, in format 2'
slug: a-state-snapshot-round-trips-from-a-build-database
spec: a-build-publishes-what-a-browser-app-starts-from
blockedBy: []
covers: [2, 8, 12]
---

## What to build

Replace the entity snapshot format with format 2 (ADR-0095) and make it round-trip from a real database. Format 2 is: a small head (format, the processor identity that computed the rows, the block the rows are AS OF, the history floor, the resume position), then, per entity, its declaration once and its rows as column-ordered arrays at the FLOOR, then the changes of every later block up to the CUT as the same columnar mutations under each block's pointer; newline-delimited and gzipped. In this task the floor is always the cut (`none`): the live rows at one block and no later blocks; the history option is `a-published-snapshot-carries-the-history-it-was-asked-for`.

Two halves, both in this task so it is demoable. The PRODUCER is a read over the SQLite backend (`@etherfold/state-store-sqlite`), not over the seam, which has no list-everything read by design (ADR-0021): given a libSQL database and a generation (ADR-0053 namespace), it answers every live row as of a block, and the snapshot is built from that plus the generation's identity and a resume position. The CONSUMER is the existing install (`bootstrap` in `@etherfold/state-store`, via `bootstrapFromSnapshot` / `openAndBootstrap` in `@etherfold/processor-entities`), now reading format 2 by replaying its blocks through `applyBlock`, streaming: it installs chunk by chunk without holding the whole document.

Format 1 is REMOVED, not kept beside it: it was never published (the comment on `ENTITY_SNAPSHOT_FORMAT` says so). This changes the published `createSnapshot` / snapshot types of `@etherfold/processor-entities` and `@etherfold/state-store` (minor changesets) and the snapshot cases of `@etherfold/state-store-conformance`, which migrate to format 2 in this task. The first line of a format-2 document is still the snapshot's own small metadata (what `SnapshotHead` names today), so a location's separate head URL keeps its meaning. A document of format 1, or of any unknown format, is refused as `unreadable-format`, as today (ADR-0040).

## Acceptance criteria

- [ ] A database folded by a real entity processor, exported at a block and installed into a fresh store, answers every read exactly as the source database answers the same read AS OF that block (asserted over every declared entity, including a row deleted before the block, which must be absent).
- [ ] The install streams: it never materialises the whole row set, asserted with a document larger than one chunk.
- [ ] The installed store reports the snapshot's block as its floor and refuses a revert under it (ADR-0028), as format 1 did.
- [ ] A snapshot computed by another processor is refused by name (`processor-mismatch` / `SnapshotProcessorMismatchError`), and a format-1 or unknown-format document is refused as `unreadable-format`.
- [ ] Every backend that installs a snapshot today installs format 2 (the IndexedDB and SQLite stores and the patch store), each covered by its existing snapshot suite or the conformance suite.
- [ ] Tests cover the new behaviour, mirroring the existing snapshot and bootstrap suites.

## Blocked by

- None: can start immediately.

## Prompt

> Goal: format 2 of the entity state snapshot (ADR-0095) and a producer that reads it out of a libSQL database, round-tripping into a fresh store. Vocabulary: a generation's state is its own table namespace (ADR-0053); the versioned SQLite store keeps every version with the block range it is valid over, so an as-of read at a block is what the producer uses. Look at the snapshot type and `bootstrap` in `@etherfold/state-store`, `createSnapshot`, `bootstrapFromSnapshot` and `openAndBootstrap` in `@etherfold/processor-entities`, and the SQLite backend's own queries. Test at the store seam, with a real SQLite database folded by a real entity processor.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-26. Read ADR-0095 and the spec `a-build-publishes-what-a-browser-app-starts-from`, and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.
