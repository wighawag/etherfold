import {
	openGenerationRegistry,
	type GenerationCaps,
	type GenerationId,
	type GenerationRecord,
	type GenerationRegistry,
	type GenerationRegistryPort,
	type GenerationRegistryState,
	type GenerationRegistryWrite,
} from '@etherfold/core';
import {logs} from 'named-logs';
import type {RemoteSQL, SQLPreparedStatement} from 'remote-sql';
import {EMISSION_STREAM_TABLE} from './emissions.js';

const logger = logs('@etherfold/server');

// ---------------------------------------------------------------------------------------------------
// THE GENERATION REGISTRY, AS ROWS: WHAT THIS INDEXER HOLDS AND WHICH ONE ANSWERS
// ---------------------------------------------------------------------------------------------------
// A **generation** is a stream plus a fold over it, an indexer holds several,
// and ONE is canonical. The RULES -- registration, the caps that refuse, the
// deletion, the reaping and the pointer -- are `openGenerationRegistry`'s in
// `@etherfold/core`, over a five-operation PORT. This module is a SUBSTRATE for
// that port and nothing else: it supplies rows and inherits every rule.
//
// It is the third substrate, after the reference one in memory and the durable
// IndexedDB one in `@etherfold/browser`. What this runtime needs it for is what
// a browser tab can do without: a server or a CLI that comes back up must come
// back holding what it held and pointing where it last pointed, because the
// non-canonical generation it kept is what the pointer moves BACK to (ADR-0053,
// "a read tier must resolve the canonical pointer before it can name a state
// table", which is why these are rows and not memory).
//
// ## What is NOT here, deliberately
//
//  - **The CAPS.** They are an ARGUMENT of `openGenerationRegistry`, the port has
//    no cap operation, and there is no caps table and no caps column: the refusal
//    is the registry's rule applied to what this substrate read. Where the cap
//    VALUES come from on this runtime is the container's
//    (`a-changed-context-creates-a-successor-instead-of-clearing`), which is also
//    why `openGenerationRegistryOnSQL` DEFAULTS none: a server or a CLI should be
//    far more generous than a browser, and the number is a deployment's to state.
//  - **Where a generation's STATE lives.** `dropState` is injected by the host
//    (`a-generation-folds-into-its-own-tables` owns the per-generation table
//    namespace, ADR-0053) and defaults to doing nothing, exactly as the memory
//    port takes it, so the two tasks stay in different packages and this one
//    forks no naming convention it does not own.
// ---------------------------------------------------------------------------------------------------

/**
 * The registry's RECORDS: one row per generation this named indexer holds.
 *
 * In the reserved `_` namespace like every other FIXED table, and in the STATIC
 * schema file for the reason `_emissions` is: two application paths must produce
 * the same database and one of them is wrangler's D1 migration, which executes
 * `schema/sql/db.sql` and nothing else.
 */
export const GENERATION_TABLE = '_generations';

/**
 * The CANONICAL POINTER: one small row per named indexer, naming the generation
 * that answers reads -- and carrying the REVISION every commit is guarded on.
 *
 * The two live on one row because every commit already writes it: the pointer
 * move is one write and the guard is the same write, so atomicity costs no extra
 * row and no extra statement (ADR-0054). What ADR-0008 called `current_version`
 * becomes exactly this, keyed on the generation identity rather than on the
 * processor version hash alone.
 */
export const GENERATION_POINTER_TABLE = '_generation_pointer';

/**
 * What the guard compares against before this indexer's pointer row exists.
 *
 * A missing row and a row nobody has bumped must compare the SAME way, or the
 * very first commit could never pass its own guard. `COALESCE(..., '')` in the
 * SQL is the other half of this: a `NULL` from a missing row would make every
 * comparison `NULL` (never true), so the first writer would spin until it gave
 * up.
 */
const UNWRITTEN = '';

/**
 * How many times a losing commit re-reads and re-decides before it refuses.
 *
 * Losing costs one round trip and a re-decision, and a loser only loses to a
 * writer that WON, so a queue of writers drains rather than livelocking. The
 * bound exists so that a pathological case surfaces as a refusal naming the
 * contention instead of an unbounded loop against someone's database.
 */
const MAX_COMMIT_ATTEMPTS = 8;

