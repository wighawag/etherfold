import {logs} from 'named-logs';
import type {RemoteSQL, SQLPreparedStatement, SQLResult} from 'remote-sql';
import {DEFAULT_BATCH_BOUNDS, planBatches, type BatchBounds} from './batching.js';
import {
	NoSuchBlockError,
	parseBlockAddress,
	type BlockAddress,
	type ParsedBlockAddress,
	type RecordedBlock,
} from './blocks.js';
import {
	assertRetained,
	blockNotAboveTip,
	boundedListing,
	mustGet,
	normalizeEntities,
	pruneBudget,
	pruneRecord,
	resolveRetention,
	retentionEnforcementOf,
	retentionFloor,
	RETENTION_ENFORCEMENT_KEY,
	StoreWriterChangedError,
	writerToken,
	type EntityIdPrefix,
	type Listing,
	type PruneOptions,
	type PruneReport,
	type Retention,
	type RetentionEnforcement,
	type RetentionOptions,
	type RetentionSetting,
	type StateStoreBackend,
	type StateStoreCapabilities,
	type CursorWrite,
} from '@etherfold/state-store';
import {ROWID, dropSchemaStatements, migrationStatements, tableNames, type TableNames} from './ddl.js';
import {assertStorableEntityNames} from './identifiers.js';
import {
	AS_OF_PREDICATE,
	CURRENT_PREDICATE,
	applyBlockStatements,
	blockAtOrBeforeStatement,
	blockByHashStatement,
	blockByNumberStatement,
	claimWriterStatement,
	clearCursorStatement,
	dropVersionsStatement,
	heldWriterStatement,
	idPredicate,
	idValues,
	latestBlockStatement,
	listAsOfStatement,
	listCurrentStatement,
	prunableVersionsStatement,
	readCursorStatement,
	releaseWriterStatement,
	revertToStatements,
	writeCursorStatement,
	writerGuard,
	writerTableExistsStatement,
	type WriterGuard,
} from './statements.js';
import type {
	BlockPointer,
	BlockUpdate,
	EntityDeclaration,
	EntityId,
	Mutation,
	NormalizedEntity,
	Statement,
} from './types.js';

const logger = logs('@etherfold/state-store-sqlite');

export type VersionedStateStoreOptions = RetentionOptions & {
	/** Per-request limits of the backend. See `DEFAULT_BATCH_BOUNDS`. */
	bounds?: Partial<BatchBounds>;
	/**
	 * The TABLE-NAME NAMESPACE this store's tables live in, so that several
	 * GENERATIONS fold into ONE database and touch nothing of each other's.
	 *
	 * A generation is a stream plus a fold over it, an indexer holds several and
	 * one is canonical; ADR-0053 makes a generation's state a table-name namespace
	 * inside one database (a generation COLUMN and a database-per-generation were
	 * both rejected there). It covers everything THIS store owns -- the entity
	 * tables, `_blocks`, `_cursor` and the indexes derived from them -- and nothing
	 * the server owns: `_meta`, `_emissions` and the generation registry are per
	 * NAMED INDEXER and are shared across its generations on purpose, because a
	 * processor-only change re-folds the SAME stored stream and that is what makes
	 * it free.
	 *
	 * `_blocks` and `_cursor` are in it, not just the entity tables, and that is
	 * the half that is easy to get wrong: two generations on one chain would
	 * otherwise share one block table, where one generation's `revertTo` deletes
	 * rows the other still needs, and one fixed cursor key (`lastSync`, the same
	 * string for every fold), where the second fold silently resumes on the first's
	 * position.
	 *
	 * It is a NAME the caller chooses, and the caller is whoever holds the
	 * generation identity: `{stream digest, processor version hash}` is computable
	 * before the processor exists, so naming the namespace up front keeps the
	 * state-then-processor build order (ADR-0043) intact. What it may be, and where
	 * it goes inside a name, is `inTableNamespace` (`identifiers.ts`); a namespace
	 * this store could not keep separate is refused HERE, at construction.
	 *
	 * ABSENT means the names this store has always created, byte for byte.
	 */
	tableNamespace?: string;
	/**
	 * How far back this deployment wants superseded versions kept, in BLOCK
	 * NUMBERS. Defaults to `unbounded`.
	 *
	 * Validated here: a window below the finality depth is refused naming both
	 * numbers. Whatever is set is also what gets REPORTED, because both halves of
	 * it are enforced: a read outside the window is refused on every read, and
	 * `prune` drops the versions the window no longer covers. Pruning is an
	 * explicit call the HOST schedules, so a deployment that sets a window and
	 * never prunes gets a store bounded in what it answers and unbounded in what
	 * it holds; see `prune`.
	 */
	retention?: RetentionSetting;
};

/** Options for a query over a whole entity table. */
export type QueryOptions = {
	/**
	 * An additional SQL predicate, ANDed with the validity predicate. It is
	 * caller-supplied SQL: pass values through `args`, never by interpolation.
	 */
	where?: string;
	args?: unknown[];
	/** Caller-supplied SQL, same warning as `where`. */
	orderBy?: string;
	limit?: number;
	offset?: number;
};

