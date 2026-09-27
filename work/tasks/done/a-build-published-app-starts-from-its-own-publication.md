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

## Decisions

- **The test lives in the CLI package, which gains `@etherfold/browser` and `fake-indexeddb` as dev dependencies.** The CLI suite already has the fixture bundles, the fake chain and the `build` harness, so the publisher side runs exactly as in the other CLI tests. The tab side uses the browser's public API, the same way `snapshotOnlyMode.test.ts` does. Alternatives: put it in the browser package and add `etherfold`, `@libsql/client` and `remote-sql-libsql` there, which would mean reaching into the CLI's test fixtures; or use the `event-processor-nfts` example, which isn't a test surface at this level. This touches `packages/cli/package.json` and `pnpm-lock.yaml` only; there's no dependency cycle because the browser package doesn't depend on the CLI.
- **The publisher's source comes from `--deployments`, not from the bundle's `contractsDataPerChain`.** The task names `--deployments`, and taking the source from a separately loaded folder is what makes "the two hash the same" a real check.
- **"A revert inside it" is tested as `revertTo` on the tab's installed store, not as a chain reorg.** A cut at `tip - finality` puts every block at or below it outside any tab's reorg window, so the fetcher can never trigger a reorg below the cut. The history's user-visible value is "as of" reads and reverts down to the floor, so that's what the test checks, with a `none` snapshot as the control.
- **The guide drops the old snippet that passed in the publisher's processor identity by hand (`SNAPSHOT_PROCESSOR_IDENTITY`).** A tab running a module while naming the bundle's hash is the injected identity ADR-0095 refuses. The guide now points to the lower-level `openAndBootstrap` form in one paragraph, with the identity of the processor the tab actually runs.
- **ADR-0028's closing bullet now reads "Only the consuming half was built here", and says the publishing half is ADR-0095, built as `etherfold publish` / `build --publish`.** I re-pointed the citation there rather than leaving a sentence the code now contradicts. The decision in ADR-0028 is unchanged.
