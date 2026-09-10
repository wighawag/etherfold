/**
 * Every backend the conformance suite covers, as factories this workload feeds.
 *
 * The list is deliberately the same one as
 * `@etherfold/state-store-conformance`'s: `MemoryStateStore` (the reference),
 * `VersionedStateStore` on libSQL (the server), `IndexedDBStateStore` (the
 * browser default, ADR-0024), and `PatchStateStore` (the light store). A
 * backend that passes the small hand-written cases and fails here has found the
 * thing those cases are too small to find.
 *
 * ## Why every one of them keeps ALL its history
 *
 * The workload replays a stream 11 million block numbers wide and then reverts
 * to a block 521 event-bearing blocks below the tip, so a store configured with
 * a retention WINDOW would rightly refuse both halves. That is not a hole in the
 * coverage: retention windows, their refusals and their pruning are exactly what
 * the small cases interrogate, under every claim a backend can make. Here each
 * backend is built the way a deployment that wants full history would build it,
 * which for the patch store means declaring no finality depth, so nothing is
 * pruned and its reverse patches reach the fork point.
 */
import 'fake-indexeddb/auto';
import {createClient} from '@libsql/client';
import {MemoryStateStore, type EntityDeclaration, type StateStoreBackend} from '@etherfold/state-store';
import {IndexedDBStateStore} from '@etherfold/state-store-indexeddb';
import {PatchStateStore} from '@etherfold/state-store-patch';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import {RemoteLibSQL} from 'remote-sql-libsql';

export type Backend = {
	readonly name: string;
	make(declarations: readonly EntityDeclaration[]): StateStoreBackend | Promise<StateStoreBackend>;
};

let databaseCounter = 0;

export const BACKENDS: readonly Backend[] = [
	{
		name: 'memory',
		make: (declarations) => new MemoryStateStore(declarations),
	},
	{
		name: 'sqlite',
		make: (declarations) => new VersionedStateStore(new RemoteLibSQL(createClient({url: ':memory:'})), declarations),
	},
	{
		name: 'indexeddb',
		make: (declarations) =>
			new IndexedDBStateStore(declarations, {databaseName: `stratagems-workload-${++databaseCounter}`}),
	},
	{
		name: 'patch',
		make: (declarations) => new PatchStateStore(declarations, {retention: 'revert-only'}),
	},
];
