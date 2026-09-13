---
'@etherfold/core': minor
'@etherfold/processor-entities': minor
'@etherfold/processor-sqlite': minor
---

A reorg PUBLISHES a retraction naming the fork point it withdrew, and the coherence token rotates with it.

A reorg does not add data, it WITHDRAWS it, so a signal that can only say "there is more" leaves a reader rendering the branch the chain abandoned. `StateMoved` is now a DISCRIMINATED union of the two cases, and a retraction names a FORK POINT rather than a set of blocks — the vocabulary `revertTo(keepUpTo)`, the emission stream's `removed` markers and the canonical view's rewind already share:

```ts
indexer.onStateMoved((moved) => {
	if (moved.coherence !== held) {
		held = moved.coherence;
		return queryClient.invalidateQueries();
	}
	if (moved.kind === 'applied') for (const entity of moved.entities) queryClient.invalidateQueries({queryKey: [entity]});
});
```

**The token is the load-bearing half.** "A missed notification is repaired by the next one" is true of an APPEND and FALSE of a retraction: after a reorg the stale entities are the ones the ABANDONED branch touched, and those are generally not in the changed-set of whatever block arrives next, so a reader that missed the retraction and invalidated narrowly would keep dead-branch rows on screen indefinitely. A retraction therefore ROTATES the token as part of publishing it (`StateMovedPublisher.publishRetraction`, one call, so a retraction that forgot to rotate is unexpressible), and the reader above converges at the very next notification without ever having seen it. That property is asserted by DROPPING the retraction over a real reorg, not by inspecting a message shape.

- **`@etherfold/core`** exports `StateApplied`, `StateRetracted` and `StateMoved` (their union). A retraction carries `{kind: 'retracted', forkPoint, coherence, generation}` — no block and no entity set, because a rotated token already means invalidate everything and a narrower answer would have to come back out of `revertTo`, which answers `void` on every backend. Only the CANONICAL fold publishes, and the same filter covers the rotation: a follower replaying a stored stream's reorg rotates nothing.
- **The processor seam's channel is RENAMED**, because it no longer carries only applied blocks: `EventProcessor.setAppliedBlockReporter` is now `setFoldReporter`, and `AppliedBlockReporter` is now `FoldReporter`, carrying `FoldReport = AppliedBlock | Retraction`. `AppliedBlock` gains `kind: 'applied'`. `process` is still NOT widened, and no other signature changed.
- **`@etherfold/processor-entities`** derives the fork point where it already did — the line that reads the `removed` markers and calls `revertTo` — and reports it AFTER the revert returned and BEFORE the replacement blocks are applied, which is the order they happened in.
- **`@etherfold/processor-sqlite`** forwards the renamed channel, retractions included, pinned by its own test.

`StateStore`, `WritableStateStore` and `revertTo` are untouched: no backend and no conformance case changed. ADR-0083 records the reasoning; a PROMOTION rotating the same token is still its own change.