/**
 * Entity state as versioned rows with a half-open block-validity range.
 *
 * Every version of every entity is a row carrying `_lower` (valid from,
 * inclusive) and `_upper` (valid until, exclusive; NULL means live). The current
 * value is never stored alone, so "the state at block N" is one indexed range
 * predicate rather than a replay, and a reorg is two SQL moves rather than an
 * undo log.
 *
 * The declaration is `{name, id, fields}` and the store owns everything else:
 * the DDL, the writes, the as-of reads, and `revertTo`.
 *
 * It speaks only the `remote-sql` interface, so the same code runs on a local
 * SQLite file, on libSQL/Turso, and on hosted SQLite reached over HTTP.
 *
 * It is one implementation of `StateStoreBackend` (`@etherfold/state-store`), which is
 * the seam a processor is written against. Everything below the `StateStore`
 * methods -- block addressing by hash and by time, and the `queryCurrent` /
 * `queryAsOf` surface that takes caller-supplied SQL -- is this backend's own
 * and deliberately NOT at the seam: a server has a query planner and a handler,
 * running once per event on every backend, does not.
 */
export class VersionedStateStore implements StateStoreBackend {
	private readonly entities: ReadonlyMap<string, NormalizedEntity>;
	/** Every table and index name this store uses, resolved once. See `tableNamespace`. */
	private readonly names: TableNames;
	private readonly bounds: BatchBounds;
	private readonly provided: Retention;
	private readonly finalityDepth: number | undefined;
	/**
	 * This writer's claim on the store, minted on the first mutation and never
	 * re-minted: a writer that lost the store stays refused, because silently
	 * re-claiming would let two writers take it in turns.
	 */
	private token: string | undefined;
	/**
	 * Whether a batch CARRYING the claim has landed.
	 *
	 * Separate from the token because a batch can fail for reasons of its own (a
	 * duplicate height is the ordinary one) and roll the claim back with it. Until
	 * one lands, every guarded batch carries the claim again; after one does, the
	 * guard alone is what stands between this writer and a rival.
	 */
	private claimed = false;

	constructor(
		private readonly db: RemoteSQL,
		declarations: Iterable<EntityDeclaration>,
		options: VersionedStateStoreOptions = {},
	) {
		this.entities = normalizeEntities(declarations);
		// The seam's rule, then THIS engine's one addition, both at DECLARATION time:
		// `sqlite_` is a namespace SQLite refuses however the name is quoted, so it
		// has to fail here rather than at `migrate()` (`identifiers.ts`).
		assertStorableEntityNames(this.entities.values());
		// and the namespace this store's tables live in, resolved and validated at the
		// same moment and for the same reason: a name that could not be kept separate
		// from another generation's must fail where it was configured (ADR-0053).
		this.names = tableNames(options.tableNamespace);
		this.bounds = {...DEFAULT_BATCH_BOUNDS, ...options.bounds};
		// Resolved at CONSTRUCTION, before `migrate` and before any read: a window
		// below the finality depth is a configuration error, and it belongs where it
		// was configured rather than on the first read it would have answered wrongly.
		this.provided = resolveRetention(options.retention, options);
		// kept beside the retention because it is `revert-only`'s prune floor: that
		// kind means "as long as reorg revert needs", and the depth is how long.
		this.finalityDepth = options.finalityDepth;
	}

	/** The declared entities, after validation. */
	get declarations(): ReadonlyMap<string, NormalizedEntity> {
		return this.entities;
	}

	/**
	 * What this store keeps, and what it can answer, as data a caller reads at
	 * startup rather than inferring from a wrong answer later.
	 *
	 * It reports what was CONFIGURED, because this store enforces all three kinds.
	 * `unbounded` (the default) keeps everything and answers at any depth. A
	 * WINDOW is refused outside on every as-of read here and on every as-of read
	 * this backend adds of its own (`queryAsOf`, and the hash and timestamp
	 * address axes), and `prune` drops the versions it no longer covers.
	 * `revert-only` refuses every historical read while `revertTo` keeps working.
	 *
	 * The report is about what a caller may RELY on, never about bytes on disk,
	 * and the two are allowed to differ in the SAFE direction: a store whose host
	 * has not pruned yet still holds versions it refuses to read, exactly as a
	 * `revert-only` store holds the whole history it will not answer about. What
	 * the report may never do is promise history that is gone.
	 */
	get capabilities(): StateStoreCapabilities {
		return {retention: this.provided, asOf: this.provided.kind !== 'revert-only', singleWriter: true};
	}

	/**
	 * Create the fixed tables and the declared entity tables with their indexes.
	 * Idempotent, so it is safe on every boot, and chunked rather than atomic
	 * because re-running it converges (see `migrationStatements`).
	 */
	async migrate(): Promise<void> {
		const statements = migrationStatements(this.entities.values(), this.names);
		logger.debug(`migrating ${this.entities.size} entities (${statements.length} DDL statements)`);
		// each DDL statement is its own group: none of them depend on the others
		for (const batch of planBatches(
			statements.map((statement) => [statement]),
			this.bounds,
		)) {
			await this.db.batch(this.prepare(batch));
		}
	}

