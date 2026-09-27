---
title: 'A returning tab catches up within a time budget, or starts from the snapshot'
slug: a-returning-tab-catches-up-within-a-budget-or-starts-from-the-snapshot
blockedBy: []
covers: []
---

## What to build

Today a tab that already holds local state never takes a snapshot: `openAndBootstrap` (`packages/processor-entities/src/snapshot.ts`) returns `kept-local` whenever a cursor exists, and the tab catches up from its own cursor however far behind it is. Two things go wrong after a long absence: the node may not serve logs that far back at all (a non-archive public node refuses older ranges, which core reports as the terminal `ArchiveRefusedError`, see `work/notes/findings/what-nodes-answer-when-a-getlogs-range-is-too-big.md`), and even where it does, catching up months of blocks can take far longer than downloading the published state. Decided with the maintainer on 2026-09-27:

1. **The fallback (correctness).** A tab that holds local state and has a usable snapshot for its generation (the publication-index option, or explicit snapshot locations) catches up from its own cursor; if the node refuses the catch-up as `ArchiveRefusedError`, the tab WIPES and starts from the snapshot instead of stopping. The wipe is the install's own (`a-snapshot-install-replaces-a-self-computed-store`: the store is replaced whole, the old cursor cleared). So a tab talking to a node with little history still proceeds. With no usable snapshot, the refusal is reported exactly as today.
2. **The budget (cost), ONE value the app gives.** The option is a TIME: while catching up, the tab estimates how long fetching the rest of the gap will take, from what it has measured so far (blocks covered per request and time per request, or whatever the fetcher already learns), and if the estimate exceeds the budget it abandons the catch-up and starts from the snapshot. The value may also be `'always'` (always index yourself; the snapshot is taken only on a failure such as the archive refusal). etherfold accepts ONE value; choosing it per chain is the APP's business (for example from its deployment tooling's chain info), and etherfold carries no per-chain table. Pick a default budget, state it in the docs, and record why in `## Decisions`.
3. **A fresh tab is unchanged**: with no local state it starts from the snapshot as today.

Where this runs matters: `openAndBootstrap` runs in `createState`, BEFORE indexing, while the catch-up and its failure happen DURING indexing, after the store is claimed. So switching from catching up to the snapshot mid-run is the core of this task: design it at the seam where the generation indexes (the browser's `IndexerState` / the generation's load and index loop), so the store is wiped and installed through the existing install and indexing resumes from the snapshot's cursor, with the switch reported on the existing status surface (a new outcome naming why: `archive-refused` or `over-budget`, with the estimate and the budget). Do not add a second install path.

