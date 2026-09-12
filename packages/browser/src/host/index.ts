/**
 * HOSTING THE INDEXER SOMEWHERE THAT IS NOT THE UI THREAD (ADR-0082).
 *
 * A **host** is the execution context that owns a **container** and drives it; a
 * **port** is the typed boundary a tab holds onto a host that is not its own
 * thread. Three **hosting shapes** exist and they differ ONLY in how a port is
 * obtained, which is why this directory splits the way it does:
 *
 * - `serve.ts` is the host, and names no shape.
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
 * - `dedicatedWorker.ts` and `sharedWorker.ts` are the two SHAPES, and hold the
 *   only CODE in this package that names a worker constructor. They are
 *   siblings rather than a branch inside anything else, and the second one is
 *   what says the seam was real: what runs inside the host is the same code in
 *   both, so a SharedWorker differs from a dedicated worker in exactly one
 *   thing -- a wire per CLIENT instead of one wire -- which `sharedWorker.ts`
 *   presents to the host as the one endpoint every shape gives it.
 */
export * from './clone.js';
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
