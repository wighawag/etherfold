import {RemoteD1} from 'remote-sql-d1';
import type {RemoteSQL} from 'remote-sql';
import {
	DEFAULT_BATCH_BOUNDS,
	VersionedStateStore,
	type BatchBounds,
	type EntityDeclaration,
	type VersionedStateStoreOptions,
} from '@etherfold/state-store-sqlite';
import type {CloudflareEnv} from './env.js';

/**
 * D1's per-request limits, and the only place in this repo they may be named in
 * shipped code.
 *
 * `@etherfold/state-store-sqlite` targets the `remote-sql` interface, so a
 * hosted backend is one backend among several and never the target; its
 * `test/no-platform-leakage.test.ts` asserts that no source file there matches
 * `/\bD1\b/`. A HOST is the one place allowed to name its own backend, which is
 * why these numbers live here and why they are CONFIGURATION reaching the
 * store's `BatchBounds` rather than constants inside it.
 *
 * The numbers below are the DOCUMENTED ones, not measurements and not taste:
 * https://developers.cloudflare.com/d1/platform/limits/ ("Last updated Apr 21,
 * 2026"), retrieved 2026-09-01 and re-verified unchanged 2026-09-02. They are
 * per-plan and Cloudflare revises them, so
 * `work/notes/findings/d1-caps-bound-parameters-per-query-at-100.md` carries the
 * dated source and the reasoning; re-fetch it before relying on it.
 */

/** Which Cloudflare plan a deployment's Worker and D1 run on. */
export type D1Plan = 'free' | 'paid';

/** The documented D1 limits a store's batch bounds are derived from. */
export type D1Limits = {
	/**
	 * Queries ONE Worker invocation may issue against D1.
	 *
	 * Cloudflare's documentation does not settle whether a `batch()` of N
	 * statements counts as N queries or as one subrequest, so everything here
	 * takes the pessimistic reading: N.
	 */
	queriesPerInvocation: number;
	/** Bound parameters ONE query may carry. Not a per-plan number. */
	boundParametersPerQuery: number;
};

export const D1_LIMITS: Record<D1Plan, D1Limits> = {
	free: {queriesPerInvocation: 50, boundParametersPerQuery: 100},
	paid: {queriesPerInvocation: 1_000, boundParametersPerQuery: 100},
};

/**
 * What a deployment that states nothing gets: the TIGHTER of the two plans.
 *
 * An under-configured deployment then works and is slow, rather than working in
 * staging and being rejected by D1 in production.
 */
export const DEFAULT_D1_PLAN: D1Plan = 'free';

/** The queries one prune ROUND costs: one SELECT of row ids, one DELETE naming them. */
const QUERIES_PER_PRUNE_ROUND = 2;

/**
 * The plan this deployment says it is on, from the `D1_PLAN` var in
 * `wrangler.toml` (or a secret, or `wrangler deploy --var`).
 *
 * Stated by CONFIGURATION and never inferred: nothing on the request tells a
 * Worker which plan it is running under, and the two caps differ by 20x, so
 * guessing high breaks a Free deployment in production while guessing low costs
 * a Paid one 20x the round trips. An unknown value is refused rather than
 * silently read as the default, because a typo in a deployment variable is
 * exactly the case where the quiet fallback hides the mistake.
 */
export function resolveD1Plan(env: {D1_PLAN?: string}): D1Plan {
	const stated = env.D1_PLAN;
	if (stated === undefined || stated === '') return DEFAULT_D1_PLAN;
	if (stated === 'free' || stated === 'paid') return stated;
	throw new Error(`D1_PLAN must be 'free' or 'paid', got '${stated}'`);
}

/**
 * D1's limits, as the store's per-request bounds.
 *
 * Two of the three come straight from the documented caps:
 *
 * - `maxRowsPerStatement` is the CORRECTNESS one. Each row id a prune names is
 *   one bound parameter and `dropVersionsStatement` carries no other, so this is
 *   D1's parameter cap exactly. It is the same on both plans.
 * - `maxStatementsPerBatch` is the THROUGHPUT one, and it is where a Paid
 *   deployment stops paying the Free tier's price: 1,000 against 50. Under the
 *   pessimistic reading above, a batch this size spends a whole invocation's
 *   query budget, which is fine for a batch that IS the invocation's work and is
 *   the reason `d1PruneBudget` exists for the work that is not.
 *
 * `maxBytesPerBatch` is deliberately NOT derived from a D1 number and keeps the
 * store's own conservative default: D1's 100 KB cap is per STATEMENT while this
 * bound is per BATCH, so deriving one from the other would be a coincidence
 * dressed as a rule.
 */
