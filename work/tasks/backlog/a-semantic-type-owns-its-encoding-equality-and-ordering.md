---
title: 'A semantic type owns its encoding, equality and ordering, with u256 as the first'
slug: a-semantic-type-owns-its-encoding-equality-and-ordering
spec: a-declaration-a-schema-can-be-built-from
blockedBy: [a-declaration-names-an-enums-values]
covers: [4, 18]
---

## What to build

The semantic-type REGISTRY, with no backend work: a field may declare `{storage, as}` (for example `{storage: 'blob', as: 'u256'}`) beside the bare storage classes, and a semantic type defines a canonical encode, a decode, an equality and an ordering (ADR-0098). `u256` is the first and only member: encoded as big-endian fixed-width bytes (32 bytes), so the bytewise order of the encoding IS the numeric order; decoded to a `bigint`; refusing a negative value or one wider than 256 bits at encode. `FieldType` stays the four storage classes; a declaration naming an unknown semantic type, or a storage class the type cannot be encoded in, is refused at declaration time. Unit tests cover encode/decode round trips at the boundaries (0, 1, 2^64, 2^256 - 1) and that the bytewise order equals the numeric order. Backends do not use it yet: that is `every-backend-stores-a-u256-canonically`. Do NOT remove ADR-0098's `accepted, not yet implemented` line: `the-browser-index-orders-a-u256-numerically` lands last and removes it.

## Acceptance criteria

- [ ] `{storage, as}` fields are accepted by the declaration type and validation; an unknown semantic type or an incompatible storage class is refused at declaration time.
- [ ] `u256` round-trips at the boundaries, refuses negative and over-wide values, and its encoded bytes sort in numeric order (asserted over a sample including 9 and 10).
- [ ] Existing declarations are unchanged; changesets for every published package changed.

## Blocked by

- `a-declaration-names-an-enums-values`

## Prompt

> Goal: the semantic-type registry with `u256` (ADR-0098); no backend changes in this task. Look at the declaration type in `@etherfold/state-store` and at `docs/spikes/a-multientry-index-over-computed-field-keys/` for the measured bytewise ordering.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Read ADR-0098 and the spec `a-declaration-a-schema-can-be-built-from` (in `work/specs/tasked/`), and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.
