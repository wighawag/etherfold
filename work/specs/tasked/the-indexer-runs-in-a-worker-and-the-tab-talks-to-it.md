---
title: 'The indexer runs in a worker and the tab talks to it'
slug: the-indexer-runs-in-a-worker-and-the-tab-talks-to-it
taskedAfter: [a-second-writer-writes-nothing]
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> Tasked 2026-09-11, in SEVEN tasks. The implementation and testing detail moved into them; the durable rationale — a worker is a third HOST rather than a new architecture, the app authoring the worker entry, dedicated as the default, status pushed rather than mirrored, and what happens when a host dies — moved to **ADR-0082**, with the vocabulary pinned in `CONTEXT.md`'s **indexer host** entry.
>
> **The spec's own words for this were *body* and *shell*, and they are RETIRED.** Review found they rename concepts the glossary already carries: a **host** owns a **container** and drives it, which is how this repository already describes the Node server host, a Worker and the two containers of ADR-0071. The prose below is left in the spec's original voice where it is harmless; the tasks and the ADR use the glossary's words, and `CONTEXT.md` records that the coinages are not to be reintroduced.
>
> **It was SPLIT at tasking.** Two of its eighteen launch stories (query the worker with the same document you would send to a server; the query executor's serialisation is the one the query spec pins) describe the executor ON this port rather than the port itself, and they depend on a `QueryExecutor` that does not exist in this repository and that `the-same-query-runs-against-a-worker-and-a-server` defines — a spec which is itself `taskedAfter` this one. Tasking them here would have meant writing build tasks against a type nobody has. They moved to that spec, which this spec's own Out of Scope had already assigned them to, and the remaining sixteen were renumbered and tasked atomically.

## Problem Statement

Nothing in this repository puts the indexer in a worker. `packages/browser/src` does not contain the string `Worker` anywhere. `createIndexerState` is a main-thread hook: it holds the store, drives the engine, and exposes reactive stores an app subscribes to.

That is fine for what it was for and it is now load-bearing for two specs that assume otherwise. The query spec says the resolvers need the store handle, the store is in the worker, so the schema and the `graphql` runtime live there and the main thread holds a stub. The election spec's first rung is a SharedWorker, which is a singleton by construction. Neither can be tasked past that presumption, and both are otherwise ready.

There are also reasons to want it independent of those specs. Indexing is a fold over every log a contract ever emitted: on the real measured workload that is 31,332 events across 1,042 blocks, and the store writes cost 45.6 ms per block on Chromium. On the main thread that is jank in an app that is also trying to render. A worker also makes the payload story work, since the `graphql` runtime the query spec prices at 47.3 to 86.3 KB gzip lands in the worker bundle rather than on the first-paint path.

What is missing is not the ability to construct a worker. It is the boundary: what crosses it, in which direction, what the app writes, and what happens when the thing on the other side stops existing.

## Solution

**The worker owns the store, the engine and the query executor. The tab owns the UI and holds a port.**

Three surfaces cross that port, and they are deliberately three rather than one because they have different shapes and different consumers:

**Queries** go over the `QueryExecutor` the query spec defines. That is the surface an app writes most of its reads against, it is the one that is identical against a remote server, and it needs nothing from this spec beyond a port to sit on. Putting it there is that spec's story, not this one's.

**Reads that are not queries** go over a thin proxy of the store's read seam, so `createReadSurface`'s four reads work cross-thread. Every method there is already async, so the proxy is mechanical, and it is what lets an app that does not want the `graphql` runtime still read typed rows.

**Status and control** are their own channel: how far the fold has got, whether it is syncing, `checkTxInclusion` for an app laying optimistic updates over indexed state, and the lifecycle calls (start, stop, reconfigure, generation control). These are the parts of today's hook that are not reads at all.

**The processor crosses as an import, never as a message.** A processor is code and a closure; it cannot be cloned. So the worker entry point imports it and hands it to the entry helper this package ships. That is the one thing an app must write itself, and it should be a handful of lines.

**Hosting shape is a deployment choice, not a code change.** Dedicated worker, SharedWorker, or the main thread differ in which host runs the container and how many of it there are. The app's code against the port should not know which, which is also what lets the election spec's ladder be a configuration rather than a fork.

The decisions behind each of these, and the answers to the five questions this spec launched with, are in ADR-0082.

## User Stories

1. As an app developer, I want the indexer off my UI thread, so that folding a chain's history does not make my app janky.
2. As an app developer, I want to write a few lines of worker entry point, so that my bundler still sees my processor and my types still work.
3. As an app developer, I want typed reads without loading a GraphQL runtime, so that a small app is not forced to pay for a query language it does not use.
4. As an app developer, I want to render "syncing, 400 blocks behind", so that a first visit is not a blank screen for a minute.
5. As an app developer, I want `checkTxInclusion` from the tab, so that I can lay an optimistic update over indexed state without double-counting.
6. As an app developer, I want to start and stop indexing, so that a background tab or a settings screen can stop burning a user's rate limit.
7. As an app developer, I want to reconfigure the source without losing state, so that the generation machinery is reachable from where my app actually runs.
8. As an app developer, I want a crashed worker to come back and resume, so that a browser evicting it is not a lost afternoon of syncing.
9. As an app developer, I want to know whether an in-flight call survived that, so that I am not silently rendering a promise that never settles.
10. As an app developer, I want to choose a dedicated or shared worker without changing my app code, so that the single-writer story is a deployment decision.
11. As an app developer with the app open twice, I want the shared case to work, so that a SharedWorker is a real option rather than a theoretical one.
12. As an app developer, I want the worker to hold the writer's store and the tab to hold a reader's, so that the writer-guard split is expressed across the boundary rather than only within one thread.
13. As a user, I want the app to be usable while it is still indexing, so that syncing is a progress bar and not a wall.
14. As a maintainer, I want one body running in every hosting shape, so that a dedicated worker, a SharedWorker and the main thread do not become three implementations.
15. As a maintainer, I want the boundary tested in a real browser with a real worker, so that a `postMessage` contract is not asserted against a mock.
16. As a maintainer, I want structured-clone limits respected at the boundary, so that a value that crosses is a value that can cross rather than one that throws at run time.

## Out of Scope

- **The query surface and its executor** (`the-same-query-runs-against-a-worker-and-a-server`): the schema, the accessor seam, the rungs, AND placing the executor on this port with the serialisation that spec pins. This spec provides the port; that spec puts the executor on it. Two of this spec's launch stories moved there at tasking, per the banner above.
- **Electing a writer** (`one-tab-indexes-and-the-others-read`). This spec makes a SharedWorker POSSIBLE, which is that spec's first rung, and takes no position on which rung is used.
- **Notifying a tab that state moved** (`a-reader-learns-when-the-state-moved`), which needs this port and is its own decision. The worker-to-its-own-tab progress channel is in scope here; how a READER tab in another window learns is not.
- **A service worker.** Rejected in the query spec for reasons that apply here too: intercepting `fetch` makes the read path depend on service-worker lifecycle and hides the seam from the type system.
- **Server-side hosting shapes.** The server and CLI already have their own containers and are not affected.
- **OPFS or any storage change.** IndexedDB remains the browser default (ADR-0024); this moves where the store is DRIVEN from, not what it is.

## Further Notes

Worth being explicit that this spec was discovered rather than planned: the query and election specs were written first and both assume a worker-hosted indexer that does not exist. That is the right order to have found it in (the assumption was load-bearing in two places before anyone tried to build either), but it means this spec is a PREREQUISITE wearing the clothes of a follow-up, and its `taskedAfter` relationships should be read that way when the set is sequenced.

That framing is also what produced the split above, and the two are the same observation caught twice: a prerequisite written after the specs that need it will tend to absorb some of their stories, because the author is reasoning forward from what those specs wanted rather than backward from what this one can build alone.

The spec's own suggestion for cutting it down, had it needed cutting, was "the port, the query executor on it, the store proxy, and status" — which still contained the executor it could not have. The tasked set is the honest version of that list: the port, the store proxy, status, control, `checkTxInclusion`, restart-and-resume, and the three hosting shapes.

One more thing the tasking decided that the spec left open: the main-thread path is `createIndexerState` ITSELF, adapted, rather than a new constructor beside it. The spec said only that the main-thread path is KEPT, which would have been satisfiable by shipping a second way to build the same thing. The final task owns that adaptation, along with the `CONTEXT.md` entries that describe the browser surface through that function.
