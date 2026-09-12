---
title: 'A replacement worker never claims the store on WebKit after a kill mid-write -- WHERE is known, WHY is not'
slug: webkit-does-not-abort-a-terminated-workers-indexeddb-transaction
observed: 2026-09-12
source: 'measured by packages/browser/browser/restartsAndResumes.spec.ts with the store-open probes in browser/indexer.worker.ts, and by the minimal probe packages/browser/spikes/webkitWedge.spec.ts (results in docs/spikes/webkit-terminated-worker-wedges-indexeddb/results/) @ 9409985d, against Playwright 1.62.1 (chromium, firefox, webkit-2359) on Linux, 2026-09-12'
---

> **This note's title and mechanism were WRONG in its first two revisions.** It claimed WebKit fails to abort a terminated worker's IndexedDB transaction, and that the surviving transaction blocks the next writer. A minimal probe FALSIFIED that (below). What is established is where the hang is and that it is WebKit-only; the cause is open. The wrong version is left described here rather than quietly deleted, because the plausible-and-wrong mechanism is the thing a reader is most likely to arrive at independently.

## What IS established

In `@etherfold/browser`'s restart-and-resume case, a dedicated worker is deliberately terminated while a store write is in flight, and a replacement worker is started to resume the fold. On WebKit, about one run in eight, **the replacement worker never takes the writer claim** and the host sits in `phase: 'waiting'` for ever.

- **Where it stops**, from probes in the worker entry: `host-construct`, `store-open-start`, `store-open-done`, and then nothing. The replacement is alive and answering its port, its database is OPEN, and what never completes is `openForWriting` -> `claim()` -> `clearSeamRecord('writerClaim')` (`@etherfold/state-store`). An earlier probe run also showed `migrate()` completing, so it is the seam `readwrite` transaction and not the open.
- **It is permanent.** The wait was raised from 15 s to 100 s and the claim still never landed.
- **It is WebKit-only**, on the product case: chromium 0/12, firefox 0/12, webkit ~2/20.
- **It is intermittent for a reason**: `terminate()` is asynchronous, so the kill only sometimes lands while a transaction is genuinely open.

## What was FALSIFIED

The obvious mechanism -- a terminated worker's transaction keeps holding the object store, so the next writer queues behind it for ever -- does not survive a minimal test. `packages/browser/spikes/webkitWedge.spec.ts` does exactly that, with no etherfold in the picture: a worker opens a database and holds ONE `readwrite` transaction open indefinitely (chaining a new `put` from each `onsuccess`, so it can never auto-commit), the tab terminates it mid-transaction, and then the database is asked for everything.

All three engines answer identically:

| step | chromium | firefox | webkit |
| --- | --- | --- | --- |
| new connection from the tab | ok | ok | ok |
| `readwrite` from the tab | ok | ok | **ok** |
| `readonly` from the tab | ok | ok | ok |
| `readwrite` from a SECOND WORKER | ok | ok | **ok** |
| `deleteDatabase` | blocked | blocked | blocked |
| after a page reload | ok | ok | ok |

So on this substrate a terminated worker's transaction does **not** block the next writer, on WebKit or anywhere else, and a second worker claims the store without trouble. `deleteDatabase` is blocked on all three merely because a live connection is still open, which is ordinary IndexedDB behaviour and not the effect being chased.

**The minimal case does not reproduce the wedge.** Something in the product path that this probe strips away is required, and the candidates are not yet narrowed: many object stores rather than one, a transaction spanning several of them, the real interleaving of a fold's writes at the moment of the kill, or -- and this deserves equal weight -- a latent ordering bug in our own `claimOrCheck`/`clearSeamRecord`, which `await`s between creating a transaction and issuing its first request, and would be sensitive to exactly the task-scheduling differences one engine can have.

## Why this matters

It undermines the feature built for it. ADR-0082's restart-and-resume exists because a browser may evict a worker; if an eviction mid-write can wedge the replacement, the app is left in `waiting` with nothing to render and nothing to act on. It also sits against the storage seam's stated contract, that `openForWriting` "does not block and it does not wait".

## Upstream

**No matching WebKit bug was found.** Searches turned up adjacent but different reports -- 197050 and 202705 are about IndexedDB after the network process or the app is SUSPENDED, not after a worker is terminated. **Nothing has been filed**, deliberately: a report is only useful with a minimal reproduction, and the minimal reproduction above shows the opposite of the claim. Filing it now would send someone else chasing a mechanism that has already been ruled out.

## What was done

- The browser case no longer asserts something that may be impossible on WebKit. It asserts what holds everywhere -- either the fold resumed, or the tab can still see exactly where it stopped -- and refuses the outcome where a tab cannot tell the difference. 0 failures in 20 WebKit runs and 12 full three-engine runs, against roughly 1 in 8.
- The store-open probes are kept, because from outside a worker all three opening steps fail identically.
- `browser/cut.ts` now records an error's MESSAGE as well as its stack; on JavaScriptCore `stack` carries no message, which is most of why this took several rounds to characterise.

## What is NOT done, and is the next step

1. **Narrow the cause.** Grow the minimal probe towards the product until it wedges: several object stores, a multi-store transaction, then a real fold. The first step that reproduces it is the answer, and it decides whether this is a WebKit bug worth filing or a bug of ours.
2. **Tell the application either way.** The product still has no way to say "your store is wedged": a bounded wait on the claim with a typed refusal would turn a silent permanent `waiting` into something an app can render and act on. That is a change to a published seam's failure vocabulary across backends, so it wants deciding rather than improvising.