	/**
	 * Remove this store's tables, and nothing else: what RETIRING a generation is.
	 *
	 * Under a namespace it drops exactly that generation's entity tables, its
	 * `_blocks` and its `_cursor`, with their indexes; every other generation in the
	 * database is left complete and READABLE, which is the property that makes
	 * moving the canonical pointer back a revert rather than a re-index. It is the
	 * verb a host wires into the generation registry's `dropState`
	 * (`@etherfold/server`), which deliberately defaults to doing nothing rather
	 * than inventing a naming convention it does not own.
	 *
	 * It is NOT on the `StateStore` seam. A backend whose whole storage is a
	 * keyspace or a database expresses the same disposal differently, and a handler
	 * must never be able to reach this at all.
	 *
	 * Idempotent (`IF EXISTS`), and a dropped store can be `migrate`d back to an
	 * empty one. Chunked rather than atomic for the reason `migrate` is: each drop
	 * is independent, and re-running converges.
	 */
	async drop(): Promise<void> {
		await this.releaseBeforeDropping();
		const statements = dropSchemaStatements(this.entities.values(), this.names);
		logger.info(`dropping the state of ${this.names.namespace ?? 'the unnamespaced generation'}`);
		for (const batch of planBatches(
			statements.map((statement) => [statement]),
			this.bounds,
		)) {
			await this.db.batch(this.prepare(batch));
		}
	}

	/**
	 * The guard for `drop`, which cannot be the guard every other path uses.
	 *
	 * `DROP TABLE` takes no `WHERE`, so a token predicate cannot ride the
	 * statements that do the work. What can be guarded is the RELEASE of the claim
	 * itself: a `DELETE ... WHERE token = ?` paired with the read-back in one
	 * batch is an ordinary compare-and-swap, and it decides the question `drop`
	 * actually asks -- may this writer dispose of this generation's state. A
	 * writer that has lost the store fails that swap, is told so with
	 * `StoreWriterChangedError`, and drops NOTHING: the store is byte-identical.
	 *
	 * What it does not give is what no DDL can: the drops that follow are not in
	 * the same transaction as the check, so a rival claiming in between is
	 * dropped out from under. That is inherent to disposing of a generation while
	 * something writes to it, and it is a smaller window than the whole call it
	 * replaced, which had none of this.
	 *
	 * The claim is forgotten afterwards, so a store `migrate`d back to life claims
	 * again on its next write rather than guarding on a token whose table went.
	 */
	private async releaseBeforeDropping(): Promise<void> {
		// a store that never migrated has no token table to read, and dropping it is
		// the documented no-op rather than an error.
		if ((await this.select(writerTableExistsStatement(this.names))).length === 0) return;
		const guard = this.guard();
		const claim = this.claimed ? [] : [claimWriterStatement(guard.token, this.names)];
		const results = await this.db.batch<{token?: string}>(
			this.prepare([...claim, releaseWriterStatement(guard, this.names), heldWriterStatement(this.names)]),
		);
		// the row is GONE when the release took, which is this batch's evidence that
		// the claim it deleted was ours.
		if (results[results.length - 1]?.results[0] !== undefined) throw new StoreWriterChangedError('drop');
		this.token = undefined;
		this.claimed = false;
	}

	// -- write side ----------------------------------------------------------

