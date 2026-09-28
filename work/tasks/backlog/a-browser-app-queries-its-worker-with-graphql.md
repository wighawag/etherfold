---
title: 'A browser app queries its worker with GraphQL, as the guide and the reference show'
slug: a-browser-app-queries-its-worker-with-graphql
spec: the-same-query-runs-against-a-worker-and-a-server
blockedBy: [a-worker-host-answers-graphql-over-its-port]
covers: [1, 2, 3, 14]
---

## What to build

Document and demonstrate the query layer end to end. `docs/guide/indexing-in-a-browser-app` gains a section on querying: the read surface for a few entities by id, GraphQL for predicates, ordering and nested relations, the measured bundle cost that decides between them, the same document run against a server with `httpExecutor`, re-querying on the state-moved signal, and the rows-examined bound and its refusal. `examples/browser-reference` runs one GraphQL query against its worker host (a filtered, ordered list with a nested relation, if its processor has one; add a relation to it if that is the honest way to show one), asserted by its `verify/reference.spec.ts`. The docs build passes. Do NOT remove ADR-0099's `accepted, not yet implemented` line: `an-indexeddb-index-serves-the-accessor` lands last and removes it.

## Acceptance criteria

- [ ] The guide documents both read paths, the executors, the bound and re-querying on the state-moved signal; `pnpm docs:build` passes.
- [ ] The browser reference runs a GraphQL query against its worker, asserted by `verify/reference.spec.ts` (run in CI's browser job).
- [ ] Changesets for every published package changed.

## Blocked by

- `a-worker-host-answers-graphql-over-its-port`

## Prompt

> Goal: the query layer documented and shown in the browser reference (ADR-0099). Look at the guide, `examples/browser-reference/`, `workerExecutor` and `httpExecutor`.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Read ADR-0098 and ADR-0099 and the spec `the-same-query-runs-against-a-worker-and-a-server` (in `work/specs/tasked/`), and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.
