---
title: 'An IndexedDB index serves the accessor, measured first and checked against the scan'
slug: an-indexeddb-index-serves-the-accessor
spec: the-same-query-runs-against-a-worker-and-a-server
blockedBy: [a-browser-app-queries-its-worker-with-graphql]
covers: [16, 21]
---

## What to build

Rung 2 of the IndexedDB accessor (ADR-0099): one `multiEntry` index on the current rows over a computed array of `[field, value]` subkeys, so a `where` is an index range and an `orderBy` rides the index order (`docs/spikes/a-multientry-index-over-computed-field-keys/` measured this viable on all three engines). It costs one package-level `versionchange`, which `keys.ts` sanctions. It is GATED on a write-path measurement FIRST: measure the fold's write cost with and without the index on the real workload (the stratagems conformance workload through the shipped backend, not a raw probe), record it as a finding under `work/notes/findings/`, and if the cost is unacceptable, stop and route to needs-attention with the numbers instead of shipping. If it ships: rung 1 stays as the fallback for fields nobody indexed and as the reference, and the SAME queries answer identically through rung 1 and rung 2 (a test that runs both). Choose how a declaration marks a field filterable and record it. This is the last task of the spec: REMOVE ADR-0099's `accepted, not yet implemented` status line in the same change and update its Status section to say where it is built.

## Acceptance criteria

- [ ] A finding records the measured write cost with and without the index on the real workload; the decision to ship follows from it.
- [ ] Rung 1 and rung 2 answer the same queries identically (a test runs both), on Chromium, Firefox and WebKit in the real-browser suite.
- [ ] ADR-0099 no longer carries `accepted, not yet implemented`; changesets for every published package changed.

## Blocked by

- `a-browser-app-queries-its-worker-with-graphql`

## Prompt

> Goal: the IndexedDB index behind the accessor, measured before it ships (ADR-0099). Look at `@etherfold/state-store-indexeddb` (`keys.ts`, the rung-1 accessor), the spike folder above, and ADR-0024's note that the shipped lower and upper indexes were never re-measured.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Read ADR-0098 and ADR-0099 and the spec `the-same-query-runs-against-a-worker-and-a-server` (in `work/specs/tasked/`), and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.
