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

## Decisions

- **A new envelope case `letGo` (request `undefined`, response `{quiesced: boolean}`) replaces the `stopIndexing` that `IndexerPort.close()` posted to get quiet.** Why: the shared shape has to tell "a tab is leaving" apart from "an app asked the fold to stop", and the host must not learn how many tabs it has (ADR-0082). So the host always treats `letGo` as a stop, and the shape decides whether to forward it. Alternatives considered: a `{closing: true}` payload on `stopIndexing`, which would give one case two meanings; or the shared access skipping the quiesce entirely, which would lose the quiet before the browser ends the worker when the last tab goes. It touches the port wire protocol (`PortCases`) for all three hosting shapes, `HostAccess.close`'s `quiesced` meaning (now "the host answered `letGo` by stopping"), and `port.ts` `quiesce`. `IndexerPort` gains no new method.
- **A tab that is not the last is answered `{quiesced: false}` by the shared shape itself.** Why: the host was not quieted, and the shared access's `close` ignores `quiesced` anyway. The alternative, not answering at all, would make every tab close wait out a one-second timeout.
- **The last tab stays attached (and in the provider pool) until its stop lands.** Why: this mirrors `port.ts`, which releases the provider after the stop because the cycle being waited on may be using it.
- **A tab that attaches after the last one let go gets `startIndexing` sent for it.** The same happens if a tab attaches while that last stop is still landing. Why: the stop was for nobody, and without this a tab reaching an instance the browser has not ended yet would see a dead fold forever. An app's explicit `stopIndexing` never sets this flag, so it is never undone. This goes slightly beyond the task's wording; it touches only `sharedWorker.ts`.
- **Letting a tab go hands its push subscriptions back to the host** by sending the matching unsubscribe case under an id nobody waits on. This applies whenever a tab is let go (`letGo`, a failed post, or a `close` event). Why: the host counts subscriptions over all tabs, and a count left behind would keep it posting pushes for nobody.
