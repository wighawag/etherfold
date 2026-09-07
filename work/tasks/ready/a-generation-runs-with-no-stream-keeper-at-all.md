---
title: 'A snapshot-seeded generation with NO stream keeper is a named, asserted mode'
slug: a-generation-runs-with-no-stream-keeper-at-all
spec: a-browser-app-starts-from-a-published-artifact
blockedBy: []
covers: [1]
---

## What to build

The configuration most browser apps should run, asserted end to end for the first time: a generation whose state comes from a published state **snapshot** and which keeps **no stream at all**, indexing forward from the snapshot's block with `keepStream` absent.

Nothing here is a new seam. `keepStream` is already optional, the engine already skips the save when it is missing, and `bootstrapFromSnapshot` already exists. What is missing is that this combination is a supported MODE rather than an accident: nothing names it, nothing tests it, and an author choosing it is guessing. This task makes the mode a named, asserted configuration, and asserts the thing that is easy to assume and never check, that the stream keyspace stays EMPTY.

Assert it the way the repo asserts stream claims: by READING the substrate's keys after the run, never by asserting a function was not called. A spy proves a call did not happen on one path; the keys prove nothing was written on any path, including the load path, the reorg re-scan and a reload.

If building this reveals that some path DOES assume a keeper (a load branch, a reconfigure, a follower), that is the defect this mode's absence was hiding: fixing it is in scope where the fix is small and obviously right. If it turns out to be a design question instead, route to needs-attention rather than inventing an answer.

## Acceptance criteria

- [ ] A test bootstraps a store from a published state snapshot, runs the indexer forward over a fake chain with NO stream keeper wired, and lands on the same state as an equivalent run that indexed the same events with one.
- [ ] The stream keyspace is asserted EMPTY after that run by reading the keys of the substrate a keeper would have used (both the segments and the cursor record), not by asserting a function was not called.
- [ ] The mode survives the paths that are not the happy one: at least a reorg inside the finality window and a RELOAD (reopening the same store and continuing) run with no keeper and still write nothing under the stream keyspace.
- [ ] The mode is NAMED where it is asserted, so a reader looking for "snapshot-seeded, no stream" finds it by that name rather than inferring it from an absent option.
- [ ] Tests mirror the browser package's existing style (per-case database names, the real IndexedDB keeper substrate under `fake-indexeddb`, assertions on what was applied rather than on internals).
- [ ] Tests ISOLATE their storage: every case uses its own fresh database name and asserts nothing about a shared/global one.
- [ ] The repo acceptance gate is green (`pnpm format:check`, `pnpm check:adr`, `pnpm changeset status --since=main`, `pnpm build`, `pnpm typecheck`, `pnpm test`), with a changeset only if a published package's behaviour actually changed.

## Blocked by

- None, can start immediately.

## Prompt

> Make the snapshot-seeded, NO-stream-keeper configuration a first-class, asserted mode of this indexer, and prove the stream keyspace stays empty under it.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `docs/adr/` and the tasks in `work/tasks/done/`? If a premise moved, do NOT build on it, route to needs-attention with the discrepancy.
>
> Vocabulary (`CONTEXT.md`): a **generation** is a stream plus a fold over it; **seeding** is creating a generation from a published artifact instead of backfilling from the node; a state **snapshot** seeds the FOLD and reports a retention floor at its own block (ADR-0028), so a snapshot-seeded generation is a LEAF; the **stream / keepStream (ExistingStream)** seam is the cached raw event stream, and it is OPTIONAL. A **segment** plus its **cursor record** is what a stream keeper writes, addressed hierarchically under `['stream', <indexer-name>, <streamDigest>, ...]`.
>
> Why this mode matters, from `work/notes/findings/what-a-published-stream-seed-costs-to-install.md`: the reference deployment republished a state snapshot a median 1.0 h apart over 357 days, which is what actually makes a browser app start. A stream underneath is a separate, narrower value (a later processor-only change re-folds locally). So this is the DEFAULT path, and it currently works by accident: nothing names it and nothing tests it.
>
> Where to look, by concept rather than by brittle path: the browser package's test suite already drives the hook over a real IndexedDB stream keeper on `fake-indexeddb` (its stream-cache and stream-segment cases), and already has a bootstrap case that starts a store from a published snapshot through `@etherfold/processor-entities`. Its shared test helpers build the hook with or without a keeper, which is exactly the axis this task exercises. The engine's own optionality lives in the core indexer (`keepStream` guards) and its save returns a `'skipped'` outcome when there is nothing to write to.
>
> The load-bearing assertion, stated as external behaviour: after a full run with no keeper, READING the keys of the substrate a keeper would have used finds nothing, neither a segment nor a cursor record. Do not assert a spy. Then show the mode is not merely the happy path: drive a reorg inside the finality window, and reopen the same store as a reload, and assert the same emptiness plus the same applied state.
>
> Done means: a named, asserted configuration a developer can point at, the empty-keyspace claim proven by reading keys, the reorg and reload paths covered, and the acceptance gate green. This task documents nothing (its own task, `the-snapshot-only-mode-is-documented-with-its-trade`, does) and adds no seam.
>
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. The runner transcribes it into the done record; do not write the done record, the commit message or the PR body yourself, and do not open a `decisions-*` note. If you find a path that assumes a keeper and the fix is a design call rather than an obvious repair, route to needs-attention instead of choosing for the project.

## Note on the build pin, resolved

The tasking loop raised one blocking issue against every task in this set: ADR-0065 pinned trust to a
build-named content hash without saying a hash OF WHAT, and over a gzipped artifact that is ambiguous
enough to break every correctly pinned install (a host sending `Content-Encoding: gzip` makes `fetch`
decompress transparently, so a hash over the compressed file cannot be recomputed from what the client
receives). It is resolved at the source: ADR-0065 now carries a 2026-09-07 amendment fixing SHA-256 over
the PUBLISHED BYTES, with the artifact served as an opaque file and never with `Content-Encoding: gzip`.
Build to that; the producer's printed hash must be reproducible from the published file alone.
