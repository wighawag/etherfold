---
'@etherfold/browser': minor
---

An app with the indexer in a worker RE-READS at the right moment, because its host tells it the state moved (ADR-0083) instead of leaving it to poll on an interval it invented.

`IndexerPort` gains `onStateMoved(listener)`, which returns the detach. What arrives is `@etherfold/core`'s own `StateMoved`, unchanged: one notification per block the host's canonical fold APPLIED (`{kind: 'applied', block, coherence, entities, generation}`) and one per reorg (`{kind: 'retracted', forkPoint, coherence, generation}`). The same value crosses every transport this signal will have, so an app that later points at another tab or at a server keeps the handler it already wrote.

```ts
let held: string | undefined;
const stop = indexer.onStateMoved((moved) => {
	// the whole reader rule, in two lines
	if (moved.coherence !== held) {
		held = moved.coherence;
		return queryClient.invalidateQueries();
	}
	if (moved.kind === 'applied') for (const entity of moved.entities) queryClient.invalidateQueries({queryKey: [entity]});
});
```

**The cadence is APPLIED WORK and never a timer**, so a host resting at the tip is silent because nothing moved. Nothing is posted until a tab asks, and when the last listener lets go the host stops POSTING -- and lets go of its own subscription to the fold, so a host nobody is watching holds nothing on anyone's behalf. A SharedWorker posts each push only to the tabs that asked for THAT push, so a tab watching progress is not billed for a tab invalidating a cache.

**A tab that attaches part way through is told NOTHING until the fold next moves**, which is the one place this differs from `onProgress`. Progress is a STATE, so its subscribe answers with the current value; a notification is a thing that HAPPENED, so there is nothing current to hand a late subscriber and replaying the last one would report a move that did not just happen. A freshly attached tab READS through the surface it already holds. Delivery is best-effort with no per-client state anywhere (ADR-0083), so a missed notification is repaired by the next one plus the coherence token.

**The `progress` push is untouched** in shape, cadence and subscription behaviour: this is a second push with a different job, subscribed to separately, and the two are not merged because they answer different questions (ADR-0082 settled that progress is its own thing).

**On the envelope:** `PortPushes` gains `stateMoved`, with `subscribeToStateMoved` / `unsubscribeFromStateMoved` beside the progress pair -- the shape that map's own note anticipated, so nothing about the transport, the correlation or either end's plumbing moved. `PORT_PUSH_SUBSCRIPTIONS` now declares, once, which pair of cases turns which push on and off, because the SharedWorker's per-client filter needs that pairing and a hand-written list of case names there would drift one push behind.