Record the decision as a new ADR (`docs/adr/0096-...`, `work/protocol/ADR-FORMAT.md`), citing ADR-0095 and ADR-0028, and update `docs/guide/indexing-in-a-browser-app` (the option, its default, `'always'`, and that per-chain values are the app's to choose).

## Acceptance criteria

- [ ] A tab with local state behind a published snapshot, whose node refuses the catch-up as an archive refusal, ends on the snapshot's state and indexes forward from its cursor; the status reports `archive-refused`.
- [ ] The same tab with no usable snapshot reports the refusal as today and installs nothing.
- [ ] A tab whose estimated catch-up exceeds the budget switches to the snapshot, reporting `over-budget` with the estimate and the budget; a tab whose estimate fits catches up and downloads no snapshot body (asserted on the requests made).
- [ ] With `'always'`, a tab catches up however long the estimate, and still falls back on an archive refusal.
- [ ] A fresh tab (no local state) starts from the snapshot as before; a tab already at or ahead of the snapshot is untouched.
- [ ] After a switch, no block is skipped or applied twice (asserted as in the publish suites), and the state equals a fresh install of the same snapshot indexed forward.
- [ ] The ADR and the browser guide are written; `pnpm docs:build` passes; changesets for every published package changed (0.x: patch or minor).

## Blocked by

- None: can start immediately.

## Prompt

> Goal: a returning tab catches up within a time budget, or starts from the snapshot; and falls back to the snapshot on an archive refusal (see What to build). Look at `openAndBootstrap` / `bootstrapFromSnapshot` in `packages/processor-entities/src/snapshot.ts`, the publication option in `packages/browser/src/publication.ts` and `IndexerState.ts`, `ArchiveRefusedError` in `packages/core/src/errors.ts`, what `RangeLogFetcher` learns about spans and timing, and `SnapshotAwareStateStore.bootstrap` (which already wipes). Test at the level `aTabStartsFromAPublicationIndex.test.ts` and `snapshotOnlyMode.test.ts` work at, with a fake chain that refuses old ranges and a clock you control.
>
> FIRST, check this task against current reality. If the mid-run switch cannot be done without a second install path or a change to a published seam that this task does not name, route to needs-attention with the discrepancy rather than inventing one.
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.

## Decisions

- **The switch re-runs the app's `createState` with `replaceLocal: true`, and `openAndBootstrap` gains `replaceLocal`.** Why: the install is app code; `@etherfold/browser` depends on no entity runtime and must not grow a second install path. Alternatives: calling `SnapshotAwareStateStore.bootstrap` from the hook (a second install path, which the task forbids); deciding in `openAndBootstrap` before indexing (it can't know about a refusal or the throughput yet). Touches: the `createState` contract (apps must forward `published.replaceLocal`, or the switch installs nothing and the tab carries on as before), `PublicationSnapshot`, `BootstrapOptions`. Recorded in ADR-0096.
- **Mid-run rebuild means reopening the whole container.** The hook disables and detaches the old container, then calls `openIndexer` again with the same registry and factories. Why: the core container has no way to swap a held generation's store, and `updateProcessor` clears the old processor's store, which is the same database, so it would erase the install. Limits: the switch happens only while the container holds just the one generation `init` built (it would otherwise drop a successor), is tried once per `init`, and never happens on a demoted tab.
- **Default budget: 30 seconds (`DEFAULT_CATCH_UP_WITHIN_SECONDS`).** Why: it is a wait a user sits through looking at stale state, and a snapshot is sized by the state, not the history (a fraction of a MB on the reference deployment), so installing one takes seconds. Alternatives: a shorter budget would abandon catch-ups that were about to finish; a longer one leaves stale state on screen past the point an app reads as broken.
- **Option name and unit: `catchUpWithinSeconds`, in seconds.** It mirrors the existing `claimWithinSeconds`. Overlap: the existing `catchupThreshold` / `catchingUp` are presentation knobs about how close to the tip counts as "latest", a different concept; I kept "catch up" because it is the same everyday meaning (behind the tip).
- **How the estimate is computed.** It is measured in the hook's loop: blocks the canonical generation covered divided by the time taken (fetching and folding) since the container opened, applied to the remaining gap to the tip. It is only measured while the cursor is still behind the snapshot. Alternative: reading `RangeLogFetcher`'s learned range, which is internal and does not track time.
- **The switch is reported as a new `switched` status on `syncing.publication`.** That is the existing surface for what the publication gave the tab. Alternatives: a new field, or putting it in `error`. It is an ordinary outcome, so `error` is wrong.
- **An invalid budget is refused when the indexer is created.** A negative or non-finite `catchUpWithinSeconds` throws; `0` is allowed. Why: silently reading it as `'always'` or as zero would pick one of two opposite behaviours.
- **Detected by the error's name, not `instanceof`.** The archive refusal is recognised by `name === 'ArchiveRefusedError'`, the same way `isRetryable` works, so a duplicated copy of `@etherfold/core` in a bundle can't break it.
- **Scope reduction: explicit snapshot locations without the `publication` option are not covered.** The task text mentions them, but the hook has no way to know such a snapshot exists or where it stands. Recorded under considered options in ADR-0096.
- **Main-thread host only.** The worker hosts (`host/serve.ts`) don't read a `publication` at all today, so the switch exists only where the publication option does. Recorded under consequences in ADR-0096.
