import {describe, expect, it} from 'vitest';
import {EntityEventProcessor, EntityStateView} from '../src/index.js';
import {BACKENDS} from './utils/backends.js';
import {finality, lastSync, processor, SOURCE, transfer} from './utils/fixtures.js';

/**
 * The backend-neutral read handle offers the SEAM TIER and nothing else, and
 * asking it for SQL is a COMPILE error rather than a runtime throw.
 *
 * `queryCurrent` / `queryAsOf` take caller-supplied SQL and exist only where a
 * query planner does. The alternative -- putting them on this handle as stubs
 * that throw "not supported on this backend" -- would move the discovery from
 * the developer's editor to a browser tab in production, which is precisely the
 * shape of failure the capability report exists to prevent, one layer up. So
 * they are simply not on the type, and a consumer that needs them chooses
 * `VersionedStateEventProcessor` and gets `VersionedStateView` instead.
 *
 * **`pnpm typecheck` is what runs the assertions in the first case.** Each
 * `@ts-expect-error` FAILS the typecheck if the expression it guards starts
 * compiling, so this file goes red the day someone adds a SQL method here --
 * which is the only way a test can assert that something does not exist.
 * Vitest, which strips types without checking them, is what proves the second
 * case: absent at run time too, rather than typed away and quietly present.
 */
describe('the backend-neutral read handle', () => {
	it('does not compile a SQL-tier read', async () => {
		const store = await BACKENDS[0].open(processor.entities);
		const p = new EntityEventProcessor(store, processor);
		const state: EntityStateView = p.state;

		// the four the seam has, which must keep compiling: this file would pass
		// trivially if the handle had nothing on it at all.
		await state.getCurrent('token', {id: '1'});
		await state.getAsOf('token', {id: '1'}, 100);
		await state.listCurrent('token', {id: '1'}, 10);
		await state.listAsOf('token', {id: '1'}, 100, 10);
		expect(state.capabilities).toEqual({retention: {kind: 'unbounded'}, asOf: true, singleWriter: false});

		// @ts-expect-error a whole-table SQL query is not at the seam: choose SQLite.
		state.queryCurrent;
		// @ts-expect-error nor is its as-of form.
		state.queryAsOf;
		// @ts-expect-error nor is addressing a block by hash or by time.
		state.getBlock;
		// and the store itself is not reachable through it either: the writer is the
		// processor, and a UI callback holding `applyBlock` corrupts the versions.
		// @ts-expect-error
		state.applyBlock;
		// @ts-expect-error
		state.revertTo;
	});

	it('and they are absent at RUN time, not merely typed away', async () => {
		const store = await BACKENDS[0].open(processor.entities);
		const p = new EntityEventProcessor(store, processor);
		await p.load(SOURCE, {finality});
		const state = await p.process(
			[transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);

		for (const method of ['queryCurrent', 'queryAsOf', 'getBlock', 'applyBlock', 'revertTo']) {
			expect(method in (state as unknown as Record<string, unknown>)).toBe(false);
		}
		// what it DOES answer still works, which is what makes the absences a tier
		// rather than an empty object
		expect(await state.getCurrent<{owner: string}>('token', {id: '1'})).toMatchObject({owner: '0xalice'});
	});
});
