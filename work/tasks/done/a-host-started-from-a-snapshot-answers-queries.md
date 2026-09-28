---
title: 'A host whose store started from a snapshot answers queries, and refuses below the installed floor'
slug: a-host-started-from-a-snapshot-answers-queries
blockedBy: []
covers: []
---

## What to build

A worker host whose store is opened through `openSnapshotAware` (which the documented `createState` pattern does on EVERY boot, bootstrapped or not: `@etherfold/browser`'s `publication.ts` and `BrowserStateStore.ts` docs) cannot answer GraphQL today. `graphqlQueryHandler` (`@etherfold/graphql/worker`) needs the store's `accessor()` and `tip()`; `ClaimedStateStore` (`openForWriting`) forwards them by feature detection from the store it wraps, but `SnapshotAwareStateStore` (`@etherfold/state-store`, `snapshot.ts`) has neither, so the claimed handle has neither and every query answers `internal-error`. The stratagems port starts from a publication AND queries with GraphQL, so it would hit this first.

Make `SnapshotAwareStateStore` offer the query layer's two reads, keeping its own as-of rules. A store that was never bootstrapped is a pass-through, exactly as its other reads are. A bootstrapped store answers tip reads (no `at`) through the inner accessor unchanged, and every accessor read that carries a block (`at`, including a relation's children read as of a block) is first checked against the NARROWED claim with the same `assertReadable` the seam's `getAsOf` / `listAsOf` use, so a block below the installed floor is refused with `BlockNotRetainedError` (GraphQL code `block-not-retained`), never answered from rows that have no history below the floor (ADR-0095: "The installed store reports the floor as its history floor (ADR-0028), not the cut"). `tip()` delegates to the inner store. Offer `accessor` and `tip` only when the inner store has them (as `ClaimedStateStore` does, since it detects them with `typeof ... === 'function'`), so a memory or patch store under the wrapper still gets the handler's clear "offers no accessor and tip" refusal instead of a failure at call time. The fix belongs in the snapshot-aware store, not in the handler: `graphqlQueryHandler` keeps reading whatever the store offers.

The accessor's type lives in `@etherfold/accessor`, which depends on `@etherfold/state-store`, so the wrapper cannot import it (the same reason `ClaimedStateStore` types it loosely). Wrap the accessor the inner store returns, in `snapshot.ts`, checking every method that takes `at` before delegating, and do NOT change the backends' `accessor()` signatures: `serve-refuses-a-query-below-the-recorded-prune-floor` rewrites the SQLite `accessor()` in parallel, and the snapshot floor is this wrapper's rule, not the backend's. Record how the wrapper enumerates the methods that take `at` (and how it stays correct when the accessor gains one) in your `## Decisions` block.

## Acceptance criteria

- [ ] END TO END: the query conformance suite (`describeQueryConformance`, `@etherfold/graphql/conformance`) passes byte for byte against a worker host (the `workerHosts` fixtures in `packages/graphql/test`, IndexedDB under `fake-indexeddb`) whose store was opened through `openSnapshotAware` and BOOTSTRAPPED from a published state snapshot produced by the real producer (`produceStateSnapshot` / `producePublication`, format 2) before the suite writes. The suite reads the store's capabilities once from a probe, and a bootstrapped store's narrowed window grows with its tip (`SnapshotAwareStateStore.capabilities`): make the subject's claim stable (a floor placed so every case the suite selects is honest, or a suite option that states a floor), record which in `## Decisions`, and weaken no case to make it pass.
- [ ] A query with `block:` below the installed floor, on that host, answers exactly one error coded `block-not-retained` and no rows; a query at the floor and above it answers the same rows the SQLite in-process executor answers for the same data.
- [ ] A host whose store went through `openSnapshotAware` but was never bootstrapped answers the suite exactly as the plain IndexedDB host does (the pass-through case).
- [ ] The reader side of the tab election (a store opened for reading through the same snapshot-aware handle) answers a query too, asserted by one test.
- [ ] Changesets: `@etherfold/state-store` (patch), plus any other published package whose directory you change (patch or minor, never major).
- [ ] CI: dorfl's `verify` gate runs vitest only, so the PR's `browser (chromium)`, `browser (firefox)` and `browser (webkit)` jobs green are part of done (`@etherfold/state-store` is in every tab and worker bundle).

## Blocked by

- None: can start immediately. `port-stratagems-to-the-etherfold-packages` waits for this task.

