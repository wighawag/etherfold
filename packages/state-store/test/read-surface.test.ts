import {describe, expect, it} from 'vitest';
import {
	BlockNotRetainedError,
	InvalidBlockNumberError,
	MemoryStateStore,
	UnknownEntityError,
	createReadSurface,
	declareEntities,
	type MemoryStateStoreOptions,
} from '../src/index.js';
import {block} from './utils/fixtures.js';

/**
 * The read half of the same declaration: a consumer names an entity and its
 * declared columns, never a table and never a column string.
 *
 * The declarations below are NOT annotated, and that is the whole mechanism: an
 * annotation (`const TOKEN: EntityDeclaration = ...`, as the other fixtures here
 * use) widens `'owner'` to `string` and the surface can derive nothing from it.
 * `declareEntities` pins the literals while keeping the value an ordinary
 * `EntityDeclaration[]` the store takes unchanged, so ONE object is both the
 * storage schema and the read schema.
 */
const entities = declareEntities([
	{name: 'token', id: 'id', fields: {owner: 'text', transferCount: 'integer'}},
	{name: 'placement', id: ['epoch', 'position', 'playerIndex'], fields: {player: 'text'}},
]);

/**
 * Three owners of token 1, and one epoch of children:
 *   [100, 101) Alice   [101, 102) Bob   [102, ...) Carol
 */
