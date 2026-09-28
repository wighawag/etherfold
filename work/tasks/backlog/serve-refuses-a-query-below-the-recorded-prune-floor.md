---
title: '`etherfold serve` refuses a GraphQL block below the prune floor recorded in the database'
slug: serve-refuses-a-query-below-the-recorded-prune-floor
blockedBy: []
covers: []
---

## What to build

`etherfold serve` opens the database with no retention of its own (`unbounded`, see the Decisions of `a-server-answers-graphql-over-http`), so its SQLite accessor checks an as-of read only against that claim: `VersionedStateStore.accessor()` in `@etherfold/state-store-sqlite` passes `assertRetained(this.capabilities, ...)`, which knows only the retention THIS handle was configured with. When another process folded the same database with `--retention` and ran a prune pass, the versions closed at or below that pass's floor are gone, and `serve` answers a `block:` below it from partly deleted history: a plausible wrong answer. `retainedFrom()` on the same store already knows both floors (the configured one and the one a prune pass recorded in the `retentionEnforcement` seam record) and `producePublication` relies on it.

Make the SQLite accessor refuse any as-of read below `retainedFrom()` with `BlockNotRetainedError` (GraphQL code `block-not-retained`), keeping the configured-retention refusal it has today (a `revert-only` store still refuses every as-of read). Then check whether the store's other as-of reads that `serve` can reach with a caller-chosen block (`getAsOf`, `listAsOf`, `queryAsOf`, reached through the read tier or the generated surfaces) have the same gap; if they do and share the same check, route them through it in this task, and if they are not reachable from `serve`, say so in your `## Decisions` block instead of changing them.

## Acceptance criteria

- [ ] Through `/graphql` on a running `etherfold serve` (the style of `packages/cli/test/aReadTierAnswersGraphQL.test.ts`): a database folded with a retention window and pruned by the folding process (so `retentionEnforcement` records a floor `F`), then served by `serve` with no retention of its own, answers a query with `block:` below `F` with exactly one error coded `block-not-retained` and no rows, and answers `block: F` (or the lowest block the recorded floor still promises) with the same rows the folding process's own `/graphql` answered for that block before `serve` started.
- [ ] A database that was never pruned is served exactly as today (a test with a block well below the tip still answers).
- [ ] A unit test on the SQLite accessor alone covers the recorded-floor refusal for `find` and for a relation's children read as of a block.
- [ ] Changesets: `@etherfold/state-store-sqlite` (patch), plus `etherfold` or any other published package whose directory you change (patch or minor, never major).
- [ ] CI: if the change stays in `@etherfold/state-store-sqlite`, the CLI and the server (none of which a tab bundles), the PR's CI green as a whole is enough; if it reaches `@etherfold/state-store` or any other package a tab or worker bundles, the PR's `browser (chromium)`, `browser (firefox)` and `browser (webkit)` jobs green are part of done, since dorfl's `verify` gate runs vitest only.

## Blocked by

- None: can start immediately.

## Prompt

> Goal: a read tier that did not write the database still refuses a block the writer already pruned (ADR-0099: "Outside retention it is `BlockNotRetainedError`, the seam's existing refusal"; ADR-0095 for why `retainedFrom` reads the recorded floor). Look at `VersionedStateStore` in `@etherfold/state-store-sqlite` (`accessor()`, `retainedFrom()`, `recordedPruneFloor`, `readRetentionEnforcement`), `sqliteAccessor` (`accessor.ts`, its `assertRetained` context), the `serve` command and its GraphQL serving in the CLI, and how `producePublication` in `@etherfold/server` uses `retainedFrom`. `retainedFrom()` reads a seam record, so avoid reading it more than once per operation if the accessor makes several reads.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Read ADR-0095 and ADR-0099 and the done record of `a-server-answers-graphql-over-http`, and check that the accessor still asserts against `this.capabilities` only. If it has changed, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor, never major). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified `*.bundle.js` files. Tests write only to their own temp databases.
