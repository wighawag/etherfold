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

## Decisions

- **Added a relation to the reference processor.** I added `account` (id `address`, field `holds`) and `holding` (id `address, id`, parent `account` as `holdings`). A token can change owner, so it can't be a child of its owner; an account's holdings are the honest one-to-many relation here. I kept the existing `token` and `counter` entities so nothing else changes. The alternative was a query with no nested relation, which would drop what the task asks to show. This touches the fake chain in `verify/wallet.ts`, now mints from the zero address to two accounts in turn. No other test depended on the old self-transfers.
- **The typed read surface stays beside GraphQL in the reference.** The counter is still read by id through `createPortReadSurface`; only the list uses GraphQL. That shows the ADR's split (read surface for a few entities by id, GraphQL for predicates) rather than replacing one with the other.
- **The page exposes `holders(min)` on `window.__reference`.** The test calls the page's own document through it, so the test checks the wiring a template would copy rather than a copy of the query.
- **The guide states the tab-side bundle cost as it is today.** It says about 23 KiB gzipped, calls it a known gap, and links the observation. I did not fix `@etherfold/graphql` here, because that changes another task's published package and is outside this task's scope. The alternative was documenting only the 48.3 KiB worker cost, which would understate what an app pays today.
- **No changeset.** Only the private `browser-reference` example, the docs and the lockfile changed, and no published package did. `changeset status` and `check:changesets` both pass.

## Requeue 2026-09-28

Gate-3 BLOCK on PR #251: CI 'browser (chromium)' failed examples/browser-reference/verify/reference.spec.ts:109. '#transfers' reached 5 but '#holders' stayed on a stale intermediate answer ('...0011: 2 (1, 3)') for 30 s. Diagnose first: either overlapping render() calls whose GraphQL answers resolve out of order (an older answer written last; fix by discarding any answer older than the latest render, e.g. a render sequence number), or a query pinned to a block older than the state-moved signal announced (check extensions.block against the signal; if so it is a library bug in the worker query context, fix it there with a test). The reference is a template apps copy, so the fix must make the page correct, not just the test pass. Run the reference's browser verify several times on chromium (repeat-each) before finishing, and change nothing unrelated.
