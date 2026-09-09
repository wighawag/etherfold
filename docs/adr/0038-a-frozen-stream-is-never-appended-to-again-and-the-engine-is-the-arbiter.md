# A frozen stream is never appended to again, and the ENGINE is the arbiter of that

The cached stream is written BEFORE the processor runs and a batch that was not written is not processed, so the cache cannot fall behind the state — except in the one case where it is allowed to: after a bounded run of failed writes the cache is FROZEN and indexing carries on without it, because an optional cache must never wedge the indexer. We decided that a frozen stream is then **never appended to again in that lineage**, and that the decision is made in `IndexerGeneration` by comparing the stored stream's cursor with the state's, rather than by the keeper's forward-jump guard.

## Why the keeper cannot decide this

`appending-to-the-stream-costs-the-batch` gives the keeper a WRITE-side guard: a batch whose `lastFromBlock` is above the stored cursor's `lastToBlock + 1` would leave a HOLE, so it is refused. That guard is real and still wanted — it is the durable backstop against a second tab and against an engine that has just reloaded — but it is **not sufficient**, and the earlier plan for this work assumed it was ("a frozen stream revives by itself, because the guard makes a wrong attempt harmless").

The reason is that the batch handed to a save is not the fetch range. It is a DELTA against the STATE's unconfirmed window: `generateStreamToAppend` emits events from the last unconfirmed block upward, while the fetch RANGE reaches back `finality` blocks on every cycle at the tip. So after a freeze, a batch routinely OVERLAPS the stored cursor — which the guard accepts — while the events it carries begin above the blocks the frozen stream never received. The guard sees a legal append; what lands is a hole, of exactly the kind nothing can detect afterwards.

The engine is the only place that holds both numbers, so it is the only place that can ask the real question: **is the stream at or AHEAD of the state?** Ahead and equal are both safe (everything between what is stored and what the batch carries is already stored); behind is not. That one comparison delivers both halves of the intended behaviour with no new machinery: a short outage, where nothing was processed and the cursor never moved, heals on the next successful write, and a long one — where the bound was hit and the state ran on — stops writing for good.

## Consequences

- **A frozen cache does not revive by itself after the bound is reached.** What is on disk stays a contiguous prefix with a cursor that describes it honestly, which is a usable partial seed: it replays and the remainder is re-fetched. It starts being written to again only once the state is rebuilt from it (a discard, a processor change), at which point the two cursors agree again. The alternative — re-fetching the gap so the cache could catch up — is a second fetch range with its own cursor, which is a feature and not a guard.
- **This does not replace the keeper's guard and must not be read as making it optional.** In-memory knowledge covers one session; a keeper's stored cursor covers a second tab, a reload and a keeper used by something other than this engine.
- **Out of space is still the one cause that CLEARS instead of freezing**, because there the cache is itself the problem. A keeper says so on the error it throws (`isOutOfSpace`, read structurally like `retryable`), and nothing else clears.
