---
title: 'The same query runs against a worker and a server'
slug: the-same-query-runs-against-a-worker-and-a-server
taskedAfter:
  [
    a-second-writer-writes-nothing,
    a-declaration-a-schema-can-be-built-from,
    the-indexer-runs-in-a-worker-and-the-tab-talks-to-it,
    a-reader-learns-when-the-state-moved,
  ]
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

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

- **No flags.** All six questions are answered, one of them by measurement. The work is ADDITIVE throughout: a new package for the accessor tier, a schema built from declarations that already exist, executors, and two rungs behind the accessor seam. Nothing existing breaks and nothing is migrated, so the cut needs no judgement a tasker does not have. Which surface the guide LEADS with remains a documentation decision, and it is one that can be taken when the guide is written rather than one that gates tasking.
- **`taskedAfter`, four of them, each for a different reason.** `a-second-writer-writes-nothing` produces `openForReading`, which is what a non-indexing tab and a query executor hold. `a-declaration-a-schema-can-be-built-from` is the sharpest: the accessor seam is this spec's central decision, and defining "find the rows matching this predicate, ordered, bounded" against a declaration that cannot name a RELATION would bake that limitation into the one place both backends and every resolver share, so the seam would be re-cut later. `the-indexer-runs-in-a-worker-and-the-tab-talks-to-it` provides the port `workerExecutor` sits on. `a-reader-learns-when-the-state-moved` decides open question 1.

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

`Promise` and not `Promise | AsyncIterable`, settled rather than provisional: liveness is a separate signal (`a-reader-learns-when-the-state-moved`), so nothing streams through here.

A client relates a notification to a query through the block number, which appears on both: pinned per operation and reported in `extensions` here, and carried by the signal there.

`httpExecutor(url)`, `workerExecutor(port)`, `localExecutor(schema, context)` for tests, and `executorToFetch(executor)` for client libraries that only accept a `fetch`. The worker executor is forced anyway: the resolvers need the store handle, the store is in the worker, so the schema and the `graphql` runtime live there and the main thread can only hold a stub.

**The accessor seam** is what the resolvers call and what each backend implements: an entity, a predicate over declared fields, an ordering over a declared field, a bound, and either the tip or a block. SQL generates SQL for it. IndexedDB serves it by scanning a key range and filtering in memory (**rung 1**), and later from a real index (**rung 2**). Relations are batched at this seam rather than resolved per row, so an N+1 is not expressible.

**It lives in its OWN PACKAGE, and the important part is what it must not be: a member of `StateStore`.** Adding a predicate-taking read to that seam would breach ADR-0021, which narrowed it precisely because a handler runs once per event on a substrate with no query planner. Putting the accessor tier inside `@etherfold/state-store`, next to the seam it is deliberately not part of, invites exactly that confusion. Its own package makes the boundary visible, gives it its own conformance suite, and turns the two-tier split that already exists as a convention (`createReadSurface` against `createQuerySurface`) into a structure.

**A relation read is bounded PER PARENT, never per batch.** This is where `a-declaration-a-schema-can-be-built-from` constrains this seam and the detail is easy to get wrong: a relation compiles to a bounded id-prefix listing, so "the children of these N parents" is one `IN` query on SQL and N cheap key-range scans on IndexedDB. Bound the whole BATCH and one prolific parent starves every other parent in the page, which looks correct in a test with three rows and is badly wrong in production. The limit belongs to each parent's collection.

**Rung 2 is a real IndexedDB index, not hand-rolled index rows**, and the move is the one `keys.ts` already makes for the entity name: put the FIELD NAME inside the KEY rather than in the key path. One `multiEntry` index on `current`, over a computed array of `[field, value]` subkeys, so a `where` is `IDBKeyRange.bound(["price", lo], ["price", []])` (the `[...prefix, []]` idiom `startingWith` already documents) and an `orderBy` rides the index order instead of sorting in memory. It costs ONE package-level `versionchange`, which `keys.ts` already sanctions as the kind that is allowed ("The schema version is this PACKAGE's, not a processor's"), and a processor declaring another filterable field still needs no migration.

