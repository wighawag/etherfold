---
status: accepted, not yet implemented
---

# The indexer is HOSTED, and a tab holds a port to its host

The browser indexer runs on the main thread: `createIndexerState` holds the store, drives the **container**, and exposes reactive stores an app subscribes to. Indexing is a fold over every log a contract ever emitted (31,332 events across 1,042 blocks on the measured workload, at 45.6 ms per block of store writes on Chromium), so on the main thread it is jank in an app that is also trying to render.

We decided: **the browser gains a third HOST, and a tab holds a PORT to it.** The host owns the container, the store and the driving loop; the tab owns the UI. Three hosting shapes exist — a dedicated worker (the default), a SharedWorker, and the main thread — and they differ ONLY in how a port is obtained.

## Why this is stated in the vocabulary the repo already has

`CONTEXT.md` already carries the two words that matter. A **container** is the named unit holding generations (`Indexer`, chain-facing; `ReceivingIndexer`, chain-free), and a **host** is the thing that owns a container and schedules its work — the word used throughout for the Node server host, a Worker, a host that can hold a process. This ADR adds a third browser host and nothing else conceptual, which is deliberate: an earlier draft coined *body* and *shell* for the hosted implementation and its wrapper, and those are `container`+`driver` and `host` under new names. ADR-0071 already found that two hosts over one model is what this repository has; a worker is a third.

The one genuinely new noun is the **port**: the typed boundary a tab holds onto a host that is not its own thread. It is pinned in `CONTEXT.md` rather than left to each task to describe.

This follows the rule `CONTEXT.md` states for the wire — *a deployment choice, not two implementations* — which is the same shape one level up: the hosting shape is a deployment choice, and three hosts running three implementations is the obvious accident.

## The port is typed, and its surfaces are cases

One request/response envelope with correlation, and the surfaces multiplexed on it, so a new call is a CASE rather than a new channel. Comlink-style ergonomics are welcome and are not a requirement: the contract is the message shapes. Structured-clone limits are respected at the boundary, so a value that crosses is a value that can cross rather than one that throws at run time.

The surfaces are deliberately several rather than one, because they have different shapes and different consumers. Reads that are not queries go over a thin proxy of the store's read seam, whose four reads are already async, so the proxy is mechanical and an app that does not want a GraphQL runtime can still read typed rows. Status and control are their own channel: how far the fold has got, whether it is syncing, **tx inclusion**, and the lifecycle calls. Queries ride the executor `the-same-query-runs-against-a-worker-and-a-server` defines, and that spec owns both the executor and its serialisation; the store proxy is a different surface with no HTTP twin to disagree with, so it may use structured clone honestly.

## The APP authors the worker entry; this package ships what it calls

A processor is code and closures, so it cannot be cloned across `postMessage`. The worker must IMPORT it. Loading it as a module by URL instead would take the processor out of the app's bundler, losing type-checking across the boundary and duplicating dependencies like viem. So the app writes about five lines, and `new Worker(new URL('./indexer.worker.ts', import.meta.url), {type: 'module'})` is first-class in every current bundler.

A consequence worth having falls out of it: a SharedWorker is identified by its SCRIPT URL plus name, so two different apps on one origin get different workers with nothing to configure — the same scoping the writer guard arrives at from the storage side.

## A dedicated worker is the DEFAULT, and a SharedWorker is opt-in

Both are chosen at construction, and they differ only in how a port is obtained, so this is configuration rather than a fork. Dedicated is the default because it works everywhere, it debugs properly (a SharedWorker needs `chrome://inspect` and has no devtools panel), and the non-leader workers are not idle: each serves its own tab's reads, so reads PARALLELISE instead of funnelling through one worker. SharedWorker wins a narrower prize — one store connection, and no election needed at all — which is why it is offered rather than assumed.

**The main thread stays a supported host.** This looks like a product decision and is not one: an in-process path is needed for tests regardless, so the main-thread host exists whether or not it is a supported product. Making it supported therefore costs documentation rather than code. What changes is that the guide stops leading with it.

**`createIndexerState` IS the main-thread host**, adapted, not a second way of doing the same thing. It is the browser's existing entry point, `CONTEXT.md` names it in two glossary entries, and shipping a parallel construction path beside it would leave two ways to build a main-thread indexer with no rule for choosing. Whether it keeps its name or gains a hosting argument is an implementation choice; what is decided here is that there is ONE main-thread path, not two.

## Writer and reader are expressed ACROSS the boundary

The host holds the store opened for writing; a tab holds a reader. That is the writer/reader split (ADR-0077, ADR-0079) reaching its natural home, and it is why this work is sequenced after it: the two ends of the port are exactly the two ends of that distinction, and building the boundary first would have meant inventing a second way to say the same thing.

## Status is PUSHED, and the control surface NARROWS

Reproducing the main thread's reactive triple across a port would mean either polling or duplicating state in every tab, which is what a surface designed for same-thread use — where a getter is free and a round trip is not — turns into when it crosses a boundary. So progress is pushed, an app builds its own reactive wrapper from the signal, and a small helper for the common case can ship beside it. `a-reader-learns-when-the-state-moved` later decides how a READER tab learns the same thing; this is the host-to-its-own-tab channel.

## A restart is expected, not exceptional

Browsers evict workers. When a host dies: tell the app, reject in-flight calls with a typed error, auto-restart and resume. Resume is nearly free because the state is in the store and the cursor is written in the same transaction as the block it describes (ADR-0027), so resuming is reading the cursor and continuing.

Rejecting rather than silently retrying is the part that is easy to get wrong in the other direction. Silence looks exactly like a stall, which is where "is it broken?" reports come from, and a hung promise is the worst of the available outcomes. Every GraphQL client already retries, and a silent retry hides an event the app may want to know about.
