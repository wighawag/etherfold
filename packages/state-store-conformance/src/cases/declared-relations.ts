import {encodeSnapshot, normalizeEntities, openSnapshotAware, type EntityDeclaration} from '@etherfold/state-store';
import {expect} from 'vitest';
import {block, cases} from '../fixtures.js';
import type {ConformanceCase, StateStoreFactory} from '../types.js';

const GROUP = 'a declared relation is checked against the ids';

/** The parent: a window of arrivals, keyed `(window, ordinal)`. */
const ARRIVAL: EntityDeclaration = {name: 'arrival', id: ['window', 'ordinal'], fields: {epoch: 'integer'}};

/** Its children: the parent's WHOLE id, then one column of their own. */
const MOVE: EntityDeclaration = {
	name: 'move',
	id: ['window', 'ordinal', 'moveOrdinal'],
	fields: {address: 'text'},
	parent: {entity: 'arrival', as: 'moves'},
};

/** A relation every backend must accept. */
const RELATED: readonly EntityDeclaration[] = [ARRIVAL, MOVE];

function moved(ordinal: string, moveOrdinal: string, address: string) {
	return {
		type: 'upsert' as const,
		entity: 'move',
		id: {window: 'w', ordinal, moveOrdinal},
		values: {address},
	};
}

/**
 * The declarations every backend must refuse, and why. Each is refused with the
 * seam's OWN message (`normalizeEntities`), so the refusal is the same sentence
 * on every backend rather than merely a refusal.
 */
const REFUSED: Record<string, readonly EntityDeclaration[]> = {
	'a child carrying only part of its parent id': [ARRIVAL, {...MOVE, id: ['ordinal', 'moveOrdinal']}],
	"the parent's id columns in the wrong order": [ARRIVAL, {...MOVE, id: ['ordinal', 'window', 'moveOrdinal']}],
	"the parent's id columns under other names": [ARRIVAL, {...MOVE, id: ['windowId', 'ordinal', 'moveOrdinal']}],
	'a parent that is not declared': [MOVE],
	'an `as` naming a field of the parent': [ARRIVAL, {...MOVE, parent: {entity: 'arrival', as: 'epoch'}}],
	'an `as` naming an id column of the parent': [ARRIVAL, {...MOVE, parent: {entity: 'arrival', as: 'ordinal'}}],
	'an `as` another relation already names on the same parent': [
		ARRIVAL,
		MOVE,
		{name: 'note', id: ['window', 'ordinal', 'note'], fields: {}, parent: {entity: 'arrival', as: 'moves'}},
	],
	'an `as` the generated read surface already uses': [
		ARRIVAL,
		{...MOVE, parent: {entity: 'arrival', as: 'listCurrent'}},
	],
};

/** What the seam says about a declaration set, as the message a backend must repeat. */
function seamRefusal(declarations: readonly EntityDeclaration[]): string {
	try {
		normalizeEntities(declarations);
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error('the seam accepted a declaration this case expects it to refuse');
}

/**
 * A relation is a DECLARATION that a leading run of the child's id names its
 * parent (ADR-0098), so every backend must agree on two things: that a relation
 * matching the ids is legal and its children are the bounded id-prefix listing
 * under the parent's key (ADR-0021), and that one NOT matching them is refused
 * where it was written, at declaration time, in the same words. A backend that
 * accepted one the others refuse would make a relation mean one thing on a
 * server and another in a browser, which is the divergence this seam exists to
 * rule out.
 */
export function declaredRelationCases(factory: StateStoreFactory): ConformanceCase[] {
	return cases(GROUP, {
		"a relation matching the ids is accepted, and its children are the listing under the parent's key": async () => {
			const store = await factory(RELATED);
			await store.migrate();
			await store.applyBlock(block(100), [
				{type: 'upsert', entity: 'arrival', id: {window: 'w', ordinal: '1'}, values: {epoch: 7}},
				{type: 'upsert', entity: 'arrival', id: {window: 'w', ordinal: '2'}, values: {epoch: 8}},
				moved('1', '2', '0xbob'),
				moved('1', '1', '0xalice'),
				moved('2', '1', '0xcarol'),
			]);

			const children = await store.listCurrent<{moveOrdinal: string; address: string}>(
				'move',
				{window: 'w', ordinal: '1'},
				10,
			);
			expect(children.rows.map((row) => [row.moveOrdinal, row.address])).toEqual([
				['1', '0xalice'],
				['2', '0xbob'],
			]);
			expect(children.truncated).toBe(false);

			const bounded = await store.listCurrent('move', {window: 'w', ordinal: '1'}, 1);
			expect(bounded.rows).toHaveLength(1);
			expect(bounded.truncated).toBe(true);
		},

		'a relation implies nothing about writes: a child whose parent was never written is stored': async () => {
			const store = await factory(RELATED);
			await store.migrate();
			await store.applyBlock(block(100), [moved('9', '1', '0xorphan')]);
			expect(await store.getCurrent('move', {window: 'w', ordinal: '9', moveOrdinal: '1'})).toMatchObject({
				address: '0xorphan',
			});
		},

		...Object.fromEntries(
			Object.entries(REFUSED).map(([shape, declarations]) => [
				`${shape} is refused at DECLARATION time, in the seam's own words`,
				async () => {
					const expected = seamRefusal(declarations);
					const error = await Promise.resolve()
						.then(() => factory(declarations))
						.then(
							() => undefined,
							(thrown: unknown) => thrown,
						);
					expect(error, `the backend accepted ${shape}`).toBeInstanceOf(Error);
					expect((error as Error).message).toBe(expected);
				},
			]),
		),

		'an entity declaring a relation survives a snapshot install': async () => {
			const inner = await factory(RELATED);
			const store = await openSnapshotAware(inner);
			await store.migrate();
			const document = encodeSnapshot(
				{
					processor: 'conformance-processor-v1',
					savedAt: '2026-09-28T00:00:00.000Z',
					takenAt: block(100),
					floor: 100,
					cursor: {key: 'lastSync', value: 'at-100'},
				},
				RELATED,
				[
					{
						block: block(100),
						mutations: [
							{type: 'upsert', entity: 'arrival', id: {window: 'w', ordinal: '1'}, values: {epoch: 7}},
							moved('1', '1', '0xalice'),
						],
					},
				],
			);
			await store.bootstrap(new Uint8Array(await new Response(document).arrayBuffer()), {
				processor: 'conformance-processor-v1',
			});

			const children = await store.listCurrent<{address: string}>('move', {window: 'w', ordinal: '1'}, 10);
			expect(children.rows.map((row) => row.address)).toEqual(['0xalice']);
			expect(await store.readCursor('lastSync')).toBe('at-100');
		},
	});
}
