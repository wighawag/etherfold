---
title: 'A declaration names a child's parent, and every backend refuses one that does not match the ids'
slug: a-declaration-names-a-childs-parent
spec: a-declaration-a-schema-can-be-built-from
blockedBy: []
covers: [1, 2, 13, 14, 15, 18]
---

## What to build

An entity declaration can say that it is the CHILD of another entity: `parent: {entity, as}` (ADR-0098), where `as` names the parent-side collection. The child's leading id columns must BE the parent's whole id, by name and in order, and that is checked at DECLARATION time on every backend identically (memory, SQLite, IndexedDB, patch), the way the identifier and reserved-namespace rules are: a relation whose columns are not the parent's whole leading id, or that names an entity that does not exist, is refused with a message naming both declarations. So is an `as` that collides with a field or id column of the parent, another relation's `as` on the same parent, or a name the generated read surface already uses. A relation implies nothing about writes (no referential check, no write order). A declaration without `parent` means exactly what it means today. A declaration WITH `parent` still round-trips through the snapshot document (`packages/state-store/src/snapshot-document.ts`: its declare line and `sameDeclaration`), so `publish` and a tab's bootstrap keep working for it.

The conformance cases lead: a declared relation's children read back the same on every backend through the existing bounded id-prefix listing with the parent's key as the prefix, and each refusal is asserted on every backend.

The promoted stratagems workload has the one shape the rule refuses: `placement` is keyed `['window', 'ordinal']` and `placementPlayer` `['ordinal', 'position', 'moveOrdinal']`, dropping `window`. Put `window` back in the child's id and declare the relation, keeping its golden-state comparison green (`@etherfold/conformance-workload-stratagems`, `test`, `test:full` and `test:all-backends`, which is where IndexedDB runs the full workload). Do NOT remove ADR-0098's `accepted, not yet implemented` line: `the-browser-index-orders-a-u256-numerically` lands last and removes it.

## Acceptance criteria

- [ ] A declaration with `parent` whose child's leading id columns are the parent's whole id is accepted on every backend, and its children read back identically through the prefix listing on every backend (conformance).
- [ ] A relation whose columns are not the parent's whole leading id (a partial key, wrong order, wrong names), one naming a missing entity, and one whose `as` collides (a parent field or id column, another relation's `as`, a read-surface name) are refused at declaration time on every backend with the same message.
- [ ] An entity declared with `parent` survives a snapshot-document round trip and a snapshot-bootstrap install.
- [ ] Every existing declaration, with no `parent`, behaves exactly as before (existing suites unchanged).
- [ ] The stratagems workload declares `placementPlayer` under `placement` with `window` in its id, and its golden comparison (`test`, `test:full`, `test:all-backends`) still passes.
- [ ] Changesets for every published package changed.

## Blocked by

- None: can start immediately.

## Prompt

> Goal: declared relations, validated at declaration time on every backend (ADR-0098). Look at `EntityDeclaration` and its validation in `@etherfold/state-store`, each backend's declaration handling, `@etherfold/state-store-conformance`, and `packages/conformance-workload-stratagems/src/entities.ts` and `project.ts`.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Read ADR-0098 and the spec `a-declaration-a-schema-can-be-built-from` (in `work/specs/tasked/`), and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.

## Decisions

- **A child must add at least one id column of its own, which also refuses an entity naming itself as parent.**
  - Why: a child keyed exactly by its parent's id has at most one row per parent, so it is not a collection. An entity that is its own parent is that same case.
  - Alternative: allow it, since ADR-0098's wording ("leading id columns are the parent's whole id") does not strictly forbid equal ids.
  - Touches: `normalizeEntities`, and so every backend. It is a new refusal; loosening it later would not break anyone.
- **`as` collisions are compared case-insensitively**, the same way `normalizeEntity` already compares the columns of one row. So `as: 'Epoch'` collides with the field `epoch`, and two relations whose `as` differ only in case collide too.
  - Why: this matches the existing case rule for identifiers, and loosening it later breaks no one, while tightening it later would.
  - Alternative: exact string comparison, since `as` is never a SQL name.
  - Touches: the upcoming tasks `the-read-surface-offers-a-parents-children` and `a-graphql-schema-is-built-from-the-declarations`.
- **The reserved "read-surface names" are exactly `getCurrent`, `getAsOf`, `listCurrent` and `listAsOf`**, the four reads the read surface gives every entity today.
  - Why: the parent's collection is expected to sit beside them on the parent's read surface.
  - Alternative: also reserve names the future GraphQL layer will use, which is not designed yet.
  - Touches: `the-read-surface-offers-a-parents-children`, which may need to extend this list (`READ_SURFACE_NAMES` in `entities.ts`).
- **A relation is part of the declaration a snapshot is checked against.** A document whose entity declares a different relation, or none, is refused on install even though the column layout is the same.
  - Why: this matches the strict equality `sameDeclaration` already uses, and a changed declaration is a different processor bundle anyway.
  - Alternative: ignore `parent` when comparing, because it changes no column.
  - Touches: `publish` and a tab's bootstrap, and it sets the precedent the enum task (`a-declaration-names-an-enums-values`) will follow.
- **The read surface's declaration comparison (`assertDeclaredBy`) now includes the relation, but only when one is declared.**
  - Why: a surface built from a declaration with a different relation would give consumers a different collection. Existing messages stay unchanged.
  - Alternative: leave this to `the-read-surface-offers-a-parents-children`.
  - Touches: that task, and `createPortReadSurface` (it passes the entity across the port as-is).
