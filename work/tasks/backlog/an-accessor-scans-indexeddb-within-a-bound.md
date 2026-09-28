---
title: 'An accessor scans IndexedDB within a bound, and answers as of a block from the changes since it'
slug: an-accessor-scans-indexeddb-within-a-bound
spec: the-same-query-runs-against-a-worker-and-a-server
blockedBy: [an-accessor-finds-rows-by-a-predicate-on-sqlite]
covers: [15, 16, 17, 20]
---

## What to build

Rung 1 of the accessor on IndexedDB (ADR-0099), in `@etherfold/state-store-indexeddb`: the entity's key range is scanned and filtered in memory, ordered by the declared field (text as UTF-8 bytes, to match SQLite, not JavaScript's UTF-16 order; `u256` numerically by its canonical bytes; nulls first ascending), limited, and REFUSED past the ROWS-EXAMINED bound (default 25,000, configurable per deployment; ADR-0099) with the accessor's coded error, never a slower answer. The bound is this backend's alone: SQLite answers the same query. As of a block B, it is served as CURRENT PLUS A DELTA: the rows with a version opened or closed above B (the existing lower and upper indexes over `above(B)`) are reconciled against the current scan, merged into the ordered stream, and the limit is cut afterwards; the same bound governs the delta. Those indexes are keyed by block across EVERY entity, so the delta examines the whole database's churn since B, not the queried entity's: an as-of query on a quiet entity can be refused because others changed. Accept that (ADR-0099 records it), and say it in the refusal's message and the package README. Outside retention it is `BlockNotRetainedError`. Relations are N bounded key-range scans. It passes the accessor conformance suite, and runs under the repo's real-browser suite (CI runs it on three engines) as well as `fake-indexeddb`. Do NOT remove ADR-0099's `accepted, not yet implemented` line: `an-indexeddb-index-serves-the-accessor` lands last and removes it.

## Acceptance criteria

- [ ] The IndexedDB accessor passes `@etherfold/accessor`'s conformance suite, identical answers to SQLite for every query within the bound, including text and `u256` ordering, null ordering, as-of via the delta and relation pages.
- [ ] Past the bound (default 25,000, configurable), on the tip scan and on the delta, it refuses with the accessor's coded error naming the bound; outside retention, `BlockNotRetainedError`.
- [ ] Covered in the real-browser suite on Chromium, Firefox and WebKit; changesets for every published package changed.

## Blocked by

- `an-accessor-finds-rows-by-a-predicate-on-sqlite`

## Prompt

> Goal: the IndexedDB rung-1 accessor (ADR-0099). Look at `@etherfold/state-store-indexeddb` (`keys.ts`, the lower and upper indexes, `asOfRange`), the accessor seam and suite `an-accessor-finds-rows-by-a-predicate-on-sqlite` added, and the package's Playwright suite.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Read ADR-0098 and ADR-0099 and the spec `the-same-query-runs-against-a-worker-and-a-server` (in `work/specs/tasked/`), and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.
