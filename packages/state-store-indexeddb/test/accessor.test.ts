import 'fake-indexeddb/auto';
import {RowsExaminedBoundError, ROWS_EXAMINED_BOUND} from '@etherfold/accessor';
import {ACCESSOR_ENTITIES, block} from '@etherfold/accessor/conformance';
import type {Mutation} from '@etherfold/state-store';
import {describe, expect, it} from 'vitest';
import {DEFAULT_ROWS_EXAMINED_BOUND, IndexedDBStateStore} from '../src/index.js';
import {freshDatabaseName} from './utils/database.js';

/**
 * What is particular to THIS backend's accessor, beside the shared suite
 * (`accessor-conformance.test.ts`): the bound's default and its configuration,
 * that the bound governs the as-of DELTA as well as the tip scan, that the delta
 * counts the whole database's churn and says so, and that a relation page is one
 * bounded scan per parent.
 */

async function store(bound?: number) {
	const subject = new IndexedDBStateStore(ACCESSOR_ENTITIES, {databaseName: freshDatabaseName()});
	await subject.migrate();
	return {store: subject, accessor: subject.accessor(bound === undefined ? {} : {rowsExaminedBound: bound})};
}

function crowd(count: number, n = 0): Mutation[] {
	return Array.from({length: count}, (_, index) => ({
		type: 'upsert' as const,
		entity: 'crowd',
		id: {id: `p${index}`},
		values: {n: n + index},
	}));
}

const ROOMS: Mutation[] = [
	{type: 'upsert', entity: 'room', id: {room: 'r1'}, values: {name: 'hall'}},
	{type: 'upsert', entity: 'room', id: {room: 'r2'}, values: {name: 'study'}},
];

function refusal(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(error: unknown) => error,
	);
}

describe('the rows-examined bound of the IndexedDB accessor', () => {
	// the refusal itself is the shared suite's (at a small configured bound): a
	// 25,001-row write under fake-indexeddb costs a minute and proves nothing more
	it('defaults to 25,000 and is reported by the accessor', async () => {
		expect(DEFAULT_ROWS_EXAMINED_BOUND).toBe(25_000);
		expect((await store()).accessor.rowsExaminedBound).toBe(25_000);
		expect((await store(7)).accessor.rowsExaminedBound).toBe(7);
	});

	it('is refused when it is not a whole number of rows, at least 1', async () => {
		const subject = new IndexedDBStateStore(ACCESSOR_ENTITIES, {databaseName: freshDatabaseName()});
		for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => subject.accessor({rowsExaminedBound: bad})).toThrow(/rowsExaminedBound/);
		}
	});

	it("scans only the queried entity's rows at the tip, whatever the others hold", async () => {
		const {store: subject, accessor} = await store(5);
		await subject.applyBlock(block(100), [...crowd(50), ...ROOMS]);
		const page = await accessor.find({entity: 'room', orderBy: {field: 'name'}, limit: 10});
		expect(page.rows).toEqual([
			{room: 'r1', name: 'hall'},
			{room: 'r2', name: 'study'},
		]);
	});
});

describe('as of a block, current plus the delta since it', () => {
	it('answers when the churn since the block is within the bound', async () => {
		const {store: subject, accessor} = await store(5);
		await subject.applyBlock(block(100), [...crowd(5), ...ROOMS]);
		// five versions closed above 100: exactly the bound
		await subject.applyBlock(block(101), crowd(5, 1000));
		expect((await accessor.find({entity: 'room', at: 100, limit: 10})).rows).toHaveLength(2);
		expect((await accessor.find({entity: 'crowd', at: 100, orderBy: {field: 'n'}, limit: 1})).rows).toEqual([
			{id: 'p0', n: 0},
		]);
	});

	it("refuses a quiet entity when OTHER entities' churn since the block passes the bound, and says why", async () => {
		const {store: subject, accessor} = await store(5);
		await subject.applyBlock(block(100), [...crowd(6), ...ROOMS]);
		// `room` never changes; `crowd` closes six versions above block 100
		await subject.applyBlock(block(101), crowd(6, 1000));

		const refused = await refusal(accessor.find({entity: 'room', at: 100, limit: 10}));
		expect(refused).toBeInstanceOf(RowsExaminedBoundError);
		expect(refused).toMatchObject({code: ROWS_EXAMINED_BOUND, bound: 5, entity: 'room'});
		expect((refused as Error).message).toMatch(/every entity/);
		expect((refused as Error).message).toMatch(/block 100/);

		// the same query at the tip, or as of a block above the churn, is answered
		expect((await accessor.find({entity: 'room', limit: 10})).rows).toHaveLength(2);
		expect((await accessor.find({entity: 'room', at: 101, limit: 10})).rows).toHaveLength(2);
	});

	it('bounds the delta of a relation page too', async () => {
		const {store: subject, accessor} = await store(5);
		await subject.applyBlock(block(100), [...crowd(6), ...ROOMS]);
		await subject.applyBlock(block(101), crowd(6, 1000));
		const refused = await refusal(
			accessor.children({entity: 'room', relation: 'visits', parents: [{room: 'r1'}], at: 100, limit: 10}),
		);
		expect(refused).toBeInstanceOf(RowsExaminedBoundError);
		expect(refused).toMatchObject({bound: 5, entity: 'visit'});
	});
});

describe('a relation page is one bounded scan per parent', () => {
	function visits(room: string, count: number): Mutation[] {
		return Array.from({length: count}, (_, seq) => ({
			type: 'upsert' as const,
			entity: 'visit',
			id: {room, seq: `s${seq}`},
			values: {guest: `g${seq}`, rank: seq},
		}));
	}

	it('answers parents whose children are each within the bound, though together they are past it', async () => {
		const {store: subject, accessor} = await store(3);
		await subject.applyBlock(block(100), [...ROOMS, ...visits('r1', 3), ...visits('r2', 3)]);
		const pages = await accessor.children({
			entity: 'room',
			relation: 'visits',
			parents: [{room: 'r1'}, {room: 'r2'}],
			orderBy: {field: 'rank', direction: 'desc'},
			limit: 1,
		});
		expect(pages.map((page) => page.rows.map((row) => `${row.room}/${row.seq}`))).toEqual([['r1/s2'], ['r2/s2']]);
	});

	it('refuses a page with one parent whose children are past the bound', async () => {
		const {store: subject, accessor} = await store(3);
		await subject.applyBlock(block(100), [...ROOMS, ...visits('r1', 4), ...visits('r2', 1)]);
		const refused = await refusal(
			accessor.children({entity: 'room', relation: 'visits', parents: [{room: 'r2'}, {room: 'r1'}], limit: 1}),
		);
		expect(refused).toBeInstanceOf(RowsExaminedBoundError);
		expect(refused).toMatchObject({bound: 3, entity: 'visit'});
	});
});
