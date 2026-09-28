import type {Accessor, FindQuery} from '@etherfold/accessor';
import {describe, expect, it} from 'vitest';
import {
	HISTORY,
	QUERY_PARITY_CASES,
	runQueryConformance,
	serialised,
	subjectWith,
	type QueryExecutorFactory,
} from '../src/conformance/index.js';
import {QUERY_ERROR_CODES, transportFailure, type QueryResult} from '../src/index.js';
import {indexedDBExecutor, sqliteExecutor, type AccessorWrap} from './executors.js';
import {block, deposit, pool} from './fixtures.js';

/**
 * The suite (`conformance.test.ts`) holds each executor to the same expected
 * bytes, which makes the two answer alike by transitivity; this file says it
 * DIRECTLY, and says what a suite of one executor at a time cannot: the two
 * backends' answers compared with each other, the one-block guard across a
 * reorg on both, and that the suite itself fails an executor that is wrong in
 * each way it claims to catch.
 */

const BOUND = 60;
const BACKENDS = {
	sqlite: (wrap?: AccessorWrap) => sqliteExecutor({retention: {blocks: 60}, finalityDepth: 60}, wrap),
	indexeddb: (wrap?: AccessorWrap) =>
		indexedDBExecutor({retention: {blocks: 60}, finalityDepth: 60, rowsExaminedBound: BOUND}, wrap),
} as const;

describe('the same query answers the same bytes on SQLite and on IndexedDB', () => {
	for (const one of QUERY_PARITY_CASES) {
		it(`${one.group}: ${one.name}`, async () => {
			const answers: string[] = [];
			for (const backend of Object.values(BACKENDS)) {
				const {executor} = await subjectWith(backend(), one.history);
				answers.push(serialised(await executor(one.request)));
			}
			expect(answers[1]).toBe(answers[0]);
		});
	}

	it('the retention refusal: the same code, and the same bytes', async () => {
		const answers: QueryResult[] = [];
		for (const backend of Object.values(BACKENDS)) {
			const subject = await subjectWith(backend(), HISTORY);
			await subject.store.applyBlock(block(200), []);
			answers.push(await subject.executor({query: `{ pool(block: 10, first: 1) { pool } }`}));
		}
		expect(answers[0]!.errors?.[0]?.extensions.code).toBe(QUERY_ERROR_CODES.blockNotRetained);
		expect(serialised(answers[1])).toBe(serialised(answers[0]));
	});
});

/** An accessor that reverts the store to block 10 once, right after the first `find` answers. */
function revertingOnce(accessor: Accessor, store: {revertTo(keepUpTo: number): Promise<void>}): Accessor {
	let left = 1;
	return {
		async find<T>(query: FindQuery) {
			const page = await accessor.find<T>(query);
			if (left-- > 0) await store.revertTo(10);
			return page;
		},
		children: (query) => accessor.children(query),
	};
}

describe('one operation, one block, across a reorg, on both backends', () => {
	for (const [name, backend] of Object.entries(BACKENDS)) {
		it(`${name}: a reorg mid-operation is retried, and answered from the replacement branch alone`, async () => {
			const subject = await subjectWith(
				backend((accessor, store) => revertingOnce(accessor, store)),
				[
					{block: 10, mutations: [pool('a', {label: 'alpha'}), deposit('a', '1', {who: 'ann'})]},
					{block: 11, mutations: [pool('a', {label: 'doomed'}), deposit('a', '2', {who: 'doomed'})]},
				],
			);
			const result = await subject.executor({
				query: `{ pool(first: 10) { pool label deposits(first: 10) { seq who } } }`,
			});
			expect(serialised(result)).toBe(
				JSON.stringify({
					data: {pool: [{pool: 'a', label: 'alpha', deposits: [{seq: '1', who: 'ann'}]}]},
					extensions: {generation: subject.generation, block: 10},
				}),
			);
		});
	}
});

describe('the suite catches an executor that is wrong', () => {
	/** The IndexedDB executor with its results rewritten by `wrong`: cheap, since its bound cases are small. */
	function rewritten(wrong: (result: QueryResult) => QueryResult): QueryExecutorFactory {
		const factory = indexedDBExecutor({rowsExaminedBound: BOUND});
		return async (declarations) => {
			const subject = await factory(declarations);
			return {...subject, executor: async (request) => wrong(await subject.executor(request))};
		};
	}

	async function failedGroups(factory: QueryExecutorFactory, options = {rowsExaminedBound: BOUND}) {
		const {failures} = await runQueryConformance(factory, options);
		return new Set(failures.map((failure) => failure.group));
	}

	it('passes the executor it is not rewriting, so the rewrites below are what fail', async () => {
		const {failures} = await runQueryConformance(
			rewritten((result) => result),
			{rowsExaminedBound: BOUND},
		);
		expect(failures).toEqual([]);
	});

	it('fails one that answers the same values in another key order: the same bytes is the rule, not deep equality', async () => {
		const groups = await failedGroups(
			rewritten(({extensions, ...rest}) => (extensions ? {extensions, ...rest} : rest)),
		);
		expect(groups).toContain('nested relations');
		expect(groups).toContain('one set of codes, one formatter');
	});

	it('fails one that is nicer locally, handing back a u256 as a bigint', async () => {
		const groups = await failedGroups(
			rewritten((result) =>
				JSON.parse(JSON.stringify(result), (key, value) =>
					key === 'amount' && typeof value === 'string' ? BigInt(value) : value,
				),
			),
		);
		expect(groups).toContain('a u256 is a decimal string, ordered numerically');
	});

	it('fails one that does not report the generation', async () => {
		const groups = await failedGroups(
			rewritten((result) =>
				result.extensions ? {...result, extensions: {...result.extensions, generation: ''}} : result,
			),
		);
		expect(groups).toContain('as of a block');
		expect(groups).toContain('an empty store');
	});

	it('fails a deployment declaring a bound that its accessor does not hold', async () => {
		const refusal = 'what a deployment cannot serve is refused with the accessor code, per executor';
		// declared bounded, but its accessor is not (SQLite has a query planner and no bound)
		expect(await failedGroups(sqliteExecutor(), {rowsExaminedBound: BOUND})).toContain(refusal);
	});

	it('fails a declared transport failure that rejects, or answers, instead of the one shape', async () => {
		let broken = false;
		const factory = rewritten((result) => result);
		const rejecting: QueryExecutorFactory = async (declarations) => {
			const subject = await factory(declarations);
			return {
				...subject,
				executor: (request) => (broken ? Promise.reject(new Error('port closed')) : subject.executor(request)),
			};
		};
		const rejected = await runQueryConformance(rejecting, {
			rowsExaminedBound: BOUND,
			transportFailures: {'port-closed': () => void (broken = true)},
		});
		expect(rejected.failures.map((failure) => failure.group)).toEqual(['a transport failure has one shape']);

		broken = false;
		const shaped: QueryExecutorFactory = async (declarations) => {
			const subject = await factory(declarations);
			return {
				...subject,
				executor: (request) =>
					broken ? Promise.resolve(transportFailure('port-closed', 'the port closed')) : subject.executor(request),
			};
		};
		const held = await runQueryConformance(shaped, {
			rowsExaminedBound: BOUND,
			transportFailures: {'port-closed': () => void (broken = true)},
		});
		expect(held.failures).toEqual([]);
	});
});