	/**
	 * Apply one block: the block row plus every entity mutation, as EXACTLY one
	 * `batch([...])`.
	 *
	 * That single call is both boundaries at once. It is the atomicity boundary,
	 * since `remote-sql` exposes a transaction only as a batch, so a failure
	 * anywhere in it leaves no part of the block applied. And it is the
	 * round-trip boundary, which is what actually costs on a remote backend.
	 *
	 * **Which blocks get a row is the CALLER's judgement, not the store's.** Every
	 * block handed to this method is recorded, including one with no mutations,
	 * and nothing else is. The contract is therefore that the caller hands over
	 * exactly the blocks that carried our logs, because "carries our logs" is not
	 * "produces a state mutation": a block can carry a log of ours that changes
	 * nothing, and a consumer can legitimately pin that block's hash. The store
	 * cannot make that call, since it sees mutations and not logs, and inferring
	 * it from a non-empty mutation list would make exactly those pinnable hashes
	 * unresolvable. Pinned by `test/batch.test.ts` and `test/block-addressing.test.ts`.
	 *
	 * The optional `cursor` rides in that same batch, which is what makes a
	 * processor's "I have got this far" atomic with the block it is about. It used
	 * to be a second `batch` issued by the processor afterwards, and a crash inside
	 * that window left state ahead of the cursor, which is a wedge and not a retry:
	 * see `cursor.ts` at the seam.
	 *
	 * ## A height that is not ABOVE the recorded tip is refused, and how
	 *
	 * The caller reverts to the fork before it applies the branch replacing it, so
	 * every apply lands above what the store holds; an offer at or below the tip is
	 * a writer working from a position this store has passed. On a substrate that
	 * could read, decide and write in one transaction that is one `if`. Here it is
	 * a CONDITIONAL WRITE plus a READ-BACK, exactly as the writer token is: every
	 * statement carries `aboveTipGuard`, so a refused block applies to nothing at
	 * all, and the tip read that opens the batch is the evidence -- taken inside the
	 * same transaction, before the insert, so the number it reports is the tip the
	 * write was judged against and the message can name both heights. An EMPTY store
	 * reports no tip and admits any height.
	 */
	async applyBlock(block: BlockPointer, mutations: readonly Mutation[] = [], cursor?: CursorWrite): Promise<void> {
		const guard = this.guard();
		const statements = applyBlockStatements(this.entities, block, mutations, this.names, cursor, guard);
		if (statements.length > this.bounds.maxStatementsPerBatch) {
			logger.warn(
				`block ${block.number} needs ${statements.length} statements, above the configured bound of ` +
					`${this.bounds.maxStatementsPerBatch}. Sent as one batch regardless: a block is one atomic unit.`,
			);
		}
		// FIRST, so it reports the tip as the guarded statements found it. It costs a
		// statement and no round trip, because it rides the batch that was going out.
		const results = await this.sendGuarded<RecordedBlock>('applyBlock', guard, [
			latestBlockStatement(this.names),
			...statements,
		]);
		const tip = results[0]?.results[0]?.number;
		if (tip !== undefined && block.number <= tip) throw new Error(blockNotAboveTip(block.number, tip));
	}

	/** The opaque string last written under `key`, or `undefined`. See `cursor.ts`. */
	async readCursor(key: string): Promise<string | undefined> {
		const rows = await this.select<{value: string}>(readCursorStatement(key, this.names));
		return rows[0]?.value;
	}

	/**
	 * Move a cursor with no block behind it. See `StateStoreBackend.writeCursor`.
	 *
	 * Guarded like every other mutation, and this is the path that needs it most:
	 * no block row incidentally protects it, so it is how a writer holding a stale
	 * `LastSync` moves the recorded position BACKWARDS.
	 */
	async writeCursor(key: string, value: string): Promise<void> {
		const guard = this.guard();
		await this.sendGuarded('writeCursor', guard, [writeCursorStatement(key, value, this.names, guard)]);
	}

	/** Forget it. A `DELETE` matching nothing is the no-op the contract asks for. */
	async clearCursor(key: string): Promise<void> {
		const guard = this.guard();
		await this.sendGuarded('clearCursor', guard, [clearCursorStatement(key, this.names, guard)]);
	}

	/**
	 * Apply several blocks, packing as many as fit into each batch.
	 *
	 * Backfill is bound by round-trips, not by SQLite work, so packing blocks is
	 * the difference that matters there. A batch remains one transaction however
	 * many blocks it carries, and a block is never split across two batches.
	 *
	 * Every block here carries the same tip guard `applyBlock` does, and the updates
	 * must therefore ASCEND -- refused HERE, before any I/O, because it is a fact
	 * about the call rather than about the store, and it is the same rule the engine
	 * applies to a fetched payload (`assertAscendingByBlock`, `@etherfold/core`).
	 *
	 * Given that, ONE tip read decides the whole sequence, and it rides a batch
	 * carrying the LOWEST block alone. If the tip this sequence started against is
	 * below that height, every later block is above both it and its own
	 * predecessors, so nothing after can be refused; and if it is not, the sequence
	 * is refused having applied NOTHING, because the batches carrying the rest have
	 * not been sent. That costs one round trip per CALL, not per block, and it is
	 * what makes a refusal here mean what a refusal on `applyBlock` means.
	 */
	async applyBlocks(updates: readonly BlockUpdate[]): Promise<void> {
		if (updates.length === 0) return;
		for (let index = 1; index < updates.length; index++) {
			const [previous, current] = [updates[index - 1].block.number, updates[index].block.number];
			if (current <= previous) {
				throw new Error(
					`the blocks handed to \`applyBlocks\` must ASCEND: block ${current} follows block ${previous}. A store's ` +
						`blocks only ever move forward, so packing them into one batch can only mean what applying them one at a ` +
						`time means if the sequence is in the order they happened.`,
				);
			}
		}

		const guard = this.guard();
		const groups = updates.map((update) =>
			applyBlockStatements(this.entities, update.block, update.mutations, this.names, undefined, guard),
		);
		const batches = planBatches(groups.slice(1), this.guardedBounds());
		logger.debug(`applying ${updates.length} blocks in ${batches.length + 1} batches`);

		// the OPENING batch: the tip read and the lowest block, so the number the
		// sequence is judged against is read in the transaction that judged it.
		const opening = await this.sendGuarded<RecordedBlock>('applyBlocks', guard, [
			latestBlockStatement(this.names),
			...groups[0],
		]);
		const tip = opening[0]?.results[0]?.number;
		const lowest = updates[0].block.number;
		if (tip !== undefined && lowest <= tip) throw new Error(blockNotAboveTip(lowest, tip));

		for (const batch of batches) {
			await this.sendGuarded('applyBlocks', guard, batch);
		}
	}

