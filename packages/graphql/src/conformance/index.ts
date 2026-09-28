/**
 * The QUERY conformance suite (ADR-0099), on its own subpath so the schema
 * module itself (`@etherfold/graphql`) never pulls in vitest and stays
 * runtime-neutral: a server or a browser worker imports the root, an
 * executor's test file imports this.
 *
 * Parameterised by an executor factory, as `@etherfold/state-store-conformance`
 * is by a store factory: one list of requests, each with its history and its
 * expected answer, asked of every executor (in process over SQLite and over
 * IndexedDB here; over HTTP and over a worker port as those land) and required
 * to answer the same BYTES.
 */
export * from './types.js';
export * from './fixtures.js';
export * from './suite.js';
export * from './vitest.js';
export {assertBytes, serialised} from './bytes.js';
export {QUERY_PARITY_CASES} from './cases/parity.js';
