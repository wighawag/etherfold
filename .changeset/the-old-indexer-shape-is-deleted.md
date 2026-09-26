---
'@etherfold/browser': minor
'@etherfold/core': minor
'etherfold': patch
---

**BREAKING: `EthereumIndexer` and the one-generation call shape are DELETED.** There is one name and one call shape. Nothing is kept as an alias, a shim or a deprecation window: nothing is published and the only consumers are repositories we own, so a compatibility path would be a second way to reach what the first one exists to replace.

This is the CONTRACT batch of the expand → migrate → contract rename the generation container needed. `the-generation-container-expands-beside-the-old-shape` landed the container beside the old shape; `every-caller-moves-onto-the-generation-container` moved every caller, example, README and test onto it; this removes what nothing reads.

**`@etherfold/core` no longer exports `EthereumIndexer`.** The class is `IndexerGeneration` — one stream, one processor, one state IS a generation, and an **indexer** is the `Indexer` container that holds several and points at the one that answers reads. An import of the old name is a compile error; rename it.

**`createIndexerState` (`@etherfold/browser`) takes the two FACTORIES a generation is built from, and nothing else.** The shape that was handed one already-built processor over one already-built store is gone:

```ts
// gone
createIndexerState(fromEntityProcessor(myProcessor)(store));

// the only shape
createIndexerState({
	createState: () => createBrowserStateStore(myProcessor.entities, {databaseName: 'my-app'}),
	createProcessor: (store) => fromEntityProcessor(myProcessor)(store),
});
```

An indexer holds any number of generations and each folds into its OWN state, so the store cannot be a value handed over once. A caller that needs the store it built (to rebuild a processor over it on a hot reload, or to read its capability report) captures it in the factory's own closure.

**A DISCARD IS NOW PUBLISHED BY THE CONTAINER, not by the browser hook.** `Indexer.reset`, `updateIndexer` and `updateProcessor` drop the handle the discarded fold had published and re-announce through `onStateUpdated`, so a subscriber holding the state that just went is told at the moment it goes. This is not new behaviour, it is the same re-seed one level lower: `createIndexerState` did it for its own `state` store, which is deleted here, and the container is what knows a verb discarded. It reaches every consumer of a container now rather than the browser hook's subscribers alone.

`etherfold` (the CLI) changes only in its own source-text guard, which enforces that the CLI folds through `StreamBuilder` and constructs no browser engine. The guard matched the class under BOTH spellings while the alias existed; with one name left it matches one, and the deliberate violations it is asserted against lose their alias half — a guard left on an identifier nothing can resolve any more would stay green and enforce nothing.

The verbs still discard exactly when they discarded before. Turning a reconfigure into a NEW GENERATION over the same stream, so nothing is discarded in place at all, is the promotion policy's landable (`the-promotion-policy-moves-the-canonical-pointer`) and needs the shared-stream follower under it.

**The guard against a rebuild being reported as empty moved down with it.** When the STREAM survives — which a processor swap always leaves it, since the stream verdict is about the source and the config and not the processor — the `load` inside the verb replays the cached events and publishes the rebuilt state before the verb returns. The container counts that publication and stays silent rather than announcing an empty fold over the top of it.
