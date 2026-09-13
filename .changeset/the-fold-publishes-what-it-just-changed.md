---
'@etherfold/core': minor
'@etherfold/processor-entities': minor
'@etherfold/processor-sqlite': minor
---

The fold PUBLISHES what it just changed: a reader can be told the state moved.

A client could read the state and had no way to know when to read it again. `Indexer` now publishes one **`StateMoved`** per block the CANONICAL fold applies — `{block, coherence, entities, generation}` — and a reader's whole rule is two lines: token unchanged, invalidate narrowly using `entities`; token changed, invalidate everything. ADR-0083 decides the shape; this is the producer's chain-facing half of it.

```ts
const detach = indexer.onStateMoved(({block, entities, coherence}) => {
	if (coherence !== held) {
		held = coherence;
		return queryClient.invalidateQueries();
	}
	for (const entity of entities) queryClient.invalidateQueries({queryKey: [entity]});
});
```

It is a SIGNAL and not a delivery of data: no rows, no mutations, no state handle, because a reader handed the delta applies it by hand and is wrong at the next reorg. It says what moved so a reader re-reads through the surface it already has.

- **`@etherfold/core`** exports `StateMoved`, `StateMovedHandler`, `StateMovedDetach`, `StateMovedPublisher` and `coherenceToken`, and `Indexer.onStateMoved(handler)` returns the detach. The publisher holds NOTHING per subscriber (no buffer, no retry, no cursor), which is what stops a SharedWorker's memory growing with the number of open tabs; a handler that throws is caught and logged, exactly as `onStateUpdated` already contains one.
- **The entity set comes from below and core RELAYS it.** `EventProcessor` gains ONE optional member, `setAppliedBlockReporter(reporter)`, carrying `AppliedBlock` (`{block, entities}`) upward. `process` is NOT widened and no existing signature changed: a processor that implements nothing here is unaffected and publishes no signal, which is the honest answer since core has no mutation vocabulary at all and could not name what such a fold applied.
- **`@etherfold/processor-entities`** produces the set where the mutations already are: `applyEventStream` takes an optional reporter and reports each block AFTER `applyBlock` returned, with the entity NAMES its mutations carried, deduplicated and sorted. Names and never ids in this version, so the payload is O(schema) rather than O(mutations). `EntityEventProcessor.setAppliedBlockReporter` is the slot the container sets.
- **`@etherfold/processor-sqlite`** forwards it to the fold it wraps, including a reporter attached before that fold is built.

Three rules worth knowing before relying on it: only the CANONICAL fold publishes (a follower re-folding a stored stream would otherwise fire one notification per past block while nothing a reader can see has moved); a block whose handlers changed nothing is still published, with an empty set, because "one notification per APPLIED BLOCK" is one rule; and the coherence token is OPAQUE — compare it, never parse it. Nothing rotates it yet, so it is stable for the life of a container; a retraction and a promotion will, each in its own change.

Delivery is best-effort, at most once: a missed notification is repaired by the next one plus the token.
