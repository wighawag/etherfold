---
title: 'A GraphQL schema is built from the declarations, and every operation answers from one block'
slug: a-graphql-schema-is-built-from-the-declarations
spec: the-same-query-runs-against-a-worker-and-a-server
blockedBy:
  - an-accessor-finds-rows-by-a-predicate-on-sqlite
  - the-read-surface-offers-a-parents-children
  - the-read-surface-decodes-a-u256
covers: [10, 11, 12, 24]
---

## What to build

A new runtime-neutral package `@etherfold/graphql` builds ONE GraphQL schema from the entity declarations (ADR-0099, with Pothos over `graphql-js`, as the research measured): an object type per entity, nested collections for declared relations (served by the accessor's batched per-parent reads), enums as GraphQL enums, `u256` as a scalar with one serialisation, and list fields taking `where`, `orderBy`, `first` and `block`. The resolvers call the accessor seam only. Every operation pins ONE block, resolves every field as of it, and reports it with the generation digest in `extensions`; a reorg mid-operation is guarded optimistically (cursor read at the start and the end, one retry if it moved backwards, then a coded refusal). One error formatter and one set of codes; a capability a backend cannot serve is a coded refusal. `localExecutor(schema, context)` runs it in process. The module imports nothing runtime-specific, asserted by building it for Node and for a browser target. Do NOT remove ADR-0099's `accepted, not yet implemented` line: `an-indexeddb-index-serves-the-accessor` lands last and removes it.

## Acceptance criteria

- [ ] A schema built from a declaration set with relations, enums and `u256` answers nested queries through the accessor in process, with `extensions.generation` and `extensions.block`.
- [ ] Torn reads: a block applied between two resolver levels does not change the answer (removing the pin turns the test red); a reorg mid-operation retries once then refuses with a code.
- [ ] The module builds for Node and for a browser target with no runtime-specific import; changesets for every published package changed.

## Blocked by

- `an-accessor-finds-rows-by-a-predicate-on-sqlite`
- `the-read-surface-offers-a-parents-children`
- `the-read-surface-decodes-a-u256`

## Prompt

> Goal: the schema module (ADR-0099). Look at the accessor seam, the declaration type (relations, enums, `u256`), `packages/core/src/generation/identity.ts` for the generation digest, and the research in `~/dev/github/wighawag/research/ethereum-indexer-historical-state-db/example/src/` (read only that folder) for `buildWhere` / `attachToMany` prior art.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Read ADR-0098 and ADR-0099 and the spec `the-same-query-runs-against-a-worker-and-a-server` (in `work/specs/tasked/`), and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.
