---
title: 'The same query runs against a worker and a server'
slug: the-same-query-runs-against-a-worker-and-a-server
humanOnly: true
needsAnswers: true
taskedAfter: [a-second-writer-writes-nothing]
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

<!-- open-questions -->
<!--
  TRANSIENT BLOCK — stripped by the apply rung on full resolution.
-->

## Open questions

> **The multiEntry question is CLOSED by measurement.** `docs/spikes/a-multientry-index-over-computed-field-keys/` answers 9 of 9 probes on Chromium, Firefox and WebKit, three runs each, with no engine needing a workaround: rung 2 is viable. What that spike did NOT settle is the write cost, which is now an obligation ON rung 2 rather than a question for this spec.

1. **Does GraphQL REPLACE the generated read surface in the browser, or sit beside it?** The `graphql` runtime is the whole cost: 47.3 KB gzip at the `graphql-http` floor and 86.3 KB with Yoga and Pothos, measured frontend-only, against 16.0 KB gzip for the page bundle that today carries the processor, the generator and every non-SQLite backend. `createReadSurface` costs approximately nothing and is already typed off the declarations. Beside-it means two read APIs and a choice every app has to make; replace means a browser app pays 3x to 5x its current payload for an API whose network cost is zero. The deciding argument is portability of APP code, not of etherfold's, so this is a product call.
2. **Does the transport type admit `AsyncIterable` from day one?** The server's live path is SSE (or a hibernating Durable Object, both built and verified in the research), and the browser's is a local event on block-apply. Subscriptions are out of scope for v1 either way, but the return type either accommodates them now or the seam is refactored later.
3. **What bounds rung 1, and in what unit?** Rows scanned, rows returned, or elapsed time. Rows scanned is the honest one (it is what actually grows), elapsed time is what a user feels, and the two disagree exactly when it matters.
4. **In the browser, is `block:` combined with `where` refused, or served by scanning versions?** The tip path scans 4,072 live rows on the real measured workload; the as-of path scans versions, of which the same workload has 29,393. Refusing is honest and asymmetric with the server; scanning is uniform and unbounded.
5. **Where does the accessor seam live?** `@etherfold/state-store` (neutral, beside `createReadSurface`, and then the seam has a member no backend can implement without a planner) or its own package that both backends and the schema depend on.

<!-- /open-questions -->

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

### Autonomy notes

- **`humanOnly: true`.** Open question 1 is a product decision about what a browser app pays and what API it writes against, and it cannot be taken from the code.
- **`needsAnswers: true`.** Six questions, of which 3 is a genuine unknown needing a spike (engine behaviour cannot be reasoned about), and 1, 4 and 5 change what the tasks are rather than how they are built.
- **`taskedAfter: [a-second-writer-writes-nothing]`.** That spec produces `openForReading`, which is precisely what a non-indexing tab and a query executor hold. Tasking this first would either duplicate that split or build the reader against a store that cannot express reader-ness.

## Implementation Decisions

**The transport.**

```ts
type QueryRequest = {query: string; variables?: Record<string, unknown>; operationName?: string};
type QueryResult = {
  data?: unknown;
  errors?: GraphQLFormattedError[];
  extensions?: {generation: string; block: number};
};
type QueryExecutor = (request: QueryRequest) => Promise<QueryResult>;
```

`httpExecutor(url)`, `workerExecutor(port)`, `localExecutor(schema, context)` for tests, and `executorToFetch(executor)` for client libraries that only accept a `fetch`. The worker executor is forced anyway: the resolvers need the store handle, the store is in the worker, so the schema and the `graphql` runtime live there and the main thread can only hold a stub.

**The accessor seam** is what the resolvers call and what each backend implements: an entity, a predicate over declared fields, an ordering over a declared field, a bound, and either the tip or a block. SQL generates SQL for it. IndexedDB serves it by scanning a key range and filtering in memory (**rung 1**), and later from a real index (**rung 2**). Relations are batched at this seam rather than resolved per row, so an N+1 is not expressible.

**Rung 2 is a real IndexedDB index, not hand-rolled index rows**, and the move is the one `keys.ts` already makes for the entity name: put the FIELD NAME inside the KEY rather than in the key path. One `multiEntry` index on `current`, over a computed array of `[field, value]` subkeys, so a `where` is `IDBKeyRange.bound(["price", lo], ["price", []])` (the `[...prefix, []]` idiom `startingWith` already documents) and an `orderBy` rides the index order instead of sorting in memory. It costs ONE package-level `versionchange`, which `keys.ts` already sanctions as the kind that is allowed ("The schema version is this PACKAGE's, not a processor's"), and a processor declaring another filterable field still needs no migration.

**Rung 2 is MEASURED viable and carries one obligation.** `docs/spikes/a-multientry-index-over-computed-field-keys/` answers 9 of 9 probes on all three engines. Three of them are load-bearing beyond "it works": a record whose key path yields no key is in NO index entry, so an index over `current` is a PARTIAL index over exactly the live set with nothing to maintain (the same mechanism `UPPER_INDEX` already uses); binary subkeys sort bytewise, so a big-endian fixed-width big number orders correctly where the decimal text the store holds today sorts `"10"` before `"9"`; and duplicate subkeys collapse, so a filter cannot double-count a row. The obligation is the WRITE cost: the probe measured tens of percent for three indexed fields per row, with run-to-run variance wider than the gaps between engines, so it establishes that the cost is material and settles nothing more. ADR-0024's own consequences already record that the shipped `lower` and `upper` indexes were added AFTER the 45.6 ms/block figure and never re-measured, so rung 2 needs a real write-path measurement on the real workload before it ships.

