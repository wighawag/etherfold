# What the state-moved payload costs a normalised cache

2026-09-13, written while wiring the documented cache example for `one-handler-for-every-transport`. The question the task asked was whether the `{block, coherence, entities, generation}` payload composes cleanly with how a real client library's cache invalidates, or whether it only appears to.

## What was checked, and what was not

The DOCUMENTED invalidation surfaces of TanStack Query (`queryClient.invalidateQueries`), Apollo (`client.refetchQueries`, `cache.evict`, `cache.modify`) and urql (`client.reexecuteOperation`, Graphcache's `cache.invalidate`), against the two-line reader rule ADR-0083 states. No app was built against any of them, and nothing here was run: this is a reading of their invalidation units against the payload's, not a measurement. What WAS run is the two-line rule itself, over all three transports, in `@etherfold/state-moved-conformance` — where it is the same function object on every one of them.

## The finding: the coarse half is free, the narrow half needs an app-declared mapping

**ADR-0083's claim survives, with one thing it does not say out loud.** "Every client library's invalidation API is a plain callback" is true, and the coarse line — *token changed, invalidate everything* — really is one call in each of the three: `invalidateQueries()` with no argument, `refetchQueries({include: 'active'})`, `reexecuteOperation`. Nothing about the payload obstructs it, and it needs no vocabulary at all.

The NARROW line is where the seam is. `entities` carries entity NAMES, which is the PROCESSOR's vocabulary, and no cache library knows it:

- **TanStack Query** invalidates by QUERY KEY, which the app chooses. `invalidateQueries({queryKey: [entity]})` is exactly right *if* the app keyed its queries by entity name, and matches nothing if it did not. Free by convention, and silently a no-op without it — which is the failure mode worth naming, because it looks like a working integration.
- **Apollo** has no type-level invalidation primitive at all. `cache.evict` addresses a normalised object id or a field of one; `refetchQueries` takes query NAMES or `'active'`. So "everything of type `Token`" is a list the app maintains.
- **urql** invalidates through Graphcache by entity KEY, and the external lever on the client is re-executing a specific OPERATION. Again a list.

So the honest statement is: **the payload composes, and the narrow half costs a mapping from entity name to the library's own unit of invalidation, which the app declares once and which no library derives for free.** That is one line per entity beside an app's queries, and it is authorable precisely because the entity names are the app's own — it wrote the processor. It is not a mapping between two strangers' vocabularies.

## Why this is not an argument for shipping ids

Ids would not remove the mapping; they would move it and make it bigger, because the app would then have to map (entity name, id) onto a cache key as well. ADR-0019's neighbouring measurement is the reason to resist: the worst block on the real measured stream carried 457 mutations against a median of 7, so an id-carrying payload is O(mutations) where this one is O(schema). And the sharper reason stands unchanged — ids invite a reader to apply the delta by hand instead of re-reading, which is what goes wrong at the next reorg. Ids remain ADDABLE later as an optional field, which is the reversible direction.

## What would actually reduce the cost, and where it belongs

A GraphQL query surface. Once operations are documents the indexer can see, the entity-name-to-operation mapping is derivable from the documents rather than declared by the app — which is the shape a normalised cache expects, and is `the-same-query-runs-against-a-worker-and-a-server`'s to decide rather than this signal's. Until then the mapping is the app's, and the guide says so (`docs/guide/indexing-in-a-browser-app/index.md`) rather than implying the narrow half is free.
