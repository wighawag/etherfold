import {describe, expect, it} from 'vitest';
import {
	encodeSnapshot,
	MemoryStateStore,
	normalizeEntities,
	openSnapshotAware,
	readSnapshot,
	type EntityDeclaration,
} from '../src/index.js';

/**
 * A declared relation (ADR-0098): `parent: {entity, as}` on the CHILD, whose
 * leading id columns ARE the parent's whole id, by name and in order.
 *
 * These are the seam's own cases, asked of `normalizeEntities` directly; the
 * every-backend half of the same property is the `a declared relation is checked
 * against the ids` group of `@etherfold/state-store-conformance`.
 */

const PLACEMENT = {name: 'placement', id: ['window', 'ordinal'], fields: {epoch: 'integer'}} as const;

function child(overrides: Partial<EntityDeclaration> = {}): EntityDeclaration {
	return {
		name: 'placementPlayer',
		id: ['window', 'ordinal', 'position', 'moveOrdinal'],
		fields: {color: 'integer', address: 'text'},
		parent: {entity: 'placement', as: 'players'},
		...overrides,
	};
}

const declaring = (declarations: EntityDeclaration[]) => () => normalizeEntities(declarations);

describe('a declared relation', () => {
	it('is accepted when the child id begins with the whole parent id, and is kept on the normalized entity', () => {
		const entities = normalizeEntities([PLACEMENT, child()]);
		expect(entities.get('placementPlayer')?.parent).toEqual({entity: 'placement', as: 'players'});
		expect(entities.get('placement')?.parent).toBeUndefined();
	});

	it('does not depend on the parent being declared first', () => {
		expect(declaring([child(), PLACEMENT])).not.toThrow();
	});

	it('leaves a declaration without `parent` exactly as it was', () => {
		const entity = normalizeEntities([PLACEMENT]).get('placement');
		expect(entity).toEqual({name: 'placement', id: ['window', 'ordinal'], fields: {epoch: 'integer'}});
		expect(Object.keys(entity ?? {})).not.toContain('parent');
	});

	it('refuses a child carrying only PART of its parent id, naming both declarations', () => {
		expect(declaring([PLACEMENT, child({id: ['ordinal', 'position', 'moveOrdinal']})])).toThrow(
			/placementPlayer[\s\S]*\(ordinal, position, moveOrdinal\)[\s\S]*placement[\s\S]*\(window, ordinal\)/,
		);
	});

	it('refuses the parent id columns in the wrong order', () => {
		expect(declaring([PLACEMENT, child({id: ['ordinal', 'window', 'position']})])).toThrow(/whole id/);
	});

	it('refuses the parent id columns under other names', () => {
		expect(declaring([PLACEMENT, child({id: ['windowId', 'ordinal', 'position']})])).toThrow(/whole id/);
	});

	it('refuses a child that adds no id column of its own, and so a child that is its own parent', () => {
		expect(declaring([PLACEMENT, child({id: ['window', 'ordinal']})])).toThrow(/at least one id column of its own/);
		expect(declaring([{...PLACEMENT, parent: {entity: 'placement', as: 'placements'}}] as EntityDeclaration[])).toThrow(
			/at least one id column of its own/,
		);
	});

	it('refuses a parent that is not declared, naming both', () => {
		expect(declaring([child()])).toThrow(/placementPlayer[\s\S]*placement[\s\S]*not declared/);
	});

	it('refuses an `as` that collides with a field or an id column of the parent', () => {
		expect(declaring([PLACEMENT, child({parent: {entity: 'placement', as: 'epoch'}})])).toThrow(
			/"epoch"[\s\S]*collides[\s\S]*placement/,
		);
		expect(declaring([PLACEMENT, child({parent: {entity: 'placement', as: 'ordinal'}})])).toThrow(/collides/);
		// the columns of one row are compared as the identifier rules compare them
		expect(declaring([PLACEMENT, child({parent: {entity: 'placement', as: 'Epoch'}})])).toThrow(/collides/);
	});

	it('refuses two relations naming the same collection on one parent, naming both children', () => {
		expect(
			declaring([
				PLACEMENT,
				child(),
				{
					name: 'placementNote',
					id: ['window', 'ordinal', 'note'],
					fields: {},
					parent: {entity: 'placement', as: 'players'},
				},
			]),
		).toThrow(/placementPlayer[\s\S]*placementNote|placementNote[\s\S]*placementPlayer/);
	});

	it('allows the same `as` on two DIFFERENT parents', () => {
		expect(
			declaring([
				PLACEMENT,
				child(),
				{name: 'team', id: ['team'], fields: {}},
				{name: 'member', id: ['team', 'member'], fields: {}, parent: {entity: 'team', as: 'players'}},
			]),
		).not.toThrow();
	});

	it('refuses an `as` the generated read surface already uses', () => {
		for (const read of ['getCurrent', 'getAsOf', 'listCurrent', 'listAsOf']) {
			expect(declaring([PLACEMENT, child({parent: {entity: 'placement', as: read}})])).toThrow(/read surface/);
		}
	});

	it('refuses an `as` the server-side query tier uses, since it spreads the collections and would overwrite one', () => {
		// `createQuerySurface` (`@etherfold/state-store-sqlite`) puts these two beside
		// the four on the same parent, so the refusal is here, on every backend alike
		for (const read of ['queryCurrent', 'queryAsOf']) {
			expect(declaring([PLACEMENT, child({parent: {entity: 'placement', as: read}})])).toThrow(/read surface/);
		}
	});

	it('refuses an `as` or a parent name that is not an identifier', () => {
		expect(declaring([PLACEMENT, child({parent: {entity: 'placement', as: 'the players'}})])).toThrow(/identifier/);
		expect(declaring([PLACEMENT, child({parent: {entity: 'placement', as: '_players'}})])).toThrow(/reserved/);
		expect(declaring([PLACEMENT, child({parent: {entity: 'place ment', as: 'players'}})])).toThrow(/identifier/);
		expect(declaring([PLACEMENT, child({parent: 'placement' as unknown as EntityDeclaration['parent']})])).toThrow(
			/parent/,
		);
	});
});

