import type {AppliedBlock} from '@etherfold/core';
import {describe, expect, it} from 'vitest';
import {VersionedStateEventProcessor} from '../src/index.js';
import {createTestDB} from './utils/db.js';
import {finality, lastSync, processor, SOURCE, transfer} from './utils/fixtures.js';

/**
 * THE RELAY SURVIVES THIS WRAPPER.
 *
 * A fold reports each block it applied, and the entity names that block touched,
 * to whoever drives it (`EventProcessor.setAppliedBlockReporter`, ADR-0083). The
 * report is produced in `@etherfold/processor-entities`, where the mutations
 * are -- and this class is a WRAPPER over one of those, built LAZILY on first
 * use, so forwarding is something it has to do rather than something it gets.
 *
 * It is pinned by a test because the seam's method is OPTIONAL, which means a
 * wrapper that forgot to forward it would still compile and still pass every
 * other test in this package: every SQL deployment would simply report an empty
 * entity set on every block, for ever, and look perfectly healthy while doing
 * it. That is the exact failure `EventProcessor.getCodeFingerprint` is required
 * in order to avoid, and the price of not being able to require this one.
 */
describe('the applied-block relay through the SQLite wrapper', () => {
	it('forwards a reporter attached BEFORE the inner fold exists', async () => {
		// The ordinary order: a container attaches the relay when it builds the
		// generation, which is before anything is loaded, and the inner fold is not
		// built until the first call that could mutate.
		const p = new VersionedStateEventProcessor(createTestDB(), processor);
		const applied: AppliedBlock[] = [];
		p.setAppliedBlockReporter((block) => applied.push(block));

		await p.load(SOURCE, {finality});
		await p.process(
			[
				transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n}),
				transfer(101, '0xBBB', {from: '0xalice', to: '0xbob', id: 1n}),
			],
			lastSync({latestBlock: 101, lastToBlock: 101, lastFromBlock: 88}),
		);

		expect(applied.map((block) => block.block)).toEqual([100, 101]);
		// the names the mutations carried, deduplicated and sorted -- not the
		// declarations, and not an empty set
		expect(applied.map((block) => block.entities)).toEqual([
			['counter', 'token'],
			['counter', 'token'],
		]);
	});

	it('forwards one attached AFTER the fold is already running, and detaches', async () => {
		const p = new VersionedStateEventProcessor(createTestDB(), processor);
		await p.load(SOURCE, {finality});
		await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);

		const applied: AppliedBlock[] = [];
		p.setAppliedBlockReporter((block) => applied.push(block));
		await p.process(
			[transfer(101, '0xBBB', {from: '0xalice', to: '0xbob', id: 1n})],
			lastSync({latestBlock: 101, lastToBlock: 101, lastFromBlock: 89}),
		);
		expect(applied.map((block) => block.block)).toEqual([101]);

		p.setAppliedBlockReporter(undefined);
		await p.process(
			[transfer(102, '0xCCC', {from: '0xbob', to: '0xcarol', id: 1n})],
			lastSync({latestBlock: 102, lastToBlock: 102, lastFromBlock: 90}),
		);
		expect(applied.map((block) => block.block)).toEqual([101]);
	});
});
