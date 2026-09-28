---
title: 'A declaration names an enum's values, and every backend refuses a value outside them'
slug: a-declaration-names-an-enums-values
spec: a-declaration-a-schema-can-be-built-from
blockedBy: [the-read-surface-offers-a-parents-children]
covers: [15, 18]
---

## What to build

A field may declare an enum, `{storage: 'text', enum: ['a', 'b']}`: a declared set of values over text, each a legal GraphQL enum name (refused at declaration time otherwise, since ADR-0099's schema maps them one to one), checked at WRITE time on every backend for the cost of a set lookup, refusing a value outside the set with an error naming the field and the allowed values (ADR-0098). The read surface types the field as the union of its values. A field without an enum means exactly what it means today. Conformance cases lead and run on every backend. The snapshot document (`packages/state-store/src/snapshot-document.ts`, ADR-0095) writes each entity's declaration and refuses to install a document whose declaration differs from the store's, comparing field types with `===` in `sameDeclaration` (and printing them in `describe`): an object-shaped field type would be refused on every install. Make the comparison structural for the new shape, and assert that an entity with an enum field survives an `encodeSnapshot` / `readSnapshot` round trip and a snapshot-bootstrap install on every backend (the snapshot conformance fixtures cover only a fixed entity set today, so add an enum case). Do NOT remove ADR-0098's `accepted, not yet implemented` line: `the-browser-index-orders-a-u256-numerically` lands last and removes it.

## Acceptance criteria

- [ ] A declared enum field accepts its values and refuses any other at write time on memory, SQLite, IndexedDB and patch, identically (conformance); a value that is not a legal GraphQL enum name is refused at declaration time.
- [ ] An entity with an enum field survives a snapshot-document round trip and a snapshot-bootstrap install on every backend.
- [ ] The read surface types the field as the union of its declared values (type-level test).
- [ ] Existing declarations are unchanged; changesets for every published package changed.

## Blocked by

- `the-read-surface-offers-a-parents-children` (serialised: both change the declaration type and the read-surface typing).

## Prompt

> Goal: enum fields, checked at write time on every backend (ADR-0098). Look at the declaration type and validation in `@etherfold/state-store`, each backend's write path, `packages/state-store/src/snapshot-document.ts` (`sameDeclaration`, `describe`), and `@etherfold/state-store-conformance` (its snapshot fixtures).
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Read ADR-0098 and the spec `a-declaration-a-schema-can-be-built-from` (in `work/specs/tasked/`), and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.

## Decisions

- **The normalized entity holds the field as declared, not an extra enum map.** A bare field stays `'text'` and an enum stays a frozen `{storage, enum}`. Why: the task says to make `sameDeclaration` structural for the new shape, which assumes this; it keeps one field shape for the later `{storage, type}` addition; and existing normalized entities are unchanged. The alternative was keeping `fields` as storage classes plus a separate `enums` map, which would leave backend layout code untouched but split one field across two places. It touches every place that reads a field's storage class (SQLite table layout and row reader, snapshot encode/decode), which now go through `fieldStorage`.
- **The write check is one shared function, called by each backend where it plans a block.** That makes the refusal the same sentence everywhere and means a refused block writes nothing. The alternative was checking in `MutationContext.set`, but that would miss direct `applyBlock` callers and snapshot installs. Snapshot installs also go through `applyBlock`, so they are checked too.
- **NULL is legal for an enum field.** Every field is nullable, and a whole-row write stores an unlisted field as NULL. Refusing NULL would make enum fields effectively required, which is a new rule the ADR doesn't state. A non-string value (a number or boolean) is refused.
- **The value sets for the lookup are cached outside the normalized entity**, in a module-level WeakMap. The normalized entity stays plain data, which matters because it is compared, serialised and posted across the browser port.
- **Legal enum names follow the GraphQL spec**: a GraphQL name (`/^[A-Za-z_][A-Za-z0-9_]*$/`) that isn't `true`, `false` or `null` and doesn't start with `__`. The task only says "a legal GraphQL enum name", so I read it strictly from the spec. Also refused: an empty enum, a repeated value, storage other than `text` (the ADR says "over text"), and extra keys on the field object. That last one means the later semantic-type task (`{storage, type}`) has to widen `fieldOf` and `isFieldShape`.
- **Enum comparison is order-sensitive.** `describeField` prints values in declared order, so `['open','closed']` and `['closed','open']` count as different declarations for a snapshot install and for `assertDeclaredBy`. This is stricter and matches how id columns are compared. The alternative was set comparison, which fits the word "value set" better but would treat the GraphQL enum order, which is visible to consumers, as meaningless. If you'd rather use set semantics, sort the values inside `describeField`.
- **No snapshot format bump.** `ENTITY_SNAPSHOT_FORMAT` stays 2. Documents without enums are byte-identical, and an enum-bearing document read by an older store is refused by that store's declaration comparison. The document reader also now refuses a field entry that is neither a string nor a `{storage: string, enum: string[]}`.
- **`@etherfold/processor-entities` re-exports `EnumField` and `FieldDeclaration`** beside `FieldType`, following that file's stated intent of being the whole authoring surface in one import. This adds a patch changeset for that package.
