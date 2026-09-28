import {describe, expect, it} from 'vitest';
import {
	createReadSurface,
	declareEntities,
	encodeSnapshot,
	MemoryStateStore,
	normalizeEntities,
	normalizeEntity,
	openSnapshotAware,
	readSnapshot,
	type EntityDeclaration,
	type EntityRow,
} from '../src/index.js';
import {block} from './utils/fixtures.js';

/**
 * A declared enum (ADR-0098): `{storage: 'text', enum: [...]}`, a value set over
 * text, each value a legal GraphQL enum name, checked at WRITE time.
 *
 * These are the seam's own cases; the every-backend half of the same property is
 * the `a declared enum is checked at write time` group of
 * `@etherfold/state-store-conformance`.
 */

const GAME = {
	name: 'game',
	id: 'id',
	fields: {status: {storage: 'text', enum: ['open', 'closed']}, winner: 'text'},
} as const satisfies EntityDeclaration;

function withStatus(field: unknown): EntityDeclaration {
	return {name: 'game', id: 'id', fields: {status: field}} as unknown as EntityDeclaration;
}

describe('a declared enum', () => {
	it('is accepted and kept on the normalized entity as declared, beside a bare field that is unchanged', () => {
		const entity = normalizeEntity(GAME);
		expect(entity.fields).toEqual({status: {storage: 'text', enum: ['open', 'closed']}, winner: 'text'});
	});

	it('leaves a declaration with no enum exactly as it was', () => {
		expect(normalizeEntity({name: 'token', id: 'id', fields: {owner: 'text'}})).toEqual({
			name: 'token',
			id: ['id'],
			fields: {owner: 'text'},
		});
	});

	it('refuses a value that is not a legal GraphQL enum name, at declaration time, naming it', () => {
		for (const value of ['in-progress', '1st', 'has space', '', 'caf\u00e9', 'true', 'false', 'null', '__open']) {
			expect(() => normalizeEntity(withStatus({storage: 'text', enum: ['open', value]}))).toThrow(
				new RegExp(`${JSON.stringify(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*not a legal GraphQL enum name`),
			);
		}
	});

	it('accepts the GraphQL name shapes that are legal: a leading underscore, digits after the first, any case', () => {
		expect(() => normalizeEntity(withStatus({storage: 'text', enum: ['_draft', 'v2', 'OPEN', 'open']}))).not.toThrow();
	});

	it('refuses an empty enum, a repeated value, a non-string value and a non-list', () => {
		expect(() => normalizeEntity(withStatus({storage: 'text', enum: []}))).toThrow(/at least one value/);
		expect(() => normalizeEntity(withStatus({storage: 'text', enum: ['open', 'open']}))).toThrow(/twice/);
		expect(() => normalizeEntity(withStatus({storage: 'text', enum: ['open', 1]}))).toThrow(/not a legal/);
		expect(() => normalizeEntity(withStatus({storage: 'text', enum: 'open'}))).toThrow(/at least one value/);
	});

	it('refuses an enum over anything but text, and an object that is not an enum', () => {
		expect(() => normalizeEntity(withStatus({storage: 'integer', enum: ['open']}))).toThrow(/storage is 'text'/);
		expect(() => normalizeEntity(withStatus({storage: 'text'}))).toThrow(/storage class/);
		expect(() => normalizeEntity(withStatus({storage: 'text', enum: ['open'], type: 'u256'}))).toThrow(/storage class/);
	});
});

describe('a declared enum is checked at write time', () => {
	async function stored() {
		const store = new MemoryStateStore([GAME]);
		await store.migrate();
		return store;
	}

	it('accepts each declared value, and NULL', async () => {
		const store = await stored();
		await store.applyBlock(block(100), [
			{type: 'upsert', entity: 'game', id: {id: '1'}, values: {status: 'open'}},
			{type: 'upsert', entity: 'game', id: {id: '2'}, values: {status: 'closed'}},
			{type: 'upsert', entity: 'game', id: {id: '3'}, values: {status: null}},
			{type: 'upsert', entity: 'game', id: {id: '4'}, values: {winner: '0xalice'}},
		]);
		expect(await store.getCurrent('game', {id: '1'})).toMatchObject({status: 'open'});
		expect(await store.getCurrent('game', {id: '2'})).toMatchObject({status: 'closed'});
		expect(await store.getCurrent('game', {id: '3'})).toMatchObject({status: null});
		expect(await store.getCurrent('game', {id: '4'})).toMatchObject({status: null});
	});

	it('refuses any other value, naming the field and the allowed values, and writes nothing of the block', async () => {
		const store = await stored();
		for (const value of ['pending', 'OPEN', 1, true]) {
			await expect(
				store.applyBlock(block(100), [
					{type: 'upsert', entity: 'game', id: {id: '1'}, values: {status: 'open'}},
					{type: 'upsert', entity: 'game', id: {id: '2'}, values: {status: value}},
				]),
			).rejects.toThrow(/game field status is declared as an enum of \(open, closed\)/);
		}
		expect(await store.getCurrent('game', {id: '1'})).toBeUndefined();
		expect(await store.getBlock(100)).toBeUndefined();
	});
});

