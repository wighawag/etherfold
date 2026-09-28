---
title: 'Every backend stores a u256 canonically, compares it by value and orders it numerically'
slug: every-backend-stores-a-u256-canonically
spec: a-declaration-a-schema-can-be-built-from
blockedBy: [a-semantic-type-owns-its-encoding-equality-and-ordering]
covers: [5, 6, 15, 17]
---

## What to build

Memory, SQLite, IndexedDB and patch all implement the semantic type `u256`, in THIS ONE TASK (ADR-0098: a half-migrated backend set means one declaration meaning different things on a server and in a browser, which fails silently; do not split it). A `u256` field is stored in its canonical encoding, two writes of the same value are equal whatever the handler passed (a `bigint`, or a canonical or non-canonical decimal string if the write path accepts one: decide and record), reads decode to `bigint`, and a listing or any ordering over it is numeric. The task is done when shared conformance cases for the semantic type pass on all four backends, and the stratagems workload's u256 fields (for example `globalRate`) declare it with the golden comparison still green. Amend ADR-0025 in the same change: its decision is unchanged, its delegation pointer names a task that completed without doing this half, and the declaration now describes what it anticipated. Do NOT remove ADR-0098's `accepted, not yet implemented` line: `the-browser-index-orders-a-u256-numerically` lands last and removes it.

## Acceptance criteria

- [ ] Shared conformance cases for `u256` (round trip, equality across equal values, numeric order with 9 before 10, refusal of invalid values) pass on memory, SQLite, IndexedDB and patch.
- [ ] The stratagems workload declares its u256 fields as `u256` and its golden comparison (fast and full) passes.
- [ ] ADR-0025 is amended; changesets for every published package changed.

## Blocked by

- `a-semantic-type-owns-its-encoding-equality-and-ordering`

## Prompt

> Goal: `u256` in every backend at once (ADR-0098). Look at the registry `a-semantic-type-owns-its-encoding-equality-and-ordering` added, each backend's row encoding and DDL, `@etherfold/state-store-conformance`, ADR-0025, and the stratagems workload's entities.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Read ADR-0098 and the spec `a-declaration-a-schema-can-be-built-from` (in `work/specs/tasked/`), and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.
