---
'@etherfold/browser': minor
---

A tab renders "syncing, N blocks behind" from progress its host PUSHES at it, and nothing polls (ADR-0082).

`IndexerPort` gains `onProgress(listener)`, which returns the detach. The host posts when a batch has been APPLIED or the fold changed phase, and posts nothing when the report would repeat the last one, so a host resting at the tip is silent rather than emitting a heartbeat an app has to ignore. Nothing is posted until a tab asks, and when the last listener lets go the host is told to stop: an unsubscribed tab stops RECEIVING pushes rather than merely ignoring them.

```ts
const stop = indexer.onProgress(({phase, blocksBehindTip}) => {
	banner.textContent = phase === 'at-tip' ? 'live' : `syncing, ${blocksBehindTip} blocks behind`;
});
```

The listener is called with where the fold is NOW as soon as the host answers (it is the subscribe call's own response, not a push chasing it), so a tab that attaches half way through a fold -- or after the fold has finished and will never move again -- renders the truth without waiting.

**`createProgressReadable(port)`** is the small helper for the app that just wants a progress bar: the same `Readable` shape `createIndexerState` publishes its stores as, holding whatever the host last said, `undefined` until it has said anything. It is a VIEW over the signal and never a second source of truth -- it keeps the host's own report by reference, derives nothing and merges nothing -- so an app with its own store or signal library subscribes to `onProgress` directly and loses nothing.

**`HostProgress` grows a `phase` and three derived figures.** The phase is coarse and the set is closed (`SyncPhase`: `waiting`, `loading`, `catching-up`, `at-tip`, `refused`), which is what an app changes its screen for; the load's finer sub-steps (`fetchingLogs`, `FetchingEventStream`, `ProcessingEventStream`) stay a main-thread detail rather than becoming a message each. `at-tip` is the driver's own rest condition and not a threshold beside it, and `refused` is pushed with the `failure` that caused it, because silence and a stall look identical from a tab.

The figures are `blocksBehindTip`, `numBlocksProcessedSoFar` and `syncPercentage`, computed in the host exactly as `createIndexerState` computes them for the main-thread case. Two differences worth knowing: the distance to the chain tip is `blocksBehindTip` and not `blocksBehind`, because `GenerationProgress.blocksBehind` already means how far a non-canonical generation is behind the CANONICAL one; and all three are ABSENT until a tip has been learnt, rather than computed from the `0` of `0` a container publishes before it has fetched. `ExtendedLastSync.totalPercentage` does not cross at all: it measures the fold against the whole chain, so a deployment starting at block 20,000,000 reads 99.9% from its first fetch.

**On the envelope:** a third message kind (`kind: 'push'`, carrying no correlation id, since nobody asked) with `PortPushes` as the map a later push adds a key to, plus `subscribeToProgress` / `unsubscribeFromProgress` cases. `isPortPush` is exported beside `isPortRequest` and `isPortResponse`.
