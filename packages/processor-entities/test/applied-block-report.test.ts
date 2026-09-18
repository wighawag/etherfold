import type {FoldReport} from '@etherfold/core';
import {MemoryStateStore, openForWriting, type WritableStateStore} from '@etherfold/state-store';
import {describe, expect, it} from 'vitest';
import {applyEventStream, EntityEventProcessor, type EntityProcessor} from '../src/index.js';
import {finality, lastSync, processor, SOURCE, transfer, type TestABI} from './utils/fixtures.js';

/**
 * WHERE THE TOUCHED-ENTITY SET IS PRODUCED, which is here, where the mutations
 * are.
 *
 * `@etherfold/core` owns the block numbers, the generations and the coherence
 * token, and it cannot see an entity name: `EventProcessor.process` returns an
 * opaque result and the word *mutation* does not occur in that package. So the
 * set is produced at this layer and RELAYED upward into the signal a reader
 * learns from (ADR-0083), and what is asserted here is the producing half: WHICH
 * blocks are reported, WHEN, and what a report contains.
 *
 * The FORK POINT is produced here for the same reason and by the same path: the
 * line that reads the `removed` markers core emitted and calls `revertTo` is the
 * one that knows it, and the seam it calls answers `void` on every backend.
 */

/** A processor that declares NO entities and handles nothing. */
const declaresNothing: EntityProcessor<TestABI> = {
	entities: [],
};

async function memoryStore(declarations = processor.entities): Promise<WritableStateStore> {
	return openForWriting(new MemoryStateStore(declarations));
}

describe('a fold reports the blocks it applied', () => {
	it('reports one block per applyBlock, with the entity names its mutations carried', async () => {
		const applied: FoldReport[] = [];
		await applyEventStream(
			await memoryStore(),
			processor,
			[
				transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n}),
				transfer(100, '0xA', {from: '0xalice', to: '0xbob', id: 1n}),
				transfer(101, '0xB', {from: '0x0', to: '0xcarol', id: 2n}),
			],
			undefined,
			undefined,
			(block) => applied.push(block),
		);

		// ONE report per BLOCK, not per event and not per mutation: three events in
		// two blocks are two reports
		expect(applied).toEqual([
			// deduplicated and sorted, so two runs of one block produce one payload
			{kind: 'applied', block: 100, entities: ['counter', 'token']},
			{kind: 'applied', block: 101, entities: ['counter', 'token']},
		]);
	});

	it('reports an EMPTY set for a processor that declares no entities, rather than failing', async () => {
		// The honest answer where there are no names to give. Narrow invalidation then
		// degrades to whatever the coherence token says, which is correct if coarse --
		// and an empty set is emphatically not a fabricated one.
		const applied: FoldReport[] = [];
		await applyEventStream(
			await memoryStore([]),
			declaresNothing,
			[transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n})],
			undefined,
			undefined,
			(block) => applied.push(block),
		);

		expect(applied).toEqual([{kind: 'applied', block: 100, entities: []}]);
	});

	it('reports a block only AFTER it was applied, and never one that was not', async () => {
		// A report tells a reader to re-read. A block that threw did not land, so
		// reporting it would send every reader back to the store for a change that is
		// not there -- and the report sits after `applyBlock` returns for exactly that
		// reason.
		const store = await memoryStore();
		const order: string[] = [];
		const applyBlock = store.applyBlock.bind(store);
		store.applyBlock = async (block, mutations, write) => {
			if (block.number === 101) throw new Error('the store refused this block');
			order.push(`applied:${block.number}`);
			return applyBlock(block, mutations, write);
		};

		await expect(
			applyEventStream(
				store,
				processor,
				[
					transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n}),
					transfer(101, '0xB', {from: '0xalice', to: '0xbob', id: 1n}),
				],
				undefined,
				undefined,
				(report) =>
					order.push(report.kind === 'applied' ? `reported:${report.block}` : `retracted:${report.forkPoint}`),
			),
		).rejects.toThrow('the store refused this block');

		expect(order).toEqual(['applied:100', 'reported:100']);
	});

	it('is OPTIONAL: a caller that passes no reporter is unaffected', async () => {
		const store = await memoryStore();
		await applyEventStream(store, processor, [transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n})], undefined);
		expect((await store.getCurrent<{owner: string}>('token', {id: '1'}))?.owner).toBe('0xalice');
	});

	it('reaches the same reports through the EventProcessor the core drives', async () => {
		// The container attaches the reporter to the `EventProcessor`, not to
		// `applyEventStream`, so the slot on the class is what actually has to work.
		const p = new EntityEventProcessor(await memoryStore(), processor);
		const applied: FoldReport[] = [];
		p.setFoldReporter((block) => applied.push(block));
		await p.load(SOURCE, {finality});
		await p.process(
			[transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		expect(applied).toEqual([{kind: 'applied', block: 100, entities: ['counter', 'token']}]);

		p.setFoldReporter(undefined);
		await p.process(
			[transfer(101, '0xB', {from: '0xalice', to: '0xbob', id: 1n})],
			lastSync({latestBlock: 101, lastToBlock: 101, lastFromBlock: 89}),
		);
		expect(applied.map((report) => report.kind === 'applied' && report.block)).toEqual([100]);
	});
});

