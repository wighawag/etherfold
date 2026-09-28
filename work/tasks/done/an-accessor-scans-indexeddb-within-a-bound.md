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

## Decisions

- **The as-of delta walks the `upper` index only, not `lower` as well.** The task says to reconcile both indexes over `above(B)`. But each current record already carries `lower`, so the tip scan drops rows whose live version opened above B without reading the `lower` index. A version live at B that has since changed must have closed above B, so it is always in the `upper` index. Walking `lower` too would add every entity's inserts since B to the delta's cost and change no answer. The trade-off ADR-0099 accepts still holds: `upper` is keyed across every entity, the refusal message and README say so, and a test asserts it. The alternative was walking both indexes literally. This touches how many rows count against the bound on the delta, and rung 2 (`an-indexeddb-index-serves-the-accessor`) will inherit it.
- **The bound applies to each scan separately, not to a query's total.** The entity's tip scan, each parent's children scan, and the as-of delta are each held to the bound on their own. So an as-of query can be refused for its delta alone, with a message that says it was the delta. A relation page of many parents is answered as long as each parent is within the bound, which is my reading of "Relations are N bounded key-range scans". The alternative was one counter across the whole call, which would refuse a large legitimate page. This touches how the GraphQL layer should read a refusal on a nested field. It is asserted in `test/accessor.test.ts` and documented on `IndexedDBAccessorOptions`.
- **The bound is configured on `store.accessor(options)`, not on the store's options.** It belongs to the accessor, not to storage (ADR-0099), and this keeps `accessor()` parallel to SQLite's. The returned `IndexedDBAccessor` also reports it as `rowsExaminedBound` so a deployment can show it, which extends the seam's `Accessor` type for this backend only. A bound that is not a whole number of at least 1 is refused when the accessor is built. That refusal is a plain `Error`, like the planner's, not a new coded error.
- **The in-memory filter and comparators stay private to `@etherfold/state-store-indexeddb`.** The previous task left open whether they belong in the seam package. Nothing else needs them yet (rung 2 lives in this package), so I kept `@etherfold/accessor`'s public API unchanged. Hoisting them later is easy.
- **The 25,000 default is asserted as the value the accessor reports, not by writing 25,001 rows.** That write takes over a minute under `fake-indexeddb` and would time out the gate. The refusal path itself is tested by the shared suite at a configured bound of 60.
- **I widened the import-guard regex in `stays-a-primitive.test.ts` to see imports written across several lines.** It was already the test I had to edit. Without the fix, the new multi-line `@etherfold/accessor` import was never checked at all. The SQLite copy is left alone and recorded as an observation.
- **The browser evidence files in `docs/spikes/indexeddb-row-backend-browser-default/results/` were regenerated from a full three-engine run.** A filtered run would have overwritten them with partial results. They now include the accessor case.
