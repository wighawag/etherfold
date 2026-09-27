---
title: 'One tab letting go of a SharedWorker host leaves the fold running for the others'
slug: one-tab-letting-go-leaves-a-shared-hosts-fold-running
blockedBy: [a-worker-host-takes-a-hot-updated-processor]
covers: []
---

## What to build

Resolve `work/notes/observations/closing-one-tabs-port-may-stop-a-shared-hosts-fold.md` (read from the code, not yet reproduced): `IndexerPort.close()` (`packages/browser/src/host/port.ts`) quiesces before letting go, which POSTS `stopIndexing` whenever the access has a `close`, and `sharedWorkerHost` gives its access one (`worker.port.close()`). A SharedWorker host serves every tab from ONE driver, so one tab closing its port would stop the fold for the tabs that stay, contradicting `sharedWorker.ts` ("one tab letting go ... leaves the fold running for the others"). The existing test `goes on folding for the tab that stayed when another lets its port go` probably misses it because it closes the host end of the channel synchronously right after `port.close()`, dropping the stop in flight; a real browser would deliver it.

First REPRODUCE it with a test that delivers the stop (as a browser would). If it reproduces, fix it: a tab letting go of a shared host detaches that tab (its reads, its subscriptions, its provider in the pool) and never stops the fold others depend on; the fold stops only when the LAST tab lets go, or on an explicit stop meant for the host. A dedicated-worker host (one tab) keeps today's behaviour. If it does not reproduce, correct the observation with what actually happens and close it.

## Acceptance criteria

- [ ] A test in which one of two tabs closes its port, with the close delivered to the host as a browser delivers it, shows the fold continuing for the other tab (it was red before the fix if the bug is real).
- [ ] The fold stops when the last tab lets go.
- [ ] The dedicated-worker host's close behaviour is unchanged.
- [ ] The observation is retired (or corrected, if it does not reproduce); changesets for every published package changed (0.x: patch).

## Blocked by

- `a-worker-host-takes-a-hot-updated-processor` (both touch the host's port and serve modules; serialised to keep the rebase trivial).

## Prompt

> Goal: a SharedWorker tab closing its port does not stop the shared fold (see What to build). Look at `packages/browser/src/host/port.ts` (`close`, quiesce), `host/sharedWorker.ts`, `host/serve.ts`, and `packages/browser/test/aSharedWorkerServesSeveralTabs.test.ts`.
>
> FIRST, check this task against current reality: reproduce before fixing.
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.
