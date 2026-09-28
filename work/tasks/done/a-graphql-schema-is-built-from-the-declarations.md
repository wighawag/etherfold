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

## Decisions

- **The block number comes from the host as `QueryContext.tip()`.** Why: the sync cursor is opaque by design (ADR-0027) and the store seam has no tip read. I called it `tip` rather than `head` because `CONTEXT.md` already uses "head" for a snapshot's head, and the codebase already says "the tip". So the refusal code is `tip-moved-during-operation`, not "head moved". Considered: parsing the cursor (breaks ADR-0027) or adding a tip read to `StateStore` (outside this task's scope). Touches: the HTTP and worker tasks, which must supply `tip`.
- **The context can be an object or a function returning one per operation.** Why: `CONTEXT.md` says reads re-resolve the canonical pointer once per unit of work, so a query must not straddle a promotion. Considered: object only. Touches: the server task.
- **`QueryContext.asOf` (defaults to true) supports stores that answer no historical reads.** Why: pinning by block would refuse every query on a `revert-only` store, so those read the latest state and treat any tip movement as a tear (retry once, then refuse). Considered: refusing GraphQL on such stores entirely. It is the same name and meaning as `StateStoreCapabilities.asOf`.
- **The reorg guard is exactly the ADR's.** Only a move below the pin (or any move when not pinned by block) triggers the retry. Limitation, stated in the code comment: a reorg that goes below the pin and back above it between the two reads is not detected.
- **New error codes, all kebab-case to match the accessor's `rows-examined-bound`, which is passed through unchanged:**
  - `invalid-query` covers parse, validation, bad variables and argument refusals;
  - `block-not-retained`, `block-not-yet-indexed` (a `block` above the pin), `tip-moved-during-operation`, `internal-error` and `transport-failure`.
  - A field error with no known code is masked as `Unexpected error.`, so storage text never leaks through a transport.
  - Touches: the query conformance suite and the server's error formatting.
- **Transport-failure reasons:** `http-status` (with `status`), `invalid-body`, `network`, `port-closed`, `host-gone`. It is returned as a result, never thrown. Touches: the HTTP and worker executors.
- **Schema naming and shape:**
  - The type name is the entity name capitalised. Each entity gets one root list field named exactly as the entity (no plural, following ADR-0098's reason for declaring `as`).
  - `first` is required with no default, as the accessor requires.
  - Lists are returned as plain lists, so the accessor's `truncated` flag is not exposed.
  - `block` is only on root fields; nested collections inherit their parent's block.
  - Combinators are `_and` and `_or`, which can never clash with a column since columns cannot start with `_`.
  - `orderBy` is `{field, direction}`. The schema keeps declaration order (`sortSchema: false`).
  - If two generated type names collide (for example entities `pool` and `poolWhere`), the build is refused, naming both.
- **Scalar choices:** `integer` is `SafeInt` (±(2^53 - 1)), because GraphQL's `Int` is 32 bits and would fail on larger values. `blob` is `Bytes` as `0x` hex. The name `SafeInt` follows the `graphql-scalars` library.
- **graphql `^16.14.2`** rather than 17. Pothos 4 and Yoga 5 accept both; 16 is the conservative pick. This dictates the version the server task installs.
- **A `U256` operand is range-checked when the variable is read** (using `u256.encode`), so a negative value is refused as `invalid-query` before any read.