**Rung 2 is MEASURED viable and carries one obligation.** `docs/spikes/a-multientry-index-over-computed-field-keys/` answers 9 of 9 probes on all three engines. Three of them are load-bearing beyond "it works": a record whose key path yields no key is in NO index entry, so an index over `current` is a PARTIAL index over exactly the live set with nothing to maintain (the same mechanism `UPPER_INDEX` already uses); binary subkeys sort bytewise, so a big-endian fixed-width big number orders correctly where the decimal text the store holds today sorts `"10"` before `"9"`; and duplicate subkeys collapse, so a filter cannot double-count a row. The obligation is the WRITE cost: the probe measured tens of percent for three indexed fields per row, with run-to-run variance wider than the gaps between engines, so it establishes that the cost is material and settles nothing more. ADR-0024's own consequences already record that the shipped `lower` and `upper` indexes were added AFTER the 45.6 ms/block figure and never re-measured, so rung 2 needs a real write-path measurement on the real workload before it ships.

**Rung 1 ships regardless.** It is the fallback for any field nobody indexed, and it is the reference the index path is checked against. Bounded and refusing past the bound: a scan that silently gets slower is the failure mode ADR-0015 and ADR-0019 refuse everywhere else.

**The bound is ROWS EXAMINED, as a declared number, and deliberately not elapsed time.** Time is a property of the DEVICE, so a bound in milliseconds would have a slow phone refusing queries a laptop answers, and it would make the same conformance case flaky depending on what else the machine is doing. Rows examined is deterministic, so a query refuses identically everywhere, which is the property that makes the refusal TESTABLE rather than merely present. It is also the quantity that actually grows, and the one a developer can reason about from their own data model. One number governs both the tip scan and the as-of delta, and the default should be generous against the measured live set of 4,072 rows.

**`block:` combined with `where` is served as CURRENT PLUS A DELTA, not as a version scan.** The rows that differ between a pinned block B and the tip are exactly the rows with a version opened above B or closed above B, and BOTH of those are already indexed range scans in this backend: `LOWER_INDEX` and `UPPER_INDEX` over `above(B)`, which are revert legs A and B, and `asOfRange` already reads one row's version as of a block. So the query runs against `current` through rung 1 or rung 2, the small delta is reconciled against it (rows that matched at B but not now are added, rows that match now but did not at B are removed), the delta is merged into the ordered stream, and the limit is cut afterwards. Cost is the index result plus the CHURN SINCE B, never the depth of history, and no two-dimensional index is needed anywhere. The same declared bound as rung 1 governs it: churn past the bound is refused rather than scanned.

**Outside retention it is `BlockNotRetainedError` and nothing new.** That refusal is the seam's (`assertRetained`), thrown on every backend by the same rule (ADR-0019), so the difference between a browser deployment and a hosted one is a RETENTION CONFIGURATION rather than an API difference, which is exactly what that ADR says it should be. Under a `revert-only` claim the question disappears: `capabilities.asOf` is false, so `block:` is refused wholesale and the browser answers the tip only. Note for whoever implements the bound that retention is currently ADVISORY in practice, since no host schedules a prune (`work/specs/tasked/a-configured-window-is-actually-pruned.md`), so an unbounded browser store makes "churn since B" unbounded for an ancient B and the bound is doing real work rather than being a formality.

**The generated read surface STAYS, and GraphQL is an addition over it.** `createReadSurface` is the seam's four reads typed off the declarations, and it costs no bundle, so deleting it saves nothing an app would notice while retracting a promise its README already makes ("A GraphQL layer is an addition over this, not a refactor of it"). It is also the right answer for an app that reads three entities by id, for which 47.3 to 86.3 KB gzip of `graphql` runtime to say `getCurrent({id})` is absurd. What remains is a DOCS question (which one the guide leads with) and one real technical requirement: `createReadSurface` calls the store directly, so with the store in a worker it only works in the thread that holds it. A small proxy of the store seam over the `MessagePort` fixes that (every method is already async), and it also gives a reader tab the four reads with no `graphql` loaded at all.

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

