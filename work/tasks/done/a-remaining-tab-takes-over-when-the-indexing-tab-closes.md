---
title: 'A remaining tab takes over indexing when the indexing tab closes'
slug: a-remaining-tab-takes-over-when-the-indexing-tab-closes
spec: one-tab-indexes-and-the-others-read
blockedBy: [a-promotion-tells-readers-the-state-moved]
covers: [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]
---

## What to build

The spec `one-tab-indexes-and-the-others-read`, with its tasking decisions D1 to D4 (the note at the top of the spec; they override the spec's text where they differ). Today every tab (main-thread or dedicated-worker host) builds its own indexer, the newest writer claim wins (ADR-0075, ADR-0077) and older tabs demote to readers (ADR-0078); nothing hands the write duty back when the indexing tab closes, so the remaining tabs go stale, and every new tab fetches until it loses.

A first attempt stopped because the host API could not express the election (recorded in this task's history): a host cannot open a tab as a reader, because `createState` always returns a CLAIMED store and reads come from the processor over it; the claim is scoped to a database name the APP chooses inside `createState`, per generation, so the host cannot name a lock; and one lock per store does not match one indexing tab. The decisions answer each:

1. **D1, the election identity.** A host option (for example `tabElection: {name}`) names ONE Web Lock (`navigator.locks`) per APP, held by the tab that indexes for as long as it indexes, covering every generation that tab's host holds. Two apps on one origin supply different names and never contend.
2. **D2, the reader factory.** Beside `createState`, the generation spec gains a factory for a READER (for example `openState(context, bundle?)`, returning a store opened with `openForReading`, and what reads need over it). A tab that does not hold the lock is built from it at once: no claim, no fetch, its reads answer the shared store, it follows the state-moved signal (ADR-0083, including the `repointed` announcement), and its sync progress comes from the leader's publication (the spec's "a leader publishes; it is not polled"). It queues for the lock; when the browser releases it (the holder's tab or worker closed or crashed), the next tab takes it and becomes the writer through ADR-0078's recovery path: a fresh start through `createState`, taking the claim, indexing forward from the stored cursor.
3. **D3, opt-in and documented default.** The election is on when the app supplies both the name and the reader factory; otherwise, and where `navigator.locks` is absent, behaviour is exactly today's. The guide ("When another tab takes the store") and `examples/browser-reference` use it.
4. **D4, scope.** The foreground-takes-the-lease-from-a-backgrounded-tab case is out; say so in the ADR.

The writer claim stays the correctness guarantee underneath: if two tabs both write anyway, the loser demotes exactly as today (the spec's "election is for cost, never for correctness"). Decide whether the lock is taken by the tab or inside a worker host, and for a SharedWorker host (already one indexer) whether it takes the lock at all; record both. Report the role (reader waiting, writer) and a takeover on the existing status surface, over the port for worker hosts. Write a new ADR recording D1 to D4 and amending ADR-0077 and ADR-0082 where they now read differently, and amend ADR-0024's criterion 3 as the spec asks.

## Acceptance criteria

- [ ] Real tabs (the repo's Playwright multi-tab harness, not a mocked lock): under N tabs of one app, exactly one fetches and writes, from the start; all N answer reads identically; the readers render progress.
- [ ] Closing the leader makes another tab take over and index forward with no gap in the recorded blocks, without a reload; the same after a CRASH (the tab or worker killed, not closed cleanly).
- [ ] The same with a dedicated-worker host per tab.
- [ ] Two tabs forced to both believe they lead leave the store correct, the loser demoting as today (asserted explicitly).
- [ ] Two apps with different election names on one origin never contend.
- [ ] Without the opt-in, or without `navigator.locks`, behaviour is exactly today's (existing suites unchanged).
- [ ] The ADR, the guide and the browser reference are written or updated; ADR-0024 amended; changesets for every published package changed (0.x: patch or minor).

## Blocked by

- `a-promotion-tells-readers-the-state-moved` (landed).

## Prompt

> Goal: leader election across tabs with Web Locks, per the spec `one-tab-indexes-and-the-others-read` and its decisions D1 to D4 (see What to build). Look at the spec, `packages/browser/src/IndexerState.ts` (`BrowserGenerationSpec`, `createState`, `demoteToReader`), `packages/browser/src/host/` (`mainThread.ts`, `dedicatedWorker.ts`, `serve.ts`), `packages/browser/src/stateMovedAcrossTabs.ts`, the multi-tab Playwright harness, ADR-0024, ADR-0075, ADR-0077, ADR-0078, ADR-0082 and ADR-0083. `jolly-roger`'s `web/src/lib/core/tab-leader/` is prior art the spec mentions (read-only, and read only that folder).
>
> FIRST, check this task against current reality: if the reader factory or an election already exists, adjust or route to needs-attention naming it.
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.

## Decisions

- **The lock is taken by the host, wherever it runs.** For worker hosts that means inside the worker, so the browser releases it when the worker is killed or its tab dies. Alternative: the tab takes it for its worker; rejected because the lock would outlive a worker the port restarts. Touches `serve.ts` and `IndexerState.ts`; recorded in ADR-0097.
- **A SharedWorker host takes the same lock through the same code.** Its own tabs never contend for it, and this puts it in one election with dedicated-worker hosts of the same app. Alternative: skip the lock for SharedWorker; rejected as a second code path. Recorded in ADR-0097.
- **The reader factory returns `{store, state}`**, not a store alone and not a role argument on `createState`. The main-thread hook needs a read handle for `state`, and `createState` returns a claimed writable store, so reusing it would break "a reader cannot write" by type. New exported type `ReaderState`.
- **The reader's context is `{stream: streamDigestOf(source, resolveStreamConfig(config.stream))}`**, the same way the container computes it, so reader and writer open the same storage.
- **Leader messages travel on a channel named from the election, using the existing cross-tab adapter.** I split out an internal `openStateMovedChannel(channelName)` and switched `index.ts` from `export *` to named re-exports so it stays unexported. The public export list of that module is unchanged.
- **What a reader reports on its port.** It shows its own `host`/`scope`, the leader's `phase` and block figures, and `election`. The leader's `failure`, `publication`, `streamSeed` and `hotUpdate` are not carried over because they describe the leader's host. Before any report arrives the phase is `waiting`. `sameProgress` now also compares `election.role` and `election.tookOver`.
- **A main-thread reader drives nothing.** `startAutoIndexing()` returns `true` and is remembered, so the loop starts on takeover. `indexMore()` and its siblings return `undefined`, the same answer a demoted tab gives. `syncing.lastSync` stays empty, so `checkTxInclusion` answers `unknown`/`not-synced`.
- **A worker-host reader waits for the takeover on reconfigure and hot update**, because both build generations and building one claims. Its driver waits for the lock the same way it waits for a tab's provider.
- **`tookOver` means the host waited behind a held lock.** It is measured by asking with `ifAvailable` first, and is not inferred from having heard a leader.
- **Hosts that stop writing give the lock back:** a demoted main-thread tab, a worker host whose driver stopped on a failure, and any disposed host. Alternative: keep holding it, as a demotion leaves everything else today; rejected because it would block every takeover. Changes demotion's side effects (ADR-0078 context); recorded in ADR-0097.
- **Running without `navigator.locks` is logged once at info level, not refused**, because the election is an optimisation (D3).
