import type {Accessor, ChildrenQuery} from '@etherfold/accessor';
import {printSchema} from 'graphql';
import {describe, expect, it} from 'vitest';
import {buildQuerySchema, localExecutor, QUERY_ERROR_CODES} from '../src/index.js';
import {block, DECLARATIONS, deposit, GENERATION, pool, sqliteSubject} from './fixtures.js';
import {hashOf} from '../src/conformance/fixtures.js';

const TWO_64 = 2n ** 64n;

/** Three pools and some deposits, over two blocks, so there is history to read as of. */
async function seeded() {
	const subject = await sqliteSubject();
	await subject.store.applyBlock(block(10), [
		pool('a', {label: 'alpha', kind: 'open', weight: 3, ratio: 0.5, amount: 9n, tag: new Uint8Array([0xab, 0x01])}),
		pool('b', {label: 'beta', kind: 'closed', weight: 1, ratio: 1.5, amount: TWO_64 + 1n, tag: null}),
		pool('c', {label: 'gamma', kind: 'open', weight: 2, ratio: null, amount: 10n, tag: null}),
		deposit('a', '1', {who: 'ann', amount: 5n}),
		deposit('a', '2', {who: 'bob', amount: TWO_64}),
		deposit('b', '1', {who: 'cat', amount: 1n}),
	]);
	await subject.store.applyBlock(block(11), [
		pool('a', {label: 'alpha', kind: 'closed', weight: 3, ratio: 0.5, amount: 9n, tag: new Uint8Array([0xab, 0x01])}),
		deposit('a', '3', {who: 'dan', amount: 7n}),
	]);
	return subject;
}

describe('the schema built from the declarations', () => {
	it('has an object type per entity, a nested collection per relation, enums, and U256', () => {
		const sdl = printSchema(buildQuerySchema(DECLARATIONS));
		expect(sdl).toContain('type Pool {');
		expect(sdl).toContain('type Deposit {');
		expect(sdl).toContain('scalar U256');
		expect(sdl).toMatch(/enum PoolKind \{\s+open\s+closed\s+\}/);
		expect(sdl).toMatch(/kind: PoolKind\n/);
		expect(sdl).toMatch(/amount: U256\n/);
		expect(sdl).toMatch(/deposits\(where: DepositWhere, orderBy: DepositOrderBy, first: Int!\): \[Deposit!\]!/);
		expect(sdl).toMatch(/pool\(where: PoolWhere, orderBy: PoolOrderBy, first: Int!, block: BlockAddress\): \[Pool!\]!/);
		// a root field is pinned by a height OR a hash, exactly one of them
		expect(sdl).toMatch(/input BlockAddress @oneOf \{\s+number: SafeInt\s+hash: Bytes32\s+\}/);
		expect(sdl).toContain('scalar Bytes32');
	});

	it('refuses a declaration set whose generated names collide, naming both', () => {
		expect(() =>
			buildQuerySchema([
				{name: 'pool', id: 'pool', fields: {}},
				{name: 'poolWhere', id: 'id', fields: {}},
			]),
		).toThrow(/PoolWhere/);
	});
});

