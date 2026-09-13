import type {FoldReport} from '@etherfold/core';
import {describe, expect, it} from 'vitest';
import {VersionedStateEventProcessor} from '../src/index.js';
import {createTestDB} from './utils/db.js';
import {finality, lastSync, processor, SOURCE, transfer} from './utils/fixtures.js';

/**
 * THE RELAY SURVIVES THIS WRAPPER.
 *
 * A fold reports what it did -- each block it applied with the entity names that
 * block touched, and each branch it took back with the fork point it kept -- to
 * whoever drives it (`EventProcessor.setFoldReporter`, ADR-0083). The report is
 * produced in `@etherfold/processor-entities`, where the mutations and the
 * `removed` markers are read -- and this class is a WRAPPER over one of those,
 * built LAZILY on first use, so forwarding is something it has to do rather than
 * something it gets.
 *
 * It is pinned by a test because the seam's method is OPTIONAL, which means a
 * wrapper that forgot to forward it would still compile and still pass every
 * other test in this package: every SQL deployment would simply report an empty
 * entity set on every block and no retraction at all when the chain reorged, for
 * ever, and look perfectly healthy while doing it. That is the exact failure
 * `EventProcessor.getCodeFingerprint` is required in order to avoid, and the
 * price of not being able to require this one.
 */
describe('the fold-report relay through the SQLite wrapper', () => {
	it('forwards a reporter attached BEFORE the inner fold exists', async () => {
		// The ordinary order: a container attaches the relay when it builds the
		// generation, which is before anything is loaded, and the inner fold is not
		// built until the first call that could mutate.
		const p = new VersionedStateEventProcessor(createTestDB(), processor);
		const applied: FoldReport[] = [];
		p.setFoldReporter((report) => applied.push(report));

		await p.load(SOURCE, {finality});
		await p.process(
			[
				transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n}),
				transfer(101, '0xBBB', {from: '0xalice', to: '0xbob', id: 1n}),
			],
			lastSync({latestBlock: 101, lastToBlock: 101, lastFromBlock: 88}),
		);

		// the names the mutations carried, deduplicated and sorted -- not the
		// declarations, and not an empty set
		expect(applied).toEqual([
			{kind: 'applied', block: 100, entities: ['counter', 'token']},
			{kind: 'applied', block: 101, entities: ['counter', 'token']},
		]);
	});

	it('forwards a RETRACTION, which is the half a reorg depends on', async () => {
		// The same channel carries the fork point, so a wrapper that forwarded only
		// half of it would leave every SQL deployment's readers rendering an abandoned
		// branch -- the failure the signal exists to prevent.
		const p = new VersionedStateEventProcessor(createTestDB(), processor);
		const reports: FoldReport[] = [];
		p.setFoldReporter((report) => reports.push(report));

		await p.load(SOURCE, {finality});
		await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		await p.process(
			[
				transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n}, {removed: true}),
				transfer(100, '0xBBB', {from: '0x0', to: '0xcarol', id: 1n}),
			],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);

		expect(reports).toEqual([
			{kind: 'applied', block: 100, entities: ['counter', 'token']},
			{kind: 'retracted', forkPoint: 99},
			{kind: 'applied', block: 100, entities: ['counter', 'token']},
		]);
	});

	it('forwards one attached AFTER the fold is already running, and detaches', async () => {
		const p = new VersionedStateEventProcessor(createTestDB(), processor);
		await p.load(SOURCE, {finality});
		await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);

		const applied: FoldReport[] = [];
		p.setFoldReporter((report) => applied.push(report));
		await p.process(
			[transfer(101, '0xBBB', {from: '0xalice', to: '0xbob', id: 1n})],
			lastSync({latestBlock: 101, lastToBlock: 101, lastFromBlock: 89}),
		);
		expect(applied.map((report) => report.kind === 'applied' && report.block)).toEqual([101]);

		p.setFoldReporter(undefined);
		await p.process(
			[transfer(102, '0xCCC', {from: '0xbob', to: '0xcarol', id: 1n})],
			lastSync({latestBlock: 102, lastToBlock: 102, lastFromBlock: 90}),
		);
		expect(applied.map((report) => report.kind === 'applied' && report.block)).toEqual([101]);
	});
});