describe('a fold reports the branch it took back', () => {
	it('reports ONE retraction naming the fork point, before the replacement block', async () => {
		// The stream a reorg produces: the reorged-out event flagged `removed`, then
		// the canonical replacement at the same height. The fold reverts ONCE, to one
		// below the lowest removed block, and says so -- and it says so BEFORE the
		// replacement, because a reader told the other way round would re-read the
		// replacement and then be told to throw it away.
		const store = await memoryStore();
		const reports: FoldReport[] = [];
		await applyEventStream(
			store,
			processor,
			[transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n})],
			undefined,
			undefined,
			(report) => reports.push(report),
		);
		await applyEventStream(
			store,
			processor,
			[
				transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n}, {removed: true}),
				transfer(100, '0xB', {from: '0x0', to: '0xcarol', id: 1n}),
			],
			undefined,
			undefined,
			(report) => reports.push(report),
		);

		expect(reports).toEqual([
			{kind: 'applied', block: 100, entities: ['counter', 'token']},
			// ONE below the lowest removed block, which is what `revertTo` was handed
			{kind: 'retracted', forkPoint: 99},
			{kind: 'applied', block: 100, entities: ['counter', 'token']},
		]);
		// and the fold really did revert: the reorged-out owner is gone
		expect((await store.getCurrent<{owner: string}>('token', {id: '1'}))?.owner).toBe('0xcarol');
	});

	it('reports a retraction with NO replacement, which is a reorg that only withdrew', async () => {
		// A block's logs can simply vanish with no replacement (the transaction went
		// back to the mempool). Nothing is applied, so a channel that only reported
		// APPLIED blocks would say nothing at all about the one case where a reader is
		// certainly wrong.
		const store = await memoryStore();
		const reports: FoldReport[] = [];
		await applyEventStream(store, processor, [transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n})], undefined);
		await applyEventStream(
			store,
			processor,
			[transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n}, {removed: true})],
			undefined,
			undefined,
			(report) => reports.push(report),
		);

		expect(reports).toEqual([{kind: 'retracted', forkPoint: 99}]);
		expect(await store.getCurrent<{owner: string}>('token', {id: '1'})).toBeUndefined();
	});

	it('reverts ONCE at the LOWEST removed block, however the retractions are ordered', async () => {
		const store = await memoryStore();
		const reports: FoldReport[] = [];
		await applyEventStream(store, processor, [transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n})], undefined);
		await applyEventStream(store, processor, [transfer(101, '0xB', {from: '0xalice', to: '0xbob', id: 1n})], undefined);
		await applyEventStream(
			store,
			processor,
			[
				transfer(101, '0xB', {from: '0xalice', to: '0xbob', id: 1n}, {removed: true}),
				transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n}, {removed: true}),
			],
			undefined,
			undefined,
			(report) => reports.push(report),
		);

		// one retraction and not two, naming 99 and not 100: the high-to-low ordering
		// is exactly the case a per-event revert would get wrong
		expect(reports).toEqual([{kind: 'retracted', forkPoint: 99}]);
	});

	it('reports the retraction only AFTER the revert returned', async () => {
		// A revert that threw took nothing back, and telling a reader otherwise would
		// rotate a coherence token over a branch that is still standing.
		const store = await memoryStore();
		await applyEventStream(store, processor, [transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n})], undefined);
		store.revertTo = async () => {
			throw new Error('the store refused this revert');
		};
		const reports: FoldReport[] = [];

		await expect(
			applyEventStream(
				store,
				processor,
				[transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n}, {removed: true})],
				undefined,
				undefined,
				(report) => reports.push(report),
			),
		).rejects.toThrow('the store refused this revert');

		expect(reports).toEqual([]);
	});
});
