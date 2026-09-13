---
'@etherfold/core': minor
'@etherfold/server': minor
'etherfold': patch
---

The RECEIVING container publishes what it applied, so a deployment that runs on a server can tell a reader the state moved.

`Indexer` has published the state-moved signal since `the-fold-publishes-what-it-just-changed`, and that is the CHAIN-FACING container, which is what a browser runs. Every server and CLI deployment applies its blocks in **`ReceivingIndexer`** (the chain-free twin, fed wire batches by a fetcher elsewhere), and that one published nothing. So the signal reached the browser half of ADR-0083 while claiming both. It now publishes too, from the SAME assembly rather than a second implementation: one `StateMovedPublisher`, one union tagged `kind`, one token, one set of rules.

```ts
const detach = container.onStateMoved((moved) => {
	if (moved.coherence !== held) {
		held = moved.coherence;
		return invalidateEverything();
	}
	if (moved.kind === 'applied') for (const entity of moved.entities) invalidate(entity);
});
```

- **`@etherfold/core`** adds `ReceivingIndexer.onStateMoved(handler)`, returning the detach, with the same name and the same shape as the chain-facing container's so a transport adapts to ONE surface. The relay that carries the touched-entity set up from `@etherfold/processor-entities` is attached to every fold this container holds, so an entity-declared processor reports real entity NAMES on a server; a retraction publishes its fork point and ROTATES the token as it publishes; and a POINTER MOVE rotates the token and publishes nothing, exactly as `Indexer.movePointerTo` does.
- **Only the CANONICAL fold publishes**, and on this container that filter is what stops an upgrade drowning every reader: a follower here re-folds a whole stored stream to catch up, so publishing per block would fire one notification per past block while nothing a reader can see has moved. The filter covers the TOKEN too, so a follower replaying a stored stream's reorg rotates nothing.
- **`@etherfold/server`** adds `IndexerRegistryEntry.onStateMoved?`, forwarded by `indexerEntryOn`. This package applies no blocks (an ingest route delegates to a receiver the host constructed), so what it holds is the way to REACH the signal, which is the only handle a route has on a name. It is OPTIONAL on the same absent-is-a-capability-statement rule as `generations` and `promote`: a host holding a bare receiver and no container (`singleContextEntry`) reports none, so a transport built over it refuses rather than attaching to silence.
- **`etherfold`** (the CLI)'s `index` command forwards it on the entry it writes out, so the receiving half of a split deployment is subscribable too.

**Nothing about the receiving container's deliberate silence on state HANDLES has changed.** It still publishes no read handle and `ReceivedGenerationSpec` still has no `stateOf`, because reads on that runtime resolve the canonical pointer to a table namespace (ADR-0053). A notification is a different thing: it says WHAT MOVED (its case plus four facts, no rows, no mutations, no handle), so a reader re-reads through the surface it already has.

One thing to know before relying on it, stated rather than discovered: which fold is canonical must be answerable SYNCHRONOUSLY (a fold reports from inside `process()`), so this container keeps the answer in memory and re-reads the durable pointer wherever it already consults it, plus on the two paths that precede a fold (`liveIngestions`, `rebuildMore`). A pointer moved by ANOTHER process is therefore not seen until the next read, which is the same in-process staleness the chain-facing container has and is bounded by the same best-effort delivery decision.
