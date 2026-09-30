import 'fake-indexeddb/auto';
import type {Accessor, ChildrenQuery, FindQuery} from '@etherfold/accessor';
import {createSnapshot, openAndBootstrap} from '@etherfold/processor-entities';
import {openForReading, openForWriting, type QueryReads} from '@etherfold/state-store';
import {IndexedDBStateStore} from '@etherfold/state-store-indexeddb';
import {describe, expect, it} from 'vitest';
import {block, hashOf} from '../src/conformance/fixtures.js';
import {buildQuerySchema, localExecutor, QUERY_ERROR_CODES, type QueryContext, type QueryResult} from '../src/index.js';
import {graphqlQueryHandler} from '../src/worker/index.js';
import {DECLARATIONS, deposit, GENERATION, pool, sqliteSubject} from './fixtures.js';

/**
 * A QUERY PINNED TO A BLOCK HASH, AND NEVER ANSWERED FROM TWO BRANCHES
 * (ADR-0099, amended 2026-09-30).
 *
 * The conformance suite asks every executor the same hash-pinned requests over a
 * history applied BEFORE the request. What only an in-process test can do is
 * move the store WHILE an operation reads, which is where the revert sequence
 * earns its place: a reorg away from the pinned block and a second one back to
 * it (A, then B, then A again) leaves the tip and the pin's hash exactly as they
 * were, while the fields read in between came from B. The tip check alone cannot
 * see that; the revert sequence, read BEFORE the pin and AFTER the last field,
 * does.
 */

const QUERY = `{ pool(first: 10) { pool label deposits(first: 10) { seq who } } }`;
/** Block 11 of the chain the operation pinned, and of the branch that briefly replaced it. */
const A11 = hashOf(11);
const B11 = `0x${'b1'.repeat(32)}`;

const ON_A = {pool: [{pool: 'a', label: 'alpha', deposits: [{seq: '1', who: 'ann'}]}]};
const ON_B = {
	pool: [
		{
			pool: 'a',
			label: 'BRANCH-B',
			deposits: [
				{seq: '1', who: 'ann'},
				{seq: '9', who: 'bea'},
			],
		},
	],
};

/** Block 10, then A's block 11 (which changes nothing the query reads). */
async function seeded() {
	const subject = await sqliteSubject();
	await subject.store.applyBlock(block(10), [pool('a', {label: 'alpha'}), deposit('a', '1', {who: 'ann'})]);
	await subject.store.applyBlock(block(11), []);
	return subject;
}

type Store = Awaited<ReturnType<typeof seeded>>['store'];

/** Reorg block 11 to branch B: a different block, with different rows, at the same height. */
async function toB(store: Store) {
	await store.revertTo(10);
	await store.applyBlock(block(11, B11), [pool('a', {label: 'BRANCH-B'}), deposit('a', '9', {who: 'bea'})]);
}

/** And back to A's block 11, the very block the operation pinned: same height, same hash. */
async function toA(store: Store) {
	await store.revertTo(10);
	await store.applyBlock(block(11), []);
}

/** The context a host builds, with the block reads and the revert sequence off the store. */
function hashingContext(store: Store, accessor: Accessor = store.accessor()): QueryContext {
	return {
		accessor,
		generation: GENERATION,
		tip: () => store.tip(),
		asOf: store.capabilities.asOf,
		blocks: {
			at: (number) => store.blockAt(number),
			of: (hash) => store.blockOf(hash),
			revertSequence: () => store.revertSequence(),
		},
	};
}

/**
 * The A, B, A flip INSIDE one operation: to B right after the root `find`
 * answers, and back to A right after the nested `children` answer, `times`
 * times. Counts the root reads, so a retry is visible.
 */
function flipping(store: Store, times: number) {
	let toBLeft = times;
	let toALeft = times;
	const counts = {finds: 0};
	const wrap = (inner: Accessor): Accessor => ({
		async find<T>(query: FindQuery) {
			counts.finds++;
			const page = await inner.find<T>(query);
			if (toBLeft > 0) {
				toBLeft--;
				await toB(store);
			}
			return page;
		},
		async children<T>(query: ChildrenQuery) {
			const pages = await inner.children<T>(query);
			if (toALeft > 0) {
				toALeft--;
				await toA(store);
			}
			return pages;
		},
	});
	return {wrap, counts};
}

