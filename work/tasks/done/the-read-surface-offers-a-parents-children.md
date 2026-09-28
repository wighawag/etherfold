---
title: 'The generated read surface offers a parent's children, typed off the declaration'
slug: the-read-surface-offers-a-parents-children
spec: a-declaration-a-schema-can-be-built-from
blockedBy: [a-declaration-names-a-childs-parent]
covers: [3, 7, 10]
---

## What to build

`createReadSurface` (and its port twin `createPortReadSurface`, so a tab reading a worker host gets it too) derives, for every declared relation, the parent-side collection named by `as`: a bounded read of a parent's children with a required limit, served by the existing id-prefix listing (ADR-0021, ADR-0098). The types are derived from the declaration, so renaming a parent's key or the `as` name breaks compilation in every consumer; assert that with type-level tests, since it is exactly what would rot. Do NOT remove ADR-0098's `accepted, not yet implemented` line: `the-browser-index-orders-a-u256-numerically` lands last and removes it.

## Acceptance criteria

- [ ] For a declared relation, the read surface (in process and over the port) returns a parent's children, bounded, identical to the prefix listing.
- [ ] Type-level tests: the collection is typed off the declaration; a renamed parent key or `as` fails to compile in a consumer.
- [ ] The four existing reads are unchanged; changesets for every published package changed.

## Blocked by

- `a-declaration-names-a-childs-parent`

## Prompt

> Goal: the read surface derives a parent's children from the declared relation (ADR-0098). Look at `createReadSurface` in `@etherfold/state-store`, `createPortReadSurface` and `packages/browser/src/host/reads.ts`, and their tests.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Read ADR-0098 and the spec `a-declaration-a-schema-can-be-built-from` (in `work/specs/tasked/`), and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.

## Decisions

- **The collection is an object with `listCurrent` / `listAsOf`, not a single function.**
  - Why: it is the child's listing and nothing more, so it keeps the listing's two reads, names and argument order. Only the prefix is replaced by the parent's key. This keeps the as-of read without adding any new names, so the reserved read-name list stays at four.
  - Alternatives: a tip-only function `players(id, limit)`; a separate `playersAsOf` name, which would need more collision rules; an optional `at` argument.
  - Touches: `a-graphql-schema-is-built-from-the-declarations` and the accessor tasks, if they ever call the read surface.
- **The collection takes the parent's whole id (`EntityIdOf<Parent>`), not any leading part of it.**
  - Why: a shorter prefix covers several parents, and ADR-0098 defines the relation by the parent's whole key.
  - How it behaves: the prefix is built from the parent's declared id columns. A missing column is refused with the parent's name. Extra properties are ignored, so a child column cannot narrow the collection.
  - Alternative: pass the caller's object straight through as the prefix.
  - Touches: nothing outside this surface.
- **A collection is offered only when the parent is also on the surface.** A surface built from a subset of the store's declarations that includes the child but not the parent offers no collection, and the type agrees.
  - Why: the collection lives on the parent's reads.
  - Touches: nothing else.
- **The port composes the collection in the tab instead of adding a new message type.**
  - Why: it is the child's listing, which already crosses the port, and it waits on the same declaration check.
  - Touches: `packages/browser/src/host/envelope.ts`, which stays unchanged.
- **The shared browser test data gains a `block` entity (keyed `blockNumber`, field `hash`) that `readProcessor` writes, with `transfer` declared under it.** The "four reads per entity" test now expects `block` in the surface's keys and `transfers` on `block`.
  - Why: it was the least invasive way to run the in-process vs port equality on a real relation, using the same captured logs.
  - Touches: the Playwright spec `browser/readsAcrossThePort.spec.ts`, which runs the same case list in a real browser. I did not run it here.
- **`createQuerySurface` (`@etherfold/state-store-sqlite`) is left as it is.** It already carries the collections at runtime, but its type does not.
  - Why: the task names only `createReadSurface` and the port surface. Typing the SQLite surface would also mean deciding whether `queryCurrent` / `queryAsOf` become reserved names for `as`.
  - Recorded as an observation instead. Touches `READ_SURFACE_NAMES` in `packages/state-store/src/entities.ts`.
