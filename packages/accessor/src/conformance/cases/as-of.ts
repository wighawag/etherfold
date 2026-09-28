import {BlockNotRetainedError, type Mutation, type StateStoreCapabilities} from '@etherfold/state-store';
import {expect} from 'vitest';
import {allItems, answersHistory, block, cases, ids, item, ITEMS, subjectWith} from '../fixtures.js';
import type {AccessorConformanceCase, AccessorFactory} from '../types.js';

const GROUP = 'a query answers at the tip or as of a block';

/** What block 101 does to the items of block 100: `a` changes, `b` goes, `g` arrives. */
function block101(): Mutation[] {
	return [
		item('a', {...ITEMS.a!, label: 'zebra', weight: 100}),
		{type: 'delete', entity: 'item', id: {id: 'b'}},
		item('g', {label: 'grape', kind: 'rare', weight: 5, ratio: 1, amount: 1n, tag: null}),
	];
}

/**
 * The tip and a pinned block, selected against what the store CLAIMS, as the
 * store conformance suite selects its as-of chapter: a store answering history is
 * asked to answer as of a block with the rows live THEN (not the tip's), a store
 * claiming a window is asked to refuse below it, and a store answering no history
 * is asked to refuse every as-of query. Every refusal is the seam's own
 * `BlockNotRetainedError`, never a query answered from the tip.
 */
export function asOfCases(factory: AccessorFactory, capabilities: StateStoreCapabilities): AccessorConformanceCase[] {
	async function history() {
		return subjectWith(factory, [
			{block: block(100), mutations: allItems()},
			{block: block(101), mutations: block101()},
		]);
	}

	const tip = cases(GROUP, {
		'at the tip, the live rows and only those': async () => {
			const {accessor} = await history();
			const page = await accessor.find({entity: 'item', where: {field: 'label', op: 'eq', value: 'apple'}, limit: 10});
			expect(ids(page)).toEqual(['f']);
			const heavy = await accessor.find({entity: 'item', orderBy: {field: 'weight', direction: 'desc'}, limit: 2});
			expect(ids(heavy)).toEqual(['a', 'f']);
			expect(heavy.rows[0]).toMatchObject({label: 'zebra', weight: 100});
		},
	});

	if (!answersHistory(capabilities)) {
		return [
			...tip,
			...cases(GROUP, {
				'a store answering no history refuses every as-of query, never answering from the tip': async () => {
					const {accessor} = await history();
					await expect(accessor.find({entity: 'item', at: 100, limit: 10})).rejects.toBeInstanceOf(
						BlockNotRetainedError,
					);
					await expect(
						accessor.children({entity: 'room', relation: 'visits', parents: [{room: 'r1'}], at: 100, limit: 10}),
					).rejects.toBeInstanceOf(BlockNotRetainedError);
				},
			}),
		];
	}

	const answered = cases(GROUP, {
		'as of a block, the rows live then, filtered and ordered as they were': async () => {
			const {accessor} = await history();
			const apples = await accessor.find({
				entity: 'item',
				where: {field: 'label', op: 'eq', value: 'apple'},
				at: 100,
				limit: 10,
			});
			expect(ids(apples)).toEqual(['a', 'f']);
			const heavy = await accessor.find({
				entity: 'item',
				orderBy: {field: 'weight', direction: 'desc'},
				at: 100,
				limit: 3,
			});
			expect({ids: ids(heavy), truncated: heavy.truncated}).toEqual({ids: ['b', 'f', 'a'], truncated: true});
			expect(heavy.rows[2]).toMatchObject({label: 'apple', weight: 3});
		},

		'as of the block that changed a row, the change; as of one before any, nothing': async () => {
			const {accessor} = await history();
			expect(ids(await accessor.find({entity: 'item', at: 101, limit: 10}))).toEqual(['a', 'c', 'd', 'e', 'f', 'g']);
			expect(ids(await accessor.find({entity: 'item', at: 99, limit: 10}))).toEqual([]);
		},
	});

	if (capabilities.retention.kind !== 'window') return [...tip, ...answered];

	const window = capabilities.retention.blocks;
	return [
		...tip,
		...answered,
		...cases(GROUP, {
			'below the claimed window an as-of query is refused, never answered from the tip': async () => {
				const {accessor, store} = await history();
				// move the tip far enough that block 100 falls out of the window
				await store.applyBlock(block(101 + window + 10), []);
				await expect(accessor.find({entity: 'item', at: 100, limit: 10})).rejects.toBeInstanceOf(BlockNotRetainedError);
				await expect(
					accessor.children({entity: 'room', relation: 'visits', parents: [{room: 'r1'}], at: 100, limit: 10}),
				).rejects.toBeInstanceOf(BlockNotRetainedError);
			},
		}),
	];
}
