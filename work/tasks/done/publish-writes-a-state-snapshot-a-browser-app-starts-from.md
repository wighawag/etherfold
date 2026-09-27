---
title: '`etherfold publish` writes a state snapshot a browser app starts from'
slug: publish-writes-a-state-snapshot-a-browser-app-starts-from
spec: a-build-publishes-what-a-browser-app-starts-from
blockedBy: [a-state-snapshot-round-trips-from-a-build-database]
covers: [1, 5, 6, 7, 9, 10]
---

## What to build

A new CLI command, `etherfold publish --db <url> --out <dir>`, that writes the CANONICAL generation of a database any command wrote (`build`, `run`, `index`) as a format-2 state snapshot a browser app can start from (ADR-0095), history `none`.

It CUTS at `tip - finality`, not at the tip, and the resume position it writes for the cut must make a consumer re-read exactly the blocks `getFromBlock` and the unconfirmed window call for. The rows come from the versioned store's as-of read at the cut. The store records only blocks that carry logs and `publish` asks no node, so the snapshot's block pointer is the highest RECORDED block at or below the cut (identical rows), while the resume position's `lastToBlock` is the cut itself (ADR-0095).

It takes the processor it is meant to publish (`-p <bundle>`, optional) and REFUSES, naming both identities, a database whose canonical generation is another one: `build`'s final promotion is fail-soft, so without this a failed promotion publishes the old processor while the app ships the new bundle.

THE PRODUCER IS A LIBRARY FUNCTION, and the command is a thin wrapper over it. It lives beside the served database's schema in `@etherfold/server` (which owns `_emissions` and the generation registry tables, and which the CLI already depends on), using the row read from `@etherfold/state-store-sqlite`: the serving hosts (`run`, `node`, `serve`) will answer the same publication over HTTP from the same function, which is the follow-on spec `a-serving-node-publishes-its-own-snapshot`. It takes a database and returns the bodies and the index entries to write; the command writes them to `--out`.

It writes the LAYOUT: the body under a name derived from its content hash, never overwritten; and the PUBLICATION INDEX (`publication.json`) keyed by GENERATION (stream digest and processor identity), where this publication replaces only its own generation's entry and every other entry is kept, so an old build of an app still finds the last snapshot of its own generation. The index is written LAST (write then rename), and nothing any earlier publication wrote is deleted. It is not called a head: `SnapshotHead` / `SnapshotLocation.head` already name one snapshot's metadata (ADR-0095). It prints what it wrote, including the body's content hash.

It refuses, naming why and writing nothing: a database with no canonical generation, one whose canonical generation has folded nothing up to the cut, and one whose canonical generation is not the processor given with `-p`.

