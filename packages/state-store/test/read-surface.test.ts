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

/**
 * A declared relation (ADR-0098) on the read surface: the parent's children,
 * under the name the child declared (`as`), on the PARENT's reads.
 *
 * It is the bounded id-prefix listing with the parent's key as the prefix
 * (ADR-0021), so every case below is asserted as an EQUALITY with that listing
 * rather than as a second description of what it should return.
 */
const related = declareEntities([
	{name: 'placement', id: ['window', 'ordinal'], fields: {epoch: 'integer'}},
	{
		name: 'placementPlayer',
		id: ['window', 'ordinal', 'position', 'moveOrdinal'],
		fields: {address: 'text'},
		parent: {entity: 'placement', as: 'players'},
	},
	{name: 'token', id: 'id', fields: {owner: 'text'}},
]);

/** Two placements in window 1, with players, and a third in window 2 sharing ordinal 0. */
async function relatedStore(): Promise<MemoryStateStore> {
	const store = new MemoryStateStore(related);
	await store.migrate();
	await store.applyBlock(block(100), [
		{type: 'upsert', entity: 'placement', id: {window: 1, ordinal: 0}, values: {epoch: 7}},
		{type: 'upsert', entity: 'placement', id: {window: 1, ordinal: 1}, values: {epoch: 7}},
		{type: 'upsert', entity: 'placement', id: {window: 2, ordinal: 0}, values: {epoch: 8}},
		{
			type: 'upsert',
			entity: 'placementPlayer',
			id: {window: 1, ordinal: 0, position: 3, moveOrdinal: 0},
			values: {address: '0xalice'},
		},
		{
			type: 'upsert',
			entity: 'placementPlayer',
			id: {window: 1, ordinal: 0, position: 4, moveOrdinal: 0},
			values: {address: '0xbob'},
		},
		{
			type: 'upsert',
			entity: 'placementPlayer',
			id: {window: 1, ordinal: 1, position: 3, moveOrdinal: 0},
			values: {address: '0xcarol'},
		},
		{
			type: 'upsert',
			entity: 'placementPlayer',
			id: {window: 2, ordinal: 0, position: 3, moveOrdinal: 0},
			values: {address: '0xzoe'},
		},
	]);
	await store.applyBlock(block(101), [
		{
			type: 'upsert',
			entity: 'placementPlayer',
			id: {window: 1, ordinal: 0, position: 5, moveOrdinal: 0},
			values: {address: '0xdan'},
		},
	]);
	return store;
}

describe("a parent's children, derived from the declared relation", () => {
	it("lists a parent's children at the tip, identical to the prefix listing, and nobody else's", async () => {
		const surface = createReadSurface(await relatedStore(), related);

		const children = await surface.placement.players.listCurrent({window: 1, ordinal: 0}, 10);
		expect(children).toEqual(await surface.placementPlayer.listCurrent({window: 1, ordinal: 0}, 10));
		expect(children.rows.map((row) => row.address)).toEqual(['0xalice', '0xbob', '0xdan']);
		// window 2's ordinal 0 is another parent: the WHOLE parent key is the prefix
		expect((await surface.placement.players.listCurrent({window: 2, ordinal: 0}, 10)).rows).toHaveLength(1);
	});

	it('is bounded by a REQUIRED limit and says whether it stopped short, as the listing does', async () => {
		const surface = createReadSurface(await relatedStore(), related);

		const bounded = await surface.placement.players.listCurrent({window: 1, ordinal: 0}, 2);
		expect(bounded).toEqual(await surface.placementPlayer.listCurrent({window: 1, ordinal: 0}, 2));
		expect(bounded.truncated).toBe(true);
		expect(bounded.rows).toHaveLength(2);
	});

	it("lists a parent's children as of an earlier block, identical to the prefix listing then", async () => {
		const surface = createReadSurface(await relatedStore(), related);

		const then = await surface.placement.players.listAsOf({window: 1, ordinal: 0}, 100, 10);
		expect(then).toEqual(await surface.placementPlayer.listAsOf({window: 1, ordinal: 0}, 100, 10));
		expect(then.rows).toHaveLength(2);
	});

	it('answers an empty listing for a parent with no children, which is not a refusal', async () => {
		const surface = createReadSurface(await relatedStore(), related);

		expect(await surface.placement.players.listCurrent({window: 9, ordinal: 9}, 10)).toEqual({
			rows: [],
			truncated: false,
		});
	});

	it('refuses a parent key missing a column, naming the parent rather than listing a wider prefix', async () => {
		const surface = createReadSurface(await relatedStore(), related);

		await expect(
			surface.placement.players.listCurrent({window: 1} as unknown as {window: number; ordinal: number}, 10),
		).rejects.toThrow(/placement[\s\S]*ordinal/);
	});

	it('ignores anything beyond the parent key, so a child column cannot narrow the collection', async () => {
		const surface = createReadSurface(await relatedStore(), related);
		const withExtra = {window: 1, ordinal: 0, position: 3} as {window: number; ordinal: number};

		expect((await surface.placement.players.listCurrent(withExtra, 10)).rows).toHaveLength(3);
	});

	it('leaves the four reads of every entity as they were, and adds nothing to an entity with no children', async () => {
		const surface = createReadSurface(await relatedStore(), related);

		expect(Object.keys(surface.placement).sort()).toEqual([
			'getAsOf',
			'getCurrent',
			'listAsOf',
			'listCurrent',
			'players',
		]);
		expect(Object.keys(surface.placementPlayer).sort()).toEqual(['getAsOf', 'getCurrent', 'listAsOf', 'listCurrent']);
		expect(Object.keys(surface.token).sort()).toEqual(['getAsOf', 'getCurrent', 'listAsOf', 'listCurrent']);
	});

	it('offers no collection when the parent is not part of the surface', async () => {
		// a surface may be generated from a SUBSET of the store's declarations; the
		// collection lives on the parent's reads, so without the parent it has nowhere to be
		const surface = createReadSurface(await relatedStore(), declareEntities([related[1]]));

		expect(Object.keys(surface)).toEqual(['placementPlayer']);
	});
});

