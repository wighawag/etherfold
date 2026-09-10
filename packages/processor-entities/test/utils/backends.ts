import 'fake-indexeddb/auto';
import {createClient} from '@libsql/client';
import {
	MemoryStateStore,
	openForWriting,
	type EntityDeclaration,
	type WritableStateStore,
} from '@etherfold/state-store';
import {IndexedDBStateStore} from '@etherfold/state-store-indexeddb';
import {PatchStateStore} from '@etherfold/state-store-patch';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import {RemoteLibSQL} from 'remote-sql-libsql';

/**
 * The four shipped backends, each with a way to REOPEN the same state.
 *
 * `reopen` is what makes "the cursor survives a reload" assertable rather than
 * asserted-to. It has to mean, per backend, whatever a restart actually is:
 *
 * - **sqlite**: a NEW `VersionedStateStore` over the same `RemoteSQL` handle, which
 *   is what a server process does when it comes back up against its database.
 * - **indexeddb**: a new store over the same DATABASE NAME, which is what a tab
 *   does on reload (the name is the identity of the state; see
 *   `IndexedDBStateStoreOptions.databaseName`).
 * - **memory** and **patch**: the SAME instance, because neither of them survives
 *   the process and both say so -- the patch store reports
 *   `durability: 'memory-only'` for exactly this reason (ADR-0023). What a
 *   restart means for them is a fresh processor over state that is still there,
 *   which is the half of the round trip they CAN honour, and pretending
 *   otherwise would be testing a claim they do not make.
 *
 * `fake-indexeddb/auto` is imported here rather than in each test, at the top,
 * because it installs the global factory and must be in place before a store
 * opens anything.
 */
export type Backend = {
	readonly name: string;
	/**
	 * A store over storage nothing else is using, CLAIMED.
	 *
	 * Claimed here rather than at every call site because these cases fold, and
	 * folding is writing: the ability to mutate is obtained by claiming (ADR-0077),
	 * so what a test that indexes wants handed to it is the writable handle.
	 * `openForWriting` migrates on the way.
	 */
	open(declarations: readonly EntityDeclaration[]): Promise<WritableStateStore>;
	/** Another store over the SAME storage, claimed in its turn: what a restart sees. */
	reopen(previous: WritableStateStore, declarations: readonly EntityDeclaration[]): Promise<WritableStateStore>;
	/** Whether this backend's storage outlives the store object that wrote it. */
	readonly durable: boolean;
};

let databaseCounter = 0;

/** The libSQL handle each sqlite store was opened over, so `reopen` finds it again. */
const handles = new WeakMap<WritableStateStore, RemoteLibSQL>();
/**
 * The IndexedDB database each store was opened on, and the CONNECTION under the
 * claim, for the same reason: a claimed handle delegates the seam and nothing
 * else, so `close()` has to be reached on the store itself.
 */
const databases = new WeakMap<WritableStateStore, {name: string; connection: IndexedDBStateStore}>();

export const BACKENDS: readonly Backend[] = [
	{
		name: 'memory',
		durable: false,
		open: async (declarations) => openForWriting(new MemoryStateStore(declarations)),
		reopen: async (previous) => previous,
	},
	{
		name: 'sqlite',
		durable: true,
		open: async (declarations) => {
			const db = new RemoteLibSQL(createClient({url: ':memory:'}));
			const store = await openForWriting(new VersionedStateStore(db, declarations));
			handles.set(store, db);
			return store;
		},
		reopen: async (previous, declarations) => {
			const db = handles.get(previous) as RemoteLibSQL;
			const store = await openForWriting(new VersionedStateStore(db, declarations));
			handles.set(store, db);
			return store;
		},
	},
	{
		name: 'indexeddb',
		durable: true,
		open: async (declarations) => {
			const databaseName = `entity-event-processor-${++databaseCounter}`;
			const connection = new IndexedDBStateStore(declarations, {databaseName});
			const store = await openForWriting(connection);
			databases.set(store, {name: databaseName, connection});
			return store;
		},
		reopen: async (previous, declarations) => {
			const opened = databases.get(previous) as {name: string; connection: IndexedDBStateStore};
			// the tab closes before it reopens: a browser cannot hold two connections
			// through a version change, and a test that leaves one open blocks the next.
			await opened.connection.close();
			const connection = new IndexedDBStateStore(declarations, {databaseName: opened.name});
			const store = await openForWriting(connection);
			databases.set(store, {name: opened.name, connection});
			return store;
		},
	},
	{
		name: 'patch',
		durable: false,
		open: async (declarations) => openForWriting(new PatchStateStore(declarations, {retention: 'revert-only'})),
		reopen: async (previous) => previous,
	},
];
