import type {EntityDeclaration, StateStore} from '@etherfold/state-store';

/**
 * How the suite gets a store to interrogate: hand it declarations, get a store.
 *
 * This is the whole of what adding a backend costs. The factory is called once
 * per case with the suite's own declarations, so every case starts from an empty
 * store and no case can be poisoned by another; `migrate` is the suite's to
 * call, since a caller has to call it too.
 *
 * A factory that closes over a fresh database per call is the intended shape:
 *
 * ```ts
 * const factory: StateStoreFactory = (declarations) =>
 *   new VersionedStateStore(new RemoteLibSQL(createClient({url: ':memory:'})), declarations);
 * ```
 *
 * What a factory must NOT do is vary its capabilities between calls: the suite
 * reads the report once, from a probe store, and selects the cases the backend
 * has CLAIMED it can pass.
 */
export type StateStoreFactory = (declarations: readonly EntityDeclaration[]) => StateStore | Promise<StateStore>;

/** Two handles the suite may write through, in the order they are handed over. */
export type StorePair = readonly [StateStore, StateStore];

/**
 * How the suite gets TWO handles at once, which is the one thing
 * `StateStoreFactory` cannot express.
 *
 * That factory is documented as a fresh database per call, and it has to stay
 * that way or every case could be poisoned by the last one. So a backend that
 * can SHARE storage says so here instead, and the contention cases are written
 * against these two shapes rather than against a factory that would have to
 * break its own promise.
 *
 * Neither function migrates: the suite calls `migrate` on both handles, exactly
 * as two tabs of one app would, which is also how it checks that opening a
 * store does not claim it.
 */
export type TwoWriters = {
	/**
	 * Two handles on ONE storage identity: the same `databaseName`, the same
	 * database and table namespace. What two tabs of one app have, and what a
	 * misconfigured pair of generations has.
	 */
	sharingStorage(declarations: readonly EntityDeclaration[]): StorePair | Promise<StorePair>;
	/**
	 * Two handles ADDRESSED APART: the CLOSEST two separate storage identities
	 * this substrate has, which is a second `databaseName` on IndexedDB and a
	 * second table namespace in ONE database on SQL.
	 *
	 * It is not the same question as calling the factory twice, and on the SQL
	 * backend it is not even the same storage: two generations of one indexer
	 * share a database and are separated by ADR-0053's namespace, so this is the
	 * do-not-over-refuse case at the granularity the design actually requires.
	 */
	addressedApart(declarations: readonly EntityDeclaration[]): StorePair | Promise<StorePair>;
};

/**
 * What a backend can tell the suite BEYOND a factory.
 *
 * Everything here is optional, and everything here exists because a property is
 * not expressible through one handle on a fresh store. A backend that offers
 * none is asked every case that one handle can answer.
 */
export type StateStoreConformanceOptions = {
	/**
	 * How to open two writers, for the contention cases.
	 *
	 * REQUIRED of a backend whose capability report claims `singleWriter`: the
	 * cases are selected on the CLAIM, so a backend that claims the guarantee and
	 * hands the suite no way to contend for it fails a case saying so, rather than
	 * silently skipping the only cases that could have caught a fiction. A backend
	 * that honestly reports `singleWriter: false` omits it.
	 */
	readonly twoWriters?: TwoWriters;
};

/**
 * One conformance case: a name, and a function that throws if the backend is wrong.
 *
 * The cases are data rather than registered tests, which is what lets the suite
 * be run in two ways that both matter. A backend's test file turns each case
 * into a vitest `it` (`describeStateStoreConformance`), so a failure is reported
 * as itself. The suite's own tests RUN the cases against deliberately broken
 * backends and assert on which ones failed
 * (`runStateStoreConformance`), which is the only way to
 * prove the capability cases are not decoration.
 */
export type ConformanceCase = {
	/** The chapter this case belongs to, e.g. `reorg revert`. */
	readonly group: string;
	/** What the case asserts, phrased as the behaviour a caller can rely on. */
	readonly name: string;
	/** Runs the case against a fresh store from the factory. Throws on failure. */
	run(): Promise<void>;
};

/** A case that did not hold, with the assertion error that says why. */
export type ConformanceFailure = {
	readonly group: string;
	readonly name: string;
	readonly error: unknown;
};

/** What a whole run came to. `failures` empty is what "conformant" means. */
export type ConformanceResult = {
	readonly passed: number;
	readonly failures: readonly ConformanceFailure[];
};
