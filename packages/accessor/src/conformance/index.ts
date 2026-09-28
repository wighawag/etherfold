/**
 * The accessor conformance suite, on its own subpath so the seam itself
 * (`@etherfold/accessor`) never pulls in vitest: a resolver in a browser worker
 * imports the root, a backend's test file imports this.
 */
export * from './types.js';
export * from './fixtures.js';
export * from './suite.js';
export * from './vitest.js';
export {UNBOUNDED_PROBE_ROWS} from './cases/rows-examined.js';
