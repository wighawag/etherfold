import type {EntityDeclaration, RetentionSetting, StateStore} from '@etherfold/state-store';
import {IndexedDBStateStore} from '@etherfold/state-store-indexeddb';

/**
 * Build the `StateStore` a browser deployment keeps its entity state in.
 *
 * This is where an application developer CHOOSES a storage backend for the
 * browser, and the choice is a line of configuration rather than a change to any
 * processor: the processor is entity declarations plus `on<EventName>` handlers
 * over a `MutationContext`, and it names no backend at all.
 *
 * ```ts
 * // the default: versioned rows in IndexedDB (ADR-0024)
 * const createState = () => createBrowserStateStore(processor.entities);
 *
 * // the same app on the light store instead: nothing else changes
 * const createState = () =>
 *   createBrowserStateStore(processor.entities, {
 *     backend: (entities) => new PatchStateStore(entities, {retention: 'revert-only', finalityDepth: 64}),
 *   });
 *
 * // ...and either one indexes through the hook, with the processor untouched.
 * // It is the FACTORY the hook takes, not the store: each GENERATION folds into
 * // its own state, so the hook is what calls this, once per generation.
 * const indexer = createIndexerState({
 *   createState,
 *   createProcessor: (store) => fromEntityProcessor(processor)(store),
 * });
 * ```
 *
 * ## Does a RELOAD keep it? Ask the store, at startup
 *
 * This is the question that is specific to a browser, and the answer is a
 * property of the backend rather than of this function. A server restarts into
 * the database it left; a tab is CLOSED, and what it finds when it opens again
 * decides whether it resumes or indexes the chain a second time.
 *
 * The sync cursor lives BEHIND this seam (ADR-0027), written in the same
 * transaction as the block it describes, so it survives exactly as far as the
 * store does. On the IndexedDB default that is across reloads: the tab picks up
 * from its cursor. `@etherfold/state-store-patch` is memory-only by design
 * (ADR-0023) and reports `durability: 'memory-only'` in its capabilities, so a
 * reload there starts over -- correctly, and knowably in advance rather than
 * from an empty tab:
 *
 * ```ts
 * if ((store.capabilities as {durability?: string}).durability === 'memory-only') {
 *   // this app will re-index on every reload; decide whether that is acceptable
 * }
 * ```
 *
 * `durability` is not at the seam because every other backend answers it by
 * existing on disk; it is on the report of the one backend for which the answer
 * is interesting. See `PatchStateStoreCapabilities`.
 *
 * ## Starting from a published snapshot instead of replaying the chain
 *
 * A tab does not have to index from the start block. `@etherfold/processor-entities`
 * can install state another indexer already computed -- several published
 * locations, the most advanced one wins, local state kept when local is already
 * ahead, an unreachable mirror skipped:
 *
 * ```ts
 * const {store} = await openAndBootstrap(
 *   await createBrowserStateStore(processor.entities),
 *   ['https://mirror-a.example/state.json', 'https://mirror-b.example/state.json'],
 *   {processor: eventProcessor.getVersionHash(), finalityDepth: 64},
 * );
 * ```
 *
 * **Open it through `openSnapshotAware` on EVERY boot, not only the one that
 * installs a snapshot** (`openAndBootstrap` above does it for you). A snapshot
 * carries no history below the block it was taken at, so a bootstrapped store
 * must report a floor there and refuse as-of reads below it; the floor is
 * persisted, and a handle constructed without reading it back would go on
 * claiming the history of a store that has been indexing since genesis. See
 * ADR-0028.
 *
 * ## Why IndexedDB is the default
 *
 * Measured rather than preferred, on the real workload, and recorded as a
 * CONDITION in **ADR-0024**: what would have to be true for wasm SQLite to win,
 * and what would overturn the answer. The short of it is that IndexedDB beat
 * wasm SQLite on writes by 1.6x to 6.9x and on reads by 4x to 14x on every
 * engine that can run both, that WebKit cannot run the SQLite route at all, and
 * that three of four tabs fail AT OPEN on both SQLite VFSs.
 *
 * ## What it replaced, and what that cost
 *
 * There used to be a second way to write a browser deployment's state to
 * IndexedDB: `keepStateOnIndexedDB`, a `KeepState` keeper that serialised the
 * WHOLE state object of a `JSObjectEventProcessor` on every save. It was the
 * fastest writer at today's sizes (2.0 ms/block on Chromium) precisely because
 * it kept no history, could not answer an as-of read and could not revert. It is
 * deleted with the free-form processor path (ADR-0037). This builds a
 * `StateStore`: the state IS versioned rows, so a write costs what CHANGED, a
 * reload reads only what it asks for, a reorg is a revert, and history is
 * readable to the declared retention.
 */
