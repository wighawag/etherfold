---
'@etherfold/browser': minor
---

**A SharedWorker is now a hosting shape: several tabs attach to ONE host, and an app chooses it with one constructor argument** (ADR-0082).

Dedicated stays the DEFAULT and nothing changes for an app that says nothing. Shared is opt-in and wins a narrow prize -- one store connection, and no election needed at all -- while paying for it: no devtools panel (it needs `chrome://inspect`), no way for a client to terminate it, and every tab's reads funnel through the one instance instead of parallelising across a worker per tab.

The tab side is one argument:

```ts
const indexer = connectToIndexerHost(
	sharedWorkerHost(
		() => new SharedWorker(new URL('./indexer.worker.ts', import.meta.url), {type: 'module', name: 'my-app-indexer'}),
	),
);
```

...and the entry point is the same file with one call changed:

```ts
// indexer.worker.ts -- `hostIndexerInThisWorker` becomes `hostIndexerInThisSharedWorker`
hostIndexerInThisSharedWorker({
	createState: async () => openForWriting(await createBrowserStateStore(processor.entities)),
	createProcessor: (store) => new EntityEventProcessor(store, processor),
	provider,
	source,
});
```

**NAME the worker.** A SharedWorker is identified by its SCRIPT URL plus its name, so two tabs of one app reach one host and two different apps on one origin get different hosts with nothing to configure -- the same scoping the writer guard arrives at from the storage side (ADR-0075). Leaving it unnamed makes every SharedWorker loaded from that script URL the same one. That property is verified rather than built: a second name is a second host, folding elsewhere, observed on Chromium, Firefox and WebKit.

**Nothing inside the host changed.** `serve.ts` was not touched: the container, the store, the driving loop, the envelope and every case on it are the same code in both shapes, and the browser run proves it by loading ONE built entry file first as a `Worker` and then as a `SharedWorker` and running one piece of app code against both ports (everything it reports matches except the two fields that SAY which shape answered). What the new shape adds is inside `sharedWorker.ts`, where a shape belongs: a SharedWorker is handed a wire per CLIENT, so those wires are presented to the host as the single endpoint every shape gives it.

That fan-in has one job that is not optional. A correlation id is unique per PORT and not globally, which is exactly right and becomes load-bearing the moment there are several ports: two tabs are two documents, each counting from one, so their ids COLLIDE by construction. Answers are therefore re-numbered into one id space on the way in and posted back to the one client that asked -- broadcasting them would RESOLVE one tab's `progress()` with the rows another tab asked for. Pushes go to the tabs that subscribed and to no others.

**A runtime without SharedWorker is TOLD.** `sharedWorkerHost` refuses before it calls your factory, naming what is missing and the shape that works everywhere. It deliberately does not fall back on its own: the shape decides how many writers an app has, so swapping it silently would change that without saying so (`typeof SharedWorker === 'undefined'` is the whole of the check, for an app that wants to branch). Calling the wrong entry helper for the scope is refused too, in both directions, because a mix-up is otherwise SILENT -- a shared scope has no `postMessage` of its own and a dedicated one never fires `connect`, so what an app would see is a host that never answers.

**Lifecycle.** One tab closing is not the host closing: `close()` releases that tab's own port and the fold goes on for whoever is left. The browser ends the worker when its LAST client is gone, and the next tab RESUMES from the cursor rather than re-indexing, because the cursor is written in the same transaction as the block it describes (ADR-0027) -- measured on the ranges the node was asked for, not on the resulting rows, which a re-index would reproduce exactly.

WHICH tab indexes, and what happens when it goes away, is still `one-tab-indexes-and-the-others-read`'s decision. This makes its first rung possible and takes no position on it.
