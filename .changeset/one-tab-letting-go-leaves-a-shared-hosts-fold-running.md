---
'@etherfold/browser': patch
---

One tab letting go of a SharedWorker host no longer stops the fold for the tabs that stay.

`IndexerPort.close()` used to ask the host for quiet by posting `stopIndexing`, which a SharedWorker host, serving every tab from one driver, honoured for all of them. The port now posts a case of its own, `letGo`, answered `{quiesced}`. A host answers it by stopping (so a dedicated worker, and the main-thread wire, behave exactly as before, and a dedicated worker is still terminated only when it was quieted), but the shared shape decides first, being the one place that knows how many tabs are attached: a tab that is not the last is detached there (its provider leaves the pool, its push subscriptions are handed back to the host) and answered `quiesced: false`, and only the LAST tab's `letGo` reaches the host, so the fold is quieted before the browser ends the worker. A tab that attaches to that instance before the browser has ended it has the fold started again. An app's own `stopIndexing` still stops the host for every tab.