describe('a reorg away from the pinned block and back to it (A, B, A) inside one operation', () => {
	it('WITHOUT the revert sequence it is not seen: the pin and its hash match at both ends, and the answer is a mix', async () => {
		// the control: what the guard is for, and why a hash re-check could not be it
		const {store, context} = await seeded();
		const {wrap} = flipping(store, 1);

		const result = await localExecutor(buildQuerySchema(DECLARATIONS), context(wrap(store.accessor())))({query: QUERY});

		// the parent read on A, its children read on B: a state no chain ever had
		expect(result.data).toEqual({
			pool: [
				{
					pool: 'a',
					label: 'alpha',
					deposits: [
						{seq: '1', who: 'ann'},
						{seq: '9', who: 'bea'},
					],
				},
			],
		});
		expect(await store.blockAt(11)).toMatchObject({hash: A11});
	});

	it('is retried, and the retry answers from A alone, naming the hash of A (a tip-pinned operation)', async () => {
		const {store} = await seeded();
		const {wrap, counts} = flipping(store, 1);

		const result = await localExecutor(
			buildQuerySchema(DECLARATIONS),
			hashingContext(store, wrap(store.accessor())),
		)({query: QUERY});

		expect(counts.finds).toBe(2);
		expect(result).toEqual({data: ON_A, extensions: {generation: GENERATION, block: 11, blockHash: A11}});
	});

	it('is retried for a HASH-pinned operation too, which a re-check of that hash would never have caught', async () => {
		const {store} = await seeded();
		const {wrap, counts} = flipping(store, 1);
		const pinned = `{ pool(block: {hash: "${A11}"}, first: 10) { pool label deposits(first: 10) { seq who } } }`;

		const result = await localExecutor(
			buildQuerySchema(DECLARATIONS),
			hashingContext(store, wrap(store.accessor())),
		)({query: pinned});

		expect(counts.finds).toBe(2);
		expect(result).toEqual({data: ON_A, extensions: {generation: GENERATION, block: 11, blockHash: A11}});
	});

	for (const [shape, query] of [
		['tip-pinned', QUERY],
		['hash-pinned', `{ pool(block: {hash: "${A11}"}, first: 10) { pool label deposits(first: 10) { seq who } } }`],
	] as const) {
		it(`and when it happens on the retry as well, the ${shape} operation is REFUSED, answering nothing`, async () => {
			const {store} = await seeded();
			const {wrap, counts} = flipping(store, 2);

			const result = await localExecutor(
				buildQuerySchema(DECLARATIONS),
				hashingContext(store, wrap(store.accessor())),
			)({query});

			expect(counts.finds).toBe(2);
			expect(result.data).toBeUndefined();
			expect(result.errors).toHaveLength(1);
			expect(result.errors?.[0]?.message).toMatch(/reverted/);
			expect(result.errors?.[0]?.extensions).toEqual({
				code: QUERY_ERROR_CODES.tipMovedDuringOperation,
				started: 11,
				ended: 11,
			});
			expect(result.extensions).toEqual({generation: GENERATION, block: null, blockHash: null});
		});
	}
});

describe('THE READ ORDER: the revert sequence before the pin, and after the last field', () => {
	it('catches a revert and a replacement block landing right AFTER the pin is read', async () => {
		// read the other way round (the pin, then the sequence), this revert lands
		// before the sequence's first read, is never seen, and the answer names A's
		// hash over B's rows. The tip is 11 throughout, so the tip check cannot see it.
		const {store} = await seeded();
		const context = hashingContext(store);
		let interleaved = false;
		let finds = 0;
		const counting: Accessor = {
			find: (query) => {
				finds++;
				return store.accessor().find(query);
			},
			children: (query) => store.accessor().children(query),
		};
		const racing: QueryContext = {
			...context,
			accessor: counting,
			blocks: {
				...context.blocks!,
				async at(number) {
					const pinned = await context.blocks!.at(number);
					if (!interleaved) {
						interleaved = true;
						await toB(store);
					}
					return pinned;
				},
			},
		};

		const result = await localExecutor(buildQuerySchema(DECLARATIONS), racing)({query: QUERY});

		// the first attempt was torn and never answered; the retry pinned B, and says so
		expect(finds).toBe(2);
		expect(result).toEqual({data: ON_B, extensions: {generation: GENERATION, block: 11, blockHash: B11}});
	});
});

