---
title: 'An IndexedDB index serves the accessor, measured first and checked against the scan'
slug: an-indexeddb-index-serves-the-accessor
spec: the-same-query-runs-against-a-worker-and-a-server
blockedBy:
  - a-browser-app-queries-its-worker-with-graphql
  - port-stratagems-to-the-etherfold-packages
  - the-listings-id-order-is-decided
covers: [16, 21]
---

## Answered (2026-09-28, by the maintainer)

How a declaration marks a field as indexed for rung 2: **with a LIST on the entity, not a flag on each field**, for example `indexed: ['holds', 'owner']` beside `name`, `id` and `fields`. Existing field shapes (a bare storage class, `{storage, type}`, `{storage: 'text', enum}`) stay unchanged, and the list can later hold multi-field indexes (an entry that is itself a list of fields) without another change to the field shape. Because this becomes part of the declaration API, SQLite must honour it too: the same list creates the matching SQLite indexes, so the declaration means the same thing on every backend (ADR-0098's rule that a declaration change lands on every backend in one change, never one backend at a time).

## What to build

Rung 2 of the IndexedDB accessor (ADR-0099): one `multiEntry` index on the current rows over a computed array of `[field, value]` subkeys, so a `where` is an index range and an `orderBy` rides the index order. IndexedDB orders string keys by UTF-16 code units while ADR-0099 fixes text order as UTF-8 bytes, so text subkeys are encoded as UTF-8 bytes in the computed key (or rung 2 declines text `orderBy` and leaves it to rung 1: decide and record), with a case that puts a supplementary-plane character next to U+E000 to U+FFFF. `u256` fields are `the-browser-index-orders-a-u256-numerically`'s: leave them out of this task's index and its rung-1 versus rung-2 test (`docs/spikes/a-multientry-index-over-computed-field-keys/` measured this viable on all three engines). It costs one package-level `versionchange`, which `keys.ts` sanctions. It is GATED on a write-path measurement FIRST: measure the fold's write cost with and without the index on the real workload (the stratagems conformance workload through the shipped backend, not a raw probe), record it as a finding under `work/notes/findings/`, and if the cost is unacceptable, do not ship the index: rewrite ADR-0099's Status section (and ADR-0098's, whose `the-browser-index-orders-a-u256-numerically` then cannot be built) to say rung 2 was measured and declined, with the numbers, removing both `accepted, not yet implemented` lines, and route to needs-attention so the maintainer confirms. If it ships: rung 1 stays as the fallback for fields nobody indexed and as the reference, and the SAME queries answer identically through rung 1 and rung 2 (a test that runs both). This is the last task of the spec: REMOVE ADR-0099's `accepted, not yet implemented` status line in the same change and update its Status section to say where it is built.

**The `indexed` list, on every backend (if the index ships).** An entity declaration gains an optional `indexed` list naming its fields, as answered above. It is validated at declaration time by `normalizeEntities`, identically on every backend (as the identifier, reserved-namespace and relation rules are): every entry names a field declared in the entity's `fields` (an id column is not a field, and the id already orders the primary key), and no field appears twice; either violation is refused with a message naming the entity and the entry. `NormalizedEntity` carries it. IndexedDB builds rung 2's subkeys only for the listed fields (a field not listed is served by rung 1); a listed `u256` field is accepted and served by rung 1 on IndexedDB until `the-browser-index-orders-a-u256-numerically` adds it to the index (SQLite indexes it from this task on, since its canonical bytes already sort). SQLite creates the matching index for each listed field in its DDL (`ddl.ts`, beside the `open`, `history`, `lower` and `upper` indexes; choose the index shape, for example partial over open versions for tip reads, and record it), so `migrate` on an existing database adds it. Memory and patch accept the list (the shared validation) and have nothing to build. The list survives the snapshot document (ADR-0095): `snapshot-document.ts` writes it on the entity's declare line only when declared, the way `parent` is, so an entity without one keeps the line it always had, and install checks it (`assertDeclaredBy`). If the measurement DECLINES the index, do not add the `indexed` list in this task either: the needs-attention question you route asks the maintainer whether the list should still ship for SQLite alone (the answer above made it part of the declaration API for both backends, on the premise that rung 2 ships).

## Acceptance criteria

- [ ] If the measurement declines the index: nothing ships (no `indexed` list either, pending the maintainer's answer on shipping it for SQLite alone), both ADRs' Status sections say rung 2 was measured and declined (with the numbers) and neither carries `accepted, not yet implemented`, and the task routes to needs-attention for the maintainer to confirm.
- [ ] A finding records the measured write cost with and without the index on the real workload; the decision to ship follows from it.
- [ ] Rung 1 and rung 2 answer the same queries identically (a test runs both), on Chromium, Firefox and WebKit in the real-browser suite.
- [ ] `indexed` validation: a declaration listing an undeclared field, an id column, or the same field twice is refused by `normalizeEntities` with the entity and the entry named, asserted in `@etherfold/state-store-conformance` so every backend runs it; a declaration without `indexed` normalises exactly as before.
- [ ] SQLite honours the list: for an entity with `indexed: [...]`, the database has one index per listed field after `migrate` (asserted by reading `sqlite_master`), an existing database gains it on the next `migrate`, and a `where` on a listed field uses it (asserted with `EXPLAIN QUERY PLAN`).
- [ ] The list survives the snapshot document: a snapshot of an entity with `indexed` round-trips it through publish and install on every backend, an entity without it writes the same declare line as before (the existing snapshot fixtures are byte-identical), and an install whose document's list differs from the store's declaration is refused like any other declaration mismatch.
- [ ] ADR-0098 records the `indexed` list (a list on the entity, not a per-field flag, and why, dated 2026-09-28) in the same change, and `CONTEXT.md`'s **entity declaration** entry names `indexed` beside `parent`.
- [ ] ADR-0099 no longer carries `accepted, not yet implemented`; changesets for every published package changed (patch or minor, never major; the declaration change is minor for `@etherfold/state-store`).
- [ ] CI: dorfl's `verify` gate runs vitest only, so the PR's `browser (chromium)`, `browser (firefox)` and `browser (webkit)` jobs green are part of done.

## Blocked by

- `a-browser-app-queries-its-worker-with-graphql`
- `port-stratagems-to-the-etherfold-packages`: the maintainer drives this index only after the stratagems port.

## Prompt

> Goal: the IndexedDB index behind the accessor, measured before it ships (ADR-0099), with the `indexed` list on the entity declaration that decides which fields it covers, honoured by SQLite too (ADR-0098). Look at `@etherfold/state-store-indexeddb` (`keys.ts`, the rung-1 accessor), the spike folder above, ADR-0024's note that the shipped lower and upper indexes were never re-measured, `normalizeEntities` and `NormalizedEntity` in `@etherfold/state-store` (`entities.ts`, and how `parent` and `enum` were added), `snapshot-document.ts` (the declare line and `assertDeclaredBy`), SQLite's `ddl.ts`, and the conformance group `a declared relation is checked against the ids` as the pattern for declaration-time refusals.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Read ADR-0098 and ADR-0099 and the spec `the-same-query-runs-against-a-worker-and-a-server` (in `work/specs/tasked/`), and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor, never major). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified `*.bundle.js` files.
>
> CI: dorfl's gate runs vitest only. The real-browser suites run in CI's `browser (chromium)`, `browser (firefox)` and `browser (webkit)` jobs; the PR is done only when those three are green too.
