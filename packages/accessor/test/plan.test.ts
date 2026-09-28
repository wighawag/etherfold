import {normalizeEntities, u256, UnknownEntityError} from '@etherfold/state-store';
import {describe, expect, it} from 'vitest';
import {ACCESSOR_ENTITIES} from '../src/conformance/index.js';
import {answeredRow, planChildren, planFind, RowsExaminedBoundError, ROWS_EXAMINED_BOUND} from '../src/index.js';

/**
 * The planner every backend calls. Its answers are asserted end to end by the
 * conformance suite on each backend; what is asserted HERE is the part a backend
 * never gets to see: that each operand arrives in the form the column stores, and
 * that every comparison with null has already been folded to "matches nothing".
 */
const entities = normalizeEntities(ACCESSOR_ENTITIES);

describe('planning a find', () => {
	it('turns a u256 operand into its canonical encoding, and an id given as a number into the text it is keyed by', () => {
		const planned = planFind(entities, {
			entity: 'item',
			where: {
				and: [
					{field: 'amount', op: 'gt', value: 10n},
					{field: 'id', op: 'in', values: [1, 'b']},
				],
			},
			limit: 5,
		});
		expect(planned.where).toEqual({
			kind: 'and',
			of: [
				{kind: 'compare', column: 'amount', op: 'gt', operand: u256.encode(10n)},
				{kind: 'in', column: 'id', operands: ['1', 'b']},
			],
		});
	});

	it('folds a comparison with null, and an in of nothing but nulls, to an empty or', () => {
		const nothing = {kind: 'or', of: []};
		expect(
			planFind(entities, {entity: 'item', where: {field: 'label', op: 'ne', value: null}, limit: 1}).where,
		).toEqual(nothing);
		expect(
			planFind(entities, {entity: 'item', where: {field: 'label', op: 'in', values: [null, null]}, limit: 1}).where,
		).toEqual(nothing);
		expect(
			planFind(entities, {entity: 'item', where: {field: 'label', op: 'in', values: [null, 'x']}, limit: 1}).where,
		).toEqual({kind: 'in', column: 'label', operands: ['x']});
	});

	it('orders ascending unless told otherwise', () => {
		expect(planFind(entities, {entity: 'item', orderBy: {field: 'weight'}, limit: 1}).orderBy).toEqual({
			column: 'weight',
			direction: 'asc',
		});
	});

	it('refuses what it cannot mean the same everywhere, naming the field', () => {
		expect(() => planFind(entities, {entity: 'item', where: {field: 'colour', op: 'eq', value: 1}, limit: 1})).toThrow(
			/names "colour", which entity item does not declare/,
		);
		expect(() =>
			planFind(entities, {entity: 'item', where: {field: 'weight', op: 'eq', value: '3'}, limit: 1}),
		).toThrow(/item\.weight compares it with "3", and it holds a number/);
		expect(() => planFind(entities, {entity: 'item', where: {field: 'amount', op: 'eq', value: 9}, limit: 1})).toThrow(
			/item\.amount .* holds a blob u256/,
		);
		expect(() =>
			planFind(entities, {entity: 'item', where: {field: 'label', op: 'like' as 'eq', value: 'x'}, limit: 1}),
		).toThrow(/operator "like"/);
		expect(() =>
			planFind(entities, {entity: 'item', where: {field: 'label', op: 'isNull', value: 1 as never}, limit: 1}),
		).toThrow(/takes true \(IS NULL\) or false/);
		expect(() => planFind(entities, {entity: 'item', limit: 1.5})).toThrow(/whole number of rows/);
		expect(() => planFind(entities, {entity: 'item', limit: 1, at: -1})).toThrow();
		expect(() => planFind(entities, {entity: 'nothing', limit: 1})).toThrow(UnknownEntityError);
	});
});

describe('planning children', () => {
	it("resolves the child through the parent's collection name, and keeps the parents' order and repeats", () => {
		const planned = planChildren(entities, {
			entity: 'shelf',
			relation: 'books',
			parents: [
				{aisle: 2, shelf: 'a', extra: 'ignored'},
				{aisle: '1', shelf: 'b'},
				{aisle: '2', shelf: 'a'},
			],
			limit: 3,
		});
		expect(planned.entity.name).toBe('book');
		expect(planned.parents).toEqual([
			['2', 'a'],
			['1', 'b'],
			['2', 'a'],
		]);
		expect(planned.distinctParents).toEqual([
			['2', 'a'],
			['1', 'b'],
		]);
	});

	it('refuses a relation the parent does not have, naming the ones it does', () => {
		expect(() => planChildren(entities, {entity: 'room', relation: 'guests', parents: [], limit: 1})).toThrow(
			/entity room has no relation "guests".*\(visits of visit\)/,
		);
	});
});

describe('a row as the accessor answers it', () => {
	it('is the declared columns only, a blob as bytes and a u256 as a bigint', () => {
		const item = entities.get('item')!;
		const stored = {
			id: 'a',
			label: 'x',
			kind: null,
			weight: 1,
			ratio: 0.5,
			amount: u256.encode(7n).buffer,
			tag: new Uint8Array([1, 2]).buffer,
			_lower: 100,
			_upper: null,
			_rank: 1,
		};
		expect(answeredRow(item, stored)).toEqual({
			id: 'a',
			label: 'x',
			kind: null,
			weight: 1,
			ratio: 0.5,
			amount: 7n,
			tag: new Uint8Array([1, 2]),
		});
	});
});

describe('the rows-examined refusal', () => {
	it('carries its code, the entity and the bound, and is not worth retrying', () => {
		const error = new RowsExaminedBoundError('crowd', 25_000);
		expect(error).toMatchObject({
			name: 'RowsExaminedBoundError',
			code: ROWS_EXAMINED_BOUND,
			entity: 'crowd',
			bound: 25_000,
			retryable: false,
		});
		expect(error.message).toMatch(/more than 25000 rows/);
	});
});