/**
 * A commit that lost its guard too many times in a row.
 *
 * It is not a cap, not a rule and not a rejected decision: nothing was written,
 * the state is whatever the winners left, and the caller may simply try again.
 * It is REFUSED rather than retried forever because an unbounded retry against a
 * contended database is indistinguishable from a hang.
 */
export class GenerationCommitContentionError extends Error {
	readonly name = 'GenerationCommitContentionError';

	constructor(
		readonly indexer: string,
		readonly attempts: number,
	) {
		super(
			`the generation registry for the named indexer '${indexer}' lost its commit guard ${attempts} times in a ` +
				`row, so nothing was written. Each attempt re-read the records and re-decided from them, which is what ` +
				`keeps a cap honest under a second writer; this many losses means sustained contention rather than a ` +
				`race, so the write is refused rather than retried forever.`,
		);
	}
}

/** The `dropState` seam, and nothing else this substrate cannot derive. */
export type SQLGenerationRegistryOptions = {
	/**
	 * Drop the state store this generation folded into. Nothing, by default.
	 *
	 * Injected rather than derived: WHERE a generation's state lives is decided by
	 * the container above `StateStore` (ADR-0053 makes it a table-name namespace
	 * inside this same database), and a registry that invented that naming
	 * convention here would fork one the rest of the system does not share.
	 */
	dropState?: (id: GenerationId) => Promise<void>;
};

/** A generation record, as its row spells it. */
type GenerationRow = {stream: string; processor: string; createdAt: number};

/** The pointer row: the canonical identity (or nothing yet) plus the guard. */
type PointerRow = {stream: string | null; processor: string | null; revision: string};

/**
 * The five substrate operations, over one `RemoteSQL` handle and ONE named
 * indexer.
 *
 * The indexer name is carried as a COLUMN on every row, exactly as `_emissions`
 * carries it, even though ADR-0053 gives each named indexer a database of its own
 * and the column is therefore redundant on every shape this repo builds today. It
 * stays correct, it costs little, and it is what a future colocated deployment
 * (several named indexers in one D1 database) needs; a read that could omit the
 * discriminator is the failure mode ADR-0036 exists to make impossible.
 */
