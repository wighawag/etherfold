import 'fake-indexeddb/auto';
import {createClient} from '@libsql/client';
import type {Accessor} from '@etherfold/accessor';
import {BLOCKS, IndexedDBStateStore, type IndexedDBStateStoreOptions} from '@etherfold/state-store-indexeddb';
import {VersionedStateStore, type VersionedStateStoreOptions} from '@etherfold/state-store-sqlite';
import type {EntityDeclaration, QueryReads, StateStoreBackend} from '@etherfold/state-store';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {QueryExecutorFactory, QuerySubject} from '../src/conformance/index.js';
import {buildQuerySchema, localExecutor, queryBlocksOf, type QueryContext} from '../src/index.js';
import {GENERATION} from './fixtures.js';

/**
 * The two executors the query conformance suite is asked of here: the
 * in-process executor (`localExecutor`) over a real SQLite store (libSQL in
 * memory) and over a real IndexedDB store (`fake-indexeddb`), each reading
 * through its own backend's accessor. Everything above the accessor (the schema,
 * the resolvers, the pin, the formatter) is the one module both tiers import, so
 * any difference in their answers is a difference of the accessors, which is
 * exactly what the suite exists to catch.
 *
 * Each factory builds the context the way a host must: the tip read from the
 * store itself, and `asOf` from the store's own claim (a revert-only store
 * answers no as-of read, so its operations read the tip).
 */

/** A hook to wrap the accessor, so a test can interleave writes with an operation's reads. */
export type AccessorWrap = (accessor: Accessor, store: StateStoreBackend) => Accessor;

function subject(
	store: StateStoreBackend,
	declarations: readonly EntityDeclaration[],
	accessor: Accessor,
	tip: () => Promise<number | undefined>,
	wrap: AccessorWrap | undefined,
): QuerySubject {
	const capabilities = store.capabilities;
	const reads = store as unknown as QueryReads;
	const context: QueryContext = {
		accessor: wrap ? wrap(accessor, store) : accessor,
		generation: GENERATION,
		tip,
		asOf: capabilities.asOf && capabilities.retention.kind !== 'revert-only',
		// the block reads and the revert sequence, off the store itself, as a host copies them
		blocks: queryBlocksOf(reads),
	};
	return {store, executor: localExecutor(buildQuerySchema(declarations), context), generation: GENERATION};
}

export function sqliteExecutor(options: VersionedStateStoreOptions = {}, wrap?: AccessorWrap): QueryExecutorFactory {
	return (declarations) => {
		const store = new VersionedStateStore(new RemoteLibSQL(createClient({url: ':memory:'})), declarations, options);
		const tip = async () => (await store.getBlockAtOrBelow(Number.MAX_SAFE_INTEGER))?.number;
		return subject(store, declarations, store.accessor(), tip, wrap);
	};
}

export type IndexedDBExecutorOptions = IndexedDBStateStoreOptions & {readonly rowsExaminedBound?: number};

let databases = 0;

export function indexedDBExecutor(
	{rowsExaminedBound, ...options}: IndexedDBExecutorOptions = {},
	wrap?: AccessorWrap,
): QueryExecutorFactory {
	return (declarations) => {
		const databaseName = `etherfold-graphql-${++databases}-${Math.random().toString(36).slice(2, 10)}`;
		const store = new IndexedDBStateStore(declarations, {databaseName, ...options});
		return subject(store, declarations, store.accessor({rowsExaminedBound}), () => highestBlock(databaseName), wrap);
	};
}

/**
 * The highest block an IndexedDB store has recorded, read from its `blocks`
 * object store through a connection of the test's own. The store keeps its tip
 * read private (a host learns the tip from its sync cursor), so the test reads
 * the storage directly, as a second tab would. Only ever called once the store
 * is migrated, since opening an unversioned database first would create it.
 */
const connections = new Map<string, Promise<IDBDatabase>>();

async function highestBlock(databaseName: string): Promise<number | undefined> {
	let connection = connections.get(databaseName);
	if (!connection) {
		connection = new Promise((resolve, reject) => {
			const open = indexedDB.open(databaseName);
			open.onsuccess = () => resolve(open.result);
			open.onerror = () => reject(open.error);
		});
		connections.set(databaseName, connection);
	}
	const db = await connection;
	return new Promise((resolve, reject) => {
		const cursor = db.transaction(BLOCKS, 'readonly').objectStore(BLOCKS).openCursor(null, 'prev');
		cursor.onsuccess = () => resolve(cursor.result ? (cursor.result.key as number) : undefined);
		cursor.onerror = () => reject(cursor.error);
	});
}
