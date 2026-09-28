import type {BlockPointer, EntityDeclaration, Mutation, StateStoreCapabilities} from '@etherfold/state-store';
import type {QueryExtensions, QueryResult} from '../executor.js';
import type {HistoryStep, QueryConformanceCase, QueryExecutorFactory, QuerySubject} from './types.js';

/**
 * The declarations every case is written against: small, hand-written, and each
 * entity earning its place.
 *
 * `pool` carries one field of every kind a GraphQL answer serialises (text, an
 * enum, an integer, a real, a `u256` and a plain blob), so every scalar is asked
 * of every executor. `deposit` is its child (ADR-0098: its leading id column IS
 * the pool's whole id), so a nested relation is asked of every executor, with a
 * `u256` of its own to order by. `crowd` is the many-rows subject of the bound
 * chapter.
 */
export const POOL: EntityDeclaration = {
	name: 'pool',
	id: ['pool'],
	fields: {
		label: 'text',
		kind: {storage: 'text', enum: ['open', 'closed']},
		weight: 'integer',
		ratio: 'real',
		amount: {storage: 'blob', type: 'u256'},
		tag: 'blob',
	},
};

export const DEPOSIT: EntityDeclaration = {
	name: 'deposit',
	id: ['pool', 'seq'],
	fields: {who: 'text', amount: {storage: 'blob', type: 'u256'}},
	parent: {entity: 'pool', as: 'deposits'},
};

export const CROWD: EntityDeclaration = {name: 'crowd', id: ['id'], fields: {n: 'integer'}};

/** What every factory is handed. */
export const QUERY_ENTITIES: readonly EntityDeclaration[] = [POOL, DEPOSIT, CROWD];

export const TWO_64 = 2n ** 64n;
export const TWO_255 = 2n ** 255n;

export function block(number: number): BlockPointer {
	return {number, hash: `0x${number.toString(16).padStart(64, '0')}`, timestamp: 1_700_000_000 + number * 12};
}

export function pool(id: string, values: Record<string, unknown>): Mutation {
	return {type: 'upsert', entity: 'pool', id: {pool: id}, values};
}

export function deposit(poolId: string, seq: string, values: Record<string, unknown>): Mutation {
	return {type: 'upsert', entity: 'deposit', id: {pool: poolId, seq}, values};
}

/** `count` crowd rows, `p0` to `p{count-1}`, row `pN` holding `n: N + offset`. */
export function crowd(count: number, offset = 0): Mutation[] {
	return Array.from({length: count}, (_, n) => ({
		type: 'upsert',
		entity: 'crowd',
		id: {id: `p${n}`},
		values: {n: n + offset},
	}));
}

/**
 * THE HISTORY most cases read: four pools and their deposits at block 10, and
 * block 11 changing it (`b` reopens, `c` goes, `a` gains a deposit), so an
 * as-of query has something to disagree with the tip about.
 *
 * The `u256` amounts are chosen so numeric order disagrees with every wrong
 * one: 9 before 10 (not decimal text), 2^64 + 1 and 2^255 (past a double and
 * past 64 bits). Every null field is null on purpose, so its serialisation is
 * asked too.
 */
export const HISTORY: readonly HistoryStep[] = [
	{
		block: 10,
		mutations: [
			pool('a', {label: 'alpha', kind: 'open', weight: 3, ratio: 0.5, amount: 9n, tag: new Uint8Array([0xab, 0x01])}),
			pool('b', {label: 'beta', kind: 'closed', weight: 1, ratio: 1.5, amount: TWO_64 + 1n, tag: null}),
			pool('c', {label: 'gamma', kind: 'open', weight: 2, ratio: null, amount: 10n, tag: null}),
			pool('d', {label: 'delta', kind: 'closed', weight: -4, ratio: -2.25, amount: TWO_255, tag: new Uint8Array([0])}),
			deposit('a', '1', {who: 'ann', amount: 5n}),
			deposit('a', '2', {who: 'bob', amount: TWO_64}),
			deposit('b', '1', {who: 'cat', amount: 1n}),
		],
	},
	{
		block: 11,
		mutations: [
			pool('b', {label: 'beta', kind: 'open', weight: 1, ratio: 1.5, amount: TWO_64 + 1n, tag: null}),
			{type: 'delete', entity: 'pool', id: {pool: 'c'}},
			deposit('a', '3', {who: 'dan', amount: 7n}),
		],
	},
];

/** A subject from the factory, migrated, with the history applied in order. */
export async function subjectWith(
	factory: QueryExecutorFactory,
	history: readonly HistoryStep[] = [],
): Promise<QuerySubject> {
	const subject = await factory(QUERY_ENTITIES);
	await subject.store.migrate();
	for (const step of history) {
		if ('revertTo' in step) await subject.store.revertTo(step.revertTo);
		else await subject.store.applyBlock(block(step.block), step.mutations);
	}
	return subject;
}

/** An answer: its data, and the generation and block every answer reports, in the order an executor writes them. */
export function answer(data: Record<string, unknown> | null, generation: string, pinned: number | null): QueryResult {
	return {data, extensions: extensions(generation, pinned)};
}

export function extensions(generation: string, pinned: number | null): QueryExtensions {
	return {generation, block: pinned};
}

/** Turns `{name: run}` into cases, so a case reads like the `it` it becomes. */
export function cases(group: string, entries: Record<string, () => Promise<void>>): QueryConformanceCase[] {
	return Object.entries(entries).map(([name, run]) => ({group, name, run}));
}

/** Whether the store claims to answer as-of reads at all. */
export function answersHistory(capabilities: StateStoreCapabilities): boolean {
	return capabilities.asOf && capabilities.retention.kind !== 'revert-only';
}