/**
 * What would rot: the collection's NAME and its KEY are both read off the
 * declaration, so renaming the parent's id column or the child's `as` stops a
 * consumer compiling. `pnpm typecheck` runs these.
 */
describe("a parent's children are typed off the declaration", () => {
	it("types the children as the child entity's rows", async () => {
		const surface = createReadSurface(await relatedStore(), related);
		const [first] = (await surface.placement.players.listCurrent({window: 1, ordinal: 0}, 1)).rows;

		const address: string | null = first!.address;
		const position: string = first!.position;
		expect([address, position]).toEqual(['0xalice', '3']);
		// @ts-expect-error `epoch` is the PARENT's field, not a column of its children
		expect(first!.epoch).toBeUndefined();
	});

	it('refuses a collection the declaration does not name, so a renamed `as` breaks the consumer', async () => {
		const renamedAs = declareEntities([
			related[0],
			{...related[1], parent: {entity: 'placement', as: 'participants'}},
			related[2],
		]);
		const store = new MemoryStateStore(renamedAs);
		await store.migrate();
		const surface = createReadSurface(store, renamedAs);

		expect((await surface.placement.participants.listCurrent({window: 1, ordinal: 0}, 1)).rows).toEqual([]);
		// @ts-expect-error the collection is now `participants`: the old name is a compile error, not `undefined`
		expect(surface.placement.players).toBeUndefined();
		// @ts-expect-error a child has no collection of its own, and a collection is never on the child
		expect(surface.placementPlayer.players).toBeUndefined();
		// @ts-expect-error `token` is nobody's parent
		expect(surface.token.players).toBeUndefined();
	});

	it("takes the parent's WHOLE key, so a renamed parent key column breaks the consumer", async () => {
		const surface = createReadSurface(await relatedStore(), related);

		// @ts-expect-error the parent key is (window, ordinal): `slot` is not one of its columns
		await expect(surface.placement.players.listCurrent({window: 1, slot: 0}, 10)).rejects.toThrow(/ordinal/);
		// @ts-expect-error the parent's WHOLE key, not a leading run of it
		await expect(surface.placement.players.listCurrent({window: 1}, 10)).rejects.toThrow(/ordinal/);
	});

	it('keeps the bound: a REQUIRED limit, and nowhere to hang a predicate', async () => {
		const surface = createReadSurface(await relatedStore(), related);

		// @ts-expect-error the limit is required, here as at the seam
		await expect(surface.placement.players.listCurrent({window: 1, ordinal: 0})).rejects.toThrow(/limit/i);
		// @ts-expect-error there is nowhere to hang a predicate, a sort or an offset
		await surface.placement.players.listCurrent({window: 1, ordinal: 0}, 10, {orderBy: 'address'});
		// @ts-expect-error this store's as-of reads take a block number
		await expect(surface.placement.players.listAsOf({window: 1, ordinal: 0}, {hash: '0x64'}, 10)).rejects.toThrow();
	});
});
