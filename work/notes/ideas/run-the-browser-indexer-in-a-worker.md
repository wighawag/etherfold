# Run the browser indexer in a WORKER, on `webevm`'s interchangeable-node pattern

Indexing in a browser blocks the main thread, and it is now measured rather than suspected:
installing a published stream seed blocks for **190 to 216 ms on a Pixel 8a** and **632 ms under a 4x
CPU throttle** in the single-document shape
(`work/notes/findings/what-a-published-stream-seed-costs-to-install.md`). That is the INSTALL alone.
The fold is far worse: `work/notes/findings/sqlite-in-the-browser.md` records 45.6 ms/block on
Chromium for the IndexedDB entity backend, about 47 seconds over the reference workload's 1,042
event-bearing blocks. None of that belongs on the thread that paints.

**Proposal: host the indexer in a Web Worker, and copy the shape `webevm` already proved** rather
than inventing one.

## The precedent, concretely

`packages/webevm` in `wighawag/embedded-eth-node` (`src/worker-client.ts`, `src/worker-host.ts`,
`src/worker-entry.ts`):

- **`createNode()` and `createWorkerNode({worker})` return the SAME interface**, so main-thread and
  worker-hosted are interchangeable one-liners and a consumer never hand-rolls the plumbing. That is
  the property to copy: `createIndexerState` should have a worker-hosted twin with one signature.
- **comlink** for the RPC, with the worker created BY THE CONSUMER
  (`new Worker(new URL('webevm/worker-entry', import.meta.url), {type: 'module'})`) so the bundler
  controls chunking rather than the library.
- **`exposeNode()`** is published from a `worker-host` entry, so a consumer can write its own worker
  module when it needs to build something custom inside the worker.

## The constraint it already learned, which etherfold hits harder

Options are STRUCTURED-CLONED into the worker, so a function-bearing object cannot cross. webevm
refuses to take an `engine` on the worker path and types it `never` so it is a compile error rather
than an opaque `DataCloneError` from inside `postMessage`. Its reasoning applies verbatim here and
then some: an etherfold generation is built from an EIP-1193 provider, a processor FACTORY, a state
store and a stream keeper, and every one of those is function-bearing and holds live handles (an
IndexedDB connection, a wasm instance). So the rule is the same and stronger:

**the indexer must be CONSTRUCTED inside the worker, from serialisable configuration plus module
specifiers, and the main thread gets a proxy carrying reads and notifications only.**

That in turn constrains the seam: whatever the main thread holds has to be expressible as a proxy, so
a state READ HANDLE crossing the boundary becomes a comlink proxy whose calls are async. An app that
reads rows synchronously today would not port unchanged.

## What it interacts with

- **`work/notes/ideas/the-reactive-update-is-an-envelope-not-a-handle.md`** is a near-prerequisite:
  an envelope of plain data plus one proxied handle is exactly what survives a structured clone,
  where today's mutated-in-place `syncing` object does not.
- **The measurement's recommendation softens.** Chunking a published seed is recommended partly to
  keep main-thread blocking down; in a worker that reason disappears and only the peak-heap argument
  remains, which the same finding shows is worth about 20% on a real device. So a worker-hosted
  indexer makes the single-document shape MORE attractive, not less.
- **`@etherfold/browser` is the only affected package**, and the core is already runtime-agnostic
  (`@etherfold/core` names no runtime and `fetch` is global), so this is a hosting change rather than
  an engine change.

## Not decided here

Whether the worker owns the provider too (so `eth_getLogs` leaves the main thread as well, which is
most of the point), how a reorg notification reaches the UI, and whether the two hosting shapes share
one entry with a flag or are two exported factories. `webevm` chose two factories with one interface,
and that is the answer to beat.
