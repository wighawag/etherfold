---
title: 'A reader tab learns from the indexing tab'
slug: a-reader-tab-learns-from-the-indexing-tab
spec: a-reader-learns-when-the-state-moved
blockedBy: [a-tab-learns-the-state-moved-across-the-port]
covers: [9, 12]
---

## What to build

The same signal, crossing between tabs of one browser profile, so that a tab which is not doing the indexing is not a stale tab.

The transport is a `BroadcastChannel`, and nothing in this repository uses one yet. It is an ADAPTER over the signal and not a second semantics: what is posted is the value the fold published, and a tab that receives it does exactly what a tab receiving it over a port does.

**The channel is scoped by the store's STORAGE IDENTITY**, which is the same scoping rule the writer token already settles by living inside the storage it guards. Two tabs running unrelated indexers on one origin must never hear each other, and two correctly separated generations must not be conflated. Scoping by origin, by app name or by a string an app passes breaks the first of those silently, which is the failure mode worth testing for.

Delivery stays best-effort with no per-client state: post and forget, no acknowledgement, no replay for a tab that was not listening. A tab that missed something converges on the next notification because the token tells it to, which is the property the retraction task established.

Deliberately NOT in this task: **which tab indexes**. Leader election is `one-tab-indexes-and-the-others-read` and is a rung above this. This task is the PUBLICATION half and works identically whoever is writing — before election exists, every indexing tab publishes and every tab listens, which is correct if noisy. Do not build an election, a lease, a heartbeat or a "who is the leader" query here.

## Acceptance criteria

- [ ] A tab that is not indexing receives the signal from the tab that is, and re-reads to state that matches the writer's, with no polling anywhere.
- [ ] The value crossing the channel is the one the fold published, identical to what crosses a port.
- [ ] The channel is scoped by storage identity: two tabs of the same store hear each other, two tabs running different stores on one origin do not. Both directions asserted.
- [ ] Nothing is buffered for a tab that was not listening, and the producer holds nothing per receiving tab.
- [ ] A tab that misses a notification converges on the next one rather than staying stale.
- [ ] No election, lease or heartbeat is introduced; a second publishing tab is noise rather than an error.
- [ ] Tested with real tabs against one database, in the browser package's real-browser suite rather than by mocking the channel, in a NEW case where each tab has its OWN host (not the shared-worker case, where both tabs already hold a port to one host and would be pushed to anyway, so a channel test there would pass while demonstrating nothing).
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`a-tab-learns-the-state-moved-across-the-port`, which establishes how the signal is subscribed to and delivered in the browser. This is the second transport and should not invent a second subscription convention; it also edits the same package.

## Prompt

The goal is that a second window of an app is not a stale window, without that tab running its own fold.

Read `work/specs/tasked/a-reader-learns-when-the-state-moved.md` and **ADR-0083**. The decision to hold to is that one notification model is delivered over whichever transport a deployment has, so the `BroadcastChannel` is an adapter and the app-visible outcome must be indistinguishable from the port case.

Where to look: `@etherfold/browser`. The previous task added the port push; this adds the cross-tab one. For the scoping rule, read `CONTEXT.md` on the **writer token** and on **readable store / writable store**: the token's scope is one unit of STORAGE precisely because the token lives inside it, which is why two unrelated indexers on one origin never contend, and that entry says in as many words that scoping to an origin, a tab, a connection or a lock name OUTSIDE the database breaks it. Your channel name must follow the same rule for the same reason.

The harness is the browser package's own real-browser suite (`packages/browser/browser/`, the playwright specs with their shared harness and workload modules), and you are ADDING a case rather than extending one: the nearest existing case puts several tabs on one SHARED WORKER, which is the wrong model here because those tabs already share a host and already get its pushes. The case that proves this signal is tabs with their OWN hosts against one database. Do not reach for `packages/state-store-indexeddb/browser/multi-tab.spec.ts` either: it is a storage-layer writer-token contention test with no indexer in it, one layer below what you are testing. Note also what the writer token already guarantees about that case: only one of those tabs will successfully write, and the loser DEMOTES to a reader, which is the existing behaviour your case sits on top of rather than something to rebuild.

Also read `CONTEXT.md` on **demotion**, so you do not accidentally build a piece of it. A demoted writer already has a defined behaviour and a defined report; a tab learning that the state moved is not a demotion and must not be routed through one.

Terminology: `CONTEXT.md` reserves **consumer** for a reader of the FEED, so the tab receiving this is a reader tab or an app, never a consumer.

The trap: it is tempting to make the publishing tab tell listeners who it is, or to have listeners ask who is publishing. That is election, it belongs to `one-tab-indexes-and-the-others-read`, and building a half of it here would force that spec to either adopt or unpick your version.

The seam to test at is real tabs in the multi-tab harness: one tab folding, others reading, asserting that the readers' rendered state matches the writer's without any timer in the reading tabs.

Done means: open two tabs, index in one, and the other updates because it was told, scoped so that the app next door hears nothing.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. Exactly which storage facts compose the channel name, and what a tab hosting its own worker does about hearing its own publication twice, are both such decisions. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.

## Decisions

**The channel name is composed from the STORAGE IDENTITY alone, spelled as the store's `databaseName`, and passed as the same config value the store was built with.** The name is `etherfold/state-moved/<databaseName>`, defaulted through `DEFAULT_DATABASE_NAME` so the channel and the store cannot resolve the default differently. Alternatives considered: (a) reading the identity off the store instance — impossible on the publishing side, because the store lives in the worker and `openForWriting`'s `ClaimedStateStore` wrapper does not expose `databaseName` anyway; (b) widening the `StateStore` seam with a `storageIdentity` — a four-backend, conformance-suite-wide change to move a fact the browser caller already holds, which ADR-0078's precedent argues against; (c) an independent channel-name option — rejected outright, it is the "a string an app passes" scoping the spec names as the silent failure. What this touches: apps on a NON-IndexedDB backend (`BrowserStateStoreConfig`'s `{backend: fn}` arm) have a storage identity this parameter cannot spell, and passing that config would silently scope to the default name; I did not add a refusal for it, because the remedy would have to name an identity concept the type does not yet have. If `one-tab-indexes-and-the-others-read` or a SQL-backed browser store needs it, the identity should come from the store rather than from a second parameter here.

**A tab hosting its own worker does not hear its own publication, because publish and listen share ONE channel object.** `BroadcastChannel` never delivers to the object that posted, so the duplicate (once over the port, once off the channel) cannot arise, and nothing has to name the publisher in order to filter it out. The alternative — stamping each publication with a publisher id and dropping your own — was rejected as exactly the half-election the spec fences off: it would put "who is publishing" on the wire, which `one-tab-indexes-and-the-others-read` would then have to adopt or unpick. The cost, stated: two separate `openStateMovedAcrossTabs` calls in ONE document DO hear each other (right, since silently dropping by document would be a scope nobody asked for), and this is why the API is one object rather than a publish function and a subscribe function.

**A publication on a CLOSED adapter is dropped and logged at `info`, not raised.** The ordinary cause is a teardown releasing the channel before the port subscription feeding it, which is a tab going away rather than a failure, and `publish` is wired directly onto a fold's notification path where a throw would reach code that has already applied its block. A genuine `postMessage` failure is still logged as an error. Touches: any app wiring `indexer.onStateMoved(tabs.publish)` and unmounting in either order.
