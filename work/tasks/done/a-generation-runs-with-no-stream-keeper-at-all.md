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

## Note on the build pin, superseded

The tasking loop raised one blocking issue against every task in this set: ADR-0065 pinned trust to a
build-named content HASH without saying a hash of what. That is settled, but not the way the first
amendment settled it. **ADR-0066 supersedes ADR-0065 on the trust anchor and the byte domain**, and a
builder should read it before either:

- **Trust is the HOST the build NAMES**, not a content hash. A build cannot pin the hash of a ROLLING
  artifact, and rolling is how this is deployed: the reference deployment held one web build against a
  snapshot republished every hour. `bootstrapFromSnapshot`, the path that already ships and works,
  verifies no hash at all.
- **A content hash is OPTIONAL**, for a release-tied immutable artifact, where it is the strongest
  thing available. When present it is SHA-256 over the DECOMPRESSED octets, taken after transfer
  decoding and before `JSON.parse`.
- **There is NO hosting constraint.** The earlier rule forbidding `Content-Encoding: gzip` is
  withdrawn: hashing the decompressed octets is transport-invariant, so it does not matter whether a
  host serves the file opaque or compresses it in transit.
- **Same-origin is not a condition anywhere**, and the refusal it once justified is gone. The app may
  be served from any IPFS gateway while the artifact lives on a known host, so the two origins never
  match by construction.

## Decisions

**A patch changeset for `@etherfold/browser`, although no behaviour changed.** The task says a changeset only if a published package's behaviour actually changed, and nothing's did — this is tests plus a test-helper type widening. But two enforced repo rules meet here: `pnpm changeset status --since=main` (in the gate) fails outright once a package's files change with no changeset added since main, and `packages/core/test/pendingChangesets.test.ts` REFUSES an empty front matter ("`changeset version` consumes the file and writes it nowhere, so the note is silently lost"). So the escape hatch changesets itself prints (`changeset add --empty`) is closed in this repo by design. I first wrote the empty changeset, found that test, and switched to a patch naming `@etherfold/browser`, whose body states plainly that no runtime code changed and why the entry exists. Alternatives considered: the empty changeset (refused by the repo's own test), and no changeset at all (red gate at land time, a bounce). Precedent for this exact shape: `.changeset/the-gate-does-not-assume-an-idle-machine.md`, a test-config-only change that took a patch across every package with the same disclaimer. What it touches: the release plan (`@etherfold/browser` 0.8.0 → 0.8.1 whenever a release is next cut) and nothing else; it also means the acceptance criterion's "changeset only if behaviour changed" reads as unsatisfiable in this repo for any change that touches a package's `test/` folder, which a future task may want to reconcile in `CONTEXT.md`'s Conventions.

**The snapshot is published at block 102, below the block the reorg replaces.** A snapshot carries no history under its own block, so `revertTo` under the snapshot origin is refused (`RevertBeyondSnapshotError`). The reorg case retracts block 104 (revert to 103), so a snapshot at the branch tip — which is what `entityBootstrap.test.ts` publishes — would have made the reorg case assert that this mode cannot survive the very reorg it has to survive. 102 is also inside the finality window the publisher's own cursor carries, which is what lets the resumed client re-read blocks 100 and 102 without applying them twice. What it touches: nothing in the product; it is a fixture choice, documented at `SNAPSHOT_TIP`. It does however state a real constraint on the mode that the documentation task (`the-snapshot-only-mode-is-documented-with-its-trade`) may want to carry: a publisher must take its snapshot at least the finality depth behind the tip, or a client bootstrapped from it cannot absorb a reorg reaching under it. `bootstrapFromSnapshot`'s optional `finalityDepth` is the client-side half of that and is already built.