	/**
	 * Roll the state back to `keepUpTo`, dropping everything above it.
	 *
	 * Afterwards the store IS the state as of `keepUpTo`: history below the fork
	 * is untouched and still time-travellable, and the canonical branch replays
	 * normally. The order of the statements is load-bearing; the reason lives on
	 * `revertToStatements`.
	 */
	async revertTo(keepUpTo: number): Promise<void> {
		// `_cursor` is deliberately not in `revertToStatements`: how far the CALLER
		// got is not entity state, and the caller moves it when it applies the
		// canonical branch. See `cursor.ts`.
		logger.info(`reverting state above block ${keepUpTo}`);
		const guard = this.guard();
		const statements = revertToStatements(this.entities, keepUpTo, this.names, guard);
		// one batch: a partially reverted store would violate the one-live-version
		// invariant while it lasted. It is also the path that can leave a WRONG state
		// rather than an exception, which is why every statement in it is guarded.
		await this.sendGuarded('revertTo', guard, statements);
	}

	/**
	 * Delete the versions this store's retention no longer covers.
	 *
	 * ## When it runs, which is a decision and not a default
	 *
	 * It runs when the HOST calls it, and nowhere else. It is deliberately not
	 * folded into `applyBlock`: a prune plus `VACUUM` measured 1.1 seconds at
	 * 62,553 versions (`work/notes/findings/sqlite-in-the-browser.md`) while a
	 * block on the same stream carries a median of 7 mutations, so a prune in the
	 * write path would stall whichever block happened to cross a threshold by a
	 * second, for work that block did not cause. An amortised policy is
	 * `prune({maxVersions: n})` on a schedule the host owns; a background policy is
	 * this call on a timer. Both are built on this verb; neither is guessed here.
	 *
	 * ## What it is bounded by, per request
	 *
	 * One statement never names more than `bounds.maxRowsPerStatement` row ids, so
	 * a prune of a hundred thousand versions is a sequence of ordinary small
	 * requests rather than one statement a hosted backend rejects. The row ids are
	 * SELECTed first rather than deleted blind by predicate, because `remote-sql`
	 * reports rows and not an affected-row count: selecting is what makes the
	 * report a fact and what tells the loop it has finished.
	 *
	 * ## What it never touches
	 *
	 * The LIVE version of every entity, however old (`prunableVersionsStatement`),
	 * and the block table. A block row is 3 columns and is how an address resolves;
	 * dropping it would turn `BlockNotRetainedError` ("that block is fine, its
	 * state is outside what I keep") into `NoSuchBlockError` ("never indexed, or
	 * reorged out"), which is a worse answer and, for a consumer that pinned the
	 * hash, a wrong one.
	 *
	 * It does not `VACUUM` either. `VACUUM` cannot run inside a transaction, which
	 * is the only thing `remote-sql` exposes for writes, it rewrites the whole file,
	 * and it is not available on every backend behind that interface. Without it
	 * SQLite keeps the freed pages on its freelist and REUSES them, so the file
	 * stops growing even though it does not shrink; an operator who wants the space
	 * back runs `VACUUM` on the database itself, at a moment of their choosing.
	 */
	async prune(options: PruneOptions = {}): Promise<PruneReport> {
		const budget = pruneBudget(options);
		const guard = this.guard();
		// The tip rides the CLAIM batch, so the number the floor is computed from and
		// the token that authorises the deletion are read in one transaction, and a
		// writer that has lost the store is refused before it reads anything. That
		// costs no round trip: this is the tip read `prune` always made.
		const [tipResult] = await this.sendGuarded<RecordedBlock>('prune', guard, [latestBlockStatement(this.names)]);
		const tip = tipResult?.results[0]?.number;
		const floor = tip === undefined ? undefined : retentionFloor(this.provided, tip, this.finalityDepth);
		if (floor === undefined) return {tip, floor: undefined, versionsDeleted: 0, complete: true};

		let versionsDeleted = 0;
		for (const entity of this.entities.values()) {
			while (versionsDeleted < budget) {
				// one fewer row than the bound allows, because the guard is the one other
				// bound parameter this statement carries -- see `maxRowsPerStatement`,
				// whose default sits EXACTLY on the tightest hosted backend's cap.
				const limit = Math.min(Math.max(1, this.bounds.maxRowsPerStatement - 1), budget - versionsDeleted);
				// keyed off ROWID rather than a literal: the column name is `ddl.ts`'s to
				// choose, and renaming it must not silently produce a list of undefineds.
				const found = await this.select<Record<typeof ROWID, number>>(
					prunableVersionsStatement(entity, floor, limit, this.names),
				);
				if (found.length === 0) break;
				await this.sendGuarded('prune', guard, [
					dropVersionsStatement(
						entity,
						found.map((row) => row[ROWID]),
						this.names,
						guard,
					),
				]);
				versionsDeleted += found.length;
			}
		}

		// AFTER the deletes, so the record can never claim a pass that did not
		// happen, and in a batch of its own because `remote-sql` exposes transactions
		// only as `batch` -- a prune here is already a SEQUENCE of batches rather than
		// one transaction, so there is no wider unit to join. A crash in between
		// leaves the store reporting `never-pruned` over rows that did go, which
		// under-claims enforcement and is corrected by the next pass.
		const record = pruneRecord(floor);
		if (record !== undefined) {
			await this.sendGuarded('prune', guard, [
				writeCursorStatement(RETENTION_ENFORCEMENT_KEY, record, this.names, guard),
			]);
		}

		// Without a budget every table was drained, so the pass is complete by
		// construction. With one, "is there more" is a question only the database can
		// answer, and one bounded probe is cheaper than making the caller guess.
		const complete = versionsDeleted < budget || !(await this.hasPrunableVersions(floor));
		logger.info(`pruned ${versionsDeleted} versions closed at or below block ${floor} (tip ${tip})`);
		return {tip, floor, versionsDeleted, complete};
	}

