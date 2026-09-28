import {declareEntities, type ChildrenReads} from '@etherfold/state-store';
import {describe, expect, expectTypeOf, it} from 'vitest';
import {BlockNotRetainedError, NoSuchBlockError, VersionedStateStore, createQuerySurface} from '../src/index.js';
import {createTestDB} from './utils/db.js';
import {block} from './utils/fixtures.js';

/**
 * The SERVER-side tier of the generated read surface: the same declarations, the
 * same typed rows, plus the predicates a backend with a query planner can
 * afford.
 *
 * The declarations are the ones the store is BUILT with, unannotated so their
 * literals survive: one description of the data, for the DDL and for the reads.
 */
const entities = declareEntities([
	{name: 'token', id: 'id', fields: {owner: 'text', transferCount: 'integer'}},
	{name: 'placement', id: ['epoch', 'position', 'playerIndex'], fields: {player: 'text'}},
]);

type StoreOptions = ConstructorParameters<typeof VersionedStateStore>[2];

// One token, three owners, one block each:
//   [100, 101) Alice   [101, 102) Bob   [102, ...) Carol
async function stocked(options: StoreOptions = {}): Promise<VersionedStateStore> {
	const store = new VersionedStateStore(createTestDB(), entities, options);
	await store.migrate();
	await store.applyBlock(block(100), [
		{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xalice', transferCount: 1}},
		{type: 'upsert', entity: 'placement', id: {epoch: 7, position: 1, playerIndex: 0}, values: {player: '0xalice'}},
	]);
	await store.applyBlock(block(101), [
		{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xbob', transferCount: 2}},
		{type: 'upsert', entity: 'token', id: {id: '2'}, values: {owner: '0xzoe', transferCount: 1}},
	]);
	await store.applyBlock(block(102), [
		{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xcarol', transferCount: 3}},
	]);
	return store;
}

describe('the server-side tier keeps the predicates, and types the rows off the declaration', () => {
	it('queries a whole entity at the tip with a caller-supplied predicate', async () => {
		const surface = createQuerySurface(await stocked(), entities);

		const busy = await surface.token.queryCurrent({where: 'transferCount > ?', args: [1], orderBy: 'id'});

		expect(busy).toEqual([{id: '1', owner: '0xcarol', transferCount: 3}]);
	});

	it('queries as of a block, on any of the three address axes', async () => {
		const surface = createQuerySurface(await stocked(), entities);
		const {number, hash, timestamp} = block(101);

		const byHeight = await surface.token.queryAsOf(number, {orderBy: 'id'});
		expect(byHeight.map((token) => token.owner)).toEqual(['0xbob', '0xzoe']);
		expect(await surface.token.queryAsOf({hash}, {orderBy: 'id'})).toEqual(byHeight);
		expect(await surface.token.queryAsOf({timestamp}, {orderBy: 'id'})).toEqual(byHeight);
	});

	it('hands back the declared columns only, version columns included in neither tier', async () => {
		const surface = createQuerySurface(await stocked(), entities);

		expect(Object.keys((await surface.token.queryCurrent())[0]).sort()).toEqual(['id', 'owner', 'transferCount']);
		expect(Object.keys((await surface.token.getCurrent({id: '1'}))!).sort()).toEqual(['id', 'owner', 'transferCount']);
	});

	it('carries the bounded tier unchanged, over the SAME store', async () => {
		// The two tiers are one surface per entity: the four seam reads every
		// backend answers, plus the two only a backend with a planner can.
		const surface = createQuerySurface(await stocked(), entities);

		expect(await surface.token.getCurrent({id: '1'})).toMatchObject({owner: '0xcarol'});
		expect(await surface.token.getAsOf({id: '1'}, {hash: block(100).hash})).toMatchObject({owner: '0xalice'});
		expect((await surface.placement.listCurrent({epoch: 7}, 10)).rows).toEqual([
			{epoch: '7', position: '1', playerIndex: '0', player: '0xalice'},
		]);
	});

	it('reads as of a HASH through the bounded tier, because this store resolves one', async () => {
		// The as-of parameter of the generated surface is the one its STORE takes.
		// Here that is a hash, a height or a timestamp; over a store with no
		// addressing layer the same call would not compile.
		const surface = createQuerySurface(await stocked(), entities);

		expect((await surface.placement.listAsOf({epoch: 7}, {timestamp: block(100).timestamp}, 10)).rows).toHaveLength(1);
	});
});

describe('errors stay errors on both tiers', () => {
	it('throws for an address that resolves to no block, rather than answering empty', async () => {
		// ADR-0015: a hash that no longer resolves is how a consumer learns its
		// pinned block was reorged out. An empty result would be that news wearing
		// "nothing matched" as a disguise.
		const surface = createQuerySurface(await stocked(), entities);

		await expect(surface.token.getAsOf({id: '1'}, {hash: '0xdead'})).rejects.toThrow(NoSuchBlockError);
		await expect(surface.token.queryAsOf({hash: '0xdead'})).rejects.toThrow(NoSuchBlockError);
		await expect(surface.placement.listAsOf({epoch: 7}, {hash: '0xdead'}, 10)).rejects.toThrow(NoSuchBlockError);
	});

	it('throws for a block outside the declared retention, on the query tier too', async () => {
		const surface = createQuerySurface(await stocked({retention: {blocks: 4}, finalityDepth: 2}), entities);

		expect(await surface.token.getAsOf({id: '1'}, 100)).toMatchObject({owner: '0xalice'});
		await expect(surface.token.getAsOf({id: '1'}, 90)).rejects.toThrow(BlockNotRetainedError);
		await expect(surface.token.queryAsOf(90)).rejects.toThrow(BlockNotRetainedError);
	});
});

/** `pnpm typecheck` is what runs these: each one fails to compile if the type stops being derived. */
describe('the types come off the declaration on this tier as well', () => {
	it('types a queried row, and refuses a column that is not declared', async () => {
		const surface = createQuerySurface(await stocked(), entities);
		const [token] = await surface.token.queryCurrent({where: 'id = ?', args: ['1']});

		const owner: string | null = token.owner;
		expect(owner).toBe('0xcarol');

		// @ts-expect-error `holder` is not a declared field: rename `owner` and this is where it breaks
		expect(token.holder).toBeUndefined();
	});

	it('keeps the bounded tier bounded: the predicates are on `query*`, never on `list*`', async () => {
		const surface = createQuerySurface(await stocked(), entities);

		// @ts-expect-error a listing takes a prefix and a limit, on every backend, planner or no planner
		await surface.placement.listCurrent({epoch: 7}, 10, {where: "player = '0xalice'"});
	});
});

/**
 * A parent and its children through a declared relation (ADR-0098), on the tier
 * that spreads the bounded one: the collection is the bounded tier's, so it is
 * typed here as it is there, with no cast.
 */
const related = declareEntities([
	{name: 'arrival', id: ['window', 'ordinal'], fields: {epoch: 'integer'}},
	{
		name: 'move',
		id: ['window', 'ordinal', 'moveOrdinal'],
		fields: {address: 'text'},
		parent: {entity: 'arrival', as: 'moves'},
	},
]);

async function relatedStore(): Promise<VersionedStateStore> {
	const store = new VersionedStateStore(createTestDB(), related);
	await store.migrate();
	await store.applyBlock(block(100), [
		{type: 'upsert', entity: 'arrival', id: {window: 1, ordinal: 0}, values: {epoch: 7}},
		{type: 'upsert', entity: 'move', id: {window: 1, ordinal: 0, moveOrdinal: 2}, values: {address: '0xbob'}},
		{type: 'upsert', entity: 'move', id: {window: 1, ordinal: 0, moveOrdinal: 1}, values: {address: '0xalice'}},
		{type: 'upsert', entity: 'move', id: {window: 1, ordinal: 1, moveOrdinal: 1}, values: {address: '0xcarol'}},
	]);
	return store;
}

describe("a parent's children are on this tier too, typed off the declaration", () => {
	it('offers the collection with no cast, typed as the bounded tier types it', async () => {
		const store = await relatedStore();
		const surface = createQuerySurface(store, related);

		expectTypeOf(surface.arrival.moves).toEqualTypeOf<
			ChildrenReads<VersionedStateStore, (typeof related)[0], (typeof related)[1]>
		>();
		const {rows} = await surface.arrival.moves.listCurrent({window: 1, ordinal: 0}, 10);
		const address: string | null = rows[0]!.address;
		expect(address).toBe('0xalice');
		expect(rows.map((row) => row.moveOrdinal)).toEqual(['1', '2']);
		// and the query tier is still beside it, on the same parent
		expect(await surface.arrival.queryCurrent()).toEqual([{window: '1', ordinal: '0', epoch: 7}]);
	});

	it('refuses a name that is not a declared relation', async () => {
		const surface = createQuerySurface(await relatedStore(), related);

		// @ts-expect-error `players` is not the `as` any child declares on `arrival`
		expect(surface.arrival.players).toBeUndefined();
		// @ts-expect-error a collection lives on its parent, never on the child
		expect(surface.move.moves).toBeUndefined();
	});
});
