---
'@etherfold/state-store-indexeddb': minor
'@etherfold/browser': minor
---

**`oneTransactionAtATime`: an opt-in refusal to hold two IndexedDB transactions open at once, because on WebKit ending a worker with two in flight can wedge the database for ever.**

On WebKit only, terminating a dedicated worker that has BOTH a `readwrite` and a `readonly` transaction in flight on one database can leave that database permanently unable to run any transaction. `indexedDB.open` keeps succeeding and reports every object store; every transaction taken afterwards then hangs with no `complete`, no `abort` and no `error`, `readonly` as hard as `readwrite`, in the tab as much as in a replacement worker. An unrelated database in the same origin stays healthy, a reload does not clear it, a NEW TAB does not clear it, and `deleteDatabase` reports `blocked` and never completes -- so an application has no recovery available to it short of choosing a different database name and re-indexing from scratch.

It is not a harness artefact: an **iPhone 12 on iOS 18.3.2 / Safari 18.3.1 wedged 12 databases in 200 runs** of a framework-free page, and a much newer upstream build wedges 7 to 13 in 200. Chromium 141 and Firefox 145 are 0 in 200 on the same page, and on all eleven variants of the automated probe. The reproduction, the results and the report body are in `docs/spikes/webkit-terminated-worker-wedges-indexeddb/`.

**Why this package is exposed to it at all:** every read here opens a transaction, awaits the REQUEST, and returns -- which is what every IndexedDB wrapper does and is perfectly legal -- so a read's `readonly` transaction is still committing under the write that follows it. A call trace of a wedging run shows exactly that and nothing else. Since ADR-0082 treats worker eviction as an EXPECTED event, an app folding in a worker can meet this.

```ts
// decide it in the TAB, where a WebKit engine can actually be identified
const webkit = navigator.vendor === 'Apple Computer, Inc.' || 'GestureEvent' in window;
const worker = new Worker(new URL('./indexer.worker.ts', import.meta.url), {type: 'module'});
worker.postMessage({oneTransactionAtATime: webkit});

// ...and in the worker, pass it to the store
const store = await createBrowserStateStore(processor.entities, {oneTransactionAtATime});
```

**It is OFF by default and this package will not decide it for you.** That is not timidity, it is measurement. The option makes every read await its transaction's COMMIT and serialises operations, and a commit round trip is the same order of magnitude as a small read: `getCurrent` costs x1.37 (chromium), x1.84 (firefox), x1.37 (webkit); `getAsOf` x1.48 / x1.88 / x1.33; a fold under concurrent read load x1.11 / x1.21 / x1.11. A `listCurrent` barely moves (x1.03 to x1.16) because its many requests share one transaction -- the cost is charged per TRANSACTION, so what it taxes is a pattern of many small reads. Chromium and Firefox would pay all of that for a defect they do not have, which is why "just do it everywhere" was measured and rejected rather than assumed.

**Nor can it be auto-detected where it would have to run.** Inside a `DedicatedWorkerGlobalScope` every WebKit tell is gone: `navigator.vendor` is `[Exposed=Window]` and absent on all three engines, and `GestureEvent`, `CSSPrimitiveValue` and `webkitConvertPointFromNodeToPage` are `true` only in WebKit's window and `false` in WebKit's own worker. Only the user-agent string separates the engines there. In the TAB both `navigator.vendor` and `GestureEvent` work, and both were checked on an iPhone against Safari, Chrome for iOS (`CriOS`) and Firefox for iOS (`FxiOS`) -- all three are WebKit, all three are caught, which matters because on iOS every browser is WebKit and therefore affected.

**It changes no answer.** `@etherfold/state-store-conformance` runs a fourth time against a store with the option set, and the whole contract passes identically: awaiting a read's commit before returning it is a latency change and nothing else. Nothing about the default path moved -- the option defaults to `false` on `IndexedDBStateStore` and is simply forwarded by `createBrowserStateStore`.

Nothing has been filed against WebKit yet; `docs/spikes/webkit-terminated-worker-wedges-indexeddb/bug-report/` holds the standalone reproduction and the report body ready to submit.
