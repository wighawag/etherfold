---
title: 'An accessor finds rows by a predicate, ordered and bounded, on SQLite'
slug: an-accessor-finds-rows-by-a-predicate-on-sqlite
spec: the-same-query-runs-against-a-worker-and-a-server
blockedBy:
  - a-declaration-names-a-childs-parent
  - a-declaration-names-an-enums-values
  - every-backend-stores-a-u256-canonically
covers: [18, 20]
---

## What to build

The accessor seam (ADR-0099), in a new package `@etherfold/accessor` that is NOT part of `StateStore` (ADR-0021): find the rows of an entity matching a predicate over declared fields (the operators fixed by ADR-0099: `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `isNull`, combined with `and` and `or`; a comparison with null is false; nulls first ascending and last descending; text compared as UTF-8 bytes, which is SQLite's BINARY collation), ordered by a declared field, with a limit, at the tip or as of a block; and the children of a PAGE of parents through a declared relation, batched in one call and bounded PER PARENT. The seam defines the coded refusal a bounded backend raises past its ROWS-EXAMINED bound (ADR-0099), but the bound is the IndexedDB accessor's alone (`an-accessor-scans-indexeddb-within-a-bound`): SQLite has a query planner and answers. `u256` fields filter and ORDER numerically here (ADR-0098: ordering is the accessor's promise, not the store seam's). This task also delivers story 8 of the spec `a-declaration-a-schema-can-be-built-from` (a nested collection costs one batched read for a page of parents) and its story 6 (numeric `orderBy` on a u256) on SQLite. The package carries the accessor conformance suite, parameterised by a factory, like `@etherfold/state-store-conformance`.

The SQLite implementation lives in `@etherfold/state-store-sqlite` and generates SQL (a relation page is one `IN` query; as-of reads use the versioned store). A memory implementation may be added if it is the cheapest reference for the suite: decide and record. The existing raw-SQL `queryCurrent` / `queryAsOf` stay. Do NOT remove ADR-0099's `accepted, not yet implemented` line: `an-indexeddb-index-serves-the-accessor` lands last and removes it.

## Acceptance criteria

- [ ] `@etherfold/accessor` defines the seam, its coded bound refusal and its conformance suite; the SQLite implementation passes it: every operator, null semantics and null ordering, UTF-8 text ordering, numeric ordering and filtering on `u256` (9 before 10, values past 2^64), limits, tip and as-of, relations batched and bounded per parent (one prolific parent does not starve the others).
- [ ] The conformance suite lets a backend declare a rows-examined bound, and SQLite declares none: a query that would examine many rows is answered.
- [ ] `StateStore` and the handler seam are unchanged; changesets for every published package changed.

## Blocked by

- `a-declaration-names-a-childs-parent`
- `a-declaration-names-an-enums-values`
- `every-backend-stores-a-u256-canonically`

## Prompt

> Goal: the accessor seam and its SQLite implementation (ADR-0099). Look at ADR-0021, `@etherfold/state-store-sqlite` (`queryCurrent`, the versioned tables, `liveRowsAsOf`), the declaration type with relations, enums and `u256`, and `@etherfold/state-store-conformance` for the suite shape.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Read ADR-0098 and ADR-0099 and the spec `the-same-query-runs-against-a-worker-and-a-server` (in `work/specs/tasked/`), and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.
