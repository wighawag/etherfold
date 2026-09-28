---
title: 'Every backend stores a u256 canonically, as a bigint at the seam, and a snapshot carries it'
slug: every-backend-stores-a-u256-canonically
spec: a-declaration-a-schema-can-be-built-from
blockedBy: [a-semantic-type-owns-its-encoding-equality-and-ordering]
covers: [5, 15, 17]
---

## What to build

Memory, SQLite, IndexedDB and patch all implement the semantic type `u256`, in THIS ONE TASK (ADR-0098: a half-migrated backend set means one declaration meaning different things on a server and in a browser, which fails silently; do not split it). At the store seam a `u256` is a `bigint`: a handler writes one (`set`), `get` / `getAsOf` / the listings answer one, and each backend holds it internally in its canonical encoding (big-endian fixed-width bytes). A value that is negative, wider than 256 bits or not a `bigint` is refused at write. Two writes of the same value are equal. The seam still orders only ids, lexicographically (ADR-0021): numeric ORDERING over a `u256` field is the accessor's promise (`an-accessor-finds-rows-by-a-predicate-on-sqlite`, `an-accessor-scans-indexeddb-within-a-bound`), not this task's.

The snapshot document (`packages/state-store/src/snapshot-document.ts`, format 2, ADR-0095) carries a `u256` field in its canonical encoding and installs it back as a `bigint`, so `publish` and a tab's bootstrap keep working for a declaration that uses one; its declaration check (`sameDeclaration`, `describe`) compares a `{storage, type}` field structurally, not by reference.

The SQLite raw-SQL tier follows the same rule: `queryCurrent` / `queryAsOf` and `createQuerySurface` (`packages/state-store-sqlite/src/query-surface.ts`) answer a `u256` column as a `bigint`, and a caller comparing one binds the canonical encoding (provide the helper that produces it), so a `where` with a decimal argument is not silently empty; say so in that package's README.

The task is done when shared conformance cases for the semantic type pass on all four backends, and the stratagems workload's u256 fields (for example `globalRate`) declare it with the golden comparison still green. Amend ADR-0025 in the same change: its decision is unchanged, its delegation pointer names a task that completed without doing this half, and the declaration now describes what it anticipated. Do NOT remove ADR-0098's `accepted, not yet implemented` line: `the-browser-index-orders-a-u256-numerically` lands last and removes it.

## Acceptance criteria

- [ ] Shared conformance cases for `u256` pass on memory, SQLite, IndexedDB and patch: a `bigint` written is the `bigint` read (current, as of a block, and in a listing), equal values are equal, invalid values are refused at write, and the stored encoding is the canonical one.
- [ ] A `u256` field survives a snapshot-document round trip and the snapshot-bootstrap conformance case on every backend.
- [ ] SQLite's `queryCurrent` / `queryAsOf` / `createQuerySurface` answer a `u256` as a `bigint`, and a comparison through the documented helper matches (tested).
- [ ] The stratagems workload declares its u256 fields as `u256` and its golden comparison (`test`, `test:full`, `test:all-backends`) passes.
- [ ] ADR-0025 is amended; changesets for every published package changed.

## Blocked by

- `a-semantic-type-owns-its-encoding-equality-and-ordering`

## Prompt

> Goal: `u256` in every backend at once (ADR-0098). Look at the registry `a-semantic-type-owns-its-encoding-equality-and-ordering` added, each backend's row encoding and DDL, `packages/state-store/src/snapshot-document.ts` (`encodeValue` / `decodeValue`), `@etherfold/state-store-conformance`, ADR-0025, and the stratagems workload's entities.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Read ADR-0098 and the spec `a-declaration-a-schema-can-be-built-from` (in `work/specs/tasked/`), and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.
