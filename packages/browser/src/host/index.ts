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
 * - `envelope.ts` is what crosses: one request/response with correlation, the
 *   surfaces multiplexed on it as CASES.
 * - `dedicatedWorker.ts` is a shape, and holds the only CODE in this package that
 *   names `Worker`.
 */
export * from './clone.js';
export * from './dedicatedWorker.js';
export * from './endpoint.js';
export * from './envelope.js';
export * from './errors.js';
export * from './port.js';
export * from './serve.js';
