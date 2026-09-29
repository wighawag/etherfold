import {MemoryStateStore} from '@etherfold/state-store';
import {describeStateStoreConformance, type StateStoreConformanceOptions} from '../src/index.js';

/**
 * The reference backend, put through the suite it defines.
 *
 * It runs HERE rather than in `@etherfold/state-store` for a boring reason with
 * no way around it: this package depends on that one, so that one cannot depend
 * back on this one to run the suite. The seam's own tests keep what is
 * particular to the in-memory store (its block lookup, the declaration
 * validation it rejects at construction) and the shared cases live here, once.
 *
 * Three runs, because retention is a CLAIM and each claim is a different
 * contract: keeping everything, keeping a window, and keeping history for revert
 * alone. The suite reads each claim and asks that store what it said it could
 * do.
 *
 * All three are ordinary CONFIGURATION rather than test doubles. They were
 * doubles while nothing pruned, because a store claiming a window it could not
 * enforce was the fiction the report exists to prevent; now that the window is
 * enforced on both halves (refused on read, pruned in storage) the honest
 * subject is the store a deployment would actually build.
 *
 * Each run also hands over `storedCurrent`, this store's non-seam read of a row
 * as it holds it, so the suite can check a `u256` is held canonically (ADR-0098).
 */

const options: StateStoreConformanceOptions = {
	storedCurrent: (store, entity, id) => (store as MemoryStateStore).storedCurrent(entity, id),
};

await describeStateStoreConformance(
	'MemoryStateStore, claiming unbounded history',
	(declarations) => new MemoryStateStore(declarations),
	options,
);

await describeStateStoreConformance(
	'MemoryStateStore, claiming a 60-block window',
	(declarations) => new MemoryStateStore(declarations, {retention: {blocks: 60}, finalityDepth: 60}),
	options,
);

await describeStateStoreConformance(
	'MemoryStateStore, set to revert-only',
	(declarations) => new MemoryStateStore(declarations, {retention: 'revert-only'}),
	options,
);
