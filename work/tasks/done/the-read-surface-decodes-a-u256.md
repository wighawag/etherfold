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

## Decisions

- **The value type comes from the registry, not from a separate lookup table.** `SemanticValue<Name>` extracts the value type from each registered type's own definition (for `u256`, the `bigint` its `decode` returns). The registry literal uses `satisfies`, so adding a type name without a definition fails to compile. The public `SEMANTIC_TYPES` export keeps its wide `SemanticType<unknown, unknown>` type, so no caller changes. The alternative was a hand-written `{u256: bigint}` map next to the registry, which is a second description that could drift. This adds one new exported type name to `@etherfold/state-store`.
- **The browser test fixture gained a `u256` field (`token.tokenId`) rather than a new entity.** The value is the event's own `uint256` id. A new entity would have changed the existing assertion on which entities the surface exposes. Making it a shared case means the same claim also runs in the real-browser Playwright run. The fixture's `show()` helper now prints a `bigint` as `12n`, because `JSON.stringify` throws on one. This touches only test fixtures.
- **`@etherfold/browser` gets a patch changeset even though its published source is unchanged.** The type of rows from its public `createPortReadSurface` changes through the `@etherfold/state-store` dependency, so the release notes should say so. The alternative was to rely on the automatic dependency bump alone.
