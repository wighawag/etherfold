---
status: accepted, not yet implemented
---

# One query runs against a worker and a server, through an accessor seam beside the store seam

An app that indexes in the browser and an app that reads a hosted indexer should be the same app, and they could not be: the browser has the four typed reads of `createReadSurface` (ADR-0021, no predicate, no ordering), and the server a raw SQL predicate. GraphQL was already chosen for the hosted case on measured evidence (Hono, Yoga, Pothos, built programmatically from the declarations). We decide that the SAME GraphQL document runs against a browser worker and a server with identical results, and that the work is in three layers decided separately. Decided with the maintainer on 2026-09-28, tasking the spec `the-same-query-runs-against-a-worker-and-a-server`; it builds on ADR-0098 (relations, enums, semantic types).

## The accessor seam, in its own package, never a member of `StateStore`

One interface the resolvers call and each backend implements: find the rows of an entity matching a predicate over declared fields, ordered by a declared field, bounded, at the tip or as of a block, with relations batched and bounded PER PARENT (a batch bound would let one prolific parent starve the others). It lives in `@etherfold/accessor`, with its conformance suite; SQLite implements it in `@etherfold/state-store-sqlite` by generating SQL, IndexedDB in `@etherfold/state-store-indexeddb`. It is not part of the handler seam because a predicate-taking read there would breach ADR-0021, which narrowed that seam because a handler runs once per event on a substrate with no query planner. The generated read surface stays: it costs no bundle and is the right answer for an app reading a few entities by id.

## The IndexedDB scan is bounded by ROWS EXAMINED, not time

Rung 1 scans a key range and filters in memory, and REFUSES past a declared number of rows examined, default 25,000 (generous against the measured live set of 4,072 rows), configurable per deployment. Rows examined, not elapsed time, because time is a property of the device (a phone would refuse what a laptop answers) and a deterministic bound refuses identically everywhere, which makes it testable. `block:` with `where` is served as current plus a delta (the rows with a version opened or closed above the block, both already indexed range scans), so the cost is churn since the block, not the depth of history, under the same bound. Outside retention it is `BlockNotRetainedError`, the seam's existing refusal. Rung 2, a real `multiEntry` index over computed `[field, value]` keys, was measured viable on all three engines and ships only after its write cost is measured on the real workload; rung 1 stays as the fallback and the reference rung 2 is checked against.

## The schema is one, built from the declarations, and the transport is an executor

One runtime-neutral schema module (`@etherfold/graphql`) builds the GraphQL schema from the declarations; a capability a deployment cannot serve is a coded REFUSAL, never a different schema or an ignored argument. The transport is a `QueryExecutor` (`{query, variables, operationName}` to a result): HTTP for a remote indexer, the worker port for a worker that holds the store, in-process for tests, and `executorToFetch` for client libraries that only take a `fetch`. The worker executor is forced: the resolvers need the store, the store is in the worker, so the schema and the `graphql` runtime live there. Liveness is not streamed through it; it is the state-moved signal (ADR-0083).

## Four parity rules, and one block per operation

`bigint` serialises identically on every executor (no path is nicer locally); both executors share one error formatter and one set of codes; the executor contract defines what a transport failure normalises to; and every response reports the generation in `extensions`. Every operation pins one block and resolves every field as of it, reported in `extensions`, so a query cannot straddle a block or a promotion; a reorg mid-operation is guarded optimistically (read the cursor at the start and the end, retry once if it moved backwards, then refuse), deliberately not by pinning below finality, because serving the unconfirmed tip is the point.

## Status

`accepted, not yet implemented`: the tasks with `spec: the-same-query-runs-against-a-worker-and-a-server` build it, and the one that lands last, `an-indexeddb-index-serves-the-accessor`, removes this status line in the same change (`work/protocol/ADR-FORMAT.md`).
