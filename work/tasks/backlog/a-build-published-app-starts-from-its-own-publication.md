---
title: 'An app built and published with the CLI starts from its own publication, end to end'
slug: a-build-published-app-starts-from-its-own-publication
spec: a-build-publishes-what-a-browser-app-starts-from
blockedBy:
  - a-published-snapshot-carries-the-history-it-was-asked-for
  - build-publishes-at-the-tip-it-stops-at
  - a-tab-runs-a-published-processor-bundle
  - a-tab-starts-from-a-publication-index
covers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
---

## What to build

The whole path, asserted end to end and documented: a fixture chain is folded by `etherfold build --publish`, and a tab loads the published processor bundle (`a-tab-runs-a-published-processor-bundle`) and starts from the publication index (`a-tab-starts-from-a-publication-index`). The CLI's source (its `--deployments`) and the tab's source must hash the same, and the test asserts it, because a mismatch is the difference between starting from the snapshot and a refusal.

The PRIMARY case is the shape `port-stratagems-to-the-etherfold-packages` needs: history `none`, no seed. The tab lands on the same state as a tab that indexed the same chain itself, absorbs a reorg inside the finality window, and downloads nothing proportional to the stream. The secondary cases: with `--seed` (a processor-only change re-folds locally) and with a history depth (a revert inside it). And the old-build case: after a new processor is published, a tab still running the old bundle starts from its own entry.

Then update `docs/guide/indexing-in-a-browser-app` so its snapshot and seed sections use this producer instead of saying the publisher is out of scope, and REMOVE ADR-0095's `status: accepted, not yet implemented` line in the same change (`work/protocol/ADR-FORMAT.md`: the last task removes it).

## Acceptance criteria

- [ ] The primary case passes: same state as a self-indexing tab, a reorg absorbed, and no request whose size follows the stream.
- [ ] The seed case, the history case and the old-build case pass.
- [ ] The browser guide documents `build --publish` / `publish` and the publication-index option, including that the app's source and finality must match the publisher's, and `pnpm docs:build` passes.
- [ ] The idea `publishing-snapshots-of-versioned-state` is retired (deleted, with every non-exempt citation re-pointed at ADR-0095), since this delivers it.
- [ ] ADR-0095 no longer carries `status: accepted, not yet implemented`, and its closing Status section is updated to say where it is built.
- [ ] Tests cover the new behaviour end to end, at the level `snapshotOnlyMode.test.ts` and the CLI suites already work at.

## Blocked by

- `a-published-snapshot-carries-the-history-it-was-asked-for`
- `build-publishes-at-the-tip-it-stops-at`
- `a-tab-runs-a-published-processor-bundle`
- `a-tab-starts-from-a-publication-index`

## Prompt

> Goal: prove the feature end to end and close ADR-0095. Every piece is built by the tasks this is blocked by; this task wires them in one test, fixes what the wiring reveals, and updates the guide.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-26. Read ADR-0095 and the spec `a-build-publishes-what-a-browser-app-starts-from`, and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.
