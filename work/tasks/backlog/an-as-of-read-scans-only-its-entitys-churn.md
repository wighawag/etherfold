---
title: "An IndexedDB as-of read scans only its own entity's churn"
slug: an-as-of-read-scans-only-its-entitys-churn
blockedBy: [an-indexeddb-index-serves-the-accessor]
covers: []
---

## What to build

An as-of query on the IndexedDB accessor (`block:` on a GraphQL root field, ADR-0099) examines only the closed versions of the entity it asks about (and, for a nested collection, only those of the parents it asks about), instead of every entity's closed versions since that block.

Today the accessor serves `block: B` as the current rows plus a DELTA: the versions closed above `B`, walked through the `upper` index on the versions store. That index is keyed by `upper` alone, across every entity, so the delta walk visits every version any entity closed after `B` and discards the other entities' in memory (`scanDelta` in `accessor.ts` compares `cursor.primaryKey[0]` with the entity name). Every one of them counts against the rows-examined bound. The guide already warns that "an as-of query on a quiet entity can be refused because other entities changed a lot". On the stratagems workload, 16,046 of 31,332 events write only the three reward entities, so an as-of read of `cell` pays for the reward churn.

The fix is an index whose leading component is the entity: a compound index over `[entity, upper]` on the versions store, so the delta for entity `E` above `B` is the key range `[E, B + 1]` to `[E, +infinity]`. A per-PARENT index for nested collections (`[entity, ...parent id, upper]`) is out of scope: parent id columns differ per entity, so it could not be one fixed `keyPath` and would need a computed value field. The per-entity index alone removes the cross-entity cost; if the finding shows per-parent deltas still matter, it names that as a follow-up task.

What it costs, which is why it is measured first:

- the version record has to carry its entity as a VALUE field (an index `keyPath` cannot reach into an out-of-line primary key, which is where the entity lives today); records written before the upgrade need it too. REWRITE THEM IN PLACE (one cursor walk over the versions store, reading the entity from each primary key) rather than discarding the database: `@etherfold/state-store-indexeddb` is published, so databases worth keeping exist, and a discard costs a tab with no stream keeper and no publication a full backfill a public node often refuses. `keys.ts`'s note that "nobody holds a database worth keeping" no longer holds. Discard only if the measurement shows the rewrite is too costly, and record why. The current `upgrade` creates indexes only when it creates the store, so the new index needs an `indexNames.contains`-guarded branch. EVERY place a version record is written must set the field, or that version silently drops out of the new index: `applyBlock`'s two `versions.put` calls, and `revertTo`'s `cursor.update`, which spreads an existing version (`store.ts`);
- one more index entry is written each time a version closes, which is every overwrite of a live row, on the fold's hot path;
- one package-level `versionchange`.

The prune (`upper` below the floor) and the retention probe keep using the existing `upper` index, which stays.

Seen in the stratagems port (`port-stratagems-to-the-etherfold-packages`): its web app follows the state by re-reading the parts a state-moved signal names, pinned to that signal's block. That keeps each delta small, but only because the block is recent; a view "as of" an older block pays for every entity's churn since.

## Acceptance criteria

- [ ] A finding under `work/notes/findings/` records, on the stratagems conformance workload through the shipped IndexedDB backend in a real browser (not `fake-indexeddb`, which is quadratic on this history), the fold's write cost with and without the index, and the rows an as-of read of a quiet entity examines with and without it. The decision to ship follows from it; if declined, the finding says why and nothing else ships.
- [ ] If it ships: an as-of read of an entity examines only that entity's closed versions above the block (a test where another entity churns heavily and the quiet entity's as-of read stays under a bound the old walk would exceed).
- [ ] As-of answers are identical with and without the index (the accessor conformance suite, and a case that runs both walks), including after a revert (the `revertTo` write path keeps the field).
- [ ] A database written by the previous package version is upgraded IN PLACE (every existing version record gains its entity field and appears in the new index) and then answers as-of reads correctly, with its live rows, history and cursor intact. If the measurement forces a discard instead, the finding says why.
- [ ] If it ships: ADR-0099 gets a dated amendment in the same change (it currently says "An entity-scoped index would fix it at the price of a `versionchange`, and is not added now"), and the delta refusal's message (`deltaRefusal` in `accessor.ts`, which says the delta counts every entity's changes) says what it counts now.
- [ ] Prune and the retention probe are unchanged (their tests pass untouched).
- [ ] The notes that justified discarding old databases (`keys.ts`, near `SCHEMA_VERSION`: "nobody holds a database worth keeping"; `store.ts`, the doc comment above `upgrade`: "a choice for a package nobody has a database of yet") say what is true now.
- [ ] The guide's "The browser refuses past a bound" section no longer says an as-of query on a quiet entity pays for other entities' churn, if that stops being true.
- [ ] A changeset for `@etherfold/state-store-indexeddb` (minor: a schema upgrade).
- [ ] CI: the real-browser jobs (`browser (chromium)`, `browser (firefox)`, `browser (webkit)`) are green.

## Blocked by

- `an-indexeddb-index-serves-the-accessor`: both change the IndexedDB `upgrade` and `SCHEMA_VERSION`, so this one builds its `versionchange` on top of that task's, serialised rather than raced. `the-browser-index-orders-a-u256-numerically` changes them too, and is blocked by THIS task (added to its `blockedBy`), so the three land one after another. That direction because this task always reaches done (its finding ships even when the index is declined), while the u256 task cannot be built if rung 2 is declined.

## Prompt

> Goal: an IndexedDB as-of read examines only the closed versions of the entity it reads, through a compound `[entity, upper]` index on the versions store, measured before it ships. Look at `@etherfold/state-store-indexeddb`: `keys.ts` (`VERSIONS`, `UPPER_INDEX`, `VersionRecord`, `versionKey`, `SCHEMA_VERSION` and its note on how a layout change is handled), `store.ts` (`upgrade`, where versions are closed on overwrite, prune and the retention probe) and `accessor.ts` (`scanDelta`, which walks `UPPER_INDEX` across every entity and filters by the primary key's first component). ADR-0099 describes the rows-examined bound and the current-plus-delta as-of read; ADR-0024 notes the shipped lower and upper indexes were never re-measured; the task `an-indexeddb-index-serves-the-accessor` is the sibling index on current rows, and its write-path measurement is the pattern to follow.
>
> FIRST, check this task against current reality (written 2026-09-29 against `@etherfold/state-store-indexeddb@0.3.0`): if `scanDelta` already narrows by entity, or the sibling index task landed differently than this assumes, do not build on the stale premise: route to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious choice in a `## Decisions` block at the end of your final report (the upgrade path for existing databases above all). Add a changeset for every published package you change (0.x: patch or minor, never major). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified bundles. Do not judge speed on `fake-indexeddb`.
