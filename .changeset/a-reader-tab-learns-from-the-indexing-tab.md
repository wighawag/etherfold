---
'@etherfold/browser': minor
---

**The state-moved signal now crosses between TABS, over a `BroadcastChannel` scoped to the store it is about** (ADR-0083's second transport).

A tab that is not doing the indexing has no host to ask and no fold to subscribe to, so it either polled an interval it invented or showed state that had stopped moving. `openStateMovedAcrossTabs({databaseName})` is the adapter that closes it:

```ts
// every tab, whether or not it is the one indexing
const tabs = openStateMovedAcrossTabs({databaseName: 'my-app'});
tabs.onStateMoved(rerenderFromTheStore); // the SAME handler you wrote for the port

// and, in a tab that holds a host, forward what that host tells it
indexer.onStateMoved(tabs.publish);
```

**It is an ADAPTER and not a second semantics.** What is posted is the value the fold published, so a tab receiving it does exactly what a tab receiving it over a port does, and the reader rule (token unchanged, invalidate narrowly; token changed, invalidate everything) is unchanged.

**The channel is scoped by STORAGE IDENTITY**, which is the same rule the writer token settles by living inside the storage it guards: the name is `etherfold/state-moved/<databaseName>` and nothing else goes into it. Two tabs of one store hear each other; two unrelated indexers on one origin never do. Pass the value you passed `createBrowserStateStore` -- a name invented at this boundary would be a second answer to "which store is this", and scoping to an origin, a tab or an app-supplied string is the failure mode that breaks the second pair silently.

**Delivery is best-effort and nothing is held per receiving tab.** No acknowledgement, no replay for a tab that was not listening, no buffer. A tab that missed one converges on the next, because the coherence token it carries is one that tab has not seen. A tab is never handed back its OWN publication (one channel object serves both directions), so wiring both lines in every tab is correct rather than noisy.

**No election is introduced.** Which tab indexes is `one-tab-indexes-and-the-others-read`; nothing on the wire names the publisher, nothing asks who is publishing, and a second publishing tab is noise rather than an error. Only one tab's fold can be writing the store at all -- that is the writer claim's job (ADR-0075) and this rests on it.

Nothing existing changes: `IndexerPort.onStateMoved`, the port envelope and the three hosting shapes are untouched. A runtime with no `BroadcastChannel` is TOLD, in a sentence that names what is missing; nothing falls back to a poll on its own.
