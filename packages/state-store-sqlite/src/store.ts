import type {Accessor} from '@etherfold/accessor';
import {logs} from 'named-logs';
import type {RemoteSQL, SQLPreparedStatement, SQLResult} from 'remote-sql';
import {sqliteAccessor} from './accessor.js';
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
	BlockNotRetainedError,
	blockNotAboveTip,
	boundedListing,
	decodeFieldValues,
	u256,
	fieldStorage,
	mustGet,
	normalizeEntities,
	pruneBudget,
	pruneRecord,
	recordedPruneFloor,
	resolveRetention,
	retentionEnforcementOf,
	retentionFloor,
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
	type SeamRecordKey,
} from '@etherfold/state-store';
import {ROWID, dropSchemaStatements, migrationStatements, tableNames, type TableNames} from './ddl.js';
import {assertStorableEntityNames, quoted} from './identifiers.js';
import {
	AS_OF_PREDICATE,
	CURRENT_PREDICATE,
	applyBlockStatements,
	blockAtOrBeforeStatement,
	blockAtOrBelowStatement,
	blockByHashStatement,
	blockByNumberStatement,
	claimWriterStatement,
	clearCursorStatement,
	deletesAtBlockStatement,
	dropVersionsStatement,
	heldWriterStatement,
	idPredicate,
	idValues,
	latestBlockStatement,
	listAsOfStatement,
	listCurrentStatement,
	liveRowsAsOfStatement,
	prunableVersionsStatement,
	readCursorStatement,
	readSeamRecordStatement,
	recordedBlocksBetweenStatement,
	upsertsAtBlockStatement,
	releaseWriterStatement,
	revertToStatements,
	clearSeamRecordStatement,
	writeCursorStatement,
	writeSeamRecordStatement,
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
	 * tables, `_blocks`, `_cursor`, `_seam` and the indexes derived from them -- and nothing
	 * the server owns: `_meta`, `_emissions` and the generation registry are per
	 * NAMED INDEXER and are shared across its generations on purpose, because a
	 * processor-only change re-folds the SAME stored stream and that is what makes
	 * it free.
	 *
	 * `_blocks`, `_cursor` and `_seam` are in it, not just the entity tables, and
	 * that is the half that is easy to get wrong: two generations on one chain would
	 * otherwise share one block table, where one generation's `revertTo` deletes
	 * rows the other still needs, and one fixed cursor key (`lastSync`, the same
	 * string for every fold), where the second fold silently resumes on the first's
	 * position -- and one snapshot origin, where a generation bootstrapped from a
	 * snapshot would impose its floor on a sibling that indexed from the start block.
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

/**
 * Options for a query over a whole entity table.
 *
 * A row comes back as the seam answers one, so a `u256` field (ADR-0098) is a
 * `bigint`. The PREDICATE is SQL, though, and runs against what is stored: a
 * `u256` column holds its canonical encoding, 32 big-endian bytes in a BLOB, so a
 * value compared with one must be bound as that encoding, `u256Arg(value)`. A
 * decimal or a number bound instead compares with a BLOB it can never equal, and
 * the query is silently empty. Bytewise order of the encoding IS numeric order,
 * so `<`, `>` and `ORDER BY` on such a column are numeric too.
 */
export type QueryOptions = {
	/**
	 * An additional SQL predicate, ANDed with the validity predicate. It is
	 * caller-supplied SQL: pass values through `args`, never by interpolation, and
	 * a `u256` through `u256Arg`.
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
	 * `_blocks`, its `_cursor` and its `_seam`, with their indexes; every other generation in the
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
		const statements = [
			...dropSchemaStatements(this.entities.values(), this.names),
			...(await this.undeclaredEntityTableDrops()),
		];
		logger.info(`dropping the state of ${this.names.namespace ?? 'the unnamespaced generation'}`);
		for (const batch of planBatches(
			statements.map((statement) => [statement]),
			this.bounds,
		)) {
			await this.db.batch(this.prepare(batch));
		}
	}

	/**
	 * The entity tables under this store's namespace that its OWN declarations do not
	 * name, as `DROP` statements: what `drop` must also remove to retire a generation
	 * whose tables were created by a DIFFERENT declaration.
	 *
	 * A host drops a generation through a store it builds NOW, over the entities of the
	 * processor it holds, and that is not necessarily the processor that created the
	 * namespace: a successor that arrived by upload declaring an extra entity is replaced
	 * or reclaimed by a process configured with another, and the registry row (with the
	 * bundle that could have said which entities) is gone before the drop runs. Dropping
	 * only the declared tables left the others behind for ever.
	 *
	 * The namespace makes the set exact rather than a guess: a namespace has no
	 * underscore (`assertStorableTableNamespace`), so an entity table of THIS namespace
	 * is exactly a table named `<namespace>_...`, and no other namespace's table can
	 * start that way. Derived indexes go with their tables, as `dropSchemaStatements`
	 * already relies on. With NO namespace there is no prefix to tell this store's
	 * tables from anything else in the database, so nothing is added.
	 */
	private async undeclaredEntityTableDrops(): Promise<ReturnType<typeof dropSchemaStatements>> {
		const namespace = this.names.namespace;
		if (namespace === undefined) return [];
		const prefix = `${namespace}_`;
		const declared = new Set([...this.entities.values()].map((entity) => this.names.entity(entity.name)));
		const found = await this.db
			.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, ?1) = ?2`)
			.bind(prefix.length, prefix)
			.all<{name: string}>();
		return found.results
			.map((row) => quoted(row.name))
			.filter((quotedName) => !declared.has(quotedName))
			.map((quotedName) => ({sql: `DROP TABLE IF EXISTS ${quotedName}`, args: []}));
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
		if (tip !== undefined && block.number <= tip) throw blockNotAboveTip(block.number, tip);
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
	 * The seam's own record under `key`, out of the table no caller can address.
	 * See `records.ts` at the seam and `SEAM_RECORD_TABLE` in `ddl.ts`.
	 *
	 * A READ: one ordinary select, no guard and no write, because
	 * `openSnapshotAware` calls it on every boot and opening is not writing.
	 */
	async readSeamRecord(key: SeamRecordKey): Promise<string | undefined> {
		const rows = await this.select<{value: string}>(readSeamRecordStatement(key, this.names));
		return rows[0]?.value;
	}

	/** Write one of the seam's records, guarded like every other mutation. */
	async writeSeamRecord(key: SeamRecordKey, value: string): Promise<void> {
		const guard = this.guard();
		await this.sendGuarded('writeSeamRecord', guard, [writeSeamRecordStatement(key, value, this.names, guard)]);
	}

	/**
	 * Forget one of the seam's records. A `DELETE` matching nothing is the no-op
	 * the contract asks for -- and is how `openForWriting` claims.
	 */
	async clearSeamRecord(key: SeamRecordKey): Promise<void> {
		const guard = this.guard();
		await this.sendGuarded('clearSeamRecord', guard, [clearSeamRecordStatement(key, this.names, guard)]);
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
		if (tip !== undefined && lowest <= tip) throw blockNotAboveTip(lowest, tip);

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
				writeSeamRecordStatement('retentionEnforcement', record, this.names, guard),
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
	 * Durable because the record is a row in the seam's own table beside the
	 * versions, so a process that prunes and dies is answered for by the next to open
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
			await this.readSeamRecord('retentionEnforcement'),
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
	 * The highest RECORDED block at or below a height, or `undefined` when none is.
	 *
	 * What a snapshot's pointer is when it is cut at a height that carries no logs
	 * of ours (ADR-0095): the state as of the cut is the state as of this block,
	 * and this is the block below the cut whose hash and timestamp are known.
	 */
	async getBlockAtOrBelow(number: number): Promise<RecordedBlock | undefined> {
		assertHeightForLookup(number);
		return (await this.select<RecordedBlock>(blockAtOrBelowStatement(number, this.names)))[0];
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
			.all<Record<string, unknown>>();
		return decodedRow<T>(declaration, result.results[0]);
	}

	/** One entity as it is at the tip: the open-row special case. */
	async getCurrent<T = Record<string, unknown>>(entity: string, id: EntityId): Promise<T | undefined> {
		const declaration = mustGet(this.entities, entity);
		const result = await this.db
			.prepare(
				`SELECT * FROM ${this.names.entity(declaration.name)} WHERE ${idPredicate(declaration)} AND ${CURRENT_PREDICATE} LIMIT 1`,
			)
			.bind(...idValues(declaration, id))
			.all<Record<string, unknown>>();
		return decodedRow<T>(declaration, result.results[0]);
	}

	/**
	 * The live row of one entity AS THIS STORE HOLDS IT: a semantic field in its
	 * canonical encoding (ADR-0098) rather than decoded, and no version columns.
	 *
	 * Not part of the seam, which answers values and never their encoding. This is
	 * here so a test can see the stored form, as `getBlock` lets one see a block.
	 */
	async storedCurrent(entity: string, id: EntityId): Promise<Record<string, unknown> | undefined> {
		const declaration = mustGet(this.entities, entity);
		const result = await this.db
			.prepare(
				`SELECT * FROM ${this.names.entity(declaration.name)} WHERE ${idPredicate(declaration)} AND ${CURRENT_PREDICATE} LIMIT 1`,
			)
			.bind(...idValues(declaration, id))
			.all<Record<string, unknown>>();
		const row = result.results[0];
		if (!row) return undefined;
		const stored: Record<string, unknown> = {};
		for (const column of [...declaration.id, ...Object.keys(declaration.fields)]) stored[column] = row[column];
		return stored;
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
		const declaration = mustGet(this.entities, entity);
		const statement = listCurrentStatement(declaration, prefix, limit, this.names);
		return boundedListing(decodedRows<T>(declaration, await this.select<Record<string, unknown>>(statement)), limit);
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
			decodedRows<T>(
				declaration,
				await this.select<Record<string, unknown>>(
					listAsOfStatement(declaration, prefix, blockNumber, limit, this.names),
				),
			),
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
			.all<Record<string, unknown>>();
		return decodedRows<T>(declaration, result.results);
	}

	/**
	 * EVERY row live as of a block, entity by entity, as the upserts that reproduce
	 * them: the read a state snapshot is produced from (ADR-0095).
	 *
	 * It is this backend's own and deliberately NOT on the seam, which has no
	 * list-everything read by design (ADR-0021): a handler runs once per event and
	 * must never be able to express a scan, while a PUBLISHER runs once and needs
	 * exactly one. It reads through the same as-of predicate, the same address
	 * resolution and the same retention refusal as `getAsOf`, so a snapshot can
	 * never carry rows the store would refuse to answer about.
	 *
	 * Paged (`liveRowsAsOfStatement`), so the rows arrive a page at a time and a
	 * consumer that writes each one as it comes (the snapshot encoder) never holds
	 * a whole entity. The version columns are storage and are stripped; a `blob`
	 * comes back as a `Uint8Array`, which is what the seam's other backends hold.
	 *
	 * The pages are separate reads, so a writer REVERTING below `at` while this
	 * runs would be seen part-way; read a block the fold has finalised (a publisher
	 * cuts at `tip - finality`, ADR-0095), where nothing reverts.
	 */
	async *liveRowsAsOf(at: BlockAddress, options: {readonly pageSize?: number} = {}): AsyncGenerator<Mutation> {
		const blockNumber = await this.resolveForRead(at);
		await assertRetained(this.capabilities, blockNumber, () => this.tipBlockNumber());
		const pageSize = Math.max(1, options.pageSize ?? LIVE_ROWS_PAGE);
		for (const entity of this.entities.values()) {
			let after = 0;
			for (;;) {
				const page = await this.select<Record<string, unknown>>(
					liveRowsAsOfStatement(entity, blockNumber, after, pageSize, this.names),
				);
				for (const row of page) yield liveRow(entity, row);
				if (page.length < pageSize) break;
				after = page[page.length - 1][ROWID] as number;
			}
		}
	}

	/**
	 * What ONE recorded block CHANGED, entity by entity, as the mutations that
	 * reproduce it when replayed through `applyBlock` on top of the state just below
	 * it: the per-block history a state snapshot carries above its floor (ADR-0095).
	 *
	 * The block's NET change, read off the version ranges rather than kept anywhere:
	 * an upsert for every id whose version opened at the block and is live at it, a
	 * delete for every id whose version was closed at it with none opened in its
	 * place. An id the block touched several times appears once, with its final
	 * value, and an id it created and deleted does not appear at all.
	 *
	 * Backend-only for the reason `liveRowsAsOf` is: it is a scan of what a block
	 * wrote, which the seam never exposes (ADR-0021). Paged, and refused where the
	 * store does not retain the block, as every as-of read is.
	 */
	async *changesAt(at: number, options: {readonly pageSize?: number} = {}): AsyncGenerator<Mutation> {
		assertHeightForLookup(at);
		await assertRetained(this.capabilities, at, () => this.tipBlockNumber());
		const pageSize = Math.max(1, options.pageSize ?? LIVE_ROWS_PAGE);
		for (const entity of this.entities.values()) {
			for (let after = 0; ; ) {
				const page = await this.select<Record<string, unknown>>(
					upsertsAtBlockStatement(entity, at, after, pageSize, this.names),
				);
				for (const row of page) yield liveRow(entity, row);
				if (page.length < pageSize) break;
				after = page[page.length - 1][ROWID] as number;
			}
			for (let after = 0; ; ) {
				const page = await this.select<Record<string, unknown>>(
					deletesAtBlockStatement(entity, at, after, pageSize, this.names),
				);
				for (const row of page) {
					const id: Record<string, string> = {};
					for (const column of entity.id) id[column] = String(row[column]);
					yield {type: 'delete', entity: entity.name, id};
				}
				if (page.length < pageSize) break;
				after = page[page.length - 1][ROWID] as number;
			}
		}
	}

	/**
	 * The recorded blocks strictly above `after` and at most `upTo`, ascending, read
	 * a page at a time: which blocks a snapshot carrying history replays.
	 */
	async *recordedBlocksBetween(
		after: number,
		upTo: number,
		options: {readonly pageSize?: number} = {},
	): AsyncGenerator<RecordedBlock> {
		const pageSize = Math.max(1, options.pageSize ?? LIVE_ROWS_PAGE);
		for (let from = after; ; ) {
			const page = await this.select<RecordedBlock>(recordedBlocksBetweenStatement(from, upTo, pageSize, this.names));
			yield* page;
			if (page.length < pageSize) return;
			from = page[page.length - 1].number;
		}
	}

	/**
	 * The oldest block this store's STORAGE can still answer an as-of read about,
	 * or `undefined` when it reaches back to every block it recorded.
	 *
	 * Two floors, and the higher wins. The one THIS handle was configured with
	 * (`retainedRange(...).from` of its retention, measured from the tip), and the
	 * one a PRUNE pass last ran at, as recorded in the database itself
	 * (`retentionEnforcement`). The second is what matters to a reader that did not
	 * write the database: a publisher opens it with no retention of its own, and the
	 * process that folded it may have pruned it (`--retention`), so versions closed
	 * at or below that floor may be gone whatever this handle claims. A `revert-only`
	 * store answers no historical read at all, and its reads refuse on their own.
	 */
	async retainedFrom(): Promise<number | undefined> {
		return this.retainedFromAt(await this.tipBlockNumber());
	}

	/** `retainedFrom` measured from a tip the caller already read, so one operation reads it once. */
	private async retainedFromAt(tip: number | undefined): Promise<number | undefined> {
		const configured = tip === undefined ? undefined : retentionFloor(this.provided, tip, this.finalityDepth);
		const pruned = recordedPruneFloor(await this.readSeamRecord('retentionEnforcement'));
		if (configured === undefined) return pruned;
		if (pruned === undefined) return configured;
		return Math.max(configured, pruned);
	}

	/**
	 * This store's ACCESSOR (ADR-0099): the rows of an entity matching a
	 * predicate over its declared fields, ordered, bounded, at the tip or as of a
	 * block, and a page of parents' children in one `IN` query bounded per parent.
	 *
	 * The seam the query layer's resolvers read through, beside `StateStore` and
	 * never part of it (a handler still gets no predicate, ADR-0021). Unlike
	 * `queryCurrent` it takes no SQL: the query is data, checked against the
	 * declarations by the planner every backend shares, so the same query means
	 * the same thing here and in a browser. It declares no rows-examined bound,
	 * because SQLite plans. As-of reads keep the retention refusal of every other
	 * as-of read here, and ALSO refuse below the floor a prune pass recorded in
	 * the database (`assertStorageRetains`). See `accessor.ts`.
	 */
	accessor(): Accessor {
		return sqliteAccessor({
			entities: this.entities,
			names: this.names,
			maxParams: this.bounds.maxRowsPerStatement,
			select: (statement) => this.select<Record<string, unknown>>(statement),
			assertRetained: (at) => this.assertStorageRetains(at),
		});
	}

	/**
	 * Refuse an as-of read below what this database's STORAGE still holds, not only
	 * below what this handle claims.
	 *
	 * First the handle's own claim (`assertRetained`, so a `revert-only` store still
	 * refuses every block, in its own words), then `retainedFrom`, which also knows
	 * the floor a prune pass RECORDED. The second is what a read tier needs: `serve`
	 * opens the database with no retention of its own (`unbounded`), while the
	 * process that folded it may have pruned it, and the versions closed at or below
	 * that floor are gone whatever this handle claims. Answering below it would be
	 * answering from partly deleted history, a plausible wrong answer; it is
	 * `BlockNotRetainedError`, the seam's existing refusal (ADR-0099), with
	 * `retained` naming the blocks storage still answers about.
	 *
	 * One tip read and one seam-record read per call, however many statements the
	 * accessor then issues. A block ABOVE the tip is never refused, as ever.
	 */
	private async assertStorageRetains(at: number): Promise<void> {
		let tip: Promise<number | undefined> | undefined;
		const tipOnce = () => (tip ??= this.tipBlockNumber());
		await assertRetained(this.capabilities, at, tipOnce);
		const current = await tipOnce();
		const from = await this.retainedFromAt(current);
		if (from !== undefined && at < from) {
			throw new BlockNotRetainedError(
				at,
				{from, to: Math.max(from, current ?? from)},
				'outside-window',
				this.capabilities.retention,
			);
		}
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
			.all<Record<string, unknown>>();
		return decodedRows<T>(declaration, result.results);
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

/**
 * A `u256` as the raw-SQL tier binds it: its canonical encoding, the 32
 * big-endian bytes the column holds (ADR-0098). Pass it in `QueryOptions.args`
 * wherever a predicate compares a `u256` column:
 *
 * ```ts
 * await store.queryCurrent('pool', {where: 'amount >= ?', args: [u256Arg(10n ** 18n)]});
 * ```
 *
 * Refuses what the column could not hold (negative, wider than 256 bits, not a
 * `bigint`), as a write does.
 */
export function u256Arg(value: bigint): Uint8Array {
	return u256.encode(value);
}

/** How many rows one page of `liveRowsAsOf` reads. */
const LIVE_ROWS_PAGE = 1_000;

/** One stored version as the upsert that reproduces it: the declared columns only. */
function liveRow(entity: NormalizedEntity, row: Record<string, unknown>): Mutation {
	const id: Record<string, string> = {};
	for (const column of entity.id) id[column] = String(row[column]);
	const values: Record<string, unknown> = {};
	for (const [field, type] of Object.entries(entity.fields)) {
		const value = row[field] ?? null;
		values[field] = fieldStorage(type) === 'blob' && value instanceof ArrayBuffer ? new Uint8Array(value) : value;
	}
	return {type: 'upsert', entity: entity.name, id, values: decodeFieldValues(entity, values)};
}

/**
 * A stored row as the seam answers it: each semantic field decoded from its
 * canonical encoding (a `u256` from its 32-byte BLOB to a `bigint`, ADR-0098).
 * Every read that hands a row out goes through here, the raw-SQL tier included.
 */
function decodedRow<T>(entity: NormalizedEntity, row: Record<string, unknown> | undefined): T | undefined {
	return row === undefined ? undefined : (decodeFieldValues(entity, row) as T);
}

function decodedRows<T>(entity: NormalizedEntity, rows: readonly Record<string, unknown>[]): T[] {
	return rows.map((row) => decodeFieldValues(entity, row) as T);
}

function assertHeightForLookup(number: number): void {
	parseBlockAddress(number);
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
