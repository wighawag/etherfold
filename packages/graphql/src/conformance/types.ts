import type {EntityDeclaration, Mutation, StateStoreBackend} from '@etherfold/state-store';
import type {QueryExecutor, QueryRequest, QueryResult, TransportFailureReason} from '../executor.js';

/**
 * What the suite interrogates: a store it WRITES through (the ordinary store
 * seam, as a fold would), and the executor it QUERIES, answering from that same
 * storage.
 *
 * Handed over together because an executor answers about a store's rows and has
 * no write path of its own: the suite writes blocks with `store.applyBlock` (and
 * reverts them with `store.revertTo`) and asks the executor about them, which is
 * how an executor meets data in a deployment. The executor may be in process
 * (`localExecutor`), over HTTP, or over a worker port: the suite only calls it.
 */
export type QuerySubject = {
	readonly store: StateStoreBackend;
	readonly executor: QueryExecutor;
	/**
	 * The generation digest the executor reports in every answer's `extensions`
	 * (ADR-0099). The suite does not choose it (a server computes its own), so the
	 * subject names it and every expected answer carries it.
	 */
	readonly generation: string;
};

/**
 * How the suite gets a subject: hand it declarations, get a fresh store (a fresh
 * database per call, so no case can poison another) and an executor answering
 * from it. `migrate` is the suite's to call, as a caller's is.
 *
 * ```ts
 * const factory: QueryExecutorFactory = (declarations) => {
 *   const store = new VersionedStateStore(createTestDB(), declarations);
 *   const schema = buildQuerySchema(declarations);
 *   const executor = localExecutor(schema, {accessor: store.accessor(), generation, tip, asOf});
 *   return {store, executor, generation};
 * };
 * ```
 *
 * The store's capabilities must not vary between calls: the suite reads them
 * once, from a probe, and selects the as-of and retention cases the store has
 * CLAIMED, as `@etherfold/state-store-conformance` and the accessor suite do.
 */
export type QueryExecutorFactory = (declarations: readonly EntityDeclaration[]) => QuerySubject | Promise<QuerySubject>;

/** What an executor's deployment declares BEYOND a factory. */
export type QueryConformanceOptions = {
	/**
	 * The ROWS-EXAMINED bound the executor's accessor refuses past (ADR-0099), or
	 * absent for a deployment whose accessor declares none.
	 *
	 * The bound is a DOCUMENTED difference between deployments, not a parity
	 * rule, so the suite asks each executor what its deployment declared: one
	 * declaring a bound is asked to REFUSE, with the accessor's code
	 * (`rows-examined-bound`) naming the entity and the bound, each of the three
	 * queries a bounded browser accessor cannot serve (a scan past the bound, one
	 * parent's children past it, an as-of query whose delta is past it); one
	 * declaring none (SQLite, which has a query planner) is asked to ANSWER the
	 * same three, at a size past the browser's default bound, so "no bound" is a
	 * claim the suite checks rather than an omission.
	 *
	 * Declare the bound the executor's accessor was configured with; a small one
	 * keeps the cases cheap.
	 */
	readonly rowsExaminedBound?: number;
	/**
	 * How to BREAK this executor's transport, one entry per failure its transport
	 * can meet (`TransportFailureReason`): a function that, given a subject, makes
	 * its next request fail that way (stop the server, close the port, terminate
	 * the worker host). The suite then asks it a query and requires the ONE
	 * transport-failure shape the executor contract defines (ADR-0099): no `data`,
	 * no `extensions`, one error coded `transport-failure` naming that reason.
	 *
	 * An in-process executor has no transport and declares none.
	 */
	readonly transportFailures?: Partial<
		Readonly<Record<TransportFailureReason, (subject: QuerySubject) => void | Promise<void>>>
	>;
	/**
	 * The block every fresh subject's store was BOOTSTRAPPED to from a snapshot
	 * (ADR-0095): the snapshot's cut (`SnapshotHead.takenAt`), or absent for a
	 * store that starts empty.
	 *
	 * A bootstrapped store is never a store holding no block, since installing a
	 * snapshot applies its blocks, so the one case asked of a store with nothing
	 * written (`an empty store`) cannot be honest of it as written. Declared, that
	 * case is asked as what it means for such a store: a store holding no ROW answers
	 * every list empty, pinned to the block the snapshot left as its tip. Nothing
	 * else changes, and nothing is skipped.
	 *
	 * The snapshot must leave NO live row (its history may carry rows it later
	 * removes), and its cut must be below block 10, the lowest block any case
	 * writes, so every case's blocks land above it.
	 *
	 * The store's CLAIM is still read once from a probe, so it must not vary
	 * between calls: a bootstrapped store's narrowed window grows with its tip
	 * (`SnapshotAwareStateStore.capabilities`), so declare a store whose claim is
	 * stable (one keeping a window no wider than the history above its floor, for
	 * instance).
	 */
	readonly snapshotTakenAt?: number;
};

/**
 * One case of the shared list: the SAME request, against the same blocks, must
 * answer the same BYTES on every executor. `expected` takes the subject's
 * generation because every answer reports it.
 */
export type QueryParityCase = {
	/** The chapter this case belongs to, e.g. `nested relations`. */
	readonly group: string;
	/** What the case asserts, phrased as the behaviour a caller can rely on. */
	readonly name: string;
	/** Whether the case reads as of a block, so is asked only of a store that answers history. */
	readonly asOf?: boolean;
	/** The blocks applied (and reverted), in order, before the request. */
	readonly history: readonly HistoryStep[];
	readonly request: QueryRequest;
	readonly expected: (generation: string) => QueryResult;
};

/**
 * One step of a case's history: a block applied (its number, what it wrote,
 * and its hash where it is not the one `block(number)` gives, which is how a
 * replacement block after a reorg is a DIFFERENT block at the same height), or a
 * REORG (`store.revertTo`, keeping every block up to `revertTo`).
 */
export type HistoryStep =
	| {readonly block: number; readonly mutations: readonly Mutation[]; readonly hash?: string}
	| {readonly revertTo: number};

/** One case: a name, and a function that throws if the executor is wrong. */
export type QueryConformanceCase = {
	readonly group: string;
	readonly name: string;
	/** Runs the case against a fresh subject from the factory. Throws on failure. */
	run(): Promise<void>;
};

/** A case that did not hold, with the assertion error that says why. */
export type QueryConformanceFailure = {
	readonly group: string;
	readonly name: string;
	readonly error: unknown;
};

/** What a whole run came to. `failures` empty is what "conformant" means. */
export type QueryConformanceResult = {
	readonly passed: number;
	readonly failures: readonly QueryConformanceFailure[];
};