	/**
	 * Whether the retention this store reports is enforced against its storage.
	 *
	 * Durable because the record is a row in the cursor table beside the versions,
	 * so a process that prunes and dies is answered for by the next one to open
	 * the database -- which on this backend is the ordinary case, since a serving
	 * tier and a folding tier are frequently two processes over one file.
	 *
	 * A READ: two ordinary selects, no guard and no write, so asking whether a
	 * store is being pruned cannot take it away from the writer that is pruning
	 * it.
	 */
	async readRetentionEnforcement(): Promise<RetentionEnforcement> {
		const tip = (await this.select<RecordedBlock>(latestBlockStatement(this.names)))[0]?.number;
		return retentionEnforcementOf(
			this.provided,
			this.finalityDepth,
			tip,
			await this.readCursor(RETENTION_ENFORCEMENT_KEY),
		);
	}

	/** Whether any version is still unreachable at `floor`: one indexed probe per table. */
	private async hasPrunableVersions(floor: number): Promise<boolean> {
		for (const entity of this.entities.values()) {
			if ((await this.select(prunableVersionsStatement(entity, floor, 1, this.names))).length > 0) return true;
		}
		return false;
	}

	// -- block addressing ----------------------------------------------------

	/**
	 * Resolve any of the three axes to the block number the reads are keyed on,
	 * or `undefined` if it identifies no block this store can answer about.
	 *
	 * This is the soft form of the resolution the reads do: it branches instead of
	 * throwing (`NoSuchBlockError`), which is what a caller wants when an unknown
	 * hash is an expected outcome rather than an alarm.
	 *
	 * - **hash** probes the unique index. Unknown means never indexed or reorged
	 *   out, and those are the same answer: not a block we can speak for.
	 * - **height** resolves to itself, with NO lookup. Only blocks carrying our
	 *   logs have rows, while every height is a valid point on the version ranges.
	 * - **timestamp** is the latest recorded block at or before T; before the first
	 *   recorded block it is `undefined`, never the first block.
	 */
	async resolveBlockNumber(address: BlockAddress): Promise<number | undefined> {
		const parsed = parseBlockAddress(address);
		if (parsed.axis === 'height') return parsed.number;
		return (await this.lookupBlock(parsed))?.number;
	}

	/**
	 * The recorded block an address identifies, with its hash, or `undefined` if
	 * no row matches.
	 *
	 * The intended use is turning a soft address into the hard one: a consumer
	 * asks by time or by height, and stores the `hash` it gets back, so that a
	 * later reorg answers "no such block" instead of silently answering about a
	 * different chain. Note that a height with no row is `undefined` here while
	 * being perfectly readable through `getAsOf`, which is the asymmetry documented
	 * in `blocks.ts`: we record blocks that carry our logs, not chain headers.
	 */
	async getBlock(address: BlockAddress): Promise<RecordedBlock | undefined> {
		return this.lookupBlock(parseBlockAddress(address));
	}

	/**
	 * The highest recorded block, or `undefined` before the first one is applied.
	 *
	 * This is the TIP a retention window is measured back from, and it is read
	 * ONLY when a window is claimed: `assertRetained` takes it as a thunk, so an
	 * `unbounded` store (which refuses nothing) and a `revert-only` store (which
	 * refuses everything) never pay the round-trip.
	 */
	private async tipBlockNumber(): Promise<number | undefined> {
		const statement = latestBlockStatement(this.names);
		const result = await this.db
			.prepare(statement.sql)
			.bind(...statement.args)
			.all<RecordedBlock>();
		return result.results[0]?.number;
	}

