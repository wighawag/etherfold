---
title: 'The same query answers byte for byte the same on a SQLite and an IndexedDB executor'
slug: the-same-query-answers-the-same-on-both-backends
spec: the-same-query-runs-against-a-worker-and-a-server
blockedBy: [an-accessor-scans-indexeddb-within-a-bound, a-graphql-schema-is-built-from-the-declarations]
covers: [1, 5, 6, 7, 8, 12, 22, 23]
---

## What to build

A query conformance suite in `@etherfold/graphql`, parameterised by an executor factory, exactly parallel to `@etherfold/state-store-conformance`: one list of `{query, variables, expected}` cases run against an executor over a SQLite-backed accessor and one over an IndexedDB-backed accessor, asserting identical rows and identical SERIALISATION (the four parity rules of ADR-0099: `bigint`/`u256`, error codes, transport-failure shape, `extensions.generation`). Every capability the browser cannot serve, the bound refusal and `BlockNotRetainedError` appear as asserted refusals with the same code on both. Include nested relations, enums, `u256` ordering and an as-of query. Do NOT remove ADR-0099's `accepted, not yet implemented` line: `an-indexeddb-index-serves-the-accessor` lands last and removes it.

## Acceptance criteria

- [ ] The suite passes against both executors with byte-identical results for every case, including nested relations, enums, `u256` and as-of.
- [ ] Every refusal (bound, retention, unservable capability) is asserted with the same code on both.
- [ ] Changesets for every published package changed.

## Blocked by

- `an-accessor-scans-indexeddb-within-a-bound`
- `a-graphql-schema-is-built-from-the-declarations`

## Prompt

> Goal: the query conformance suite (ADR-0099). Look at `@etherfold/state-store-conformance` for the parameterised shape, the schema module and `localExecutor`, and the two accessor implementations.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Read ADR-0098 and ADR-0099 and the spec `the-same-query-runs-against-a-worker-and-a-server` (in `work/specs/tasked/`), and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.