describe('the existing guard is kept beside it', () => {
	it('a revert that did not reach the pin still costs a retry, and nothing else', async () => {
		const {store} = await seeded();
		await store.applyBlock(block(12), []);
		let left = 1;
		let finds = 0;
		const accessor: Accessor = {
			async find<T>(query: FindQuery) {
				finds++;
				const page = await store.accessor().find<T>(query);
				// a reorg of 12 while a field reads block 10
				if (left-- > 0) {
					await store.revertTo(11);
					await store.applyBlock(block(12, `0x${'c2'.repeat(32)}`), []);
				}
				return page;
			},
			children: (query) => store.accessor().children(query),
		};
		const at10 = `{ pool(block: {number: 10}, first: 10) { pool label deposits(first: 10) { seq who } } }`;

		const result = await localExecutor(buildQuerySchema(DECLARATIONS), hashingContext(store, accessor))({query: at10});

		expect(finds).toBe(2);
		expect(result).toEqual({
			data: ON_A,
			extensions: {generation: GENERATION, block: 12, blockHash: `0x${'c2'.repeat(32)}`},
		});
	});
});

describe('a store that answers queries by hash, through every wrapper between it and the query layer', () => {
	const TOKENS = DECLARATIONS;
	const request = (hash: string) => ({
		query: `{ pool(block: {hash: "${hash}"}, first: 10) { pool label } }`,
	});

	it('bootstrapped from a snapshot (`openAndBootstrap`) and then CLAIMED (`openForWriting`)', async () => {
		const databaseName = `pinned-by-hash-${Math.random().toString(36).slice(2, 10)}`;
		const snapshot = await createSnapshot({
			takenAt: block(20),
			entities: TOKENS,
			rows: [pool('a', {label: 'seeded'})],
			lastSync: {
				context: {source: [], config: '', processor: 'p'},
				lastToBlock: 20,
				lastFromBlock: 10,
				latestBlock: 100,
				unconfirmedBlocks: [],
			} as never,
			processor: 'proc',
		});
		const fetch = (async () => new Response(snapshot.document)) as unknown as typeof globalThis.fetch;
		const {store: aware} = await openAndBootstrap(new IndexedDBStateStore(TOKENS, {databaseName}), 'https://x/s', {
			processor: 'proc',
			fetch,
		});
		const writer = await openForWriting(aware);
		await writer.applyBlock(block(21), [pool('a', {label: 'later'})]);
		const handler = graphqlQueryHandler();
		const context = async () => ({store: writer, generation: GENERATION});

		const at20 = await handler(request(hashOf(20)), context);
		const at21 = await handler(request(hashOf(21).toUpperCase().replace('0X', '0x')), context);
		const gone = (await handler(request(`0x${'ee'.repeat(32)}`), context)) as QueryResult;

		expect(at20).toEqual({
			data: {pool: [{pool: 'a', label: 'seeded'}]},
			extensions: {generation: GENERATION, block: 21, blockHash: hashOf(21)},
		});
		expect(at21).toMatchObject({data: {pool: [{pool: 'a', label: 'later'}]}});
		expect(gone.errors?.[0]?.extensions.code).toBe(QUERY_ERROR_CODES.blockNotRecorded);
	});

	it('a raw backend passed to `openForReading`, as the documented reader recipe does, reading the store its leader writes', async () => {
		const databaseName = `pinned-by-hash-reader-${Math.random().toString(36).slice(2, 10)}`;
		const leader = await openForWriting(new IndexedDBStateStore(TOKENS, {databaseName}));
		await leader.applyBlock(block(10), [pool('a', {label: 'alpha'})]);
		await leader.applyBlock(block(11), [pool('a', {label: 'beta'})]);
		const reader = openForReading(new IndexedDBStateStore(TOKENS, {databaseName}));
		const handler = graphqlQueryHandler();
		const context = async () => ({store: reader, generation: GENERATION});

		expect(await handler(request(hashOf(10)), context)).toEqual({
			data: {pool: [{pool: 'a', label: 'alpha'}]},
			extensions: {generation: GENERATION, block: 11, blockHash: hashOf(11)},
		});
		// the leader reorgs 11 away: the reader sees the revert sequence move, and the hash go
		await leader.revertTo(10);
		expect(await (reader as unknown as QueryReads).revertSequence()).toBe(1);
		expect(((await handler(request(hashOf(11)), context)) as QueryResult).errors?.[0]?.extensions.code).toBe(
			QUERY_ERROR_CODES.blockNotRecorded,
		);
	});
});