describe('a declared enum in a snapshot document', () => {
	async function documentOf(declarations: EntityDeclaration[]): Promise<Uint8Array> {
		const stream = encodeSnapshot(
			{
				processor: 'proc-v1',
				savedAt: '2026-09-28T00:00:00.000Z',
				takenAt: {number: 10, hash: '0xa', timestamp: 1},
				floor: 10,
				cursor: {key: 'lastSync', value: 'at-10'},
			},
			declarations,
			[
				{
					block: {number: 10, hash: '0xa', timestamp: 1},
					mutations: [{type: 'upsert', entity: 'game', id: {id: '1'}, values: {status: 'closed', winner: '0xbob'}}],
				},
			],
		);
		return new Uint8Array(await new Response(stream).arrayBuffer());
	}

	it('round-trips through the document and installs into a store declaring the same enum', async () => {
		const bytes = await documentOf([GAME]);

		const reader = await readSnapshot(bytes);
		const blocks = [];
		for await (const one of reader.blocks({declarations: normalizeEntities([GAME])})) blocks.push(one);
		expect(blocks.flatMap((one) => one.mutations)).toEqual([
			{type: 'upsert', entity: 'game', id: {id: '1'}, values: {status: 'closed', winner: '0xbob'}},
		]);

		const store = await openSnapshotAware(new MemoryStateStore([GAME]));
		await store.migrate();
		await store.bootstrap(bytes, {processor: 'proc-v1'});
		expect(await store.getCurrent('game', {id: '1'})).toMatchObject({status: 'closed', winner: '0xbob'});
	});

	it('is part of the declaration a document is checked against: other values, or a bare text field, are refused', async () => {
		const bytes = await documentOf([GAME]);
		for (const status of [
			{storage: 'text', enum: ['open', 'closed', 'void']},
			{storage: 'text', enum: ['closed', 'open']},
			'text',
		]) {
			const store = await openSnapshotAware(
				new MemoryStateStore([{...GAME, fields: {...GAME.fields, status}} as EntityDeclaration]),
			);
			await store.migrate();
			await expect(store.bootstrap(bytes, {processor: 'proc-v1'})).rejects.toThrow(
				/declares `game` as \(id\) \{status: text enum\(open, closed\), winner: text\}/,
			);
		}
	});

	it('leaves the declare line of an entity without an enum byte-identical, and writes an enum as declared', async () => {
		const bytes = await documentOf([GAME, {name: 'token', id: 'id', fields: {owner: 'text'}}]);
		const text = await new Response(
			new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip')),
		).text();
		const lines = text.split('\n');
		expect(lines).toContain(JSON.stringify({declare: 'token', id: ['id'], fields: [['owner', 'text']]}));
		expect(lines).toContain(
			JSON.stringify({
				declare: 'game',
				id: ['id'],
				fields: [
					['status', {storage: 'text', enum: ['open', 'closed']}],
					['winner', 'text'],
				],
			}),
		);
	});
});

/**
 * The read surface types an enum field as the union of its values. `pnpm
 * typecheck` runs these (vitest strips types), hence the `@ts-expect-error`s.
 */
describe('a declared enum is typed off the declaration', () => {
	const entities = declareEntities([GAME]);

	it('types the field as the union of its declared values', async () => {
		const store = new MemoryStateStore(entities);
		await store.migrate();
		await store.applyBlock(block(100), [{type: 'upsert', entity: 'game', id: {id: '1'}, values: {status: 'open'}}]);
		const game = (await createReadSurface(store, entities).game.getCurrent({id: '1'}))!;

		const status: 'open' | 'closed' | null = game.status;
		const winner: string | null = game.winner;
		expect([status, winner]).toEqual(['open', null]);

		// @ts-expect-error `pending` is not one of the declared values
		const pending: typeof game.status = 'pending';
		expect(pending).toBe('pending');
	});

	it('is exactly the union, and a bare text field stays string', () => {
		type Row = EntityRow<typeof GAME>;
		const exact: [Row['status']] extends ['open' | 'closed' | null]
			? ['open' | 'closed' | null] extends [Row['status']]
				? true
				: false
			: false = true;
		const bare: [Row['winner']] extends [string | null]
			? [string | null] extends [Row['winner']]
				? true
				: false
			: false = true;
		expect([exact, bare]).toEqual([true, true]);
	});
});