- **Subscriptions and live push**, which are `a-reader-learns-when-the-state-moved`. The server-side transports are researched and built (SSE on a plain Worker, WebSocket hibernation on a Durable Object); the browser side is a local event. Only consuming that spec's answer is in scope here, as open question 1.
- **Making the declaration expressive enough for a graph** (`a-declaration-a-schema-can-be-built-from`). Without it every generated type is flat, which removes the two rows GraphQL wins on in the research's own matrix. A dependency, not a detail.
- **Hosting the indexer in a worker** (`the-indexer-runs-in-a-worker-and-the-tab-talks-to-it`). This spec assumes a worker holds the store and the schema; nothing does that yet.
- **The writer guard** (`a-second-writer-writes-nothing`), which this depends on.
- **Leader election** (`one-tab-indexes-and-the-others-read`), which decides which tab writes. This spec only needs a reader.
- **The bigint codec.** `orderBy` on a `uint256` is wrong on BOTH backends until it lands, because a u256 stored as decimal text sorts lexicographically (`"10" < "9"`), and ADR-0025 parks decoding deliberately. IndexedDB accepts binary keys sorted bytewise, so a big-endian fixed-width buffer converges with the server's sortable-BLOB approach; that is a note for whoever takes the codec, not work here.
- **A two-dimensional index for `block:` plus `where`.** Filtering by value and by version validity at once is a range no B-tree answers in one scan, which is why graph-node reaches for GiST in Postgres and why the SQLite design falls back to two integer columns plus a partial index. The current-plus-delta path sidesteps it rather than solving it, and that is deliberate: its cost is churn since the pinned block, which is the right model for a reader near the tip and the wrong one for an analytical query deep in history. Making the deep case fast is not in scope.
- **Scheduling a prune.** The bound above leans on retention meaning something, and today no host in the repository calls `prune` at all, so retention refuses reads and reclaims nothing. Its own spec: `a-configured-window-is-actually-pruned`. A dependency in spirit and not in tasking order, since this spec refuses past its bound either way.
- **Changing the browser's retention default.** Tempting to bound it at the finality depth and wrong for a measured reason: event-bearing blocks are median 429 apart, so a 64-block window holds zero or one of them. That decision belongs with the prune spec above.
- **wasm SQLite in the browser.** ADR-0024 criterion 5 is literally "query shapes IndexedDB cannot serve", so this spec is the most likely future trigger for revisiting it. Not triggered by rung 1 or rung 2.

## Further Notes

The thing most likely to be underestimated is that the resolver layer does not exist yet on EITHER side. The research's mapping table lists `buildWhere`, `attachToOne`, `attachToMany` and `queryInterface` as already built, and they are, in `~/dev/github/wighawag/research/ethereum-indexer-historical-state-db/example/src/`. What ships in `@etherfold/state-store-sqlite` is a raw SQL predicate escape hatch. So the accessor seam is new work on the server too, and that is a reason to be glad rather than sorry: it is being defined once, with a second implementation already in view, instead of being grown SQL-first and then discovered to be unimplementable in a browser.

The bundle number deserves stating plainly wherever open question 1 is answered, because it will be quoted: you cannot make a GraphQL server small, and `graphql-js` is the weight, not Pothos (which costs about 9 KB gzip over raw graphql-js and is cheaper in glue: 133 lines against 138). Schema construction is not a concern at 3.1 ms.

Finally, the reason this spec is worth its size: the transport question people ask first ("can client libraries take a custom fetch?") has the boring answer yes, and answering only that produces two APIs that agree on the happy path and diverge on `bigint`, on errors, on what a `where` means and on whether one query saw one block.
