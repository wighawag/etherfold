---
'@etherfold/browser': minor
---

**Sync progress rides the cross-tab signal, so "syncing, 400 blocks behind" is renderable in a tab that is not the one folding.**

A tab that hosts the fold has always been told where it has got to, over its port (`IndexerPort.onProgress`, ADR-0082). A tab that is merely READING has no host to ask and cannot work it out: the **sync cursor** is opaque behind the storage seam (ADR-0027), so a reader deriving a position from it would be reading through that seam. So the side that knows publishes, on the ONE channel a reader already listens to (ADR-0083) rather than on a second mechanism with its own lifetime and its own silence.

`StateMovedAcrossTabs` gains two verbs beside the two it had:

```ts
const tabs = openStateMovedAcrossTabs({databaseName: 'my-app-state'});

// in the tab that holds a host: the second line of the wiring it already wrote
indexer.onStateMoved(tabs.publish);
indexer.onProgress(tabs.publishProgress);

// in every tab, including the ones with no host at all
const progress = createProgressReadable(tabs); // the SAME helper a port binds to
// {$progress.phase === 'at-tip' ? 'live' : `syncing, ${$progress.blocksBehindTip} blocks behind`}
```

What crosses is the host's own `HostProgress`, unchanged: same fields, same meanings, same cadence (the host pushes when a batch was applied or the phase moved, and says nothing when the report would repeat), so a reader tab and a hosting tab render the same words from the same numbers. Nothing here recomputes, merges or times anything.

**A tab attaching part way through IS told, which is deliberately the opposite of `onStateMoved` beside it.** Progress is a STATE, so a new listener is handed where the fold is: the last report this tab heard if it has one, and otherwise this tab ASKS on the channel and any tab holding a report of its own re-posts it. The ask exists for the case nothing can push to -- a host resting at the tip pushes nothing, so a window opened into a quiet chain would otherwise be blank until the chain moved. It is an ask and not a request: nothing is awaited, nothing is retried, an ask nobody can answer is silence, and a report identical to the one a tab already holds is not delivered twice.

**Nothing is kept per listening tab.** A publisher holds ONE report, its own last, whatever the number of tabs; no backlog is replayed, so a tab that missed a hundred reports is handed the hundredth and not the hundred.

**The port's `progress` push is untouched** in shape, cadence and subscription behaviour: this is about a reader tab, which has no port, being told the same facts over the channel it does have. Progress and the notification stay two pushes answering two questions, on one channel.