describe('a declared relation in a snapshot document', () => {
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
					mutations: [
						{type: 'upsert', entity: 'placement', id: {window: 'global', ordinal: '1'}, values: {epoch: 3}},
						{
							type: 'upsert',
							entity: 'placementPlayer',
							id: {window: 'global', ordinal: '1', position: '5', moveOrdinal: '1'},
							values: {color: 2, address: '0xalice'},
						},
					],
				},
			],
		);
		return new Uint8Array(await new Response(stream).arrayBuffer());
	}

	it('round-trips through the document and installs into a store declaring the same relation', async () => {
		const declarations = [PLACEMENT, child()];
		const bytes = await documentOf(declarations);

		const reader = await readSnapshot(bytes);
		const blocks = [];
		for await (const one of reader.blocks({declarations: normalizeEntities(declarations)})) blocks.push(one);
		expect(blocks).toHaveLength(1);

		const store = await openSnapshotAware(new MemoryStateStore(declarations));
		await store.migrate();
		await store.bootstrap(bytes, {processor: 'proc-v1'});
		const children = await store.listCurrent('placementPlayer', {window: 'global', ordinal: '1'}, 10);
		expect(children.rows).toMatchObject([{position: '5', address: '0xalice'}]);
	});

	it('is part of the declaration a document is checked against', async () => {
		const bytes = await documentOf([PLACEMENT, child()]);
		const store = await openSnapshotAware(new MemoryStateStore([PLACEMENT, child({parent: undefined})]));
		await store.migrate();
		await expect(store.bootstrap(bytes, {processor: 'proc-v1'})).rejects.toThrow(/placementPlayer/);
	});

	it('leaves the declare line of an entity without `parent` byte-identical', async () => {
		const bytes = await documentOf([PLACEMENT, child()]);
		const text = await new Response(
			new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip')),
		).text();
		const lines = text.split('\n');
		expect(lines).toContain(
			JSON.stringify({declare: 'placement', id: ['window', 'ordinal'], fields: [['epoch', 'integer']]}),
		);
		expect(lines).toContain(
			JSON.stringify({
				declare: 'placementPlayer',
				id: ['window', 'ordinal', 'position', 'moveOrdinal'],
				fields: [
					['color', 'integer'],
					['address', 'text'],
				],
				parent: {entity: 'placement', as: 'players'},
			}),
		);
	});
});
