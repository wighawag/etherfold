---
title: 'A declaration names a child's parent, and every backend refuses one that does not match the ids'
slug: a-declaration-names-a-childs-parent
spec: a-declaration-a-schema-can-be-built-from
blockedBy: []
covers: [1, 2, 13, 14, 15, 18]
---

## What to build

An entity declaration can say that it is the CHILD of another entity: `parent: {entity, as}` (ADR-0098), where `as` names the parent-side collection. The child's leading id columns must BE the parent's whole id, by name and in order, and that is checked at DECLARATION time on every backend identically (memory, SQLite, IndexedDB, patch), the way the identifier and reserved-namespace rules are: a relation whose columns are not the parent's whole leading id, or that names an entity that does not exist, is refused with a message naming both declarations. A relation implies nothing about writes (no referential check, no write order). A declaration without `parent` means exactly what it means today.

The conformance cases lead: a declared relation's children read back the same on every backend through the existing bounded id-prefix listing with the parent's key as the prefix, and each refusal is asserted on every backend.

The promoted stratagems workload has the one shape the rule refuses: `placement` is keyed `['window', 'ordinal']` and `placementPlayer` `['ordinal', 'position', 'moveOrdinal']`, dropping `window`. Put `window` back in the child's id and declare the relation, keeping its golden-state comparison green (`@etherfold/conformance-workload-stratagems`, `test` and `test:full`). Do NOT remove ADR-0098's `accepted, not yet implemented` line: `the-browser-index-orders-a-u256-numerically` lands last and removes it.

## Acceptance criteria

- [ ] A declaration with `parent` whose child's leading id columns are the parent's whole id is accepted on every backend, and its children read back identically through the prefix listing on every backend (conformance).
- [ ] A relation whose columns are not the parent's whole leading id (a partial key, wrong order, wrong names), and one naming a missing entity, are refused at declaration time on every backend with the same message.
- [ ] Every existing declaration, with no `parent`, behaves exactly as before (existing suites unchanged).
- [ ] The stratagems workload declares `placementPlayer` under `placement` with `window` in its id, and its golden comparison (fast and full) still passes.
- [ ] Changesets for every published package changed.

## Blocked by

- None: can start immediately.

## Prompt

> Goal: declared relations, validated at declaration time on every backend (ADR-0098). Look at `EntityDeclaration` and its validation in `@etherfold/state-store`, each backend's declaration handling, `@etherfold/state-store-conformance`, and `packages/conformance-workload-stratagems/src/entities.ts` and `project.ts`.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Read ADR-0098 and the spec `a-declaration-a-schema-can-be-built-from` (in `work/specs/tasked/`), and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.