async function stocked(options: MemoryStateStoreOptions = {}): Promise<MemoryStateStore> {
	const store = new MemoryStateStore(entities, options);
	await store.migrate();
	await store.applyBlock(block(100), [
		{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xalice', transferCount: 1}},
		{type: 'upsert', entity: 'placement', id: {epoch: 7, position: 1, playerIndex: 0}, values: {player: '0xalice'}},
		{type: 'upsert', entity: 'placement', id: {epoch: 7, position: 2, playerIndex: 0}, values: {player: '0xbob'}},
		{type: 'upsert', entity: 'placement', id: {epoch: 8, position: 0, playerIndex: 0}, values: {player: '0xzoe'}},
	]);
	await store.applyBlock(block(101), [
		{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xbob', transferCount: 2}},
	]);
	await store.applyBlock(block(102), [
		{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xcarol', transferCount: 3}},
	]);
	return store;
}

describe('a read surface generated from the declarations', () => {
	it('reads one entity by id at the tip, naming no table and no column', async () => {
		const surface = createReadSurface(await stocked(), entities);

		expect(await surface.token.getCurrent({id: '1'})).toEqual({id: '1', owner: '0xcarol', transferCount: 3});
	});

	it('reads the same entity as of an earlier block', async () => {
		const surface = createReadSurface(await stocked(), entities);

		expect(await surface.token.getAsOf({id: '1'}, 100)).toMatchObject({owner: '0xalice'});
		// the block is known and the entity was absent from it: an ordinary answer
		expect(await surface.token.getAsOf({id: '2'}, 100)).toBeUndefined();
	});

	it('lists the children of a prefix, bounded, and says whether it stopped short', async () => {
		const surface = createReadSurface(await stocked(), entities);

		expect(await surface.placement.listCurrent({epoch: 7}, 10)).toEqual({
			rows: [
				{epoch: '7', position: '1', playerIndex: '0', player: '0xalice'},
				{epoch: '7', position: '2', playerIndex: '0', player: '0xbob'},
			],
			truncated: false,
		});
		expect(await surface.placement.listCurrent({epoch: 7}, 1)).toMatchObject({truncated: true});
	});

	it('lists a prefix as of an earlier block', async () => {
		const store = await stocked();
		await store.applyBlock(block(103), [
			{type: 'delete', entity: 'placement', id: {epoch: 7, position: 2, playerIndex: 0}},
		]);
		const surface = createReadSurface(store, entities);

		expect((await surface.placement.listAsOf({epoch: 7}, 100, 10)).rows).toHaveLength(2);
		expect((await surface.placement.listCurrent({epoch: 7}, 10)).rows).toHaveLength(1);
	});

	it('hands back the DECLARED columns and nothing else, so the row type is true', async () => {
		// the version columns are storage, not state: a row that carried `_lower`
		// and `_upper` would be a row the declaration does not describe, and one a
		// caller can spread back into a write.
		const surface = createReadSurface(await stocked(), entities);

		expect(Object.keys((await surface.token.getCurrent({id: '1'}))!).sort()).toEqual(['id', 'owner', 'transferCount']);
	});

	it('reads an unlisted declared field as null, exactly as the store wrote it', async () => {
		const store = await stocked();
		await store.applyBlock(block(103), [
			// `set` writes a WHOLE row: transferCount is not mentioned, so it is NULL
			{type: 'upsert', entity: 'token', id: {id: '2'}, values: {owner: '0xdan'}},
		]);
		const surface = createReadSurface(store, entities);

		expect(await surface.token.getCurrent({id: '2'})).toEqual({id: '2', owner: '0xdan', transferCount: null});
	});
});

describe('errors stay errors: the surface propagates a refusal rather than swallowing it', () => {
	it('propagates the retention refusal instead of answering `undefined`', async () => {
		// `revert-only` keeps superseded versions for reorg revert and answers no
		// historical read at all. A generated surface that turned that into
		// `undefined` would read as "the entity was absent then", which is an
		// ordinary answer a caller acts on.
		const surface = createReadSurface(await stocked({retention: 'revert-only'}), entities);

		await expect(surface.token.getAsOf({id: '1'}, 100)).rejects.toThrow(BlockNotRetainedError);
		await expect(surface.placement.listAsOf({epoch: 7}, 100, 10)).rejects.toThrow(BlockNotRetainedError);
	});

	it('propagates a read outside a declared window', async () => {
		const surface = createReadSurface(await stocked({retention: {blocks: 4}, finalityDepth: 2}), entities);

		expect(await surface.token.getAsOf({id: '1'}, 100)).toMatchObject({owner: '0xalice'});
		await expect(surface.token.getAsOf({id: '1'}, 90)).rejects.toThrow(BlockNotRetainedError);
	});

	it('refuses a surface built from a declaration the store was not built with', async () => {
		// The one failure a generated surface could still have: two descriptions of
		// the data that disagree. Caught where it is created, naming both.
		const store = await stocked();
		const renamed = declareEntities([{name: 'token', id: 'id', fields: {holder: 'text'}}]);

		expect(() => createReadSurface(store, renamed)).toThrow(/token/);
		expect(() => createReadSurface(store, declareEntities([{name: 'ghost', id: 'id', fields: {}}]))).toThrow(/ghost/);
	});

	it('refuses an entity the store does not declare with a NAMED error, here and at the store', async () => {
		// Named rather than a bare `Error` because this is the refusal a caller
		// furthest from the store meets -- a surface generated from one set of
		// declarations asked of a store built with another -- and because a class does
		// not survive a `postMessage` while a `name` does, which is what a tab reading
		// across a port acts on (`@etherfold/browser`).
		const store = await stocked();
		const ghost = declareEntities([{name: 'ghost', id: 'id', fields: {}}]);

		expect(() => createReadSurface(store, ghost)).toThrow(UnknownEntityError);
		// the same refusal, with the same name, from the untyped read every backend
		// answers through
		await expect(store.getCurrent('ghost', {id: '1'})).rejects.toThrow(UnknownEntityError);
		await expect(store.getCurrent('ghost', {id: '1'})).rejects.toMatchObject({
			name: 'UnknownEntityError',
			entity: 'ghost',
		});
	});
});

/**
 * The reason this task exists: the types come off the declaration, so renaming a
 * field or a key column stops the CONSUMER compiling instead of handing it
 * `undefined` at run time.
 *
 * `pnpm typecheck` is what runs these assertions (vitest strips types without
 * checking them), which is why each one is a `@ts-expect-error`: the test fails
 * to compile if the error it expects stops happening.
 */
describe('the types are derived from the declaration', () => {
	it('types a row off the declared fields, and refuses a field that is not declared', async () => {
		const surface = createReadSurface(await stocked(), entities);
		const token = (await surface.token.getCurrent({id: '1'}))!;

		const owner: string | null = token.owner;
		const transferCount: number | null = token.transferCount;
		// the id column comes back as it is stored: a string, on every backend
		const id: string = token.id;
		expect([id, owner, transferCount]).toEqual(['1', '0xcarol', 3]);

		// @ts-expect-error `ownr` is not a declared field of `token`: rename `owner` and this line is where it breaks
		expect(token.ownr).toBeUndefined();
	});

	it('refuses an id that is not the declared key', async () => {
		const surface = createReadSurface(await stocked(), entities);

		// @ts-expect-error the declared id column is `id`, not `tokenId`
		await expect(surface.token.getCurrent({tokenId: '1'})).rejects.toThrow(/id/);
	});

	it('refuses an entity that was never declared', async () => {
		const surface = createReadSurface(await stocked(), entities);

		// @ts-expect-error `account` is not one of the declared entities
		expect(surface.account).toBeUndefined();
	});

	it('keeps the bound of the handler-facing seam: a prefix and a REQUIRED limit, and nothing else', async () => {
		const surface = createReadSurface(await stocked(), entities);

		// @ts-expect-error the limit is required, here as at the seam: a default bound is a bound nobody chose
		await expect(surface.placement.listCurrent({epoch: 7})).rejects.toThrow(/limit/i);
		// @ts-expect-error a prefix is a LEADING run of the declared id columns
		await expect(surface.placement.listCurrent({position: 1}, 10)).rejects.toThrow(/placement/);
		// @ts-expect-error there is nowhere to hang a predicate, a sort or an offset
		await surface.placement.listCurrent({epoch: 7}, 10, {orderBy: 'player'});
	});

	it('refuses a block address the store cannot resolve', async () => {
		const surface = createReadSurface(await stocked(), entities);

		// A `MemoryStateStore` reads as of a block NUMBER. Addressing by hash or by
		// time is the read layer a BACKEND adds above the seam, so a surface over a
		// store that has none refuses a hash at COMPILE time -- and, because a cast
		// or a JavaScript caller walks straight past that, at RUN time too: a hash
		// compared against block numbers matches no version, and answering
		// `undefined` would report the token as absent at a block nobody named.
		// @ts-expect-error this store's as-of reads take a block number
		await expect(surface.token.getAsOf({id: '1'}, {hash: '0x64'})).rejects.toBeInstanceOf(InvalidBlockNumberError);
	});
});