export function generationRegistryPortOnSQL(
	db: RemoteSQL,
	indexer: string,
	options?: SQLGenerationRegistryOptions,
): GenerationRegistryPort {
	return {
		async read() {
			return (await readGuarded(db, indexer)).state;
		},

		/**
		 * Read, DECIDE and write, so that the decision cannot be beaten by a second
		 * writer -- over a seam that cannot hold a transaction open across the
		 * decision.
		 *
		 * `RemoteSQL` is `prepare(sql)` plus `batch(statements)` and nothing else, and
		 * a batch is a PRE-BUILT list, so there is no way to read, run JS and write
		 * while still inside one transaction: the synchronous guarantee the memory and
		 * IndexedDB ports get for free does not carry over. What carries instead is a
		 * GUARD (ADR-0054). Every statement this commit writes is conditional on the
		 * revision the decision was made from, the last write swaps that revision for
		 * a fresh unique one, and a final `SELECT` inside the SAME batch reports which
		 * revision the row now holds. Ours means we won and every guarded statement
		 * applied; anything else means a second writer got there first, our whole
		 * batch applied to NOTHING, and we re-read, re-decide and try again.
		 *
		 * That is why the cap stays honest: a refusal is decided from the state the
		 * write actually landed on, never from a state that had moved on. A
		 * read-outside-then-write that merely LOOKS atomic is the failure mode here,
		 * and it is invisible afterwards -- three generations under a cap of two, with
		 * nothing able to say which write was the one too many.
		 */
		async commit(plan: (current: GenerationRegistryState) => GenerationRegistryWrite | undefined): Promise<void> {
			for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt++) {
				const {state, revision} = await readGuarded(db, indexer);
				// a THROW from here propagates with nothing written, which is what a cap
				// refusal is: a decision made on the state this attempt read
				const write = plan(state);
				if (!writesAnything(write)) {
					return;
				}

				const next = revisionToken();
				const results = await db.batch(statementsFor(db, indexer, write, revision, next));
				const applied = (results[results.length - 1]?.results[0] as {revision?: string} | undefined)?.revision;
				if (applied === next) {
					return;
				}
				logger.info(
					`a generation registry commit for '${indexer}' was beaten by another writer (attempt ${attempt} of ` +
						`${MAX_COMMIT_ATTEMPTS}): its statements were guarded on the revision it decided from, so NOTHING was ` +
						`written. Re-reading and deciding again.`,
				);
			}
			throw new GenerationCommitContentionError(indexer, MAX_COMMIT_ATTEMPTS);
		},

		/**
		 * Every stream that has rows under this indexer NAME, registered or not.
		 *
		 * The stored emission stream is where a stream physically lives on this
		 * runtime (ADR-0006, keyed on `(indexer, stream)`), so it is what the sweep
		 * compares the registry's knowledge against. The registry's own records are
		 * deliberately not consulted here: the whole point of the sweep is that the
		 * two can disagree, and a listing derived from the records could not express
		 * the case it exists for.
		 *
		 * Note what that means for a database written BEFORE this runtime held
		 * generations: its stored stream is claimed by no registered generation, so
		 * the first registry open sweeps it. That is the sweep working, not a bug --
		 * the cost is a re-fetch rather than a hole, and the registry's own rule is
		 * that a generation is created BEFORE anything writes its stream.
		 */
		async listStreamDigests() {
			const rows = await db
				.prepare(`SELECT DISTINCT stream FROM ${EMISSION_STREAM_TABLE} WHERE indexer = ?1 ORDER BY stream`)
				.bind(indexer)
				.all<{stream: string}>();
			return rows.results.map((row) => row.stream);
		},

		/**
		 * Delete one stream's whole subtree under this name, and report how many rows
		 * went.
		 *
		 * The count and the delete travel in ONE batch, so the number reported is the
		 * number deleted rather than a second opinion read either side of it --
		 * `remote-sql` reports no affected-row count, which is the same constraint
		 * pair-compaction works around by naming every row it deletes.
		 *
		 * Both statements carry BOTH discriminators. A delete that could omit one
		 * would cross into another named indexer's rows, which is exactly the isolation
		 * ADR-0036 makes structural.
		 */
		async dropStreamSubtree(digest) {
			const [counted] = await db.batch<{records: number}>([
				db
					.prepare(`SELECT COUNT(*) AS records FROM ${EMISSION_STREAM_TABLE} WHERE indexer = ?1 AND stream = ?2`)
					.bind(indexer, digest),
				db.prepare(`DELETE FROM ${EMISSION_STREAM_TABLE} WHERE indexer = ?1 AND stream = ?2`).bind(indexer, digest),
			]);
			return Number(counted?.results[0]?.records ?? 0);
		},

		async dropState(id) {
			await options?.dropState?.(id);
		},
	};
}

/**
 * Open the generation registry for one named indexer, over this database.
 *
 * Opening it SWEEPS every stored stream under this name that no registered
 * generation claims (`openGenerationRegistry`), which is how a subtree beyond the
 * reach of ordinary reaping -- one with no generation whose departure could fire
 * it -- is finally disposed of.
 *
 * The CAPS are required and have no default here. A browser has one
 * (`BROWSER_GENERATION_CAPS`, two of each, because a tab keeps the previous
 * generation only until the successor is promoted); a server or a CLI wants a far
 * more generous number, chosen by the deployment, and picking one on its behalf
 * in a substrate module is exactly the kind of invisible default an operator
 * would be surprised by.
 */
export function openGenerationRegistryOnSQL(
	db: RemoteSQL,
	indexer: string,
	options: SQLGenerationRegistryOptions & {caps: GenerationCaps},
): Promise<GenerationRegistry> {
	return openGenerationRegistry(generationRegistryPortOnSQL(db, indexer, options), options.caps);
}

/** Whether a planned write has anything in it that would reach the database. */
function writesAnything(write: GenerationRegistryWrite | undefined): write is GenerationRegistryWrite {
	return !!write && ((write.remove?.length ?? 0) > 0 || !!write.put || !!write.canonical);
}

/**
 * The records and the pointer, plus the REVISION they were read at, in ONE
 * batch.
 *
 * One batch is one transaction, so the three answers are one consistent read: a
 * commit decided from records and a pointer that came from either side of
 * somebody else's write would be deciding about a state that never existed.
 */
