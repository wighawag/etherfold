---
'@etherfold/browser': minor
---

**The MAIN THREAD is now a named hosting shape, and `createIndexerState` IS it** (ADR-0082, whose `status: accepted, not yet implemented` line is removed by this change: all three shapes exist).

The set closes. A browser indexer runs in a dedicated worker (the default), in a SharedWorker, or on the main thread, and the three differ ONLY in how a port is obtained. **The code an app writes against the port is identical across all three**, which is what makes moving the fold off the UI thread later a change to one line of wiring.

```ts
const indexer = createIndexerState({createState, createProcessor});
await indexer.init({provider, source, config: {stream: {finality: 12}}});
await indexer.startAutoIndexing();

// the third hosting shape: a wire to the host that is ALREADY here
const port = connectToIndexerHost(indexer.mainThreadHost(), {watch: false});
```

**Nothing breaks.** `createIndexerState`'s name, arguments and every verb it returned are unchanged; the returned object GAINED one method (`mainThreadHost()`). An app that never wants a port never sees any of this.

**Why the third shape is reached from the hook rather than from a top-level factory.** `dedicatedWorkerHost(() => new Worker(...))` and `sharedWorkerHost(...)` CONSTRUCT a host. On this thread there is already one: `createIndexerState` owns the container, opens the store for writing and runs the loop. A `mainThreadHost(spec)` beside those two would have been a SECOND way to build a main-thread indexer with no rule for choosing between them (and, if an app used both, a second container over one store and a writer refusal three layers from the line that caused it). Grep the package's exports: there is one.

**What it costs, said plainly, because the guide now leads with the dedicated worker instead.** The fold is on the UI thread. 45.6 ms per block of store writes on Chromium is jank in an app that is also trying to render. The main-thread shape is for tests (an in-process path is needed regardless), for a backfill small enough that nobody notices, and for a build that cannot emit a worker. Pass `{watch: false}`: a host on this thread cannot die independently of the tab holding the port, so the liveness probe has nothing to find, and its access carries no `reopen` rather than pretending a restart is possible.

The wire is a real `MessageChannel`, not a direct call. A value that could not cross to a worker must not cross here either, or the shape an app develops against would be more permissive than the shape it ships.

**"One implementation, three shapes" is now a fact about one module.** The case dispatch, the row projection, the derived progress figures, the refusals and the push cadence moved into `src/host/cases.ts`, which is the only place a port case is served, and all three shapes reach it. What is honestly NOT shared is the DRIVER: the worker hosts run `serveIndexerHost`'s loop, the main-thread host runs the hook's own auto-index loop and its four verbs. It is checked by ONE parameterised behaviour suite run against all three shapes in a real browser and against the main-thread one under vitest on every commit, rather than by three test files that agree.

**One behaviour change worth knowing.** `stopAutoIndexing()` now also stops a cycle that was already IN FLIGHT from re-arming the loop. It used to clear only the pending timer, so a stop that landed mid-cycle was undone by that cycle's own re-arm a moment later. That was invisible while nothing waited on a stop; `IndexerPort.stopIndexing()` promises that no chain request is made after it answers, and this is what makes the promise true on this shape.

`CONTEXT.md`'s **indexer host** entry loses its NOT YET BUILT marker, and its **tx inclusion** and **processor kind** entries now describe the browser surface as the three shapes rather than as one hook.
