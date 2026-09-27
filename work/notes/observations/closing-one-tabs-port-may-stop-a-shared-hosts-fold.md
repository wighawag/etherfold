---
title: Closing one tab's port may stop a SharedWorker host's fold for every tab
slug: closing-one-tabs-port-may-stop-a-shared-hosts-fold
---

2026-09-27. Unverified, read from the code: `IndexerPort.close()` (`packages/browser/src/host/port.ts`) quiesces before letting go, which POSTS `stopIndexing` whenever the access has a `close`, and `sharedWorkerHost` gives its access one (`worker.port.close()`). A SharedWorker host serves every tab from one driver, so one tab closing its port would stop the fold for the tabs that stay, which contradicts `sharedWorker.ts` ("one tab letting go ... leaves the fold running for the others"). The node test `goes on folding for the tab that stayed when another lets its port go` probably does not see it because it closes the host end of the channel synchronously right after `port.close()`, dropping the stop in flight; a real browser would deliver it.
