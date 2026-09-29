import {describeStateStoreConformance, type StateStoreConformanceOptions} from '@etherfold/state-store-conformance';
import {PatchStateStore} from '../src/index.js';

/**
 * This backend, put through the suite every backend must pass.
 *
 * Adding a backend is providing a factory and running the suite, and this file
 * is the whole of it. The cases assert EXTERNAL behaviour only -- what a read
 * returns after a write, after a revert, as of a block -- so a patch-log backend
 * that stores no versions at all is asked exactly the questions a versioned-rows
 * backend is asked, and the suite selects the as-of cases from what this store
 * CLAIMS: `revert-only`, so it must refuse every historical read and keep
 * reverting.
 *
 * Two runs, because a finality depth is what turns pruning on here and pruning
 * is what eventually makes a revert impossible. Neither run is a test double:
 * the first is the store a test or a short-lived tab gets (nothing is ever
 * pruned, because no floor was stated), the second is what a deployment
 * protecting against a 64-block reorg would build.
 *
 * What is NOT here is the case this backend exists for. A conformance case runs
 * on a dense hand-written ladder, which is precisely the fixture that makes this
 * store look like it has history; the sparse stream that shows what it really
 * has is `test/sparse-stream.test.ts`.
 *
 * Both runs hand over `storedCurrent`, this store's non-seam read of a row as it
 * holds it, so the suite can check a `u256` is held canonically (ADR-0098), and
 * `idOrder`, the string order its listings actually ascend in: UTF-16 code units,
 * since `listCurrent` and the read-your-writes merge both sort with `compareIds`,
 * which is JavaScript's `<`. No `listAsOf` order is declared because this store
 * answers no historical listing. Declared, not endorsed: which order the listing
 * SHOULD use is `the-listings-id-order-is-decided`'s question.
 */

const options: StateStoreConformanceOptions = {
	storedCurrent: (store, entity, id) => (store as PatchStateStore).storedCurrent(entity, id),
	idOrder: {listCurrent: 'utf-16', mutationContextList: 'utf-16'},
};

await describeStateStoreConformance(
	'PatchStateStore, with no finality depth declared',
	(declarations) => new PatchStateStore(declarations),
	options,
);

await describeStateStoreConformance(
	'PatchStateStore, protecting against a 64-block reorg',
	(declarations) => new PatchStateStore(declarations, {retention: 'revert-only', finalityDepth: 64}),
	options,
);
