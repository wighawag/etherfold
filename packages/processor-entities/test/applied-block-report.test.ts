import type {AppliedBlock} from '@etherfold/core';
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
 */

/** A processor that declares NO entities and handles nothing. */
const declaresNothing: EntityProcessor<TestABI> = {
	version: '1.0.0',
	entities: [],
};

async function memoryStore(declarations = processor.entities): Promise<WritableStateStore> {
	return openForWriting(new MemoryStateStore(declarations));
}

describe('a fold reports the blocks it applied', () => {
	it('reports one block per applyBlock, with the entity names its mutations carried', async () => {
		const applied: AppliedBlock[] = [];
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
		expect(applied.map((block) => block.block)).toEqual([100, 101]);
		// deduplicated and sorted, so two runs of one block produce one payload
		expect(applied.map((block) => block.entities)).toEqual([
			['counter', 'token'],
			['counter', 'token'],
		]);
	});

	it('reports an EMPTY set for a processor that declares no entities, rather than failing', async () => {
		// The honest answer where there are no names to give. Narrow invalidation then
		// degrades to whatever the coherence token says, which is correct if coarse --
		// and an empty set is emphatically not a fabricated one.
		const applied: AppliedBlock[] = [];
		await applyEventStream(
			await memoryStore([]),
			declaresNothing,
			[transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n})],
			undefined,
			undefined,
			(block) => applied.push(block),
		);

		expect(applied).toEqual([{block: 100, entities: []}]);
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
				(block) => order.push(`reported:${block.block}`),
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
		const applied: AppliedBlock[] = [];
		p.setAppliedBlockReporter((block) => applied.push(block));
		await p.load(SOURCE, {finality});
		await p.process(
			[transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		expect(applied).toEqual([{block: 100, entities: ['counter', 'token']}]);

		p.setAppliedBlockReporter(undefined);
		await p.process(
			[transfer(101, '0xB', {from: '0xalice', to: '0xbob', id: 1n})],
			lastSync({latestBlock: 101, lastToBlock: 101, lastFromBlock: 89}),
		);
		expect(applied.map((block) => block.block)).toEqual([100]);
	});
});
