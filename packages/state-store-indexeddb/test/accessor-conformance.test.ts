import 'fake-indexeddb/auto';
import {describeAccessorConformance, type AccessorFactory} from '@etherfold/accessor/conformance';
import {IndexedDBStateStore, type IndexedDBStateStoreOptions} from '../src/index.js';
import {freshDatabaseName} from './utils/database.js';

/**
 * This backend's accessor (ADR-0099, rung 1: a bounded scan), put through the
 * suite every accessor must pass, so its answers are the SQLite accessor's for
 * every query within the bound: text in UTF-8 order, a `u256` numerically,
 * nulls first ascending, the id tie break, as-of through current plus a delta,
 * and relation pages bounded per parent.
 *
 * Once per retention CLAIM, because the as-of chapter asks a store what it said
 * it could answer, and once with `oneTransactionAtATime`, because a workaround
 * that changes when a read returns has to answer every question identically.
 *
 * Each run DECLARES the bound its accessor was configured with, which is the
 * difference from SQLite (which declares none): the suite asks it to answer at
 * the bound and refuse one row past it. A small bound keeps that cheap; the
 * default is asserted in `accessor.test.ts`.
 *
 * The same suite runs against the same accessor in Chromium, Firefox and WebKit
 * (`browser/state-store.spec.ts`), because the engines' key order and cursor
 * behaviour are exactly what `fake-indexeddb` cannot show.
 */
const BOUND = 60;

function factory(options: IndexedDBStateStoreOptions = {}): AccessorFactory {
	return (declarations) => {
		const store = new IndexedDBStateStore(declarations, {databaseName: freshDatabaseName(), ...options});
		return {store, accessor: store.accessor({rowsExaminedBound: BOUND})};
	};
}

await describeAccessorConformance('the IndexedDB accessor, over a store keeping everything', factory(), {
	rowsExaminedBound: BOUND,
});

await describeAccessorConformance(
	'the IndexedDB accessor, over a store with a 128-block window over a 64-block finality',
	factory({retention: {blocks: 128}, finalityDepth: 64}),
	{rowsExaminedBound: BOUND},
);

await describeAccessorConformance(
	'the IndexedDB accessor, over a store keeping only what a revert needs',
	factory({retention: 'revert-only', finalityDepth: 64}),
	{rowsExaminedBound: BOUND},
);

await describeAccessorConformance(
	'the IndexedDB accessor, refusing two transactions at once',
	factory({oneTransactionAtATime: true}),
	{rowsExaminedBound: BOUND},
);
