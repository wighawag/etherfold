---
title: 'A tab starts from a publication index'
slug: a-tab-starts-from-a-publication-index
spec: a-build-publishes-what-a-browser-app-starts-from
blockedBy:
  - a-state-snapshot-round-trips-from-a-build-database
  - publish-writes-a-state-snapshot-a-browser-app-starts-from
  - publish-writes-the-stream-seed-when-asked
  - a-tab-runs-a-published-processor-bundle
covers: [2, 3, 7]
---

## What to build

One browser option points a tab at a published PUBLICATION INDEX (`publication.json`, ADR-0095), as a LIST of locations it fails over between, as the snapshot bootstrap fails over between mirrors today. The tab reads the index and picks the STATE SNAPSHOT entry for its own GENERATION: its processor identity AND its stream digest, which is its source and stream config. It starts from it through the existing bootstrap (the snapshot-only mode). It installs the STREAM SEED entry for its own stream ONLY when the app asks for the seed; by default it downloads the snapshot alone, so an app with a small state over a long history pays only for the state.

Keyed by generation because a tab keeps an installed snapshot only when the cursor's source and stream-config hashes match its own (`IndexerGeneration.load` otherwise discards it and indexes from the start block). So an index with an entry for this PROCESSOR but another stream is reported by name (the publisher's contracts or finality differ from the app's) and nothing is installed; it is never installed and then discarded.

An old build (an older processor identity) finds its own, older entry and starts from it, then indexes forward. No entry for this generation, and an unreachable index, are reported as outcomes on the existing status surface and the tab indexes from the chain as it does today with no snapshot.

## Acceptance criteria

- [ ] A tab whose generation has an entry starts from that snapshot and indexes forward from its block, and the state is KEPT across the first load (not discarded as a changed processor).
- [ ] A tab with an OLDER processor, whose entry is older, starts from its own entry, never from the newer processor's.
- [ ] An entry for the same processor over ANOTHER stream (a different source or finality) is refused by name, and nothing is downloaded beyond the index.
- [ ] By default no seed is fetched even when the index lists one (asserted on the requests made); with the seed asked for, it is installed.
- [ ] No entry for this generation, and an unreachable index (all locations), are reported and fall back to indexing from the chain; a second location is used when the first is unreachable.
- [ ] Tests cover the new behaviour, mirroring `snapshotOnlyMode.test.ts` and the seed status suites.

## Blocked by

- `a-state-snapshot-round-trips-from-a-build-database`
- `publish-writes-a-state-snapshot-a-browser-app-starts-from`
- `publish-writes-the-stream-seed-when-asked`
- `a-tab-runs-a-published-processor-bundle` (both edit the browser's generation options and hosts)

## Prompt

> Goal: the browser side of the publication index (ADR-0095). It composes the existing snapshot bootstrap and seed install; it does not replace them. The index's shape is whatever `publish-writes-a-state-snapshot-a-browser-app-starts-from` and `publish-writes-the-stream-seed-when-asked` wrote: read their tests.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-26. Read ADR-0095 and the spec `a-build-publishes-what-a-browser-app-starts-from`, and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.
