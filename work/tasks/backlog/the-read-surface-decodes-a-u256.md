---
title: 'The read surface types a u256 as a bigint, in process and across the port'
slug: the-read-surface-decodes-a-u256
spec: a-declaration-a-schema-can-be-built-from
blockedBy: [every-backend-stores-a-u256-canonically]
covers: [9, 10]
---

## What to build

Since `every-backend-stores-a-u256-canonically`, the store seam answers a `u256` as a `bigint`. The generated read surface (`createReadSurface`, and `createPortReadSurface` over a worker host's port) TYPES such a field as `bigint`, derived from the declaration, which ADR-0025 said follows "for free" once the declaration describes it; assert it with type-level tests, since that claim is exactly what would rot. Crossing the worker port keeps it a `bigint` at run time (structured clone carries it; check the port's row codec does not stringify it). Do NOT remove ADR-0098's `accepted, not yet implemented` line: `the-browser-index-orders-a-u256-numerically` lands last and removes it.

## Acceptance criteria

- [ ] A `u256` field reads as a `bigint` from the read surface in process and over the port (run time).
- [ ] Type-level tests: the field is typed `bigint`, derived from the declaration.
- [ ] Changesets for every published package changed.

## Blocked by

- `every-backend-stores-a-u256-canonically`

## Prompt

> Goal: the read surface decodes `u256` (ADR-0098, ADR-0025). Look at `createReadSurface`, `createPortReadSurface` and the port's row codec.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Read ADR-0098 and the spec `a-declaration-a-schema-can-be-built-from` (in `work/specs/tasked/`), and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.
