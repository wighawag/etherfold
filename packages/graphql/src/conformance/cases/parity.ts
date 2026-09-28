import {QUERY_ERROR_CODES} from '../../errors.js';
import {answer, deposit, extensions, HISTORY, pool, TWO_255, TWO_64} from '../fixtures.js';
import type {HistoryStep, QueryParityCase} from '../types.js';

/**
 * ## THE LIST: one request, one history, one answer, BYTE FOR BYTE on every executor
 *
 * Every case here is asked of every executor and must answer EXACTLY the
 * expected JSON, compared as the string it serialises to (key order included),
 * so the four parity rules of ADR-0099 are asserted rather than hoped for:
 *
 * - a `u256` is a decimal string on every executor (`U256`), ordered
 *   numerically, and bytes are `0x` hex: no executor is nicer locally;
 * - every error is formatted by the one formatter, with the one set of codes,
 *   down to its message, locations and path;
 * - every answer reports the generation (and the pinned block) in `extensions`;
 * - and the transport-failure shape, which only an executor WITH a transport can
 *   meet, is its own chapter (`transport.ts`).
 *
 * A capability one deployment serves and another refuses is NOT here: that is a
 * documented difference, asserted per executor (`rows-examined.ts`). Nor is the
 * retention refusal, whose message names the store's own window, so it is
 * selected against what the store claims (`retention.ts`), with the same code
 * and the same bytes wherever it is asked.
 */

const TWO_64_TEXT = TWO_64.toString();
const TWO_64_PLUS_1_TEXT = (TWO_64 + 1n).toString();
const TWO_255_TEXT = TWO_255.toString();

/**
 * A reorg on top of `HISTORY`: block 11 is abandoned and replaced by another
 * block 11, which writes pool `a` differently and a deposit the abandoned one
 * did not (and not the one it did).
 */
const REORGED: readonly HistoryStep[] = [
	...HISTORY,
	{revertTo: 10},
	{block: 11, mutations: [pool('a', {label: 'ALPHA', kind: 'closed'}), deposit('a', '4', {who: 'eve', amount: 3n})]},
];

