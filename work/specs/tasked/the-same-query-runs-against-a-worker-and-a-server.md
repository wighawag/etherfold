---
title: 'The same query runs against a worker and a server'
slug: the-same-query-runs-against-a-worker-and-a-server
taskedAfter:
  - a-second-writer-writes-nothing
  - a-declaration-a-schema-can-be-built-from
  - the-indexer-runs-in-a-worker-and-the-tab-talks-to-it
  - a-reader-learns-when-the-state-moved
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **Tasked 2026-09-28.** Its decisions (and their reasons) moved to ADR-0099; what to build moved to the tasks with `spec: the-same-query-runs-against-a-worker-and-a-server`.

## Problem Statement

An app that indexes in the browser and an app that reads from a hosted indexer should be the same app. Today they cannot be. The browser has `createReadSurface`: typed off the declarations, four reads, no predicate, no ordering, by ADR-0021's deliberate design. The server has `/status`, which its own README calls "the WHOLE query surface for now, deliberately", plus `createQuerySurface`, whose richer half takes a **raw SQL predicate** (`{where: 'owner = ?', args: [a]}`). So an app either writes to two different read APIs, or writes SQL strings it cannot run in a browser.

GraphQL is already decided as the answer for the hosted case, on measured evidence: Hono, then Yoga, then Pothos, built programmatically from the same declarations, no SDL and no deploy-time codegen. Five spikes, one behaviour suite, all running on Node and Bun and building on Workers. What was never decided is what happens when the indexer is in the user's own browser, and answering it "later" is what produces two APIs.

The instinct is that the browser case is a transport problem, and it is not. Transport is the easy part. Three things are hard, in this order: the browser substrate has no query planner (ADR-0021 exists because IndexedDB has none), the two paths will silently disagree about `bigint`, errors and failure modes unless something forces them to agree, and a query is many reads while the indexer is writing underneath it.

There is also a gap on the server that is easy to miss because a research table lists it as done: `buildWhere`, `attachToOne`, `attachToMany` and `queryInterface` exist in the research repo's `example/`, not in the shipped packages. The resolvers have nothing to call yet on either side.

## Solution

**Three layers, decided separately, and the middle one is where the work is.**

**The accessor seam is the central decision.** One interface the resolvers call: find the rows of an entity matching a predicate, ordered, bounded, current or as of a block. SQL implements it by generating SQL. IndexedDB implements it by scanning, and later by an index. Get this seam right and the resolvers, the schema and every client are written once; get it wrong and the resolvers fork per backend, which is the exact outcome "one query mechanism" exists to prevent. It is also what lets the browser improve later without touching anything above it.

**The schema is one, built programmatically from the declarations**, in a runtime-neutral module both tiers import. A capability a deployment cannot serve is a **refusal**, never a silently ignored argument, and never a different schema: one schema means one typed client, and a coded error means the difference between two deployments is documented and testable rather than discovered.

**The transport is a `QueryExecutor`, not a `fetch`.** A function from `{query, variables, operationName}` to a result. Three implementations: HTTP for a remote indexer, a `MessagePort` for a worker that holds the store, and in-process for tests. A `fetch` shim is derivable in a few lines for client libraries that only accept one, and most do not even need it: urql takes `fetch` on the client, Apollo takes a custom `ApolloLink`, and Houdini's `fetch` plugin already takes a handler of exactly this shape. Deliberately not a service worker: intercepting `fetch` makes the read path depend on service-worker lifecycle (install, activate, scope, update races, hard-refresh bypass, contexts with no service worker at all) and hides the seam from the type system, where an injected executor is explicit and testable.

**Two rules make "the same query" true rather than aspirational.** Every executor serialises identically, including `bigint`, error codes and what a transport failure looks like. And every operation pins one block and resolves every field as of it, so a query cannot straddle a block or a promotion.

## User Stories

