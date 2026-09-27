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
- [ ] The install streams the DOCUMENT: it inflates and parses the body incrementally (gunzip and newline-delimited records read chunk by chunk), never holding the whole downloaded or decoded document, and holds at most ONE block's mutations at a time, asserted with a document larger than one chunk. The floor block goes through `applyBlock` as one atomic unit, so a `none` snapshot holds its live rows once while they are written; that is intended (ADR-0095: installing is replaying blocks through `applyBlock`, with no new install path per backend).
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

## Decisions

- **Line format.** The head comes first. Then one `{"declare": name, "id": [...], "fields": [[field, type], ...]}` per entity, which fixes the column order. Each block opens with `{"block": pointer}`, and inside it `{"entity": name}` opens that entity's section. An array is an upsert in column order; `{"delete": [ids]}` is a delete, allowed only above the floor. A `blob` travels as `0x` hex, because JSON has no bytes. The alternative was repeating the entity name on every row, which is what format 1 did wrong. This touches the history task, which fills in the later blocks; decoding them is already built and tested.
- **Head shape.** `takenAt` is the pointer of the last block (the cut), and a new numeric `floor` is the first block. The name `SnapshotHead` is kept, so a location's separate head URL keeps its meaning.
- **`StateSnapshot` now means `{head, document}`**, not an object with a `rows` field. `createSnapshot` returns that pair and `snapshotHead()` is removed. The alternative was returning bare bytes plus an async head reader; the pair is what a mirror and the upcoming `publish` task both need.
- **The `snapshotOrigin` marker has its own format number**, a private constant equal to 1, instead of sharing `ENTITY_SNAPSHOT_FORMAT`. Keeping them shared would have made every store bootstrapped under format 1 refuse to open once the document format moved to 2. This only touches `openSnapshotAware`.
- **New refusal: mismatched declarations.** If a document declares an entity differently from the store (id columns, fields or types), install is refused with a plain `Error` before anything is written. To make "nothing written" true, the floor block is read in full before the marker goes down. The alternative, installing by column name, would silently write nulls into the wrong layout.
- **Where the producer lives.** It is in `@etherfold/state-store-sqlite` (`produceStateSnapshot` over `liveRowsAsOf`), taking the cut and applying ADR-0095's "highest recorded block at or below the cut" rule itself. A cut below every recorded block is refused with a plain `Error` whose message contains "folded nothing". The `publish` task's server-side function (which looks up the generation and builds the cursor for the cut) should wrap this, not duplicate it.
- **`bootstrapFromSnapshot` error mapping.** An HTTP error status is now `unreachable`. A separate head URL that serves non-JSON is now `unreadable-format`; it used to fall into `unreachable`, and ADR-0071 says a reached-but-unreadable document is `unreadable-format`. A download that fails partway through the install throws instead of failing over, because the install has already started. For a `none` snapshot that leaves only the floor marker over an empty store, and the next `openAndBootstrap` bootstraps again.
- **How the streaming test measures.** Node's `DecompressionStream` reads ahead about 128 KB, while browsers apply proper backpressure. So the test asserts a fixed bound on bytes pulled from multi-megabyte documents, not "less than a fraction of the document".
