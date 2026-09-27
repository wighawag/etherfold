---
title: 'A remaining tab takes over indexing when the indexing tab closes'
slug: a-remaining-tab-takes-over-when-the-indexing-tab-closes
blockedBy: [a-promotion-tells-readers-the-state-moved]
covers: []
needsAnswers: true
---

## What to build

With the app open in several tabs, each tab (main-thread or dedicated-worker host) builds its own indexer and takes its store's writer claim; the NEWEST claim wins (ADR-0075, ADR-0077) and an older tab, refused on its next write, demotes itself to a reader (ADR-0078). Nothing ever hands the write duty back: when the indexing tab closes, the remaining tabs are readers of a store nobody updates and go stale until reloaded. ADR-0078 deliberately rejected re-claiming automatically inside a demoted indexer, and names the recovery (`dispose()` plus a fresh `init()` over a store built fresh), but no one triggers it, and the guide leaves "electing one indexing tab" to the app. ADR-0082's "non-leader workers" presumes an election that was never built. Also, every new tab starts fetching before it wins or loses, a short duplicate fetch. Decided with the maintainer on 2026-09-27: build the election.

Use the Web Locks API (`navigator.locks`, available on the main thread and in workers on every current engine): ONE exclusive lock per store (scoped exactly as the writer claim is, so two apps on one origin never share one), held by the tab that indexes for as long as it indexes. A tab that does not hold it opens as a READER at once (no claim, no fetch, reads the shared store, follows the state-moved signal), and queues for the lock. The browser releases a lock when its holder's tab or worker dies, so the next tab in the queue gets it and becomes the writer through ADR-0078's recovery path (a fresh start over a store built fresh, taking the claim). The writer claim stays the correctness guarantee underneath: if two tabs ever both write (a tab without the lock, an older build), the claim still demotes the loser exactly as today.

- Applies to the main-thread and dedicated-worker hosts; a SharedWorker host is already one indexer for all its tabs (take the lock there too only if it is simpler than not).
- Where `navigator.locks` is absent, behave exactly as today.
- An app can opt out (keep today's behaviour) and an explicit `demoteToReader` keeps working; decide how a tab that demoted on purpose interacts with the queue and record it.
- Report the role on the existing status surface (reader waiting for the lock, writer), and the takeover when it happens.
- Record the decision as a new ADR citing ADR-0075, ADR-0077, ADR-0078 and ADR-0082, and update the guide's "When another tab takes the store" section.

## Acceptance criteria

- [ ] With two tabs open, exactly one indexes (fetches and writes); the other reads the same state and fetches nothing, from the start (no duplicate fetch while it waits).
- [ ] Closing the indexing tab makes the other take over and index forward from the stored cursor, without a reload; its reads keep answering throughout.
- [ ] The same with a dedicated-worker host per tab (the lock taken inside the worker, or by the tab for its worker: decide and record).
- [ ] Without `navigator.locks`, or with the opt-out, behaviour is exactly today's (existing suites unchanged).
- [ ] If two writers happen anyway, the claim still demotes the loser as today.
- [ ] Tests run in a real browser where the Web Locks semantics matter (the repo's Playwright setup), plus unit tests where they suffice; the ADR and guide are written; changesets for every published package changed (0.x: patch or minor).

## Blocked by

- `a-promotion-tells-readers-the-state-moved` (both touch the browser hosts; serialised to keep the rebase trivial).

## Prompt

> Goal: leader election across tabs with Web Locks, so a remaining tab takes over when the indexing tab closes (see What to build). Look at `packages/browser/src/IndexerState.ts` (`demoteToReader`, the claim with `claimWithinSeconds`), `packages/browser/src/host/` (`mainThread.ts`, `dedicatedWorker.ts`, `serve.ts`), `packages/browser/src/stateMovedAcrossTabs.ts`, ADR-0075, ADR-0077, ADR-0078, ADR-0082, and the guide section "When another tab takes the store: your tab becomes a reader".
>
> FIRST, check this task against current reality: if an election exists after all, route to needs-attention naming it.
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.
