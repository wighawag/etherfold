import 'fake-indexeddb/auto';
import {describeStateStoreConformance, type TwoWriters} from '@etherfold/state-store-conformance';
import {IndexedDBStateStore} from '../src/index.js';
import {freshDatabaseName} from './utils/database.js';

/**
 * This backend, put through the suite every backend must pass.
 *
 * Adding a backend is providing a factory and running the suite, and this file
 * is the whole of it. The cases assert EXTERNAL behaviour only, so a store made
 * of three object stores and two indexes is asked exactly the questions the SQL
 * store and the patch store are asked, and the as-of cases are selected from
 * what this store CLAIMS.
 *
 * Three runs, because this backend can honestly make all three claims and each
 * one selects different cases: `unbounded` is asked historical reads at any
 * depth, the WINDOW is asked at both its edges and asked to have pruned to it,
 * and `revert-only` is asked to refuse every historical read while still
 * reverting.
 *
 * It runs here on `fake-indexeddb`, which is the same IndexedDB API without a
 * browser. That is deliberately NOT the whole of the evidence: the same suite is
 * run against the same store in Chromium, Firefox and WebKit by
 * `browser/conformance.spec.ts`, because the engine differences this backend was
 * chosen on (and the multi-tab behaviour it was chosen for) are exactly what a
 * shim cannot show. This run is what keeps the acceptance gate honest between
 * browser runs.
 *
 * Every run hands over `twoWriters`, because this backend CLAIMS it enforces a
 * single writer, and on this substrate the storage identity is exactly the
 * `databaseName` (ADR-0075): two handles on one name are two tabs of one app,
 * and two names are two unrelated indexers -- or two generations of one indexer
 * addressed apart, which must keep writing at the same time.
 */

/** Two stores on one database name, or on two: the whole of the scoping question here. */
const twoWriters: TwoWriters = {
	sharingStorage(declarations) {
		const databaseName = freshDatabaseName();
		return [
			new IndexedDBStateStore(declarations, {databaseName}),
			new IndexedDBStateStore(declarations, {databaseName}),
		];
	},
	addressedApart(declarations) {
		return [
			new IndexedDBStateStore(declarations, {databaseName: freshDatabaseName()}),
			new IndexedDBStateStore(declarations, {databaseName: freshDatabaseName()}),
		];
	},
};

await describeStateStoreConformance(
	'IndexedDBStateStore, keeping everything',
	(declarations) => new IndexedDBStateStore(declarations, {databaseName: freshDatabaseName()}),
	{twoWriters},
);

await describeStateStoreConformance(
	'IndexedDBStateStore, with a 128-block window over a 64-block finality',
	(declarations) =>
		new IndexedDBStateStore(declarations, {
			databaseName: freshDatabaseName(),
			retention: {blocks: 128},
			finalityDepth: 64,
		}),
	{twoWriters},
);

await describeStateStoreConformance(
	'IndexedDBStateStore, keeping only what a revert needs',
	(declarations) =>
		new IndexedDBStateStore(declarations, {
			databaseName: freshDatabaseName(),
			retention: 'revert-only',
			finalityDepth: 64,
		}),
	{twoWriters},
);
