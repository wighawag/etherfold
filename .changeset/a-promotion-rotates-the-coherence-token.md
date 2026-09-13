---
'@etherfold/core': minor
---

A PROMOTION rotates the coherence token, by the same mechanism a retraction does.

When the canonical pointer moves, a different fold answers reads, and from a reader's point of view that is indistinguishable from "everything you hold may be wrong" — so it gets the same treatment as a reorg and the reader invalidates everything. `Indexer.movePointerTo` (every `promote`, and therefore every revert too) now rotates the token before it tells anybody the pointer moved.

The sameness is the point. A promotion and a reorg have nothing in common mechanically, and exactly one thing in common for a reader, which is that narrow invalidation is no longer sufficient — so the reader written for the retraction case already handles this one, unchanged:

```ts
indexer.onStateMoved((moved) => {
	if (moved.coherence !== held) {
		held = moved.coherence;
		return queryClient.invalidateQueries();
	}
	if (moved.kind === 'applied') for (const entity of moved.entities) queryClient.invalidateQueries({queryKey: [entity]});
});
```

- **No new event kind and no new field.** `StateMoved` is the same union of the same two cases. A promotion PUBLISHES nothing of its own, because a pointer move has no block to name and no fold applied anything: what a reader receives is the NEXT notification, carrying a token it has never seen and naming the generation that answers now. Two kinds would have meant every app handling both for one reader-visible consequence.
- **`generation` is not a second mechanism** — it rides every notification, and it was already correct across a move because only the CANONICAL fold publishes. It is now pinned by a test: every notification before the move names the retired lineage and every notification from the first one after it names the successor, so a refetch on the changed token is answered by the generation the notification named.
- **Where the rotation sits is the load-bearing part.** It fires BEFORE the pointer-moved callback (`onPromoted`) and before the state notification that applies the move, since both of those are a reader being told to re-read; a rotation after either would let one notification's worth of questions about the new generation be answered under the retired one's token. It fires AFTER the registry write, so a move that did not happen does not invalidate every reader's cache.
- **An ordinary append is untouched**: blocks folded within one generation carry ONE token, before and after a promotion, asserted on both sides of the move. A `promote` naming the generation that is already canonical moves no pointer and rotates nothing.

A REVERT rotates it too, because moving the pointer back changes which fold answers exactly as moving it forward does, and that is the only thing a reader can see of either. ADR-0083 records the reasoning and now records both of the token's rotations as built.
