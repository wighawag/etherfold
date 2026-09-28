import {describeAccessorConformance, type AccessorFactory} from '@etherfold/accessor/conformance';
import {VersionedStateStore, type VersionedStateStoreOptions} from '../src/index.js';
import {createTestDB} from './utils/db.js';

/**
 * This backend's accessor (ADR-0099), put through the suite every accessor must
 * pass, once per retention CLAIM because the as-of chapter asks a store what it
 * said it could answer, and once in a table namespace beside another
 * generation, where a statement that spelled a table name for itself would read
 * nothing.
 *
 * No `rowsExaminedBound` is passed, deliberately: SQLite has a query planner and
 * declares no bound, and the suite checks that claim by asking it to answer a
 * query examining more rows than the browser's default bound.
 */
function factory(options: VersionedStateStoreOptions = {}): AccessorFactory {
	return (declarations) => {
		const store = new VersionedStateStore(createTestDB(), declarations, options);
		return {store, accessor: store.accessor()};
	};
}

await describeAccessorConformance('the SQLite accessor, over a store claiming unbounded history', factory());

await describeAccessorConformance(
	'the SQLite accessor, over a store claiming a 60-block window',
	factory({retention: {blocks: 60}, finalityDepth: 60}),
);

await describeAccessorConformance(
	'the SQLite accessor, over a store set to revert-only',
	factory({retention: 'revert-only'}),
);

await describeAccessorConformance(
	'the SQLite accessor, in a table namespace beside another generation',
	async (declarations) => {
		const db = createTestDB();
		await new VersionedStateStore(db, declarations, {tableNamespace: 'incumbent'}).migrate();
		const store = new VersionedStateStore(db, declarations, {tableNamespace: 'successor'});
		return {store, accessor: store.accessor()};
	},
);