describe('a query answered in process through the accessor', () => {
	it('answers a nested query, with where, orderBy and first, and reports the generation and the block', async () => {
		const {context} = await seeded();
		const executor = localExecutor(buildQuerySchema(DECLARATIONS), context());
		const result = await executor({
			query: `query ($min: U256) {
				pool(where: {amount: {gte: $min}}, orderBy: {field: amount, direction: desc}, first: 10) {
					pool label kind amount weight ratio tag
					deposits(orderBy: {field: amount}, first: 2) { seq who amount }
				}
			}`,
			variables: {min: '9'},
		});
		expect(result).toEqual({
			data: {
				pool: [
					{
						pool: 'b',
						label: 'beta',
						kind: 'closed',
						amount: '18446744073709551617',
						weight: 1,
						ratio: 1.5,
						tag: null,
						deposits: [{seq: '1', who: 'cat', amount: '1'}],
					},
					{
						pool: 'c',
						label: 'gamma',
						kind: 'open',
						amount: '10',
						weight: 2,
						ratio: null,
						tag: null,
						deposits: [],
					},
					{
						pool: 'a',
						label: 'alpha',
						kind: 'closed',
						amount: '9',
						weight: 3,
						ratio: 0.5,
						tag: '0xab01',
						deposits: [
							{seq: '1', who: 'ann', amount: '5'},
							{seq: '3', who: 'dan', amount: '7'},
						],
					},
				],
			},
			extensions: {generation: GENERATION, block: 11, blockHash: hashOf(11)},
		});
		// what crosses a transport is JSON, and it is already that: no bigint, no bytes
		expect(JSON.parse(JSON.stringify(result))).toEqual(result);
	});

	it('filters on an enum, an id and with _and / _or, and answers an empty where as every row', async () => {
		const {context} = await seeded();
		const executor = localExecutor(buildQuerySchema(DECLARATIONS), context());
		const result = await executor({
			query: `{
				open: pool(where: {kind: {eq: open}}, first: 10) { pool }
				either: pool(where: {_or: [{pool: {eq: "a"}}, {label: {in: ["gamma"]}}]}, first: 10) { pool }
				none: pool(where: {_and: [{kind: {eq: open}}, {weight: {gt: 2}}]}, first: 10) { pool }
				every: pool(where: {}, first: 10) { pool }
				unset: pool(where: {ratio: {isNull: true}}, first: 10) { pool }
			}`,
		});
		expect(result.errors).toBeUndefined();
		expect(result.data).toEqual({
			open: [{pool: 'c'}],
			either: [{pool: 'a'}, {pool: 'c'}],
			none: [],
			every: [{pool: 'a'}, {pool: 'b'}, {pool: 'c'}],
			unset: [{pool: 'c'}],
		});
	});

	it('answers as of an earlier block when asked, children included', async () => {
		const {context} = await seeded();
		const executor = localExecutor(buildQuerySchema(DECLARATIONS), context());
		const result = await executor({
			query: `{ pool(where: {pool: {eq: "a"}}, first: 1, block: {number: 10}) { kind deposits(first: 10) { seq } } }`,
		});
		expect(result).toEqual({
			data: {pool: [{kind: 'open', deposits: [{seq: '1'}, {seq: '2'}]}]},
			extensions: {generation: GENERATION, block: 11, blockHash: hashOf(11)},
		});
	});

	it("reads a page of parents' children in ONE accessor call, not one per parent", async () => {
		const {store, context} = await seeded();
		const inner = store.accessor();
		const calls: ChildrenQuery[] = [];
		const counting: Accessor = {
			find: (query) => inner.find(query),
			children: (query) => {
				calls.push(query);
				return inner.children(query);
			},
		};
		const executor = localExecutor(buildQuerySchema(DECLARATIONS), context(counting));
		const result = await executor({query: `{ pool(first: 10) { deposits(first: 10) { who } } }`});
		expect(result.errors).toBeUndefined();
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({entity: 'pool', relation: 'deposits', at: 11, limit: 10});
		expect(calls[0]!.parents).toEqual([{pool: 'a'}, {pool: 'b'}, {pool: 'c'}]);
	});

	it('refuses a block above the one the operation pinned, and a first below 1, with a code', async () => {
		const {context} = await seeded();
		const executor = localExecutor(buildQuerySchema(DECLARATIONS), context());
		const ahead = await executor({query: `{ pool(first: 1, block: {number: 12}) { pool } }`});
		expect(ahead.errors?.[0]?.extensions.code).toBe(QUERY_ERROR_CODES.blockNotYetIndexed);
		const none = await executor({query: `{ pool(first: 0) { pool } }`});
		expect(none.errors?.[0]?.extensions.code).toBe(QUERY_ERROR_CODES.invalidQuery);
	});

	it('refuses a document it cannot run, and a variable that is not a u256, with a code and the generation', async () => {
		const {context} = await seeded();
		const executor = localExecutor(buildQuerySchema(DECLARATIONS), context());
		const unparsable = await executor({query: `{ pool(`});
		expect(unparsable.errors?.[0]?.extensions.code).toBe(QUERY_ERROR_CODES.invalidQuery);
		expect(unparsable.extensions).toEqual({generation: GENERATION, block: null, blockHash: null});
		const invalid = await executor({query: `{ nope }`});
		expect(invalid.errors?.[0]?.extensions.code).toBe(QUERY_ERROR_CODES.invalidQuery);
		const negative = await executor({
			query: `query ($min: U256) { pool(where: {amount: {gte: $min}}, first: 1) { pool } }`,
			variables: {min: '-1'},
		});
		expect(negative.errors?.[0]?.extensions.code).toBe(QUERY_ERROR_CODES.invalidQuery);
		expect('data' in negative).toBe(false);
	});

	it('refuses a block outside what the store retains with the seam code, never answering from the tip', async () => {
		const {store, context} = await sqliteSubject({retention: 'revert-only'});
		await store.applyBlock(block(10), [pool('a', {label: 'alpha'})]);
		const executor = localExecutor(buildQuerySchema(DECLARATIONS), context());
		const result = await executor({query: `{ pool(first: 1, block: {number: 9}) { pool } }`});
		expect(result.errors?.[0]?.extensions.code).toBe(QUERY_ERROR_CODES.blockNotRetained);
		expect(result.errors?.[0]?.path).toEqual(['pool']);
		expect(result.data).toBeNull();
	});

	it('masks an unexpected error rather than leaking it, with a code', async () => {
		const {context} = await seeded();
		const broken: Accessor = {
			find: () => Promise.reject(new Error('secret connection string')),
			children: () => Promise.reject(new Error('unreachable')),
		};
		const executor = localExecutor(buildQuerySchema(DECLARATIONS), context(broken));
		const result = await executor({query: `{ pool(first: 1) { pool } }`});
		expect(result.errors?.[0]?.extensions.code).toBe(QUERY_ERROR_CODES.internalError);
		expect(JSON.stringify(result)).not.toContain('secret');
	});
});
