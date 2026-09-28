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
