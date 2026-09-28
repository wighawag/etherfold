import {declareEntities, u256} from '@etherfold/state-store';
import {describe, expect, it} from 'vitest';
import {VersionedStateStore, createQuerySurface, u256Arg} from '../src/index.js';
import {createTestDB} from './utils/db.js';
import {block} from './utils/fixtures.js';

/**
 * The raw-SQL tier and a `u256` (ADR-0098): a row comes back with the field as a
 * `bigint`, as every other read answers it, while a PREDICATE runs against what
 * the column holds, the 32-byte canonical encoding, so a compared value is bound
 * through `u256Arg`. The shared conformance chapter covers the seam's reads; these
 * are the reads only this backend has.
 */
const entities = declareEntities([{name: 'pool', id: 'id', fields: {amount: {storage: 'blob', type: 'u256'}}}]);

const MAX = 2n ** 256n - 1n;

// [100, 101) a = 9, b = 10          [101, ...) a = 9, b = 2^200, c = MAX
async function stocked(): Promise<VersionedStateStore> {
	const store = new VersionedStateStore(createTestDB(), entities);
	await store.migrate();
	await store.applyBlock(block(100), [
		{type: 'upsert', entity: 'pool', id: {id: 'a'}, values: {amount: 9n}},
		{type: 'upsert', entity: 'pool', id: {id: 'b'}, values: {amount: 10n}},
	]);
	await store.applyBlock(block(101), [
		{type: 'upsert', entity: 'pool', id: {id: 'b'}, values: {amount: 2n ** 200n}},
		{type: 'upsert', entity: 'pool', id: {id: 'c'}, values: {amount: MAX}},
	]);
	return store;
}

describe('the raw-SQL tier answers a u256 as a bigint and compares one through u256Arg', () => {
	it('answers a u256 column as a bigint from queryCurrent and queryAsOf', async () => {
		const store = await stocked();
		expect(await store.queryCurrent('pool', {orderBy: 'id'})).toMatchObject([
			{id: 'a', amount: 9n},
			{id: 'b', amount: 2n ** 200n},
			{id: 'c', amount: MAX},
		]);
		expect(await store.queryAsOf('pool', 100, {orderBy: 'id'})).toMatchObject([
			{id: 'a', amount: 9n},
			{id: 'b', amount: 10n},
		]);
	});

	it('answers one as a bigint from createQuerySurface, in both tiers', async () => {
		const surface = createQuerySurface(await stocked(), entities);
		expect(await surface.pool.queryCurrent({orderBy: 'id'})).toEqual([
			{id: 'a', amount: 9n},
			{id: 'b', amount: 2n ** 200n},
			{id: 'c', amount: MAX},
		]);
		expect(await surface.pool.queryAsOf(100, {orderBy: 'id'})).toEqual([
			{id: 'a', amount: 9n},
			{id: 'b', amount: 10n},
		]);
		expect(await surface.pool.getCurrent({id: 'c'})).toEqual({id: 'c', amount: MAX});
	});

	it('matches an equality bound through u256Arg, which is the canonical encoding', async () => {
		const store = await stocked();
		expect(u256Arg(9n)).toEqual(u256.encode(9n));
		expect(await store.queryCurrent('pool', {where: 'amount = ?', args: [u256Arg(9n)]})).toMatchObject([{id: 'a'}]);
		expect(await store.queryAsOf('pool', 100, {where: 'amount = ?', args: [u256Arg(10n)]})).toMatchObject([
			{id: 'b', amount: 10n},
		]);
	});

	it('compares and orders numerically through u256Arg, 9 before 10 included', async () => {
		const store = await stocked();
		const surface = createQuerySurface(store, entities);
		expect(
			(await surface.pool.queryAsOf(100, {where: 'amount > ?', args: [u256Arg(9n)]})).map((row) => row.id),
		).toEqual(['b']);
		expect((await store.queryCurrent('pool', {orderBy: 'amount DESC'})).map((row) => row.amount)).toEqual([
			MAX,
			2n ** 200n,
			9n,
		]);
		expect(
			(await surface.pool.queryCurrent({where: 'amount >= ?', args: [u256Arg(10n)], orderBy: 'amount'})).map(
				(row) => row.id,
			),
		).toEqual(['b', 'c']);
	});

	it('finds nothing when a decimal is bound instead, which is why the helper exists', async () => {
		const store = await stocked();
		expect(await store.queryCurrent('pool', {where: 'amount = ?', args: ['9']})).toEqual([]);
		expect(await store.queryCurrent('pool', {where: 'amount = ?', args: [9]})).toEqual([]);
	});

	it('refuses to encode what the column could not hold', () => {
		expect(() => u256Arg(-1n)).toThrow(/negative/);
		expect(() => u256Arg(2n ** 256n)).toThrow(/wider than 256 bits/);
	});

	it('produces a snapshot that carries the u256 and installs it back as a bigint', async () => {
		const store = await stocked();
		const rows = [];
		for await (const row of store.liveRowsAsOf(101)) rows.push(row);
		expect(rows).toEqual([
			{type: 'upsert', entity: 'pool', id: {id: 'a'}, values: {amount: 9n}},
			{type: 'upsert', entity: 'pool', id: {id: 'b'}, values: {amount: 2n ** 200n}},
			{type: 'upsert', entity: 'pool', id: {id: 'c'}, values: {amount: MAX}},
		]);
		const changes = [];
		for await (const change of store.changesAt(101)) changes.push(change);
		expect(changes).toEqual([
			{type: 'upsert', entity: 'pool', id: {id: 'b'}, values: {amount: 2n ** 200n}},
			{type: 'upsert', entity: 'pool', id: {id: 'c'}, values: {amount: MAX}},
		]);
	});
});