1. As an app developer, I want to write one GraphQL document and run it against a browser worker or a hosted indexer, so that offline, hotseat and single-player builds are the same source as the hosted build.
2. As an app developer, I want to choose which executor to inject at startup, so that "runs locally" is a deployment choice rather than a code change.
3. As an app developer, I want to use my own GraphQL client, so that etherfold does not pick urql, Apollo or Houdini on my behalf.
4. As an app developer using a client that only accepts a `fetch`, I want a shim, so that the seam being an executor costs me nothing.
5. As an app developer, I want the browser executor to return exactly what the server one returns for the same query, byte for byte, so that pointing my app at a server cannot break it.
6. As an app developer, I want `uint256` to arrive the same way on both, so that a value is not a native `bigint` locally and a decimal string remotely.
7. As an app developer, I want a query the local deployment cannot serve to fail with a coded error naming what it could not do, so that I learn it in development rather than from a user.
8. As an app developer, I want the same coded error for a retention refusal on both paths, so that `BlockNotRetainedError` handling is written once.
9. As an app developer, I want a transport failure to have a defined shape, so that I do not write different error handling for the mode that can return a 500 and the mode that cannot.
10. As an app developer, I want every response to say which generation answered it, so that I can compare it across deployments without parsing it.
11. As an app developer, I want one operation to return a coherent snapshot, so that a parent and its children cannot come from different blocks and render a state that never existed.
12. As an app developer, I want that guarantee to hold across a reorg, so that a query cannot mix the abandoned branch with its replacement.
13. As an app developer indexing in the browser, I want the GraphQL runtime in the worker bundle, so that it is off the first-paint path.
14. As an app developer, I want to know the browser payload cost up front, so that I can decide whether an app takes GraphQL locally or stays on the generated read surface.
15. As an app developer, I want a `where` on a declared field in the browser, so that a list view does not have to fetch everything and filter in my component.
16. As an app developer, I want an `orderBy` on a declared field in the browser, so that pagination is stable.
17. As an app developer, I want the browser to refuse rather than degrade past a declared bound, so that a growing dataset produces an error I can act on rather than a UI that gets slower every week.
18. As an app developer, I want a nested relation to cost one batched read rather than one read per row, so that a hundred-child collection is not a hundred round trips.
19. As a user with the app open in two tabs, I want the tab that is not indexing to answer queries normally, so that a second tab is not a broken tab.
20. As a maintainer, I want one accessor seam both backends implement, so that resolvers are written once and a backend improvement needs no change above it.
21. As a maintainer, I want the browser's scan path and its index path to be provably equivalent, so that adding the index is an optimisation rather than a second set of answers.
22. As a maintainer, I want a query conformance suite both executors pass, so that "one query mechanism" is checkable rather than asserted.
23. As a maintainer, I want each browser-side refusal asserted in that suite, so that every difference between the two deployments is documented rather than discovered.
24. As a maintainer, I want the schema module to import nothing runtime-specific, so that one schema really is one schema.
25. As a maintainer, I want parsed and validated documents cached in the worker, so that with no network to hide behind, `parse` and `validate` are not the hot path.

## Out of Scope

- **Subscriptions and live push**, which is the state-moved signal (ADR-0083, including the `repointed` announcement): a client re-queries on it.
- **Making the declaration expressive enough for a graph** (`a-declaration-a-schema-can-be-built-from`). Without it every generated type is flat, which removes the two rows GraphQL wins on in the research's own matrix. A dependency, not a detail.
- **Hosting the indexer in a worker**, which is built (ADR-0082): a worker host holds the store, and the port already carries the read surface (`createPortReadSurface`).
- **The writer guard** (`a-second-writer-writes-nothing`), which this depends on.
- **Leader election** (`one-tab-indexes-and-the-others-read`), which decides which tab writes. This spec only needs a reader.
- **The bigint codec**, which is `a-declaration-a-schema-can-be-built-from` (ADR-0098: `u256` as a semantic type ordered by its big-endian bytes).
- **A two-dimensional index for `block:` plus `where`.** Filtering by value and by version validity at once is a range no B-tree answers in one scan, which is why graph-node reaches for GiST in Postgres and why the SQLite design falls back to two integer columns plus a partial index. The current-plus-delta path sidesteps it rather than solving it, and that is deliberate: its cost is churn since the pinned block, which is the right model for a reader near the tip and the wrong one for an analytical query deep in history. Making the deep case fast is not in scope.
- **Scheduling a prune.** The bound above leans on retention meaning something, and today no host in the repository calls `prune` at all, so retention refuses reads and reclaims nothing. Its own spec: `a-configured-window-is-actually-pruned`. A dependency in spirit and not in tasking order, since this spec refuses past its bound either way.
- **Changing the browser's retention default.** Tempting to bound it at the finality depth and wrong for a measured reason: event-bearing blocks are median 429 apart, so a 64-block window holds zero or one of them. That decision belongs with the prune spec above.
- **wasm SQLite in the browser.** ADR-0024 criterion 5 is literally "query shapes IndexedDB cannot serve", so this spec is the most likely future trigger for revisiting it. Not triggered by rung 1 or rung 2.