**Rung 1 ships regardless.** It is the fallback for any field nobody indexed, and it is the reference the index path is checked against. Bounded and refusing past the bound: a scan that silently gets slower is the failure mode ADR-0015 and ADR-0019 refuse everywhere else.

**Parity is four specific rules**, because each has a way of silently diverging:

- `bigint`: structured clone carries it over `postMessage` and JSON does not, so the in-process executor serialises exactly as the HTTP one. No path is allowed to be "nicer locally".
- Errors: Yoga masks unexpected resolver errors by default and bare `execute()` masks nothing, so both executors share ONE error formatter and one set of codes.
- Transport failures: only the HTTP executor can produce a 500, a non-JSON body or a network error, so the executor contract defines what those normalise to rather than leaving each app to invent it.
- `extensions`: the generation digest is reported on both, as the server's feed views already do, so a consumer compares it and never parses it.

**Every operation pins one block.** Resolve the pinned block once, resolve every field as of it, report it in `extensions`. This is what stops a torn read, and it is nearly free because the store is versioned: point `getAsOf` against point `getCurrent` measured 0.073 ms against 0.055 ms at 10k entities and 0.069 against 0.061 at 100k, effectively flat from 50k to 2M versions. It is not browser-specific: `remote-sql` exposes transactions only as `batch`, so the server has no read snapshot to hold either.

**Pinning alone does not cover a reorg mid-operation**, since the pinned block can be retracted while the query runs. The guard is optimistic: read the cursor at the start and again at the end, retry once if it moved backwards, then refuse. Deliberately not solved by pinning below finality, because serving the unconfirmed tip is the point (`checkTxInclusion` exists so apps can render it).

**In the browser the consistency guarantee is cheaper than on the server**, because one worker owns both the writer and every executor and can serialise a block apply against in-flight operations, which is what `createAction` already does for load, feed and index in core.

## Testing Decisions

- **A query conformance suite**, parameterised by an executor factory, exactly parallel to `@etherfold/state-store-conformance`: one list of `{query, variables, expected}` cases run against the SQL-backed and IndexedDB-backed executors, asserting identical rows, identical serialisation, identical error codes and a present `extensions.generation`. Every capability the browser cannot serve appears in it as an asserted REFUSAL, so a difference is a test rather than a surprise.
- **Rung 1 against rung 2**, same queries, same answers. That equivalence is what makes adding the index an optimisation.
- **The multiEntry behaviour is already measured** (`docs/spikes/a-multientry-index-over-computed-field-keys/`) and the probe file is re-runnable, so a future engine regression is one command away rather than a re-investigation. What is still owed is the WRITE-path measurement on the real workload, against the shipped backend rather than a raw-IndexedDB probe, and it gates rung 2 shipping rather than rung 2 being designed.
- **Torn reads**, without timing: land a block apply in the window between two resolver levels and assert the operation still answers from one block. Removing the pin must turn it red.
- **The schema module's neutrality**, asserted by building it in both runtimes.

## Out of Scope

- **Subscriptions and live push.** The server-side transports are researched and built (SSE on a plain Worker, WebSocket hibernation on a Durable Object); the browser side is a local event. Only the return type question is in scope here, as open question 2.
- **The writer guard** (`a-second-writer-writes-nothing`), which this depends on.
- **Leader election** (`one-tab-indexes-and-the-others-read`), which decides which tab writes. This spec only needs a reader.
- **The bigint codec.** `orderBy` on a `uint256` is wrong on BOTH backends until it lands, because a u256 stored as decimal text sorts lexicographically (`"10" < "9"`), and ADR-0025 parks decoding deliberately. IndexedDB accepts binary keys sorted bytewise, so a big-endian fixed-width buffer converges with the server's sortable-BLOB approach; that is a note for whoever takes the codec, not work here.
- **`block:` combined with `where`, efficiently.** Filtering by value and by version validity at once is a two-dimensional range no B-tree answers in one scan, which is why graph-node reaches for GiST in Postgres and why the SQLite design falls back to two integer columns plus a partial index. Open question 5 decides what the browser does about it; making it fast is not in scope.
- **wasm SQLite in the browser.** ADR-0024 criterion 5 is literally "query shapes IndexedDB cannot serve", so this spec is the most likely future trigger for revisiting it. Not triggered by rung 1 or rung 2.

## Further Notes

The thing most likely to be underestimated is that the resolver layer does not exist yet on EITHER side. The research's mapping table lists `buildWhere`, `attachToOne`, `attachToMany` and `queryInterface` as already built, and they are, in `~/dev/github/wighawag/research/ethereum-indexer-historical-state-db/example/src/`. What ships in `@etherfold/state-store-sqlite` is a raw SQL predicate escape hatch. So the accessor seam is new work on the server too, and that is a reason to be glad rather than sorry: it is being defined once, with a second implementation already in view, instead of being grown SQL-first and then discovered to be unimplementable in a browser.

The bundle number deserves stating plainly wherever open question 1 is answered, because it will be quoted: you cannot make a GraphQL server small, and `graphql-js` is the weight, not Pothos (which costs about 9 KB gzip over raw graphql-js and is cheaper in glue: 133 lines against 138). Schema construction is not a concern at 3.1 ms.

Finally, the reason this spec is worth its size: the transport question people ask first ("can client libraries take a custom fetch?") has the boring answer yes, and answering only that produces two APIs that agree on the happy path and diverge on `bigint`, on errors, on what a `where` means and on whether one query saw one block.
