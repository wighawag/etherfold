---
title: 'The browser index orders a u256 numerically, by its bytes'
slug: the-browser-index-orders-a-u256-numerically
spec: a-declaration-a-schema-can-be-built-from
blockedBy: [an-indexeddb-index-serves-the-accessor]
covers: [16]
---

## What to build

The IndexedDB index path (rung 2) orders and ranges `u256` fields by their canonical big-endian fixed-width bytes, which sort bytewise on all three engines (`docs/spikes/a-multientry-index-over-computed-field-keys/`), so an index range and an `orderBy` on a `u256` are numeric and agree with the scan and with SQLite. Asserted in the real-engine run, not only under `fake-indexeddb`, since the ordering claim is the engine's. This is the last task of the spec: REMOVE ADR-0098's `accepted, not yet implemented` status line in the same change and update its Status section to say where it is built.

## Acceptance criteria

- [ ] A `u256` `where` range and `orderBy` through the index are numeric (9 before 10, values past 2^64) and match rung 1 and SQLite, on Chromium, Firefox and WebKit.
- [ ] ADR-0098 no longer carries `accepted, not yet implemented`; changesets for every published package changed.

## Blocked by

- `an-indexeddb-index-serves-the-accessor`

## Prompt

> Goal: `u256` ordering on the IndexedDB index (ADR-0098). Look at the rung-2 index, the `u256` encoding, and the spike folder above.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Read ADR-0098 and ADR-0099 and the spec `a-declaration-a-schema-can-be-built-from` (in `work/specs/tasked/`), and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.
