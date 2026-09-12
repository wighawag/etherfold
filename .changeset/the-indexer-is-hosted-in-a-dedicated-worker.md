---
'@etherfold/browser': minor
---

**The indexer can be HOSTED in a dedicated worker, and a tab holds a typed PORT to it** (ADR-0082).

A **host** is the execution context that owns a **container** and drives it. This adds the first one that is not the UI thread, so folding a chain's history stops competing with rendering, and a tab holds a port instead of the container.

An app writes two things. A worker entry point, which is where its processor and its provider are IMPORTED (both are code and closures, so neither can cross a `postMessage`):

```ts
// indexer.worker.ts
import {createBrowserStateStore, hostIndexerInThisWorker} from '@etherfold/browser';
import {EntityEventProcessor} from '@etherfold/processor-entities';
import {openForWriting} from '@etherfold/state-store';
import {processor, source, provider} from './my-app.js';

hostIndexerInThisWorker({
	createState: async () => openForWriting(await createBrowserStateStore(processor.entities)),
	createProcessor: (store) => new EntityEventProcessor(store, processor),
	provider,
	source,
});
```

...and a constructor call in the tab, which owns the `new Worker(...)` line so its bundler can trace the entry:

```ts
const indexer = connectToIndexerHost(
	dedicatedWorkerHost(() => new Worker(new URL('./indexer.worker.ts', import.meta.url), {type: 'module'})),
);
const {lastToBlock, latestBlock} = await indexer.progress();
```

**The host holds the writer and a tab cannot.** `createState` runs inside the host, so the claim (ADR-0077) is taken there; `IndexerPort` names no mutating verb and carries no store, so the writer/reader split is a fact of the type rather than a rule to remember. A tab that wants rows opens the same store for READING today; proxying the four reads over the port is the next task in this spec.

**One envelope, and surfaces are CASES on it.** `PortCases` is the map a later task adds a key to: request and response are typed off it, correlation is handled once, and every value is checked for structured-clone safety BEFORE it is posted — a function, a symbol or a live class instance is refused with a message naming the field it sat in (`the 'read' response.rows[1].store`), rather than as a `DataCloneError` naming an object from the boundary's own stack. A class instance is refused even though clone accepts it, because clone accepts it by dropping the prototype and handing the other side a copy with no methods.

**One host body, not one per shape.** `serve.ts` names no worker; `dedicatedWorker.ts` is the only file in the package that does, and all it does is hand over a wire (`HostAccess`). That is what makes the SharedWorker and main-thread shapes configuration rather than a second implementation.

`progress` is the one surface so far: how far the fold has got, and WHERE it is running — `scope` is what `globalThis` IS in the answering context, which is how a test asserts that the UI thread is not doing the fold without timing anything. Note the container's own edge it reports faithfully: before the first fetch a cursor is `0` of `0`, so equality alone is not "caught up".

`createIndexerState` is untouched and remains the main-thread path; the last task in this spec makes it this same host rather than a second way of building one.