## Prompt

> Goal: a worker host whose store is snapshot-aware answers GraphQL, and refuses a block below the snapshot's floor instead of answering it (ADR-0099, ADR-0095, ADR-0028). Look at `SnapshotAwareStateStore` and `openSnapshotAware` in `@etherfold/state-store` (`snapshot.ts`: `capabilities`, `assertReadable`, the pass-through when `origin` is undefined), `ClaimedStateStore` in `store.ts` (how it forwards `accessor` and `tip` by feature detection), the IndexedDB and SQLite `accessor()` (each takes an `assertRetained` in its context), `graphqlQueryHandler` in `@etherfold/graphql`'s worker module, the query conformance suite and its `QueryExecutorFactory` contract, `packages/graphql/test/workerHosts.ts`, and `openAndBootstrap` in `@etherfold/processor-entities`. `a-worker-host-answers-graphql-over-its-port` (done) is where the handler came from. `the-tab-bundle-carries-no-graphql-for-the-worker-executor` may be restructuring `@etherfold/graphql`'s worker module at the same time: keep your change in the store, and put new tests in new files, so the two do not collide.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Read ADR-0095, ADR-0099 and ADR-0028, and check that `SnapshotAwareStateStore` still lacks `accessor` and `tip`. If it has changed, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor, never major). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified `*.bundle.js` files.
>
> CI: dorfl's gate runs vitest only. The real-browser suites run in CI's `browser (chromium)`, `browser (firefox)` and `browser (webkit)` jobs; the PR is done only when those three are green too.

## Decisions

- **How the accessor wrapper finds the reads that take a block.** It is a `Proxy` that follows the seam's own rule: every accessor read takes one query object, and a read as of a block puts it in that object's `at` (`ReadAt`). Any method whose first argument has an `at` is checked before it runs. Non-function properties such as `rowsExaminedBound` read through unchanged.
  - Why: a method the accessor gains later is covered as soon as it takes a `ReadAt`, with nothing in the wrapper to update.
  - Alternative: an explicit `find`/`children` list, which would silently answer a new method's historical reads below the floor.
  - Limit: a future read that took `at` as a separate positional argument would not be checked. Nothing in the seam does that today.
  - The check runs on every call, because the handler builds its accessor once per store while the floor can be cleared by a wipe and set by a later bootstrap.
  - Touches: only `@etherfold/state-store`.
- **How the suite's one-time capability read stays stable.** The store underneath keeps a 1-block window (`finalityDepth: 1`), and the snapshot carries exactly one block of history above its floor. So the narrowed claim is `{window, blocks: 1}` from install onward, at every tip the suite reaches.
  - Alternative: a suite option stating a floor. I rejected it because it needs new floor-aware retention cases.
  - Consequence: in the conformance run the inner window, not the snapshot floor, is what refuses. Refusal at the snapshot floor is covered by the separate floor test (on a store that keeps everything) and by the reader test.
- **New suite option `QueryConformanceOptions.snapshotTakenAt`.** One case, "a store holding no block answers every list empty, pinned to no block", can never be honest for a bootstrapped store, because installing a snapshot records blocks. It was the only failure.
  - With the option set, that one case (the only one that writes nothing) is asked with the same request and the same empty lists, pinned to the snapshot's cut instead of `null`. Nothing is skipped and no other case changes.
  - The suite refuses a value that is not a block below 10, the lowest block any case writes. The name follows `SnapshotHead.takenAt`.
  - Alternatives: skip the case (that weakens the suite), or have `tip()` lie. Rejected.
  - Touches: the public `@etherfold/graphql/conformance` API, which is why graphql gets a minor changeset. This goes beyond "keep your change in the store"; the task did name a suite option as allowed, so I recorded it here rather than stopping.
- **`workerHosts.ts` gained an additive `open(store, role)` hook** instead of new tests reaching into its unexported helpers. It is small and additive, but it does touch a file the parallel `the-tab-bundle-carries-no-graphql-for-the-worker-executor` task may also edit.
- **Typing.** `accessor` and `tip` are typed loosely, the same as `ClaimedStateStore`'s (`(options?: never) => unknown`), because `@etherfold/accessor` depends on this package. `tip()` does not update the wrapper's own tracked tip (`knownTip`). A reader's handle can therefore report a narrower window than it can actually answer, which is the safe direction; its floor stays exact.