	private async lookupBlock(parsed: ParsedBlockAddress): Promise<RecordedBlock | undefined> {
		const statement =
			parsed.axis === 'hash'
				? blockByHashStatement(parsed.hash, this.names)
				: parsed.axis === 'timestamp'
					? blockAtOrBeforeStatement(parsed.timestamp, this.names)
					: blockByNumberStatement(parsed.number, this.names);
		const result = await this.db
			.prepare(statement.sql)
			.bind(...statement.args)
			.all<RecordedBlock>();
		return result.results[0];
	}

	/**
	 * The resolution the reads use: a block number, or a thrown `NoSuchBlockError`.
	 *
	 * Costs one extra round-trip on the hash and timestamp axes, and none on the
	 * height axis. Folding the resolution into the read as a sub-select would save
	 * that trip, but a sub-select that matched nothing would make the as-of
	 * predicate false and return an empty result, which is the one confusion this
	 * whole seam exists to prevent: "no such block" would become "entity absent".
	 */
	private async resolveForRead(address: BlockAddress): Promise<number> {
		const parsed = parseBlockAddress(address);
		if (parsed.axis === 'height') return parsed.number;
		const found = await this.lookupBlock(parsed);
		if (found) return found.number;
		throw new NoSuchBlockError(address, parsed.axis === 'hash' ? 'unknown-hash' : 'no-recorded-block-at-or-before');
	}

	// -- read side (time travel) ---------------------------------------------

	/**
	 * One entity as of a block hash, a height, or a timestamp.
	 *
	 * All three resolve to a block number (`resolveBlockNumber`) and then run the
	 * one as-of predicate, so they answer identically when they identify the same
	 * block.
	 *
	 * `undefined` means the block is known and the entity was absent from it. An
	 * address that identifies no block THROWS `NoSuchBlockError` instead, because
	 * those two are not the same news: see `blocks.ts`. A block this store does
	 * not RETAIN throws `BlockNotRetainedError`, the other member of that family:
	 * the address was fine, the history is gone, and answering from the tip would
	 * be a plausible wrong number.
	 */
	async getAsOf<T = Record<string, unknown>>(entity: string, id: EntityId, at: BlockAddress): Promise<T | undefined> {
		const declaration = mustGet(this.entities, entity);
		const blockNumber = await this.resolveForRead(at);
		await assertRetained(this.capabilities, blockNumber, () => this.tipBlockNumber());
		const result = await this.db
			.prepare(
				`SELECT * FROM ${this.names.entity(declaration.name)} WHERE ${idPredicate(declaration)} AND ${AS_OF_PREDICATE} LIMIT 1`,
			)
			.bind(...idValues(declaration, id), blockNumber, blockNumber)
			.all<T>();
		return result.results[0];
	}

	/** One entity as it is at the tip: the open-row special case. */
	async getCurrent<T = Record<string, unknown>>(entity: string, id: EntityId): Promise<T | undefined> {
		const declaration = mustGet(this.entities, entity);
		const result = await this.db
			.prepare(
				`SELECT * FROM ${this.names.entity(declaration.name)} WHERE ${idPredicate(declaration)} AND ${CURRENT_PREDICATE} LIMIT 1`,
			)
			.bind(...idValues(declaration, id))
			.all<T>();
		return result.results[0];
	}

	/**
	 * The children of an id PREFIX at the tip: one indexed range scan, bounded.
	 *
	 * This is the seam's only set read, and it is deliberately the poor relation of
	 * `queryCurrent` below: no predicate, no caller-supplied ordering, no offset.
	 * The reason is not taste but WHERE IT RUNS. A handler runs once per event on
	 * every backend, including the ones with no query planner, so the seam gets the
	 * one shape that is an indexed range scan everywhere; a server-side caller with
	 * a planner underneath it uses `queryCurrent`. See `listStatement` for the
	 * access path, which `test/listing.test.ts` pins with `EXPLAIN QUERY PLAN`.
	 */
	async listCurrent<T = Record<string, unknown>>(
		entity: string,
		prefix: EntityIdPrefix,
		limit: number,
	): Promise<Listing<T>> {
		const statement = listCurrentStatement(mustGet(this.entities, entity), prefix, limit, this.names);
		return boundedListing(await this.select<T>(statement), limit);
	}

	/**
	 * The same range as of a block hash, a height or a timestamp.
	 *
	 * Same resolution and the same two refusals as `getAsOf`: an address that
	 * identifies no block throws `NoSuchBlockError`, and a block outside what this
	 * store retains throws `BlockNotRetainedError`. An EMPTY listing means the
	 * block is known and the prefix had no children then.
	 */
	async listAsOf<T = Record<string, unknown>>(
		entity: string,
		prefix: EntityIdPrefix,
		at: BlockAddress,
		limit: number,
	): Promise<Listing<T>> {
		const declaration = mustGet(this.entities, entity);
		const blockNumber = await this.resolveForRead(at);
		await assertRetained(this.capabilities, blockNumber, () => this.tipBlockNumber());
		return boundedListing(
			await this.select<T>(listAsOfStatement(declaration, prefix, blockNumber, limit, this.names)),
			limit,
		);
	}

