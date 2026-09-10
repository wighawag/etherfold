---
title: 'The indexer runs in a worker and the tab talks to it'
slug: the-indexer-runs-in-a-worker-and-the-tab-talks-to-it
humanOnly: true
needsAnswers: true
taskedAfter: [a-second-writer-writes-nothing]
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

<!-- open-questions -->
<!--
  TRANSIENT BLOCK — stripped by the apply rung on full resolution.
-->

## Open questions

1. **Who authors the worker script?** The processor is CODE and cannot cross a `postMessage` boundary, so the worker must IMPORT it, which means the worker entry point is app-authored and this package ships the body it calls rather than the script itself. The alternative is a processor MODULE loaded by URL, which `instantiateProcessor` already contemplates for hosts, and which would let this package ship a ready-made worker at the cost of the app's bundler no longer seeing its own processor.
2. **Dedicated worker or SharedWorker, and who decides?** They differ in exactly the way the election spec cares about: a SharedWorker is one instance per origin and script, so it removes election entirely, while a dedicated worker is per tab and needs one. Both are wanted, which suggests the boundary should be transport-shaped (a `MessagePort`) and the choice a deployment's, but a SharedWorker's lifecycle and its inability to be debugged in some tooling are real costs to accept knowingly.
3. **Does the control surface mirror the current hook, or narrow?** `createIndexerState` exposes a reactive `syncing` / `state` / `status` triple, `checkTxInclusion`, and generation control. Mirroring it across a port preserves every app, and it also exports a surface designed for same-thread use, where a getter is free and a round trip is not.
4. **What happens when the worker dies?** A crashed or evicted worker leaves a tab holding a port to nothing. Restart-and-resume should be transparent (the state is in the store and the cursor is beside it), but "transparent" has to be defined: whether in-flight queries reject or retry, and whether the app is told at all.
5. **Is the main-thread path kept?** Running the indexer on the main thread is what ships today and is the simplest thing for a small app. Keeping both means two hosting shapes to support; dropping it means the smallest app pays for a worker.

<!-- /open-questions -->

## Problem Statement

Nothing in this repository puts the indexer in a worker. `packages/browser/src` does not contain the string `Worker` anywhere. `createIndexerState` is a main-thread hook: it holds the store, drives the engine, and exposes reactive stores an app subscribes to.

That is fine for what it was for and it is now load-bearing for two specs that assume otherwise. The query spec says the resolvers need the store handle, the store is in the worker, so the schema and the `graphql` runtime live there and the main thread holds a stub. The election spec's first rung is a SharedWorker, which is a singleton by construction. Neither can be tasked past that presumption, and both are otherwise ready.

There are also reasons to want it independent of those specs. Indexing is a fold over every log a contract ever emitted: on the real measured workload that is 31,332 events across 1,042 blocks, and the store writes cost 45.6 ms per block on Chromium. On the main thread that is jank in an app that is also trying to render. A worker also makes the payload story work, since the `graphql` runtime the query spec prices at 47.3 to 86.3 KB gzip lands in the worker bundle rather than on the first-paint path.

What is missing is not the ability to construct a worker. It is the boundary: what crosses it, in which direction, what the app writes, and what happens when the thing on the other side stops existing.

## Solution

**The worker owns the store, the engine and the query executor. The tab owns the UI and holds a port.**

Three surfaces cross that port, and they are deliberately three rather than one because they have different shapes and different consumers:

**Queries** go over the `QueryExecutor` the query spec defines. That is the surface an app writes most of its reads against, it is the one that is identical against a remote server, and it needs nothing from this spec beyond a port to sit on.

**Reads that are not queries** go over a thin proxy of the store's read seam, so `createReadSurface`'s four reads work cross-thread. Every method there is already async, so the proxy is mechanical, and it is what lets an app that does not want the `graphql` runtime still read typed rows.

**Status and control** are their own channel: how far the fold has got, whether it is syncing, `checkTxInclusion` for an app laying optimistic updates over indexed state, and the lifecycle calls (start, stop, reconfigure, generation control). These are the parts of today's hook that are not reads at all.

**The processor crosses as an import, never as a message.** A processor is code and a closure; it cannot be cloned. So the worker entry point imports it and hands it to the body this package ships. That is the one thing an app must write itself, and it should be a handful of lines.

**Hosting shape is a deployment choice, not a code change.** Dedicated worker, SharedWorker, or (if kept) the main thread differ in where the body runs and how many of it there are. The app's code against the port should not know which, which is also what lets the election spec's ladder be a configuration rather than a fork.

## User Stories

1. As an app developer, I want the indexer off my UI thread, so that folding a chain's history does not make my app janky.
2. As an app developer, I want to write a few lines of worker entry point, so that my bundler still sees my processor and my types still work.
3. As an app developer, I want to query the worker with the same document I would send to a server, so that local and hosted are one code path.
4. As an app developer, I want typed reads without loading a GraphQL runtime, so that a small app is not forced to pay for a query language it does not use.
5. As an app developer, I want to render "syncing, 400 blocks behind", so that a first visit is not a blank screen for a minute.
6. As an app developer, I want `checkTxInclusion` from the tab, so that I can lay an optimistic update over indexed state without double-counting.
7. As an app developer, I want to start and stop indexing, so that a background tab or a settings screen can stop burning a user's rate limit.
8. As an app developer, I want to reconfigure the source without losing state, so that the generation machinery is reachable from where my app actually runs.
9. As an app developer, I want a crashed worker to come back and resume, so that a browser evicting it is not a lost afternoon of syncing.
10. As an app developer, I want to know whether an in-flight query survived that, so that I am not silently rendering a promise that never settles.
11. As an app developer, I want to choose a dedicated or shared worker without changing my app code, so that the single-writer story is a deployment decision.
12. As an app developer with the app open twice, I want the shared case to work, so that a SharedWorker is a real option rather than a theoretical one.
13. As an app developer, I want the worker to hold the writer's store and the tab to hold a reader's, so that the writer-guard split is expressed across the boundary rather than only within one thread.
14. As a user, I want the app to be usable while it is still indexing, so that syncing is a progress bar and not a wall.
15. As a maintainer, I want one body running in every hosting shape, so that a dedicated worker, a SharedWorker and the main thread do not become three implementations.
16. As a maintainer, I want the boundary tested in a real browser with a real worker, so that a `postMessage` contract is not asserted against a mock.
17. As a maintainer, I want structured-clone limits respected at the boundary, so that a value that crosses is a value that can cross rather than one that throws at run time.
18. As a maintainer, I want the query executor's serialisation to be the one the query spec pins, so that the worker path cannot become "nicer locally" and diverge from HTTP.

