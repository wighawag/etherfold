---
title: '`etherfold build --publish <dir>` publishes at the tip it stops at'
slug: build-publishes-at-the-tip-it-stops-at
spec: a-build-publishes-what-a-browser-app-starts-from
blockedBy:
  - publish-writes-a-state-snapshot-a-browser-app-starts-from
  - a-published-snapshot-carries-the-history-it-was-asked-for
  - publish-writes-the-stream-seed-when-asked
covers: [4]
---

## What to build

`build` gains `--publish <dir>`, plus the pass-through `--history` and `--seed`: after it has folded to the tip and before it exits, it runs exactly what `etherfold publish` runs over the same database, so a scheduled job is one step (ADR-0095). It always passes its OWN processor as the expected one, so a build whose final promotion failed (fail-soft) is refused by `publish` rather than publishing the previous processor. A publish failure makes `build` exit non-zero, after the fold has been kept.

## Acceptance criteria

- [ ] `build --publish <dir>` over a fixture chain leaves the same output a separate `publish` over the resulting database writes.
- [ ] `--history` and `--seed` reach the publication.
- [ ] A publish refusal exits non-zero and the folded database is intact, including the case where the build's own processor did not become canonical (forced in the test), which is refused naming both identities.
- [ ] Tests cover the new behaviour, mirroring the existing `build` suites, with the output in a temp directory.

## Blocked by

- `publish-writes-a-state-snapshot-a-browser-app-starts-from`
- `a-published-snapshot-carries-the-history-it-was-asked-for`
- `publish-writes-the-stream-seed-when-asked`

## Prompt

> Goal: the one-step form of publishing (ADR-0095). It must call the `publish` command's implementation, not a second copy of it.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-26. Read ADR-0095 and the spec `a-build-publishes-what-a-browser-app-starts-from`, and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.

## Decisions

- **`--history` and `--seed` on `build` are refused without `--publish`.** The refusal names `--publish`. This follows ADR-0048: a flag is never accepted and then ignored. Alternatives considered: accepting and ignoring them (breaks that rule), or keeping them refused on `build` entirely (breaks the pass-through the task asks for). Touches the `build` row of `OWNERSHIP` in `config.ts`.
- **`--out` stays refused on `build`, and `--publish` is refused on every other command, including `publish`.** Each refusal message says where the flag belongs. The flag name `--publish` comes from the task and ADR-0095; `--out` stays the separate `publish` command's flag. Alternative considered: reusing `--out` on `build`, which would give one flag two meanings. This adds a new input, `publish`, which every command's row in the config table now lists.
- **A build stopped from outside (by signal) publishes nothing.** This matches how such a build already skips its settle and prune: the tip it stopped at is not the tip it was asked to publish. Alternative considered: publishing whatever was folded, which would not be "the tip it stops at".
- **Publishing happens in `build()`, after `prepared.index()`, not inside `driveCycles`.** It therefore runs after the settle and the prune. Tests that drive `prepareIndexing().index()` directly are unaffected. To make this work, `PreparedIndexing` gains `arrived` (the configured bundle and its identity; absent on `node`) and `IndexingDependencies` gains `publication` (`files` and `savedAt` substitutes for tests).
- **The expected processor's declarations are read by loading the build's own bundle bytes, just as `publish -p` does.** The build's already-loaded processor is not reused. This keeps a single code path. The trade-off: a test that injects a module with synthetic bundle bytes cannot use `--publish`. That affects tests only.
- **`describePublication` takes an optional command name**, so `build` prints `etherfold build: PUBLISHED ...`. The rest of the printed report, including the pinned content hash, is identical to `publish`'s.