export type BrowserStateStoreFactory = (declarations: readonly EntityDeclaration[]) => StateStore | Promise<StateStore>;

/**
 * What a browser deployment says about where its state lives.
 *
 * The two arms are deliberately exclusive: the options below configure the
 * DEFAULT backend, and a store a host builds itself has already been configured
 * by the host. An option that silently did nothing would be worse than a type
 * error.
 */
export type BrowserStateStoreConfig =
	| {
			/** Versioned rows in IndexedDB. The default, and what ADR-0024 decided. */
			backend?: 'indexeddb';
			/**
			 * The IndexedDB database to keep this state in. Defaults to
			 * `etherfold-state`.
			 *
			 * It is the IDENTITY of the state: several tabs of one app share it (which
			 * is the point), and two unrelated indexers in one origin must not.
			 */
			databaseName?: string;
			/**
			 * How far back superseded versions are kept, in BLOCK NUMBERS. Defaults to
			 * `unbounded`.
			 *
			 * A window is `{blocks: N}` and needs `finalityDepth` beside it, since a
			 * window below the depth a reorg can reach would prune the versions the
			 * revert itself needs. Note the trap recorded in ADR-0019: N BLOCKS is not
			 * N updates of history -- on the real measured stream, event-bearing blocks
			 * are median 429 blocks apart.
			 *
			 * **What is set here is also what is RECLAIMED**, and a caller has nothing
			 * further to schedule: `createIndexerState`'s cycle prunes the state of
			 * every generation it holds, so a store that states a FLOOR physically
			 * drops the versions below it instead of only refusing to answer about
			 * them. A floor is what `{blocks: N}` states and what `revert-only` states
			 * ALONGSIDE a `finalityDepth` (that kind keeps superseded versions exactly
			 * as long as reorg revert needs them, and the depth is how long that is);
			 * `unbounded`, and `revert-only` with no depth, state none and nothing is
			 * ever dropped.
			 */
			retention?: RetentionSetting;
			/** The reorg depth this deployment protects against, in block numbers. */
			finalityDepth?: number;
	  }
	| {
			/**
			 * Any other backend: a function from the processor's declarations to a
			 * store.
			 *
			 * This is the whole of "choosing another backend is a configuration
			 * change": `@etherfold/state-store-patch` for a tab that only needs current
			 * state and reorg safety, `MemoryStateStore` in a test, or something a host
			 * wrote itself. What it may not be is a backend this package has to know
			 * about, which is what keeps the browser package from importing every store
			 * that exists.
			 */
			backend: BrowserStateStoreFactory;
	  };

/**
 * The store, migrated and ready.
 *
 * `migrate` is called here (it is idempotent everywhere) so that a host gets
 * something it can read from, rather than a store that throws on first use for a
 * reason it has to learn.
 */
export async function createBrowserStateStore(
	declarations: readonly EntityDeclaration[],
	config: BrowserStateStoreConfig = {},
): Promise<StateStore> {
	const store =
		typeof config.backend === 'function'
			? await config.backend(declarations)
			: new IndexedDBStateStore(declarations, {
					databaseName: config.databaseName,
					retention: config.retention,
					finalityDepth: config.finalityDepth,
				});
	await store.migrate();
	return store;
}