### Autonomy notes

- **`humanOnly: true`.** This decides the shape of the public browser API: whether `createIndexerState` stays, what an app writes, and whether the main-thread path survives. That is the surface every browser app is written against.
- **`needsAnswers: true`.** Question 1 decides what an app authors and therefore what this package can ship at all; question 5 decides whether there are one or two supported hosting shapes, which changes every task's scope.
- **`taskedAfter: [a-second-writer-writes-nothing]`.** The two ends of this port are exactly the two ends of that spec's writer/reader split: the worker holds the store opened for writing, a tab holds a reader. Building the boundary first would mean inventing a second way to say the same thing.

## Implementation Decisions

**One body, several hosts.** The indexing loop, the store, the executor and the control handling are written once and are agnostic about what they run inside. A dedicated worker, a SharedWorker and (if kept) the main thread differ only in the shell around them and in how a port is obtained. This is the same discipline the fetcher/receiver split already follows and the reason it is stated here is that three shells with three bodies is the obvious accident.

**The boundary is a port, and the surfaces on it are typed.** Not an ad-hoc message protocol per feature: a request/response envelope with the three surfaces above multiplexed on it, so a new call is a case rather than a new channel. Comlink-style ergonomics are welcome and are not a requirement; the contract is the message shapes.

**Serialisation at the boundary is the query spec's, not structured clone's.** Structured clone will happily carry a `bigint` that JSON cannot, and the query spec's parity rule forbids the worker path being nicer than HTTP. So query results are serialised identically on both, and the fact that the transport COULD carry more is deliberately unused. The store proxy is a different surface and may use structured clone honestly, since it has no HTTP twin to disagree with.

**Writer and reader are expressed across the boundary.** The worker holds the store opened for writing; a tab holds a reader. That is the writer-guard spec's split reaching its natural home, and it is why this spec is worth doing in the order it is: the two ends of the port are exactly the two ends of that distinction.

**A restart is expected, not exceptional.** Browsers evict workers. The state is in the store and the cursor is written in the same transaction as the block it describes (ADR-0027), so resuming is reading the cursor and continuing. What needs deciding is only the tab's experience of it (question 4), and the default should be that the app is told rather than left guessing, because a silent restart looks exactly like a stall.

## Testing Decisions

- **A real browser, a real worker.** The `playwright-browser-harness` used by the existing browser runs supports this, and a `postMessage` contract asserted against a mocked port tests the mock.
- **The three surfaces separately**: a query answered identically to the same query in-process; the store proxy returning what a same-thread `createReadSurface` returns; status advancing and `checkTxInclusion` answering correctly across the boundary.
- **Worker death**, deliberately induced: terminate it mid-fold and assert that a restart resumes from the persisted cursor without re-indexing from the start block, and that in-flight calls resolve or reject according to whatever question 4 decides rather than hanging.
- **Both hosting shapes**, in the shapes that survive: a dedicated worker per tab, and a SharedWorker with several tabs attached, which is also the setup the election spec's rung 1 needs.
- **Parity with the in-process executor**, reusing the query spec's conformance cases rather than writing browser-flavoured copies of them, on the same principle the IndexedDB browser run already follows (the cases themselves, not a copy).

## Out of Scope

- **Electing a writer** (`one-tab-indexes-and-the-others-read`). This spec makes a SharedWorker POSSIBLE, which is that spec's first rung, and takes no position on which rung is used.
- **The query surface itself** (`the-same-query-runs-against-a-worker-and-a-server`): the schema, the accessor seam and the rungs. This provides the port its worker executor sits on.
- **Notifying a tab that state moved** (`a-reader-learns-when-the-state-moved`), which needs this port and is its own decision.
- **A service worker.** Rejected in the query spec for reasons that apply here too: intercepting `fetch` makes the read path depend on service-worker lifecycle and hides the seam from the type system.
- **Server-side hosting shapes.** The server and CLI already have their own containers and are not affected.
- **OPFS or any storage change.** IndexedDB remains the browser default (ADR-0024); this moves where the store is DRIVEN from, not what it is.

## Further Notes

Worth being explicit that this spec was discovered rather than planned: the query and election specs were written first and both assume a worker-hosted indexer that does not exist. That is the right order to have found it in (the assumption was load-bearing in two places before anyone tried to build either), but it means this spec is a PREREQUISITE wearing the clothes of a follow-up, and its `taskedAfter` relationships should be read that way when the set is sequenced.

The smallest honest version of this, if it needs to be cut down, is: the port, the query executor on it, the store proxy, and status. Control (start, stop, reconfigure, generations) can follow, because an app that cannot reconfigure from the tab is limited, while an app that cannot read from the tab is not an app.