	/**
	 * A whole entity table as of a block hash, a height, or a timestamp.
	 *
	 * Same resolution, the same "no such block" contract and the same retention
	 * refusal as `getAsOf`: an empty array means the block is known and nothing
	 * matched, while an address that identifies no block, or a block outside what
	 * this store retains, throws.
	 */
	async queryAsOf<T = Record<string, unknown>>(
		entity: string,
		at: BlockAddress,
		options: QueryOptions = {},
	): Promise<T[]> {
		const declaration = mustGet(this.entities, entity);
		const blockNumber = await this.resolveForRead(at);
		await assertRetained(this.capabilities, blockNumber, () => this.tipBlockNumber());
		const {tail, tailArgs} = paginate(options);
		const result = await this.db
			.prepare(
				`SELECT * FROM ${this.names.entity(declaration.name)} WHERE ${AS_OF_PREDICATE}${filter(options)}${order(options)}${tail}`,
			)
			.bind(blockNumber, blockNumber, ...(options.args ?? []), ...tailArgs)
			.all<T>();
		return result.results;
	}

	/** A whole entity table as it is at the tip. */
	async queryCurrent<T = Record<string, unknown>>(entity: string, options: QueryOptions = {}): Promise<T[]> {
		const declaration = mustGet(this.entities, entity);
		const {tail, tailArgs} = paginate(options);
		const result = await this.db
			.prepare(
				`SELECT * FROM ${this.names.entity(declaration.name)} WHERE ${CURRENT_PREDICATE}${filter(options)}${order(options)}${tail}`,
			)
			.bind(...(options.args ?? []), ...tailArgs)
			.all<T>();
		return result.results;
	}

	// -- the writer token ----------------------------------------------------

	/**
	 * This writer's guard, minting its claim token on first use.
	 *
	 * Minting is not claiming: the token becomes real only when a batch carrying
	 * `claimWriterStatement` commits. Until then it is a value nobody has seen.
	 */
	private guard(): WriterGuard {
		this.token ??= writerToken();
		return writerGuard(this.token, this.names);
	}

	/**
	 * Send one guarded batch: the CLAIM (until one has landed), the caller's
	 * already-guarded statements, and the READ-BACK that says who holds the store.
	 *
	 * This is ADR-0054's shape, and the ordering is the same and load-bearing for
	 * the same reasons. The claim comes FIRST, because a writer's first mutation
	 * must take the store and write in one transaction. The read-back comes LAST,
	 * because `remote-sql` reports rows and no affected-row count, so what the
	 * token row says at the end of the batch is the only evidence there is: ours
	 * means every guarded statement applied, anything else means a second writer
	 * got there first and this whole batch applied to NOTHING.
	 *
	 * There is deliberately NO retry. ADR-0054 re-runs a losing decision because
	 * the registry's caller wants the write to happen against whatever state holds;
	 * here a loser must not write at all, so it is told and it stops.
	 *
	 * Returns the caller's own results, aligned with the statements it passed.
	 */
	private async sendGuarded<T = Record<string, unknown>>(
		operation: string,
		guard: WriterGuard,
		statements: readonly Statement[],
	): Promise<SQLResult<T>[]> {
		const claim = this.claimed ? [] : [claimWriterStatement(guard.token, this.names)];
		const results = await this.db.batch<T & {token?: string}>(
			this.prepare([...claim, ...statements, heldWriterStatement(this.names)]),
		);
		const held = results[results.length - 1]?.results[0]?.token;
		if (held !== guard.token) throw new StoreWriterChangedError(operation);
		this.claimed = true;
		return results.slice(claim.length, results.length - 1);
	}

	/**
	 * The batch bounds with room kept for the two statements every guarded batch
	 * adds: the claim and the read-back.
	 *
	 * Only the paths that PACK several atomic units need it (`applyBlocks`): a
	 * single block is one indivisible group and is sent oversized on purpose if it
	 * has to be, and so is the opening batch that carries the tip read with it.
	 */
	private guardedBounds(): BatchBounds {
		return {...this.bounds, maxStatementsPerBatch: Math.max(1, this.bounds.maxStatementsPerBatch - 2)};
	}

	private async select<T>(statement: Statement): Promise<T[]> {
		const result = await this.db
			.prepare(statement.sql)
			.bind(...statement.args)
			.all<T>();
		return result.results;
	}

	private prepare(statements: readonly Statement[]): SQLPreparedStatement[] {
		return statements.map((statement) => this.db.prepare(statement.sql).bind(...statement.args));
	}
}

function filter(options: QueryOptions): string {
	return options.where ? ` AND (${options.where})` : '';
}

function order(options: QueryOptions): string {
	return options.orderBy ? ` ORDER BY ${options.orderBy}` : '';
}

function paginate(options: QueryOptions): {tail: string; tailArgs: unknown[]} {
	if (options.limit === undefined) return {tail: '', tailArgs: []};
	if (options.offset === undefined) return {tail: ' LIMIT ?', tailArgs: [options.limit]};
	return {tail: ' LIMIT ? OFFSET ?', tailArgs: [options.limit, options.offset]};
}
