import {describe, expect, it} from 'vitest';
import {VersionedStateEventProcessor} from '../src/index.js';
import {createTestDB, rows} from './utils/db.js';
import {finality, lastSync, processor, SOURCE, transfer} from './utils/fixtures.js';

// ---------------------------------------------------------------------------------------------------
// TWO GENERATIONS THROUGH THE CONVENIENCE CLASS, IN ONE DATABASE
// ---------------------------------------------------------------------------------------------------
// A generation's state is a TABLE-NAME NAMESPACE inside one database (ADR-0053),
// and this class BUILDS THE STORE FOR YOU -- so if it cannot pass the namespace
// through, two generations built with it over one handle land on the same tables
// and silently share rows, which is the single failure the namespace exists to
// prevent.
//
// The entity-path assembly (`VersionedStateStore` + `EntityEventProcessor`, which
// is what the CLI folds through) always took the option, so this is the gap
// BETWEEN two ways of building the same thing rather than a new axis: the options
// type was a narrow `Pick` that predated the namespace. Asserted here because a
// convenience class that quietly differs from the assembly it stands in for is
// worse than no convenience class.
// ---------------------------------------------------------------------------------------------------

const CONFIG = {finality, alwaysFetchTimestamps: true} as const;

describe('the convenience class passes a table namespace through to the store it builds', () => {
	it('keeps two generations over ONE handle in their own tables', async () => {
		const db = createTestDB();
		const incumbent = new VersionedStateEventProcessor(db, processor, {tableNamespace: 'genA'});
		const successor = new VersionedStateEventProcessor(db, processor, {tableNamespace: 'genB'});
		// `load` is what sets finality and migrates; both must be loaded before either
		// folds, exactly as a host holding two generations does
		await incumbent.load(SOURCE, CONFIG);
		await successor.load(SOURCE, CONFIG);

		await incumbent.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100, lastFromBlock: 88}),
		);

		// the same id, read through each generation's own store
		const inIncumbent = await incumbent.load(SOURCE, CONFIG);
		expect((await inIncumbent?.state.getCurrent<{owner: string}>('token', {id: '1'}))?.owner).toBe('0xalice');
		// the successor folded nothing, so it holds nothing -- rather than reading the
		// incumbent's row out of a table they would otherwise have shared
		const inSuccessor = await successor.load(SOURCE, CONFIG);
		expect(inSuccessor).toBeUndefined();
	});

	it('keeps their SYNC CURSORS apart, which is the half a shared table hides', async () => {
		const db = createTestDB();
		const incumbent = new VersionedStateEventProcessor(db, processor, {tableNamespace: 'genA'});
		const successor = new VersionedStateEventProcessor(db, processor, {tableNamespace: 'genB'});
		// `load` is what sets finality and migrates; both must be loaded before either
		// folds, exactly as a host holding two generations does
		await incumbent.load(SOURCE, CONFIG);
		await successor.load(SOURCE, CONFIG);

		await incumbent.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100, lastFromBlock: 88}),
		);

		// the cursor key is FIXED for every fold, so only the namespace can keep a
		// second generation from resuming on the first one's position
		expect((await incumbent.load(SOURCE, CONFIG))?.lastSync.lastToBlock).toBe(100);
		expect(await successor.load(SOURCE, CONFIG)).toBeUndefined();
	});

	it('names the tables inside the reserved `_` prefix, and leaves an un-namespaced build untouched', async () => {
		const db = createTestDB();
		await new VersionedStateEventProcessor(db, processor, {tableNamespace: 'genA'}).load(SOURCE, CONFIG);

		const names = (
			await rows<{name: string}>(
				db,
				`SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
			)
		).map((row) => row.name);

		// the store's own fixed tables keep the `_` lead, with the namespace INSIDE it,
		// so they stay recognisable as fixed tables
		expect(names).toContain('_genA_blocks');
		expect(names).toContain('_genA_cursor');
		// and a declared entity is the declaration's name under the namespace
		expect(names).toContain('genA_token');
		// nothing was created under the un-namespaced names
		expect(names).not.toContain('_blocks');
		expect(names).not.toContain('token');
	});
});