export function d1BatchBounds(plan: D1Plan): BatchBounds {
	const limits = D1_LIMITS[plan];
	return {
		maxStatementsPerBatch: limits.queriesPerInvocation,
		maxRowsPerStatement: limits.boundParametersPerQuery,
		maxBytesPerBatch: DEFAULT_BATCH_BOUNDS.maxBytesPerBatch,
	};
}

/**
 * How many versions one invocation may ask `prune` to drop on this plan, as its
 * `maxVersions`.
 *
 * This is the per-INVOCATION half, which no batch bound can address: D1's query
 * cap is per Worker invocation, and a prune is a LOOP of small requests, so the
 * thing that keeps it inside the cap is its budget (ADR-0022 makes `prune` an
 * explicit host-scheduled call for exactly this kind of reason). A prune costs
 * two queries per round plus a tip read, and one round drops at most
 * `maxRowsPerStatement` versions.
 *
 * Half the plan's queries are RESERVED by default, for the rest of whatever the
 * invocation is doing (an ingest reads a cursor and writes blocks before it ever
 * prunes) and for the tip read and completeness probe the prune itself adds. A
 * deployment whose scheduled invocation does nothing else can pass a smaller
 * `reservedQueries` and prune more per call.
 */
export function d1PruneBudget(plan: D1Plan, options: {reservedQueries?: number} = {}): number {
	const limits = D1_LIMITS[plan];
	const reserved = options.reservedQueries ?? Math.floor(limits.queriesPerInvocation / 2);
	const rounds = Math.floor((limits.queriesPerInvocation - reserved) / QUERIES_PER_PRUNE_ROUND);
	return Math.max(1, rounds) * limits.boundParametersPerQuery;
}

/**
 * The `RemoteSQL` a Worker host uses, from the D1 binding on the per-request
 * `env`. Exposed so tests and a deployment's own wiring share one construction,
 * exactly as `createNodeDB` is in `@etherfold/platform-nodejs`.
 */
export function createD1DB(env: Pick<CloudflareEnv, 'DB'>): RemoteSQL {
	return new RemoteD1(env.DB as never);
}

/** Everything a store takes here except its bounds, which the PLAN decides. */
export type D1StoreOptions = Omit<VersionedStateStoreOptions, 'bounds'> & {
	/** Stated, never guessed. `resolveD1Plan(env)` is where a deployment's answer comes from. */
	plan: D1Plan;
};

/**
 * A versioned-row store on D1, bounded by what THIS deployment's plan allows.
 *
 * The store is handed a `RemoteSQL` rather than the binding so that one handle
 * can serve both this store and `@etherfold/server`'s `getDB` (and so a test can
 * wrap it). A deployment that hosts a processor builds its ingestion around this:
 *
 * ```ts
 * const db = createD1DB(env);
 * const store = createD1Store(db, processor.entities, {plan: resolveD1Plan(env), retention});
 * const ingestion = new StreamBuilder(new EntityEventProcessor(store, processor), source, {
 * 	stream,
 * 	// the host owns the store, so the host stores the stream the fold produces,
 * 	// under the name it registers that ingestion by (ADR-0052)
 * 	appendEmissions: emissionAppenderFor(db, 'alpha'),
 * });
 * createServer({getDB: () => db, getEnv: (c) => c.env, getIndexer: indexerRegistry({alpha: ingestion})});
 * ```
 *
 * and schedules its pruning separately with
 * `store.prune({maxVersions: d1PruneBudget(plan)})`, because a prune is never a
 * side effect of a write (ADR-0022).
 */
export function createD1Store(
	db: RemoteSQL,
	declarations: Iterable<EntityDeclaration>,
	options: D1StoreOptions,
): VersionedStateStore {
	const {plan, ...storeOptions} = options;
	return new VersionedStateStore(db, declarations, {...storeOptions, bounds: d1BatchBounds(plan)});
}
