import {
	assertFieldValues,
	encodeSnapshot,
	normalizeEntity,
	openSnapshotAware,
	readSnapshot,
	normalizeEntities,
	type EntityDeclaration,
	type Mutation,
} from '@etherfold/state-store';
import {expect} from 'vitest';
import {block, cases} from '../fixtures.js';
import type {ConformanceCase, StateStoreFactory} from '../types.js';

const GROUP = 'a declared enum is checked at write time';

/** An entity with one enum field, beside a bare text field that means what it always meant. */
const GAME: EntityDeclaration = {
	name: 'game',
	id: ['id'],
	fields: {status: {storage: 'text', enum: ['open', 'closed']}, winner: 'text'},
};

const ENUMERATED: readonly EntityDeclaration[] = [GAME];

function game(id: string, values: Record<string, unknown>): Mutation {
	return {type: 'upsert', entity: 'game', id: {id}, values};
}

/** What the seam says about a write, as the message a backend must repeat. */
function seamRefusal(values: Record<string, unknown>): string {
	try {
		assertFieldValues(normalizeEntity(GAME), values);
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error('the seam accepted a value this case expects it to refuse');
}

/**
 * An enum is a DECLARED value set over text (ADR-0098), so every backend must
 * agree on three things: each declared value (and NULL) is stored and read back
 * as the text it is, any other value is refused at WRITE time with the seam's
 * own sentence and leaves the store as it was, and an entity declaring one
 * installs from a snapshot document. A backend that stored a value the others
 * refuse would make one declaration mean two things, silently.
 */
export function declaredEnumCases(factory: StateStoreFactory): ConformanceCase[] {
	async function opened() {
		const store = await factory(ENUMERATED);
		await store.migrate();
		return store;
	}

	return cases(GROUP, {
		'each declared value, and NULL, is stored and read back as text': async () => {
			const store = await opened();
			await store.applyBlock(block(100), [
				game('1', {status: 'open', winner: '0xalice'}),
				game('2', {status: 'closed'}),
				game('3', {status: null}),
				game('4', {winner: '0xbob'}),
			]);
			expect(await store.getCurrent('game', {id: '1'})).toMatchObject({status: 'open', winner: '0xalice'});
			expect(await store.getCurrent('game', {id: '2'})).toMatchObject({status: 'closed', winner: null});
			expect(await store.getCurrent('game', {id: '3'})).toMatchObject({status: null});
			expect(await store.getCurrent('game', {id: '4'})).toMatchObject({status: null, winner: '0xbob'});
		},

		...Object.fromEntries(
			(
				[
					['an undeclared value', 'pending'],
					['a declared value in another case', 'OPEN'],
					['a number', 1],
					['a boolean', true],
				] as const
			).map(([shape, value]) => [
				`${shape} is refused at WRITE time, in the seam's own words, and the block writes nothing`,
				async () => {
					const store = await opened();
					await store.applyBlock(block(100), [game('1', {status: 'open'})], {key: 'lastSync', value: 'at-100'});

					const expected = seamRefusal({status: value});
					expect(expected).toMatch(/game field status .*\(open, closed\)/);
					const error = await store
						.applyBlock(block(101), [game('1', {status: 'closed'}), game('2', {status: value})], {
							key: 'lastSync',
							value: 'at-101',
						})
						.then(
							() => undefined,
							(thrown: unknown) => thrown,
						);
					expect(error, `the backend stored ${JSON.stringify(value)}`).toBeInstanceOf(Error);
					expect((error as Error).message).toBe(expected);

					expect(await store.getCurrent('game', {id: '1'})).toMatchObject({status: 'open'});
					expect(await store.getCurrent('game', {id: '2'})).toBeUndefined();
					expect(await store.readCursor('lastSync')).toBe('at-100');
					// the height was not recorded either: the same block, corrected, lands
					await store.applyBlock(block(101), [game('2', {status: 'closed'})]);
					expect(await store.getCurrent('game', {id: '2'})).toMatchObject({status: 'closed'});
				},
			]),
		),

		...Object.fromEntries(
			(
				[
					['a value that is not a GraphQL name', ['open', 'in-progress']],
					['a value GraphQL reserves', ['open', 'null']],
					['a repeated value', ['open', 'open']],
					['no value at all', []],
				] as const
			).map(([shape, values]) => [
				`an enum with ${shape} is refused at DECLARATION time, in the seam's own words`,
				async () => {
					const declarations = [{...GAME, fields: {status: {storage: 'text', enum: values}}} as EntityDeclaration];
					let expected: string | undefined;
					try {
						normalizeEntities(declarations);
					} catch (error) {
						expected = (error as Error).message;
					}
					expect(expected, `the seam accepted ${shape}`).toBeDefined();
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

		'an entity declaring an enum survives a snapshot-document round trip and install': async () => {
			const rows = [game('1', {status: 'closed', winner: '0xbob'}), game('2', {status: 'open'})];
			const document = encodeSnapshot(
				{
					processor: 'conformance-processor-v1',
					savedAt: '2026-09-28T00:00:00.000Z',
					takenAt: block(100),
					floor: 100,
					cursor: {key: 'lastSync', value: 'at-100'},
				},
				ENUMERATED,
				[{block: block(100), mutations: rows}],
			);
			const bytes = new Uint8Array(await new Response(document).arrayBuffer());

			const reader = await readSnapshot(bytes);
			const decoded: Mutation[] = [];
			for await (const one of reader.blocks({declarations: normalizeEntities(ENUMERATED)})) {
				decoded.push(...one.mutations);
			}
			expect(decoded).toEqual([
				game('1', {status: 'closed', winner: '0xbob'}),
				game('2', {status: 'open', winner: null}),
			]);

			const store = await openSnapshotAware(await factory(ENUMERATED));
			await store.migrate();
			await store.bootstrap(bytes, {processor: 'conformance-processor-v1'});
			expect(await store.getCurrent('game', {id: '1'})).toMatchObject({status: 'closed', winner: '0xbob'});
			expect(await store.getCurrent('game', {id: '2'})).toMatchObject({status: 'open', winner: null});
			expect(await store.readCursor('lastSync')).toBe('at-100');
		},
	});
}