async function readGuarded(
	db: RemoteSQL,
	indexer: string,
): Promise<{state: GenerationRegistryState; revision: string}> {
	const [records, pointer] = await db.batch([
		db.prepare(`SELECT stream, processor, createdAt FROM ${GENERATION_TABLE} WHERE indexer = ?1`).bind(indexer),
		db.prepare(`SELECT stream, processor, revision FROM ${GENERATION_POINTER_TABLE} WHERE indexer = ?1`).bind(indexer),
	]);

	const generations = ((records?.results ?? []) as GenerationRow[]).map(
		(row): GenerationRecord => ({stream: row.stream, processor: row.processor, createdAt: Number(row.createdAt)}),
	);
	const row = (pointer?.results ?? [])[0] as PointerRow | undefined;
	const canonical =
		row && row.stream !== null && row.processor !== null ? {stream: row.stream, processor: row.processor} : undefined;
	return {state: {generations, canonical}, revision: row?.revision ?? UNWRITTEN};
}

/**
 * The one batch a commit sends: every write GUARDED on the revision it was
 * decided from, then the revision swap, then the report.
 *
 * The order is load-bearing. Each guarded statement reads the revision as it
 * stands when it runs, so the swap has to come AFTER them or it would invalidate
 * the very guards it is meant to close, and the report has to come after the
 * swap, because what it reports is whether the swap took.
 */
function statementsFor(
	db: RemoteSQL,
	indexer: string,
	write: GenerationRegistryWrite,
	revision: string,
	next: string,
): SQLPreparedStatement[] {
	const guard = `COALESCE((SELECT revision FROM ${GENERATION_POINTER_TABLE} WHERE indexer = ?1), '')`;
	const statements: SQLPreparedStatement[] = [];

	// `remove` runs before `put`, as the registry's write contract says
	for (const id of write.remove ?? []) {
		statements.push(
			db
				.prepare(
					`DELETE FROM ${GENERATION_TABLE}
					 WHERE indexer = ?1 AND stream = ?2 AND processor = ?3 AND ${guard} = ?4`,
				)
				.bind(indexer, id.stream, id.processor, revision),
		);
	}

	if (write.put) {
		statements.push(
			db
				.prepare(
					`INSERT INTO ${GENERATION_TABLE} (indexer, stream, processor, createdAt)
					 SELECT ?1, ?2, ?3, ?4 WHERE ${guard} = ?5
					 ON CONFLICT (indexer, stream, processor) DO UPDATE SET createdAt = excluded.createdAt`,
				)
				.bind(indexer, write.put.stream, write.put.processor, write.put.createdAt, revision),
		);
	}

	/**
	 * The pointer row, the revision swap and the guard, in ONE statement.
	 *
	 * An ABSENT `canonical` means LEAVE IT WHERE IT IS rather than clear it -- a
	 * registry holding generations and pointing at none of them answers nothing --
	 * so the identity is bound as `NULL` and `COALESCE` keeps whatever the row
	 * already said. On a first commit there is no row at all and the plain insert
	 * takes it, which is the only case the `WHERE` on the upsert cannot cover.
	 */
	statements.push(
		db
			.prepare(
				`INSERT INTO ${GENERATION_POINTER_TABLE} (indexer, stream, processor, revision)
				 VALUES (?1, ?2, ?3, ?4)
				 ON CONFLICT (indexer) DO UPDATE SET
					stream = COALESCE(excluded.stream, ${GENERATION_POINTER_TABLE}.stream),
					processor = COALESCE(excluded.processor, ${GENERATION_POINTER_TABLE}.processor),
					revision = excluded.revision
				 WHERE ${GENERATION_POINTER_TABLE}.revision = ?5`,
			)
			.bind(indexer, write.canonical?.stream ?? null, write.canonical?.processor ?? null, next, revision),
	);

	statements.push(db.prepare(`SELECT revision FROM ${GENERATION_POINTER_TABLE} WHERE indexer = ?1`).bind(indexer));
	return statements;
}

/**
 * A revision nobody else can produce.
 *
 * It is a TOKEN and deliberately not a counter, because the report a commit
 * reads back is the only evidence it has: under a counter a loser would read
 * `expected + 1` -- the winner's value, and the very number the loser was about
 * to write -- and could not tell a win from a loss. A value only this attempt
 * could have written makes the two distinguishable with one `SELECT`.
 *
 * `crypto.randomUUID` is present on Node, Workers and browsers; the fallback is
 * for a host that predates it, and it is time plus two independent random draws
 * rather than one, so it stays unguessable enough for a value whose only job is
 * to be unique among concurrent writers.
 */
function revisionToken(): string {
	const uuid = globalThis.crypto?.randomUUID?.();
	return (
		uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
	);
}