export const QUERY_PARITY_CASES: readonly QueryParityCase[] = [
	// -- nested relations -----------------------------------------------------
	{
		group: 'nested relations',
		name: 'a nested query with where, orderBy and first answers every scalar, and its children, the same everywhere',
		history: HISTORY,
		request: {
			query: `query ($min: U256) { pool(where: {amount: {gte: $min}}, orderBy: {field: amount, direction: desc}, first: 10) { pool label kind weight ratio amount tag deposits(orderBy: {field: amount}, first: 2) { seq who amount } } }`,
			variables: {min: '9'},
		},
		expected: (generation) =>
			answer(
				{
					pool: [
						{
							pool: 'd',
							label: 'delta',
							kind: 'closed',
							weight: -4,
							ratio: -2.25,
							amount: TWO_255_TEXT,
							tag: '0x00',
							deposits: [],
						},
						{
							pool: 'b',
							label: 'beta',
							kind: 'open',
							weight: 1,
							ratio: 1.5,
							amount: TWO_64_PLUS_1_TEXT,
							tag: null,
							deposits: [{seq: '1', who: 'cat', amount: '1'}],
						},
						{
							pool: 'a',
							label: 'alpha',
							kind: 'open',
							weight: 3,
							ratio: 0.5,
							amount: '9',
							tag: '0xab01',
							deposits: [
								{seq: '1', who: 'ann', amount: '5'},
								{seq: '3', who: 'dan', amount: '7'},
							],
						},
					],
				},
				generation,
				11,
			),
	},
	{
		group: 'nested relations',
		name: 'a nested collection is bounded PER PARENT, so one prolific parent does not starve the others',
		history: HISTORY,
		request: {
			query: `{ pool(orderBy: {field: pool}, first: 10) { pool deposits(orderBy: {field: amount, direction: desc}, first: 1) { seq amount } } }`,
		},
		expected: (generation) =>
			answer(
				{
					pool: [
						{pool: 'a', deposits: [{seq: '2', amount: TWO_64_TEXT}]},
						{pool: 'b', deposits: [{seq: '1', amount: '1'}]},
						{pool: 'd', deposits: []},
					],
				},
				generation,
				11,
			),
	},
	{
		group: 'nested relations',
		name: 'a nested collection takes its own where and orderBy',
		history: HISTORY,
		request: {
			query: `{ pool(where: {pool: {eq: "a"}}, first: 1) { deposits(where: {amount: {lt: "10"}}, orderBy: {field: who, direction: desc}, first: 10) { who } } }`,
		},
		expected: (generation) => answer({pool: [{deposits: [{who: 'dan'}, {who: 'ann'}]}]}, generation, 11),
	},

	// -- u256 -----------------------------------------------------------------
	{
		group: 'a u256 is a decimal string, ordered numerically',
		name: 'ordered by a u256, 9 before 10 before 2^64 before 2^255, ascending and descending',
		history: HISTORY,
		request: {
			query: `{ pool(orderBy: {field: amount}, first: 10) { pool amount } deposit(orderBy: {field: amount, direction: desc}, first: 10) { pool seq amount } }`,
		},
		expected: (generation) =>
			answer(
				{
					pool: [
						{pool: 'a', amount: '9'},
						{pool: 'b', amount: TWO_64_PLUS_1_TEXT},
						{pool: 'd', amount: TWO_255_TEXT},
					],
					deposit: [
						{pool: 'a', seq: '2', amount: TWO_64_TEXT},
						{pool: 'a', seq: '3', amount: '7'},
						{pool: 'a', seq: '1', amount: '5'},
						{pool: 'b', seq: '1', amount: '1'},
					],
				},
				generation,
				11,
			),
	},
	{
		group: 'a u256 is a decimal string, ordered numerically',
		name: 'filtered by a u256 given as an integer literal, a string literal and a string variable',
		history: HISTORY,
		request: {
			query: `query ($max: U256!) { range: pool(where: {amount: {gt: 9, lte: $max}}, orderBy: {field: amount}, first: 10) { pool } listed: pool(where: {amount: {in: ["9", "${TWO_64_PLUS_1_TEXT}"]}}, first: 10) { pool } }`,
			variables: {max: TWO_255_TEXT},
		},
		expected: (generation) =>
			answer({range: [{pool: 'b'}, {pool: 'd'}], listed: [{pool: 'a'}, {pool: 'b'}]}, generation, 11),
	},

	// -- enums and predicates ---------------------------------------------------
	{
		group: 'enums and predicates',
		name: 'an enum is filtered and answered by its declared values',
		history: HISTORY,
		request: {
			query: `{ open: pool(where: {kind: {eq: open}}, first: 10) { pool kind } notOpen: pool(where: {kind: {ne: open}}, first: 10) { pool kind } listed: pool(where: {kind: {in: [closed]}}, first: 10) { pool } byKind: pool(orderBy: {field: kind}, first: 2) { pool kind } }`,
		},
		expected: (generation) =>
			answer(
				{
					open: [
						{pool: 'a', kind: 'open'},
						{pool: 'b', kind: 'open'},
					],
					notOpen: [{pool: 'd', kind: 'closed'}],
					listed: [{pool: 'd'}],
					// `closed` before `open`, then the tie on `open` broken by id
					byKind: [
						{pool: 'd', kind: 'closed'},
						{pool: 'a', kind: 'open'},
					],
				},
				generation,
				11,
			),
	},
	{
		group: 'enums and predicates',
		name: '_and, _or, isNull, an empty where, a comparison with null, and nulls first ascending and last descending',
		history: HISTORY,
		request: {
			query: `{ both: pool(where: {_and: [{kind: {eq: open}}, {weight: {gt: 1}}]}, first: 10) { pool } any: pool(where: {_or: [{pool: {eq: "d"}}, {label: {in: ["beta"]}}]}, first: 10) { pool } tagless: pool(where: {tag: {isNull: true}}, first: 10) { pool } tagged: pool(where: {tag: {isNull: false}}, first: 10) { pool } every: pool(where: {}, first: 10) { pool } none: pool(where: {ratio: {ne: null}}, first: 10) { pool } nullsFirst: pool(orderBy: {field: tag}, first: 10) { pool tag } nullsLast: pool(orderBy: {field: tag, direction: desc}, first: 10) { pool } }`,
		},
		expected: (generation) =>
			answer(
				{
					both: [{pool: 'a'}],
					any: [{pool: 'b'}, {pool: 'd'}],
					tagless: [{pool: 'b'}],
					tagged: [{pool: 'a'}, {pool: 'd'}],
					every: [{pool: 'a'}, {pool: 'b'}, {pool: 'd'}],
					none: [],
					nullsFirst: [
						{pool: 'b', tag: null},
						{pool: 'd', tag: '0x00'},
						{pool: 'a', tag: '0xab01'},
					],
					nullsLast: [{pool: 'a'}, {pool: 'd'}, {pool: 'b'}],
				},
				generation,
				11,
			),
	},
	{
		group: 'enums and predicates',
		name: 'the operation named is the one run',
		history: HISTORY,
		request: {
			query: `query First { pool(first: 1) { pool } } query Second { deposit(orderBy: {field: amount, direction: desc}, first: 1) { pool seq amount } }`,
			operationName: 'Second',
		},
		expected: (generation) => answer({deposit: [{pool: 'a', seq: '2', amount: TWO_64_TEXT}]}, generation, 11),
	},

	// -- as of a block -----------------------------------------------------------
	{
		group: 'as of a block',
		name: 'as of an earlier block, the rows and children live THEN, a deleted row included, and the pin reported',
		asOf: true,
		history: HISTORY,
		request: {
			query: `{ pool(block: 10, orderBy: {field: pool}, first: 10) { pool kind deposits(first: 10) { seq who } } }`,
		},
		expected: (generation) =>
			answer(
				{
					pool: [
						{
							pool: 'a',
							kind: 'open',
							deposits: [
								{seq: '1', who: 'ann'},
								{seq: '2', who: 'bob'},
							],
						},
						{pool: 'b', kind: 'closed', deposits: [{seq: '1', who: 'cat'}]},
						{pool: 'c', kind: 'open', deposits: []},
						{pool: 'd', kind: 'closed', deposits: []},
					],
				},
				generation,
				11,
			),
	},
	{
		group: 'as of a block',
		name: 'the tip and an earlier block in ONE operation, filtered and ordered by a u256 as of the block',
		asOf: true,
		history: HISTORY,
		request: {
			query: `{ now: pool(where: {kind: {eq: open}}, orderBy: {field: amount, direction: desc}, first: 10) { pool amount } then: pool(block: 10, where: {kind: {eq: open}}, orderBy: {field: amount, direction: desc}, first: 10) { pool label amount } }`,
		},
		expected: (generation) =>
			answer(
				{
					now: [
						{pool: 'b', amount: TWO_64_PLUS_1_TEXT},
						{pool: 'a', amount: '9'},
					],
					then: [
						{pool: 'c', label: 'gamma', amount: '10'},
						{pool: 'a', label: 'alpha', amount: '9'},
					],
				},
				generation,
				11,
			),
	},

	// -- a reorg -------------------------------------------------------------------
	{
		group: 'a reorg',
		name: 'after a reorg, the replacement branch and nothing of the abandoned one',
		history: REORGED,
		request: {
			query: `{ pool(where: {pool: {eq: "a"}}, first: 1) { label kind weight deposits(first: 10) { seq who } } }`,
		},
		expected: (generation) =>
			answer(
				{
					pool: [
						{
							label: 'ALPHA',
							kind: 'closed',
							weight: null,
							deposits: [
								{seq: '1', who: 'ann'},
								{seq: '2', who: 'bob'},
								{seq: '4', who: 'eve'},
							],
						},
					],
				},
				generation,
				11,
			),
	},
	{
		group: 'a reorg',
		name: 'as of the replaced block, the replacement; as of the block before it, what both branches share',
		asOf: true,
		history: REORGED,
		request: {
			query: `{ replaced: deposit(block: 11, orderBy: {field: seq}, first: 10) { pool seq } shared: deposit(block: 10, orderBy: {field: seq}, first: 10) { pool seq } }`,
		},
		expected: (generation) =>
			answer(
				{
					replaced: [
						{pool: 'a', seq: '1'},
						{pool: 'b', seq: '1'},
						{pool: 'a', seq: '2'},
						{pool: 'a', seq: '4'},
					],
					shared: [
						{pool: 'a', seq: '1'},
						{pool: 'b', seq: '1'},
						{pool: 'a', seq: '2'},
					],
				},
				generation,
				11,
			),
	},

	// -- an empty store ------------------------------------------------------------
	{
		group: 'an empty store',
		name: 'a store holding no block answers every list empty, pinned to no block',
		history: [],
		request: {query: `{ pool(first: 10) { pool deposits(first: 10) { seq } } crowd(first: 1) { id } }`},
		expected: (generation) => answer({pool: [], crowd: []}, generation, null),
	},

	// -- one set of codes -------------------------------------------------------------
	{
		group: 'one set of codes, one formatter',
		name: 'a document that does not parse is invalid-query, pinned to no block',
		history: HISTORY,
		request: {query: `{ pool(`},
		expected: (generation) => ({
			errors: [
				{
					message: 'Syntax Error: Expected Name, found <EOF>.',
					locations: [{line: 1, column: 8}],
					extensions: {code: QUERY_ERROR_CODES.invalidQuery},
				},
			],
			extensions: extensions(generation, null),
		}),
	},
	{
		group: 'one set of codes, one formatter',
		name: 'a field the schema does not hold is invalid-query',
		history: HISTORY,
		request: {query: `{ pool(first: 1) { pool nope } }`},
		expected: (generation) => ({
			errors: [
				{
					message: 'Cannot query field "nope" on type "Pool".',
					locations: [{line: 1, column: 25}],
					extensions: {code: QUERY_ERROR_CODES.invalidQuery},
				},
			],
			extensions: extensions(generation, null),
		}),
	},
	{
		group: 'one set of codes, one formatter',
		name: 'a U256 variable that is negative is invalid-query, before anything is read',
		history: HISTORY,
		request: {
			query: `query ($min: U256) { pool(where: {amount: {gte: $min}}, first: 1) { pool } }`,
			variables: {min: '-1'},
		},
		expected: (generation) => ({
			errors: [
				{
					message:
						'Variable "$min" got invalid value "-1"; Expected type "U256". a U256 is a decimal string of digits, got "-1"',
					locations: [{line: 1, column: 8}],
					extensions: {code: QUERY_ERROR_CODES.invalidQuery},
				},
			],
			extensions: extensions(generation, 11),
		}),
	},
	{
		group: 'one set of codes, one formatter',
		name: 'a first below 1 is invalid-query, at the field that asked it',
		history: HISTORY,
		request: {query: `{ pool(first: 0) { pool } }`},
		expected: (generation) => ({
			data: null,
			errors: [
				{
					message: 'first on pool is 0: it is how many rows to answer, a whole number at least 1.',
					locations: [{line: 1, column: 3}],
					path: ['pool'],
					extensions: {code: QUERY_ERROR_CODES.invalidQuery},
				},
			],
			extensions: extensions(generation, 11),
		}),
	},
	{
		group: 'one set of codes, one formatter',
		name: 'a null where a filter was expected is invalid-query, never read as "is null"',
		history: HISTORY,
		request: {query: `{ pool(where: {kind: null}, first: 1) { pool } }`},
		expected: (generation) => ({
			data: null,
			errors: [
				{
					message: 'where on pool gives kind as null: to match a null field use {isNull: true}, or leave it out.',
					locations: [{line: 1, column: 3}],
					path: ['pool'],
					extensions: {code: QUERY_ERROR_CODES.invalidQuery},
				},
			],
			extensions: extensions(generation, 11),
		}),
	},
	{
		group: 'one set of codes, one formatter',
		name: 'a block above the one the operation pinned is block-not-yet-indexed, never answered from the tip',
		history: HISTORY,
		request: {query: `{ pool(first: 1, block: 12) { pool } }`},
		expected: (generation) => ({
			data: null,
			errors: [
				{
					message:
						'block 12 is not indexed yet: this operation answers as of block 11, the highest the store held when it began.',
					locations: [{line: 1, column: 3}],
					path: ['pool'],
					extensions: {code: QUERY_ERROR_CODES.blockNotYetIndexed, requested: 12, pinned: 11},
				},
			],
			extensions: extensions(generation, 11),
		}),
	},
];
