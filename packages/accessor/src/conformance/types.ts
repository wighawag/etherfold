import type {EntityDeclaration, StateStoreBackend} from '@etherfold/state-store';
import type {Accessor} from '../types.js';

/**
 * What the suite interrogates: a store it WRITES through (the ordinary store
 * seam, as a fold would), and the accessor it READS through, over that same
 * storage.
 *
 * The two are handed over together because an accessor answers about a store's
 * rows and has no write path of its own: the suite writes blocks with
 * `store.applyBlock` and asks the accessor about them, which is exactly how an
 * accessor meets data in a deployment.
 */
export type AccessorSubject = {
	readonly store: StateStoreBackend;
	readonly accessor: Accessor;
};

/**
 * How the suite gets a subject: hand it declarations, get a fresh store (a
 * fresh database per call, so no case can poison another) and an accessor over
 * it. `migrate` is the suite's to call, as a caller's is.
 *
 * ```ts
 * const factory: AccessorFactory = (declarations) => {
 *   const store = new VersionedStateStore(createTestDB(), declarations);
 *   return {store, accessor: store.accessor()};
 * };
 * ```
 *
 * The store's capabilities must not vary between calls: the suite reads them
 * once, from a probe, and selects the as-of cases the store has CLAIMED.
 */
export type AccessorFactory = (
	declarations: readonly EntityDeclaration[],
) => AccessorSubject | Promise<AccessorSubject>;

/**
 * What a backend declares BEYOND a factory.
 */
export type AccessorConformanceOptions = {
	/**
	 * The ROWS-EXAMINED bound this accessor refuses past (ADR-0099), or absent
	 * for a backend that declares none.
	 *
	 * The bound is a DOCUMENTED difference between deployments, not a parity
	 * rule, so the suite asks each backend what it declared: a backend declaring a
	 * bound is asked to answer a query examining that many rows and to refuse one
	 * examining more, with `RowsExaminedBoundError` naming the bound; a backend
	 * declaring none (SQLite, which has a query planner) is asked to ANSWER a query
	 * examining more rows than the browser's default bound, so "no bound" is a
	 * claim the suite checks rather than an omission.
	 *
	 * Declare the bound the factory's accessor was configured with; a small one
	 * keeps the case cheap.
	 */
	readonly rowsExaminedBound?: number;
};

/** One case: a name, and a function that throws if the backend is wrong. */
export type AccessorConformanceCase = {
	/** The chapter this case belongs to, e.g. `every operator`. */
	readonly group: string;
	/** What the case asserts, phrased as the behaviour a caller can rely on. */
	readonly name: string;
	/** Runs the case against a fresh subject from the factory. Throws on failure. */
	run(): Promise<void>;
};

/** A case that did not hold, with the assertion error that says why. */
export type AccessorConformanceFailure = {
	readonly group: string;
	readonly name: string;
	readonly error: unknown;
};

/** What a whole run came to. `failures` empty is what "conformant" means. */
export type AccessorConformanceResult = {
	readonly passed: number;
	readonly failures: readonly AccessorConformanceFailure[];
};