> FORWARD-POINTER (conductor, after `a-state-snapshot-round-trips-from-a-build-database` landed as #218): the snapshot producer already exists in `@etherfold/state-store-sqlite` as `produceStateSnapshot(store, {at, processor, cursor})` over `VersionedStateStore.liveRowsAsOf(at)`, and it already applies the highest-recorded-block-at-or-below-the-cut rule (`getBlockAtOrBelow`). The library function in `@etherfold/server` WRAPS it (looks up the canonical generation, computes the cut and the resume position, lays out the bodies and the index); it does not duplicate the row read or the pointer rule. A snapshot is now `{head, document}` (`StateSnapshot`).

## Acceptance criteria

- [ ] A database built over a fixture chain publishes an index and a body; installing the body answers every read as the database does AS OF `tip - finality`.
- [ ] A consumer that installs it and then indexes forward over the same chain neither skips a block nor applies one twice, both when the cut falls on a block that carries logs and when it falls on one that does not (the pointer is then the highest recorded block below it).
- [ ] Publishing twice with the same generation replaces that generation's index entry and leaves the first body in place; publishing a DIFFERENT generation (a promoted successor, or the same processor over another source) adds an entry and keeps the first.
- [ ] Nothing an earlier publication wrote is ever deleted, asserted over three publications.
- [ ] `publication.json` is written last: a reader never sees an index naming a body that is not on disk (asserted by the write order, and by the rename being the last filesystem operation).
- [ ] The refusals write nothing and exit non-zero with a message naming the reason; the `-p` mismatch names both identities.
- [ ] The producer is exported as a library function the command only wraps, and it is tested directly as well as through the command.
- [ ] Tests isolate the output directory in a temp directory and assert nothing is written elsewhere.
- [ ] Tests cover the new behaviour, mirroring the existing CLI command suites (a real libSQL database, a fixture chain).

## Blocked by

- `a-state-snapshot-round-trips-from-a-build-database`

## Prompt

> Goal: the `publish` command (ADR-0095), history `none`, no seed. Use the producer from `a-state-snapshot-round-trips-from-a-build-database`. The CLI's commands open a database through one shared assembly (`openFolding`), and the canonical generation is the registry's `canonical` slot. The stream config's `finality` is what the cut subtracts. Read how `getFromBlock` and a `LastSync`'s unconfirmed blocks decide where a fold resumes before writing the cursor at the cut, and test the no-skip, no-double-apply property directly.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-26. Read ADR-0095 and the spec `a-build-publishes-what-a-browser-app-starts-from`, and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.

## Decisions

- **`publish` does not go through `openFolding`.** It opens the database with `createNodeDB`, applies no schema and reads the registry with `readHeldGenerations`. `openFolding` needs a processor, registers generations and sweeps the registry when it opens it, which are all writes; publish must only read. The alternative was `openFoldingDatabase` plus `openFolding`. This touches `build-publishes-at-the-tip-it-stops-at`, which should call `publish` or `producePublication` rather than go through `openFolding`.
- **Which "tip" is subtracted from.** `tip` is the canonical generation's cursor `lastToBlock` (the block it folded through), not `latestBlock`. Using `latestBlock` could put the cut above what was folded. The resume position keeps the observed `latestBlock`, so a consumer resumes at `min(cut+1, latestBlock - finality)`.
- **Where finality comes from, and a new refusal.** Finality comes from `STREAM_FINALITY` in the environment, as the folding commands read it. It must hash to the stored cursor's config hash, otherwise the publication is refused (`stream-config-mismatch`). A wrong finality would silently cut inside the reorg window. The alternatives were trusting the environment or adding a flag.
- **Where entity declarations come from.** The library asks for them through a `declarationsOf` callback, because column types can't be recovered from a table. The CLI answers from the `-p` bundle, once its identity has been checked, or else from the bundle the generation stores beside its state. If neither exists it refuses (`no-declarations`); this is a new refusal.
- **`--indexer` is refused on `publish`.** Like `serve`, it learns the name from the rows and refuses a database holding several named indexers. The library still accepts an `indexer` option. Refusing now can later become optional without breaking anyone, which is the direction the input rules prefer.
- **`--out` has no environment variable**, and `-p` is optional on `publish`, per the task.
- **Content hash and body name.** The content hash is `sha256:<hex>` over the decompressed document, matching ADR-0066's definition for seeds, so it doesn't depend on how a host serves the file. The body is named `state-<hex>.ndjson.gz`. The body is held in memory in full to hash it, which trades against ADR-0095's streaming goal but is fine at stratagems' state size.
- **Index shape.** It is `{format: 1, snapshots: {<generationDigest>: {stream, processor, body, contentHash, takenAt, floor, cut, savedAt}}}`. A `publication.json` in `--out` that isn't format 1 is refused (`unreadable-index`) rather than overwritten, since overwriting would forget its entries. Unknown top-level keys are kept when merging, which leaves room for the seed task's per-stream entries. This shape is what `a-tab-starts-from-a-publication-index` and `publish-writes-the-stream-seed-when-asked` will read.
- **A `file:` URL naming no file is refused** rather than opened, because opening it would create an empty database nobody named.
- **`@etherfold/server` gains two runtime dependencies**, `@etherfold/processor-entities` (the cursor codec) and `@etherfold/state-store-sqlite` (the row read), as the task requires. Both are platform-agnostic, and the explicit list in the server's platform test was updated with the reason.
