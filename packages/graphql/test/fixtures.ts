import {createClient} from '@libsql/client';
import type {Accessor} from '@etherfold/accessor';
import type {BlockPointer, EntityDeclaration, Mutation} from '@etherfold/state-store';
import {VersionedStateStore, type VersionedStateStoreOptions} from '@etherfold/state-store-sqlite';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {QueryContext} from '../src/index.js';

/**
 * A declaration set carrying everything ADR-0098 added: a relation (a pool's
 * deposits, the child keyed by the pool's whole id plus its own column), an enum
 * and a `u256`, beside every plain storage class.
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

export const DECLARATIONS: readonly EntityDeclaration[] = [POOL, DEPOSIT];

export const GENERATION = '0123456789abcdef0123456789abcdef';

export function block(number: number): BlockPointer {
	return {number, hash: `0x${number.toString(16).padStart(64, '0')}`, timestamp: 1_700_000_000 + number * 12};
}

export function pool(id: string, values: Record<string, unknown>): Mutation {
	return {type: 'upsert', entity: 'pool', id: {pool: id}, values};
}

export function deposit(poolId: string, seq: string, values: Record<string, unknown>): Mutation {
	return {type: 'upsert', entity: 'deposit', id: {pool: poolId, seq}, values};
}

/** A real SQLite store (libSQL in memory), its accessor, and a query context over it. */
export async function sqliteSubject(options: VersionedStateStoreOptions = {}) {
	const store = new VersionedStateStore(new RemoteLibSQL(createClient({url: ':memory:'})), DECLARATIONS, options);
	await store.migrate();
	const tip = async () => (await store.getBlockAtOrBelow(Number.MAX_SAFE_INTEGER))?.number;
	const context = (accessor: Accessor = store.accessor()): QueryContext => ({
		accessor,
		generation: GENERATION,
		tip,
		asOf: store.capabilities.asOf,
	});
	return {store, tip, context};
}
