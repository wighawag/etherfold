import {normalizeEntities, type Mutation, type StateStoreCapabilities} from '@etherfold/state-store';
import {expect} from 'vitest';
import {planChildren} from '../../plan.js';
import type {ChildrenQuery, Page} from '../../types.js';
import {ACCESSOR_ENTITIES, answersHistory, block, book, cases, subjectWith, visit} from '../fixtures.js';
import type {AccessorConformanceCase, AccessorFactory} from '../types.js';

const GROUP = "a page of parents' children is one call, bounded per parent";

/** A prolific parent: `r1` has fifty visits, `r2` two, `r3` none. */
function visits(): Mutation[] {
	const prolific = Array.from({length: 50}, (_, index) =>
		visit('r1', String(index).padStart(2, '0'), `guest-${index}`, index % 5),
	);
	return [
		{type: 'upsert', entity: 'room', id: {room: 'r1'}, values: {name: 'hall'}},
		{type: 'upsert', entity: 'room', id: {room: 'r2'}, values: {name: 'study'}},
		{type: 'upsert', entity: 'room', id: {room: 'r3'}, values: {name: 'attic'}},
		...prolific,
		visit('r2', '00', 'ada', 4),
		visit('r2', '01', 'bob', 1),
	];
}

/** Seqs of each page, and whether each was cut. */
function shape(
	pages: readonly Page<Record<string, unknown>>[],
	column = 'seq',
): {rows: unknown[]; truncated: boolean}[] {
	return pages.map((page) => ({rows: page.rows.map((row) => row[column]), truncated: page.truncated}));
}

/**
 * The parent-side collection of a declared relation (ADR-0098), for a PAGE of
 * parents at once: what a nested GraphQL field resolves through, so that a
 * hundred parents are one read and not a hundred (story 8 of
 * `a-declaration-a-schema-can-be-built-from`). Whether a backend really makes it
 * one read is not observable from here and is that backend's own test; what is
 * asserted is the answer: one page per parent, in the order asked, each bounded
 * on its own so a prolific parent does not starve the others, and filtered and
 * ordered over the child.
 */
export function relationCases(
	factory: AccessorFactory,
	capabilities: StateStoreCapabilities,
): AccessorConformanceCase[] {
	async function rooms() {
		return subjectWith(factory, [{block: block(100), mutations: visits()}]);
	}

	function seamRefusal(query: ChildrenQuery): string {
		try {
			planChildren(normalizeEntities(ACCESSOR_ENTITIES), query);
		} catch (error) {
			return (error as Error).message;
		}
		throw new Error('the planner accepted a query this case expects it to refuse');
	}

	const always = cases(GROUP, {
		'each parent gets its own bounded page, so a prolific parent does not starve the others': async () => {
			const {accessor} = await rooms();
			const pages = await accessor.children({
				entity: 'room',
				relation: 'visits',
				parents: [{room: 'r1'}, {room: 'r2'}, {room: 'r3'}, {room: 'nowhere'}],
				limit: 3,
			});
			expect(shape(pages)).toEqual([
				{rows: ['00', '01', '02'], truncated: true},
				{rows: ['00', '01'], truncated: false},
				{rows: [], truncated: false},
				{rows: [], truncated: false},
			]);
			// a child row is the child's declared columns, as the seam answers it
			expect(pages[1]!.rows[0]).toEqual({room: 'r2', seq: '00', guest: 'ada', rank: 4});
		},

		'pages come in the order the parents were asked, a repeated parent answered each time': async () => {
			const {accessor} = await rooms();
			const pages = await accessor.children({
				entity: 'room',
				relation: 'visits',
				parents: [{room: 'r2'}, {room: 'r1'}, {room: 'r2'}],
				limit: 2,
			});
			expect(shape(pages)).toEqual([
				{rows: ['00', '01'], truncated: false},
				{rows: ['00', '01'], truncated: true},
				{rows: ['00', '01'], truncated: false},
			]);
		},

		"the predicate and the order are the child's, applied per parent before the bound": async () => {
			const {accessor} = await rooms();
			const pages = await accessor.children({
				entity: 'room',
				relation: 'visits',
				parents: [{room: 'r1'}, {room: 'r2'}],
				where: {field: 'rank', op: 'gte', value: 4},
				orderBy: {field: 'guest', direction: 'desc'},
				limit: 2,
			});
			// r1's rank-4 visits are 04, 09, 14, ..., 49; by guest descending, `guest-9` then `guest-49`
			expect(shape(pages, 'guest')).toEqual([
				{rows: ['guest-9', 'guest-49'], truncated: true},
				{rows: ['ada'], truncated: false},
			]);
		},

		'a parent key of several columns selects exactly that parent, and no other combination': async () => {
			const {accessor} = await subjectWith(factory, [
				{
					block: block(100),
					mutations: [
						book('1', 'a', 'x', 'one-a', 10),
						book('1', 'b', 'x', 'one-b', 20),
						book('2', 'a', 'x', 'two-a', 30),
						// (2, b) is a combination of the asked columns that is not an asked key
						book('2', 'b', 'x', 'two-b', 40),
					],
				},
			]);
			const pages = await accessor.children({
				entity: 'shelf',
				relation: 'books',
				parents: [
					{aisle: '1', shelf: 'b'},
					{aisle: 2, shelf: 'a'},
					{aisle: '1', shelf: 'a'},
				],
				limit: 5,
			});
			expect(shape(pages, 'title')).toEqual([
				{rows: ['one-b'], truncated: false},
				{rows: ['two-a'], truncated: false},
				{rows: ['one-a'], truncated: false},
			]);
		},

		'no parents is no pages': async () => {
			const {accessor} = await rooms();
			expect(await accessor.children({entity: 'room', relation: 'visits', parents: [], limit: 1})).toEqual([]);
		},

		"a relation the declaration does not have, or a key missing a column, is refused in the seam's own words":
			async () => {
				const {accessor} = await rooms();
				const refused: ChildrenQuery[] = [
					{entity: 'room', relation: 'guests', parents: [{room: 'r1'}], limit: 1},
					{entity: 'shelf', relation: 'books', parents: [{aisle: '1'}], limit: 1},
					{
						entity: 'room',
						relation: 'visits',
						parents: [{room: 'r1'}],
						where: {field: 'name', op: 'eq', value: 'hall'},
						limit: 1,
					},
				];
				for (const query of refused) {
					await expect(accessor.children(query), JSON.stringify(query)).rejects.toThrow(seamRefusal(query));
				}
			},
	});

	if (!answersHistory(capabilities)) return always;

	return [
		...always,
		...cases(GROUP, {
			'as of a block, each parent has the children it had then': async () => {
				const {accessor, store} = await rooms();
				await store.applyBlock(block(101), [
					visit('r2', '02', 'cy', 3),
					{type: 'delete', entity: 'visit', id: {room: 'r1', seq: '00'}},
				]);
				const query = {entity: 'room', relation: 'visits', parents: [{room: 'r1'}, {room: 'r2'}], limit: 3};
				expect(shape(await accessor.children({...query, at: 100}))).toEqual([
					{rows: ['00', '01', '02'], truncated: true},
					{rows: ['00', '01'], truncated: false},
				]);
				expect(shape(await accessor.children(query))).toEqual([
					{rows: ['01', '02', '03'], truncated: true},
					{rows: ['00', '01', '02'], truncated: false},
				]);
			},
		}),
	];
}
