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

A new runtime-neutral package `@etherfold/graphql` builds ONE GraphQL schema from the entity declarations (ADR-0099, with Pothos over `graphql-js`, as the research measured): an object type per entity, nested collections for declared relations (served by the accessor's batched per-parent reads), enums as GraphQL enums, `u256` as a `U256` scalar carried as a decimal string (JSON has no `bigint`), and list fields taking `where`, `orderBy`, `first` and `block`. The resolvers call the accessor seam only. Every operation pins ONE block, resolves every field as of it, and reports it with the generation digest in `extensions`; a reorg mid-operation is guarded optimistically (cursor read at the start and the end, one retry if it moved backwards, then a coded refusal). One error formatter and one set of codes; a capability a backend cannot serve is a coded refusal. `localExecutor(schema, context)` runs it in process. The `QueryExecutor` contract is defined here, including the ONE transport-failure shape every executor normalises to (an HTTP 500, a non-JSON body, a network error, a closed port, a dead worker host), so the HTTP and worker executors implement it rather than invent it. This task also delivers story 11 of the spec `a-declaration-a-schema-can-be-built-from` (a GraphQL schema with nested types). The module imports nothing runtime-specific, asserted by building it for Node and for a browser target. Do NOT remove ADR-0099's `accepted, not yet implemented` line: `an-indexeddb-index-serves-the-accessor` lands last and removes it.

## Acceptance criteria

- [ ] A schema built from a declaration set with relations, enums and `u256` answers nested queries through the accessor in process, with `extensions.generation` and `extensions.block`.
- [ ] Torn reads: a block applied between two resolver levels does not change the answer (removing the pin turns the test red); a reorg mid-operation retries once then refuses with a code.
- [ ] The executor contract and its transport-failure shape are defined and exported.
- [ ] The module builds for Node and for a browser target with no runtime-specific import; changesets for every published package changed.

## Blocked by

- `an-accessor-finds-rows-by-a-predicate-on-sqlite`
- `the-read-surface-offers-a-parents-children`
- `the-read-surface-decodes-a-u256`

## Prompt

> Goal: the schema module (ADR-0099). Look at the accessor seam, the declaration type (relations, enums, `u256`), `packages/core/src/generation/identity.ts` for the generation digest, and, IF it exists on this machine, the research in `~/dev/github/wighawag/research/ethereum-indexer-historical-state-db/example/src/` (read only that folder) for `buildWhere` / `attachToMany` prior art; it is optional.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Read ADR-0098 and ADR-0099 and the spec `the-same-query-runs-against-a-worker-and-a-server` (in `work/specs/tasked/`), and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.
