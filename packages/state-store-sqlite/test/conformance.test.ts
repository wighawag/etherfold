import {describeStateStoreConformance} from '@etherfold/state-store-conformance';
import {VersionedStateStore} from '../src/index.js';
import {createTestDB} from './utils/db.js';

/**
 * This backend, put through the suite every backend must pass.
 *
 * Adding a backend is providing a factory and running the suite, and this file
 * is the whole of it: the cases live in `@etherfold/state-store-conformance` and
 * assert EXTERNAL behaviour only, so they are the same cases the in-memory
 * reference store answers and the same ones a patch-log or IndexedDB backend
 * will answer. The tests that reach for a table, a statement or a version column
 * stay in this package (`schema`, `batch`, `revert-order`, and the raw-SQL
 * assertions in `as-of` and `revert`), because those are properties of THIS
 * implementation rather than of the seam.
 *
 * Each run is a real local libSQL database, never a mock: the properties that
 * matter here (a re-applied block raising, a block applying as one unit, the
 * DELETE-before-reopen ordering inside `revertTo`) are properties of an engine.
 *
 * Three runs, one per retention CLAIM, because the suite tests a store against
 * what it says about itself: keeping everything, keeping a window, and keeping
 * history for revert alone. All three are ordinary configuration: the windowed
 * run was a test double while this package had no pruning and could not honestly
 * claim a window, and it is a real store now that it can.
 *
 * A fourth run puts the store in a TABLE NAMESPACE, beside another generation
 * already migrated into the same handle (ADR-0053). The namespace must be
 * invisible from outside -- every case here is the seam's own behaviour and none
 * of them knows a table name -- and the decoy is what makes the run worth having:
 * a statement that spelled a table name for itself would address the
 * unnamespaced one, which under a namespace exists nowhere, so the case fails
 * loudly instead of passing on a store that was quietly alone.
 */

await describeStateStoreConformance(
	'VersionedStateStore, claiming unbounded history',
	(declarations) => new VersionedStateStore(createTestDB(), declarations),
);

await describeStateStoreConformance(
	'VersionedStateStore, claiming a 60-block window',
	(declarations) => new VersionedStateStore(createTestDB(), declarations, {retention: {blocks: 60}, finalityDepth: 60}),
);

await describeStateStoreConformance(
	'VersionedStateStore, set to revert-only',
	(declarations) => new VersionedStateStore(createTestDB(), declarations, {retention: 'revert-only'}),
);

await describeStateStoreConformance(
	'VersionedStateStore, in a table namespace beside another generation',
	async (declarations) => {
		const db = createTestDB();
		await new VersionedStateStore(db, declarations, {tableNamespace: 'incumbent'}).migrate();
		return new VersionedStateStore(db, declarations, {tableNamespace: 'successor'});
	},
);
