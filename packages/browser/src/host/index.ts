/**
 * HOSTING THE INDEXER SOMEWHERE THAT IS NOT THE UI THREAD (ADR-0082).
 *
 * A **host** is the execution context that owns a **container** and drives it; a
 * **port** is the typed boundary a tab holds onto a host. Three **hosting
 * shapes** exist and they differ ONLY in how a port is obtained, which is why
 * this directory splits the way it does:
 *
 * - `cases.ts` is what every shape RUNS: the case dispatch, the row projection,
 *   the derived progress figures, the refusals and the push cadence. It is the
 *   structural form of ADR-0082's "one body running in every hosting shape" --
 *   there is one place a `PortCases` key is served, and all three reach it.
 * - `serve.ts` is the WORKER hosts' driver: it opens a container and advances
 *   it. It names no shape.
 * - `port.ts` is what a tab holds, and names no shape.
 * - `reads.ts` is the store's four reads as a tab holds them: the untyped
 *   proxy on the port, and the TYPED surface generated over it from an app's
 *   own declarations.
 * - `progress.ts` is the small reactive wrapper over the PUSHED progress signal,
 *   for the app that just wants a progress bar. It is a convenience over
 *   `IndexerPort.onProgress` and never a second source of truth.
 * - `envelope.ts` is what crosses: one request/response with correlation, the
 *   surfaces multiplexed on it as CASES.
 * - `restart.ts` is what happens when the host stops existing: a death an app is
 *   TOLD about, a typed refusal for the calls that were in flight, and the policy
 *   the port restarts under. The port drives it; the shape's `reopen` is the one
 *   thing it needs from a hosting shape to do so.
 * - `dedicatedWorker.ts` and `sharedWorker.ts` are two of the three SHAPES, and
 *   hold the only CODE in this package that names a worker constructor. They
 *   are siblings rather than a branch inside anything else, and the second one
 *   is what says the seam was real: what runs inside the host is the same code
 *   in both, so a SharedWorker differs from a dedicated worker in exactly one
 *   thing -- a wire per CLIENT instead of one wire -- which `sharedWorker.ts`
 *   presents to the host as the one endpoint every shape gives it.
 * - `mainThread.ts` is the third, and it is the one that constructs NOTHING:
 *   the host on this thread is `createIndexerState` itself (ADR-0082), so the
 *   shape is reached as `indexer.mainThreadHost()` and there is deliberately no
 *   top-level factory beside the two above that would be a SECOND way to build
 *   a main-thread indexer.
 */
export * from './clone.js';
// `cases.ts`, `pacing.ts` and `mainThread.ts` are deliberately NOT re-exported:
// they are the shared boundary, the shared drive cadence and the third shape's
// plumbing, and the entry points to all of them are already public
// (`hostIndexerInThisWorker`, `createIndexerState().mainThreadHost()`). A second
// exported way to serve or to pace a container is exactly what ADR-0082 closes.
export * from './dedicatedWorker.js';
export * from './endpoint.js';
export * from './envelope.js';
export * from './errors.js';
export * from './port.js';
export * from './progress.js';
export * from './reads.js';
export * from './restart.js';
export * from './serve.js';
export * from './sharedWorker.js';
