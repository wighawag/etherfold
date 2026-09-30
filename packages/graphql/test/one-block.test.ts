import type {Accessor, FindQuery} from '@etherfold/accessor';
import {describe, expect, it} from 'vitest';
import {buildQuerySchema, localExecutor, QUERY_ERROR_CODES, queryBlocksOf, type QueryContext} from '../src/index.js';
import {block, DECLARATIONS, deposit, GENERATION, pool, sqliteSubject} from './fixtures.js';
import {hashOf} from '../src/conformance/fixtures.js';

/**
 * EVERY OPERATION PINS ONE BLOCK (ADR-0099), which is what stops a parent and
 * its children coming from different blocks and rendering a state that never
 * existed. The writes here happen INSIDE an operation, between the root level
 * and the nested one, through an accessor that applies a block (or reverts one)
 * right after its `find` answers, on a real SQLite store.
 */

const QUERY = `{ pool(first: 10) { pool label deposits(first: 10) { seq who } } }`;

/** An accessor that runs `between` once, after the first `find` has answered and before anything nested is read. */
function interleaving(inner: Accessor, between: () => Promise<void>, times = 1): Accessor {
	let left = times;
	return {
		async find<T>(query: FindQuery) {
			const page = await inner.find<T>(query);
			if (left > 0) {
				left--;
				await between();
			}
			return page;
		},
		children: (query) => inner.children(query),
	};
}

/** The same accessor with the pin stripped: every read at the tip. What an operation with no pin would do. */
function unpinned(inner: Accessor): Accessor {
	return {
		find: ({at: _at, ...query}) => inner.find(query),
		children: ({at: _at, ...query}) => inner.children(query),
	};
}

async function seeded() {
	const subject = await sqliteSubject();
	await subject.store.applyBlock(block(10), [pool('a', {label: 'alpha'}), deposit('a', '1', {who: 'ann'})]);
	return subject;
}

const AT_10 = {
	data: {pool: [{pool: 'a', label: 'alpha', deposits: [{seq: '1', who: 'ann'}]}]},
	extensions: {generation: GENERATION, block: 10, blockHash: hashOf(10)},
};

describe('one operation answers from one block', () => {
	it('a block applied between two resolver levels does not change the answer', async () => {
		const {store, context} = await seeded();
		const accessor = interleaving(store.accessor(), () =>
			store.applyBlock(block(11), [pool('a', {label: 'ALPHA'}), deposit('a', '2', {who: 'bob'})]),
		);
		const result = await localExecutor(buildQuerySchema(DECLARATIONS), context(accessor))({query: QUERY});
		expect(result).toEqual(AT_10);
		// and the next operation sees block 11, so the pin is a pin and not a stale read
		const next = await localExecutor(buildQuerySchema(DECLARATIONS), context())({query: QUERY});
		expect(next.extensions).toEqual({generation: GENERATION, block: 11, blockHash: hashOf(11)});
		expect(next.data).toEqual({
			pool: [
				{
					pool: 'a',
					label: 'ALPHA',
					deposits: [
						{seq: '1', who: 'ann'},
						{seq: '2', who: 'bob'},
					],
				},
			],
		});
	});

	it('and without the pin the same interleaving IS torn, so the case above has teeth', async () => {
		const {store, context} = await seeded();
		const accessor = interleaving(unpinned(store.accessor()), () =>
			store.applyBlock(block(11), [pool('a', {label: 'ALPHA'}), deposit('a', '2', {who: 'bob'})]),
		);
		const result = await localExecutor(buildQuerySchema(DECLARATIONS), context(accessor))({query: QUERY});
		// the parent as of 10, its children as of 11: a state that never existed
		expect(result.data).toEqual({
			pool: [
				{
					pool: 'a',
					label: 'alpha',
					deposits: [
						{seq: '1', who: 'ann'},
						{seq: '2', who: 'bob'},
					],
				},
			],
		});
	});

	it('a reorg mid-operation is retried once, and the retry answers from the replacement branch', async () => {
		const {store, context} = await seeded();
		await store.applyBlock(block(11), [pool('a', {label: 'doomed'})]);
		const accessor = interleaving(store.accessor(), () => store.revertTo(10));
		let finds = 0;
		const counting: Accessor = {
			find: (query) => {
				finds++;
				return accessor.find(query);
			},
			children: (query) => accessor.children(query),
		};
		const result = await localExecutor(buildQuerySchema(DECLARATIONS), context(counting))({query: QUERY});
		expect(finds).toBe(2);
		expect(result).toEqual(AT_10);
	});

	it('a reorg during the retry as well is refused with a code, and answers nothing', async () => {
		const {store, context} = await seeded();
		await store.applyBlock(block(11), [pool('a', {label: 'doomed'})]);
		await store.applyBlock(block(12), [pool('a', {label: 'doomed too'})]);
		// the first attempt pins 12 and sees 11 at its end; the retry pins 11 and sees 10
		const reverts = [11, 10];
		const accessor = interleaving(store.accessor(), () => store.revertTo(reverts.shift()!), 2);
		const result = await localExecutor(buildQuerySchema(DECLARATIONS), context(accessor))({query: QUERY});
		expect(result.data).toBeUndefined();
		expect(result.errors).toHaveLength(1);
		expect(result.errors?.[0]?.extensions).toEqual({
			code: QUERY_ERROR_CODES.tipMovedDuringOperation,
			started: 11,
			ended: 10,
		});
		expect(result.extensions).toEqual({generation: GENERATION, block: null, blockHash: null});
	});

	it('a tip that moved FORWARD is no reorg: the pinned answer stands, with no retry', async () => {
		const {store, context} = await seeded();
		const accessor = interleaving(store.accessor(), () => store.applyBlock(block(11), [pool('a', {label: 'ALPHA'})]));
		let finds = 0;
		const counting: Accessor = {
			find: (query) => {
				finds++;
				return accessor.find(query);
			},
			children: (query) => accessor.children(query),
		};
		const result = await localExecutor(buildQuerySchema(DECLARATIONS), context(counting))({query: QUERY});
		expect(finds).toBe(1);
		expect(result).toEqual(AT_10);
	});

	it('on a store that answers no as-of read, it reads the tip and treats ANY move of the tip as a tear', async () => {
		const {store, tip} = await sqliteSubject({retention: 'revert-only'});
		await store.applyBlock(block(10), [pool('a', {label: 'alpha'}), deposit('a', '1', {who: 'ann'})]);
		const context = (accessor: Accessor): QueryContext => ({
			accessor,
			generation: GENERATION,
			tip,
			asOf: false,
			blocks: queryBlocksOf(store),
		});

		const quiet = await localExecutor(buildQuerySchema(DECLARATIONS), context(store.accessor()))({query: QUERY});
		expect(quiet).toEqual(AT_10);

		const applying = interleaving(
			store.accessor(),
			() => store.applyBlock(block(11), [pool('a', {label: 'ALPHA'}), deposit('a', '2', {who: 'bob'})]),
			1,
		);
		const retried = await localExecutor(buildQuerySchema(DECLARATIONS), context(applying))({query: QUERY});
		expect(retried).toEqual({
			data: {
				pool: [
					{
						pool: 'a',
						label: 'ALPHA',
						deposits: [
							{seq: '1', who: 'ann'},
							{seq: '2', who: 'bob'},
						],
					},
				],
			},
			extensions: {generation: GENERATION, block: 11, blockHash: hashOf(11)},
		});
	});
});
