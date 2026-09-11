import {
	assertListingLimit,
	assertRetained,
	blockAlreadyRecorded,
	blockHashAlreadyRecorded,
	blockNotAboveTip,
	boundedListing,
	idValues,
	mustGet,
	normalizeBlockHash,
	normalizeEntities,
	pruneBudget,
	pruneRecord,
	resolveRetention,
	retentionEnforcementOf,
	retentionFloor,
	StoreWriterChangedError,
	writerToken,
	type BlockPointer,
	type EntityDeclaration,
	type EntityId,
	type EntityIdPrefix,
	type Listing,
	type Mutation,
	type NormalizedEntity,
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
import {committed, openDatabase, request, walk} from './idb.js';
import {
	above,
	asOfRange,
	BLOCKS,
	CURRENT,
	CURSORS,
	HASH_INDEX,
	listingRange,
	LOWER_INDEX,
	rowKey,
	rowOfVersionKey,
	SCHEMA_VERSION,
	SEAM,
	UPPER_INDEX,
	versionKey,
	VERSIONS,
	WRITER_KEY,
	type BlockRecord,
	type CurrentRecord,
	type VersionRecord,
} from './keys.js';

/** The database a store opens when the host does not name one. */
export const DEFAULT_DATABASE_NAME = 'etherfold-state';

export type IndexedDBStateStoreOptions = RetentionOptions & {
	/**
	 * The IndexedDB database to keep this state in. Defaults to
	 * `etherfold-state`.
	 *
	 * It is the identity of the state, so two stores sharing a name are ONE store
	 * (which is what makes several tabs of one app work) and two UNRELATED
	 * indexers sharing a name would write into each other. An origin running more
	 * than one processor names them apart here.
	 */
	readonly databaseName?: string;
	/**
	 * What the deployment asks this store to keep. Defaults to `unbounded`.
	 *
	 * Validated at construction rather than at the first read it would have
	 * answered wrongly: a window below the finality depth is refused here, naming
	 * both numbers. What is set is what gets REPORTED, because this store enforces
	 * both halves of it: a read outside the window is refused, and `prune` drops
	 * the versions the window no longer covers.
	 */
	readonly retention?: RetentionSetting;
	/**
	 * The IndexedDB implementation to open the database through. Defaults to the
	 * global one.
	 *
	 * For a test running under `fake-indexeddb`, or a host that has its own
	 * factory. It is not a way to make this store work off a browser: the point of
	 * this backend is the engine underneath it.
	 */
	readonly indexedDB?: IDBFactory;
};

/**
 * Entity state as versioned rows in IndexedDB: the browser backend.
 *
 * Every version of every entity is a record carrying `lower` (valid from,
 * inclusive) and `upper` (valid until, exclusive; `null` means live), exactly as
 * `@etherfold/state-store-sqlite` keeps them as columns, so "the state at block
 * N" is a key range rather than a replay and a reorg is two range scans rather
 * than an undo log. The declaration is `{name, id, fields}` and the store owns
 * everything else.
 *
 * ## Why IndexedDB, and what would change the answer
 *
 * Measured, not preferred: on the real workload (the launched stratagems game on
 * Base) IndexedDB beat wasm SQLite on writes by 1.6x to 6.9x and on reads by 4x
 * to 14x, on every engine that can run both, and WebKit cannot run the SQLite
 * route at all. The four things that would have to be true at once for the
 * answer to change, and the five things that would overturn it, are in
 * **ADR-0024**, from `work/notes/findings/sqlite-in-the-browser.md`.
 *
 * What this is NOT is a speed-up over the whole-state blob it replaced
 * (`keepStateOnIndexedDB`, deleted with the free-form path by ADR-0037), which
 * was the FASTEST writer at today's sizes (2.0 ms/block on Chromium against 45.6
 * for row-level writes at 4,072 live rows).
 * What row-level writes buy is history, reorg revert, a cold start that reads
 * only what it needs, and a write cost proportional to what CHANGED rather than
 * to total state. Sold as a speed-up, the first benchmark contradicts it.
 *
 * ## Two rules this implementation lives by
 *
 * **One block is one transaction**, so a block applies whole or not at all, and
 * two tabs writing the same database serialise instead of interleaving.
 *
 * **Inside a transaction, await only IndexedDB.** A promise resolved from an
 * IndexedDB event continues in the same microtask checkpoint and the transaction
 * is still active; anything else lets it auto-commit under code that thinks it
 * still owns it. See `idb.ts`.
 *
 * Those two rules are also the whole of why this backend can enforce a SINGLE
 * WRITER exactly rather than best-effort: the writer token is read and checked
 * in the same serialisable `readwrite` transaction that performs the write, so
 * there is no window between the check and the write for a second tab to land
 * in. See `writer.ts` at the seam and ADR-0075.
 */
export class IndexedDBStateStore implements StateStoreBackend {
	readonly databaseName: string;
	private readonly entities: ReadonlyMap<string, NormalizedEntity>;
	private readonly provided: Retention;
	private readonly finalityDepth: number | undefined;
	private readonly factory: IDBFactory | undefined;
	private connection: Promise<IDBDatabase> | undefined;
	/**
	 * This writer's claim on the database, minted by its first mutation and never
	 * re-minted: a writer that lost the store stays refused, because silently
	 * re-claiming would let two writers take it in turns and corrupt exactly the
	 * state this guard exists to protect.
	 */
	private token: string | undefined;
	/**
	 * Whether a transaction CARRYING the claim has committed.
	 *
	 * Separate from the token because a transaction can abort for reasons of its
	 * own -- a duplicate height is the ordinary one -- and it takes the claim down
	 * with it. Until one commits, this writer has not written, so its next
	 * mutation claims again; after one does, the check is all that stands between
	 * it and a rival. The SQL backend keeps the same two fields for the same
	 * reason, so the two answer identically.
	 */
	private claimed = false;

	constructor(declarations: Iterable<EntityDeclaration>, options: IndexedDBStateStoreOptions = {}) {
		this.entities = normalizeEntities(declarations);
		// resolved at CONSTRUCTION: a retention below the finality floor is a
		// configuration error, and it should land where it was configured rather
		// than on the first read that would have been served wrongly.
		this.provided = resolveRetention(options.retention, options);
		this.finalityDepth = options.finalityDepth;
		this.databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
		this.factory = options.indexedDB;
	}

	get declarations(): ReadonlyMap<string, NormalizedEntity> {
		return this.entities;
	}

	/**
	 * What was configured, because this store enforces all of it.
	 *
	 * `unbounded` by default. A window is reported as a window: reads outside it
	 * are refused by `getAsOf` / `listAsOf` at all times, and `prune` drops the
	 * versions it no longer covers. `revert-only` refuses every historical read
	 * while `revertTo` keeps working.
	 *
	 * Readable before `migrate`, and before the database is even opened, which is
	 * the point of a capability report: a caller learns what history it can have
	 * at startup rather than from a wrong answer later.
	 */
	get capabilities(): StateStoreCapabilities {
		return {retention: this.provided, asOf: this.provided.kind !== 'revert-only', singleWriter: true};
	}

	/**
	 * Open the database, creating the object stores and indexes the first time.
	 *
	 * Idempotent and safe on every boot: the schema is FIXED (see `keys.ts`), so
	 * declaring another entity is not a migration here and cannot be blocked by a
	 * second open tab.
	 */
	async migrate(): Promise<void> {
		await this.database();
	}

	/**
	 * Read the writer token and either CLAIM the database or check this writer
	 * still holds it -- inside the caller's transaction, before it writes.
	 *
	 * This is the whole mechanism, and it is short because the substrate does the
	 * hard part: a `readwrite` transaction serialises across tabs, so this check
	 * and the writes that follow it are one indivisible unit and a rival's claim
	 * is either wholly before it (we are refused) or wholly after it (it is
	 * refused). There is no window, so there is no timing assumption.
	 *
	 * The first mutation through a handle claims UNCONDITIONALLY, taking the store
	 * from whoever held it. That is what makes a crashed writer harmless: there is
	 * no lease to expire, nothing to clear by hand, and the next writer waits for
	 * nothing. The loser finds out at its next mutation, which is the point.
	 */
	private async claimOrCheck(tx: IDBTransaction, settled: Promise<void>, operation: string): Promise<void> {
		const writer = tx.objectStore(SEAM);
		if (!this.claimed) {
			this.token ??= writerToken();
			writer.put(this.token, WRITER_KEY);
			// only a COMMITTED claim is a claim; the rejection is swallowed because
			// the caller is being told what happened in better words already.
			settled.then(
				() => (this.claimed = true),
				() => undefined,
			);
			return;
		}
		const held = (await request(writer.get(WRITER_KEY))) as string | undefined;
		if (held !== this.token) throw abort(tx, settled, new StoreWriterChangedError(operation));
	}

	/**
	 * Close the connection.
	 *
	 * Not part of the seam, and needed anyway: a browser cannot delete a database
	 * while a connection is open, and a test that leaves one open blocks the next
	 * one. The store reopens on the next call.
	 */
	async close(): Promise<void> {
		const connection = this.connection;
		this.connection = undefined;
		if (connection) (await connection).close();
	}

	/**
	 * Apply one block: the block record plus every mutation, as ONE transaction.
	 *
	 * Every mutation is resolved against the declarations BEFORE the transaction
	 * is opened, so a mutation naming an entity that was never declared leaves the
	 * store exactly as it found it and leaves the block's height free.
	 *
	 * Re-applying a height, or a second hash claiming one, is refused rather than
	 * written: two versions of one business key open at once is a state every
	 * later read would have to pick between. A reorged height is REVERTED and then
	 * re-applied.
	 *
	 * So is a height that is not ABOVE the recorded tip, which is the same rule one
	 * step wider: the caller reverts to the fork before it applies the branch that
	 * replaces it, so every apply lands above what the store holds, and an offer at
	 * or below the tip is a writer working from a position this store has passed --
	 * a backgrounded tab resuming on a stale cursor is the ordinary way to get one.
	 * The tip is read from the BLOCKS store inside this same transaction, which is
	 * what makes it a genuine compare-and-swap: another tab's revert cannot lower it
	 * between the read and the write, because a `readwrite` transaction serialises
	 * across connections. An EMPTY store has no tip and admits any height.
	 *
	 * Two mutations of ONE business key in one block resolve to the last of them,
	 * because a version is keyed by `(id, lower)` and a block opens at most one
	 * version per key here. The SQL backend keeps both (its version identity is a
	 * surrogate row id) and the extra one is a zero-width version no read can ever
	 * return, so the two backends answer identically; they differ only in what they
	 * store. `MutationContext` coalesces per business key anyway, so this is only
	 * reachable by calling `applyBlock` directly.
	 *
	 * The optional `cursor` is written inside that same transaction, which is the
	 * point of the cursor living behind the seam at all: the block and the record
	 * of having reached it commit together or neither does. See `cursor.ts`.
	 */
	async applyBlock(block: BlockPointer, mutations: readonly Mutation[] = [], cursor?: CursorWrite): Promise<void> {
		const hash = normalizeBlockHash(block.hash);
		const planned = mutations.map((mutation) => {
			const entity = mustGet(this.entities, mutation.entity);
			return {mutation, entity, key: rowKey(entity, mutation.id), id: idValues(entity, mutation.id)};
		});

		const db = await this.database();
		const tx = db.transaction([CURRENT, VERSIONS, BLOCKS, CURSORS, SEAM], 'readwrite');
		const current = tx.objectStore(CURRENT);
		const versions = tx.objectStore(VERSIONS);
		const blocks = tx.objectStore(BLOCKS);
		const settled = committed(tx);

		// FIRST, so a writer that has lost the store is told THAT rather than
		// whatever the block checks below would have said about a state it no longer
		// has any business writing to.
		await this.claimOrCheck(tx, settled, 'applyBlock');

		const recorded = (await request(blocks.get(block.number))) as BlockRecord | undefined;
		if (recorded) {
			throw abort(tx, settled, blockAlreadyRecorded(block.number));
		}
		const claimed = await request(blocks.index(HASH_INDEX).getKey(hash));
		if (claimed !== undefined) {
			throw abort(tx, settled, blockHashAlreadyRecorded(hash, claimed as number));
		}
		// AFTER the two above, so the ordinary caller bug -- re-applying a block --
		// keeps the message that names it, and this one answers the case those cannot:
		// a height the tip has passed and nothing ever recorded. One cursor, backwards
		// over the primary key, so it costs a single key read and no scan.
		const tipCursor = await request(blocks.openCursor(null, 'prev'));
		const tip = tipCursor ? (tipCursor.key as number) : undefined;
		if (tip !== undefined && block.number <= tip) {
			throw abort(tx, settled, blockNotAboveTip(block.number, tip));
		}

		for (const {mutation, entity, key, id} of planned) {
			const previous = (await request(current.get(key))) as CurrentRecord | undefined;
			// close the live version AT this block: the range is half-open, so the
			// version that was live is readable as of every block below this one.
			if (previous) {
				versions.put(
					{lower: previous.lower, upper: block.number, values: previous.values},
					versionKey(key, previous.lower),
				);
			}
			if (mutation.type === 'upsert') {
				const values = completeRow(entity, id, mutation.values);
				current.put({lower: block.number, values}, key);
				versions.put({lower: block.number, upper: null, values}, versionKey(key, block.number));
			} else if (previous) {
				// a delete is ONLY the close: no version is opened, so the entity is
				// absent from this block onward and fully readable as of any earlier one.
				current.delete(key);
			}
		}

		blocks.put({number: block.number, hash, timestamp: block.timestamp} satisfies BlockRecord);
		if (cursor) tx.objectStore(CURSORS).put(cursor.value, cursor.key);
		await settled;
	}

	/** The opaque string last written under `key`, or `undefined`. See `cursor.ts`. */
	async readCursor(key: string): Promise<string | undefined> {
		const db = await this.database();
		const store = db.transaction(CURSORS, 'readonly').objectStore(CURSORS);
		return (await request(store.get(key))) as string | undefined;
	}

	/**
	 * Move a cursor with no block behind it. See `StateStoreBackend.writeCursor`.
	 *
	 * Guarded like every other mutation, and this is the path the guard exists
	 * for most: there is no block record here to refuse a stale writer
	 * incidentally, so this is how a position moves BACKWARDS silently.
	 */
	async writeCursor(key: string, value: string): Promise<void> {
		const db = await this.database();
		const tx = db.transaction([CURSORS, SEAM], 'readwrite');
		const settled = committed(tx);
		await this.claimOrCheck(tx, settled, 'writeCursor');
		tx.objectStore(CURSORS).put(value, key);
		await settled;
	}

	/** Forget it. Deleting a key that is not there is the no-op the contract asks for. */
	async clearCursor(key: string): Promise<void> {
		const db = await this.database();
		const tx = db.transaction([CURSORS, SEAM], 'readwrite');
		const settled = committed(tx);
		await this.claimOrCheck(tx, settled, 'clearCursor');
		tx.objectStore(CURSORS).delete(key);
		await settled;
	}

	/**
	 * The seam's own record under `key`, out of the object store the CALLER cannot
	 * reach. See `records.ts` at the seam and `SEAM` in `keys.ts`.
	 *
	 * A READ, so it opens a `readonly` transaction and never claims: this is what
	 * `openSnapshotAware` calls on every boot, including in a tab that only
	 * renders.
	 */
	async readSeamRecord(key: SeamRecordKey): Promise<string | undefined> {
		const db = await this.database();
		const store = db.transaction(SEAM, 'readonly').objectStore(SEAM);
		return (await request(store.get(key))) as string | undefined;
	}

	/** Write one of the seam's records, guarded like every other mutation. */
	async writeSeamRecord(key: SeamRecordKey, value: string): Promise<void> {
		const db = await this.database();
		const tx = db.transaction(SEAM, 'readwrite');
		const settled = committed(tx);
		await this.claimOrCheck(tx, settled, 'writeSeamRecord');
		tx.objectStore(SEAM).put(value, key);
		await settled;
	}

	/**
	 * Forget one of the seam's records. Deleting a key that is not there is the
	 * no-op the contract asks for -- and is how `openForWriting` claims.
	 */
	async clearSeamRecord(key: SeamRecordKey): Promise<void> {
		const db = await this.database();
		const tx = db.transaction(SEAM, 'readwrite');
		const settled = committed(tx);
		await this.claimOrCheck(tx, settled, 'clearSeamRecord');
		tx.objectStore(SEAM).delete(key);
		await settled;
	}

	/** One entity as it stands at the tip: one `get` against the live set. */
	async getCurrent<T = Record<string, unknown>>(entity: string, id: EntityId): Promise<T | undefined> {
		const declaration = mustGet(this.entities, entity);
		const db = await this.database();
		const store = db.transaction(CURRENT, 'readonly').objectStore(CURRENT);
		const record = (await request(store.get(rowKey(declaration, id)))) as CurrentRecord | undefined;
		return record && ({...record.values, _lower: record.lower, _upper: null} as T);
	}

	/**
	 * One entity as of a block number, or a refusal.
	 *
	 * The refusal is the seam's (`assertRetained`) and it comes BEFORE the read: a
	 * historical read this store's declared retention does not cover throws rather
	 * than answering, because an as-of read quietly served from the tip is a
	 * plausible wrong number nothing downstream can tell apart from a true one.
	 *
	 * The read itself is one cursor walked BACKWARDS over the versions of this
	 * business key that opened at or before the block asked about: the first hit
	 * is the newest of them, and it is the answer unless it had already been
	 * closed by then.
	 */
	async getAsOf<T = Record<string, unknown>>(entity: string, id: EntityId, at: number): Promise<T | undefined> {
		const declaration = mustGet(this.entities, entity);
		await assertRetained(this.capabilities, at, () => this.tipBlockNumber());
		const db = await this.database();
		const store = db.transaction(VERSIONS, 'readonly').objectStore(VERSIONS);
		const cursor = await request(store.openCursor(asOfRange(rowKey(declaration, id), at), 'prev'));
		if (!cursor) return undefined;
		const version = cursor.value as VersionRecord;
		if (version.upper !== null && version.upper <= at) return undefined;
		return {...version.values, _lower: version.lower, _upper: version.upper} as T;
	}

	/**
	 * The children of an id PREFIX at the tip: one `IDBKeyRange` cursor over the
	 * live set, bounded by the limit.
	 *
	 * The range is `bound([entity, ...prefix], [entity, ...prefix, []])`, which is
	 * every key starting with the prefix and nothing else, so this is an indexed
	 * range scan and never a scan with a filter over it. That is the whole reason
	 * the seam's only set read has this exact shape (ADR-0021), and it is asserted
	 * rather than assumed in `test/listing-access-path.test.ts`.
	 */
	async listCurrent<T = Record<string, unknown>>(
		entity: string,
		prefix: EntityIdPrefix,
		limit: number,
	): Promise<Listing<T>> {
		const declaration = mustGet(this.entities, entity);
		const range = listingRange(declaration, prefix);
		assertListingLimit(declaration, limit);

		const db = await this.database();
		const store = db.transaction(CURRENT, 'readonly').objectStore(CURRENT);
		const rows: T[] = [];
		// one MORE than the limit, which is how `truncated` is a fact rather than a
		// guess a caller has to make from `rows.length`.
		await walk(store.openCursor(range), (cursor) => {
			const record = cursor.value as CurrentRecord;
			rows.push({...record.values, _lower: record.lower, _upper: null} as T);
			return rows.length > limit ? 'stop' : 'continue';
		});
		return boundedListing(rows, limit);
	}

	/**
	 * The same listing as of a block number: the children that were live THEN.
	 *
	 * The same range over the VERSIONS, which are ordered by `[entity, ...id,
	 * lower]`, so the versions of one row arrive together and in the order they
	 * opened. At most one of them is live at the block asked about, so the walk
	 * emits at most one row per business key and does it in ascending id order
	 * without sorting anything.
	 */
	async listAsOf<T = Record<string, unknown>>(
		entity: string,
		prefix: EntityIdPrefix,
		at: number,
		limit: number,
	): Promise<Listing<T>> {
		const declaration = mustGet(this.entities, entity);
		const range = listingRange(declaration, prefix);
		assertListingLimit(declaration, limit);
		await assertRetained(this.capabilities, at, () => this.tipBlockNumber());

		const db = await this.database();
		const store = db.transaction(VERSIONS, 'readonly').objectStore(VERSIONS);
		const rows: T[] = [];
		await walk(store.openCursor(range), (cursor) => {
			const version = cursor.value as VersionRecord;
			if (version.lower <= at && (version.upper === null || at < version.upper)) {
				rows.push({...version.values, _lower: version.lower, _upper: version.upper} as T);
				if (rows.length > limit) return 'stop';
			}
			return 'continue';
		});
		return boundedListing(rows, limit);
	}

	/**
	 * Roll the state back to `keepUpTo`: the SQL backend's two moves, as two
	 * index range scans.
	 *
	 * Leg A drops the versions the dead branch OPENED (`lower` above the fork).
	 * Leg B re-opens the versions it CLOSED (`upper` above the fork), which is
	 * what makes a counter a reorged block incremented go back DOWN, and what
	 * brings back a row a reorged block deleted.
	 *
	 * The order is load-bearing: a version the dead branch closed can only become
	 * live again once the dead branch's own version is gone, or two versions of
	 * one business key would be open at once. Both legs also fix the live set as
	 * they go, so the tip read and the tip listing see the reverted state rather
	 * than a stale copy of the dead branch.
	 *
	 * There is deliberately no undo journal per block. The two indexes already
	 * say exactly which versions are above the fork, so a revert costs what it
	 * touches, and a journal would be a second description of the same fact that
	 * grows with every mutation ever applied.
	 */
	async revertTo(keepUpTo: number): Promise<void> {
		// `CURSORS` is deliberately not in this transaction: how far the CALLER got is
		// not entity state, and the caller moves it when it applies the canonical
		// branch. See `cursor.ts`.
		const db = await this.database();
		const tx = db.transaction([CURRENT, VERSIONS, BLOCKS, SEAM], 'readwrite');
		const current = tx.objectStore(CURRENT);
		const versions = tx.objectStore(VERSIONS);
		const blocks = tx.objectStore(BLOCKS);
		const settled = committed(tx);

		// the destructive path, so the guard matters most here: this is the one that
		// can leave a WRONG state rather than an exception.
		await this.claimOrCheck(tx, settled, 'revertTo');

		await walk(versions.index(LOWER_INDEX).openCursor(above(keepUpTo)), (cursor) => {
			current.delete(rowOfVersionKey(cursor.primaryKey as IDBValidKey[]));
			cursor.delete();
			return 'continue';
		});

		await walk(versions.index(UPPER_INDEX).openCursor(above(keepUpTo)), (cursor) => {
			const version = cursor.value as VersionRecord;
			cursor.update({...version, upper: null} satisfies VersionRecord);
			current.put(
				{lower: version.lower, values: version.values} satisfies CurrentRecord,
				rowOfVersionKey(cursor.primaryKey as IDBValidKey[]),
			);
			return 'continue';
		});

		blocks.delete(above(keepUpTo));
		await settled;
	}

	/**
	 * Delete the versions the retention floor puts out of reach, oldest close
	 * first, and report what went.
	 *
	 * The tip, the floor derived from it and the deletion are ONE transaction, so
	 * the floor is never computed against a tip another writer has moved.
	 *
	 * The predicate is the seam's (`retentionFloor`) and the access path is this
	 * backend's: the `upper` index holds exactly the CLOSED versions, ordered by
	 * the block that closed them, because a live version's `upper` is `null` and
	 * `null` is not a valid IndexedDB key. So the LIVE version of an entity --
	 * the current state, however old, which is the row a prune written as "drop
	 * what is older than the floor" destroys -- cannot be reached from here at
	 * all, and the pass is a range scan rather than the full scan the spike's
	 * prototype used (6.3 s at 62,553 versions in the finding).
	 *
	 * Oldest first matters when a budget stops the pass: what survives a partial
	 * prune is the newest of the unreachable versions, so the store converges
	 * towards the window from the far end rather than leaving arbitrary holes.
	 *
	 * It never touches the block records. They are three fields each, they are
	 * what makes re-applying a height raise, and dropping them would turn "that
	 * block is outside what I keep" into "there is no such block", which is a
	 * worse answer and, for a consumer that pinned the hash, a wrong one.
	 */
	async prune(options: PruneOptions = {}): Promise<PruneReport> {
		const budget = pruneBudget(options);

		const db = await this.database();
		// BLOCKS is in here so the TIP is read inside the transaction that then
		// deletes against it. It used to be read outside, which made the retention
		// floor a number computed from a tip another writer could have moved between
		// the read and the delete -- the read-then-write that merely LOOKS atomic.
		// Widening the transaction is what closes that, and the writer token is what
		// makes the closure hold across tabs (ADR-0075).
		// SEAM is in here for the guard AND for the `retentionEnforcement` record this
		// pass leaves, so that what was deleted and the claim that a pass ran commit
		// together rather than in two transactions a crash can separate.
		const tx = db.transaction([VERSIONS, BLOCKS, SEAM], 'readwrite');
		const versions = tx.objectStore(VERSIONS);
		const settled = committed(tx);
		// a prune that turns out to delete nothing still claims: pruning is a write
		// path, and whoever prunes is the writer (see the seam's `prune`).
		await this.claimOrCheck(tx, settled, 'prune');

		const tipCursor = await request(tx.objectStore(BLOCKS).openCursor(null, 'prev'));
		const tip = tipCursor ? (tipCursor.key as number) : undefined;
		const floor = tip === undefined ? undefined : retentionFloor(this.provided, tip, this.finalityDepth);
		if (floor === undefined) {
			await settled;
			return {tip, floor: undefined, versionsDeleted: 0, complete: true};
		}

		const record = pruneRecord(floor);
		if (record !== undefined) tx.objectStore(SEAM).put(record, 'retentionEnforcement' satisfies SeamRecordKey);

		let versionsDeleted = 0;
		await walk(versions.index(UPPER_INDEX).openCursor(IDBKeyRange.upperBound(floor)), (cursor) => {
			cursor.delete();
			versionsDeleted++;
			return versionsDeleted >= budget ? 'stop' : 'continue';
		});
		await settled;

		// Without a budget the range was drained, so the pass is complete by
		// construction. With one, whether anything is left is a question only the
		// database can answer, and one bounded probe is cheaper than making the
		// caller guess.
		const complete = versionsDeleted < budget || !(await this.hasPrunableVersions(floor));
		return {tip, floor, versionsDeleted, complete};
	}

	/**
	 * Whether the retention this store reports is enforced against its storage.
	 *
	 * Durable across a reload, which on this backend is the case that matters
	 * most: a tab that pruned yesterday comes back reporting the block it pruned
	 * to, because the record is a row in the same database as the versions rather
	 * than a flag in a closure the reload threw away.
	 *
	 * A READ, so it opens no `readwrite` transaction and never claims: asking
	 * whether a store is being pruned must not take the store away from the tab
	 * that is pruning it.
	 */
	async readRetentionEnforcement(): Promise<RetentionEnforcement> {
		return retentionEnforcementOf(
			this.provided,
			this.finalityDepth,
			await this.tipBlockNumber(),
			await this.readSeamRecord('retentionEnforcement'),
		);
	}

	/**
	 * The block recorded at a height, or `undefined`.
	 *
	 * Not part of the seam: addressing state by hash or by time (and refusing
	 * an address that resolves to nothing) is the read layer above the seam. This
	 * is here so a caller, or a test, can see what was recorded.
	 */
	async getBlock(number: number): Promise<BlockRecord | undefined> {
		const db = await this.database();
		const store = db.transaction(BLOCKS, 'readonly').objectStore(BLOCKS);
		return (await request(store.get(number))) as BlockRecord | undefined;
	}

	// -- internals -----------------------------------------------------------

	/**
	 * The highest recorded block, or `undefined` before the first one is applied.
	 *
	 * Read from the database every time rather than cached, and that is the
	 * multi-tab decision showing up in the smallest place: another tab may have
	 * moved the tip since this one last wrote, and a retention window is a
	 * distance from it, so a cached tip would refuse reads that are inside the
	 * window (or answer ones that are not). It is only ever read when a WINDOW is
	 * claimed, because `assertRetained` takes it as a thunk.
	 */
	private async tipBlockNumber(): Promise<number | undefined> {
		const db = await this.database();
		const store = db.transaction(BLOCKS, 'readonly').objectStore(BLOCKS);
		const cursor = await request(store.openCursor(null, 'prev'));
		return cursor ? (cursor.key as number) : undefined;
	}

	/** Whether any version is still unreachable at `floor`: one bounded probe. */
	private async hasPrunableVersions(floor: number): Promise<boolean> {
		const db = await this.database();
		const store = db.transaction(VERSIONS, 'readonly').objectStore(VERSIONS);
		const cursor = await request(store.index(UPPER_INDEX).openCursor(IDBKeyRange.upperBound(floor)));
		return cursor !== null;
	}

	/**
	 * The one connection, opened on first use and reused.
	 *
	 * A failed open does not poison the store: the promise is dropped so the next
	 * call tries again, which is what a tab that was denied storage and then
	 * granted it needs.
	 */
	private database(): Promise<IDBDatabase> {
		if (!this.connection) {
			const factory = this.factory ?? (globalThis as {indexedDB?: IDBFactory}).indexedDB;
			if (!factory) {
				return Promise.reject(
					new Error(
						`no IndexedDB in this environment: @etherfold/state-store-indexeddb is the BROWSER backend. On a ` +
							`server use @etherfold/state-store-sqlite, in a test either MemoryStateStore (the seam's reference ` +
							`store) or fake-indexeddb, or pass your own factory as \`indexedDB\`.`,
					),
				);
			}
			this.connection = openDatabase(this.databaseName, SCHEMA_VERSION, upgrade, factory).catch((error) => {
				this.connection = undefined;
				throw error;
			});
		}
		return this.connection;
	}
}

/**
 * Create the fixed schema, and add whatever a newer version of this package
 * introduced.
 *
 * The version is this PACKAGE's and never a processor's: the object stores do not
 * depend on the declarations (`keys.ts` says why), so a processor gaining an
 * entity never needs an upgrade transaction that an open tab could block. Every
 * step is `contains`-guarded so an existing database gains the missing store and
 * keeps every row it had.
 */
function upgrade(db: IDBDatabase): void {
	if (!db.objectStoreNames.contains(SEAM)) db.createObjectStore(SEAM);
	if (!db.objectStoreNames.contains(CURSORS)) db.createObjectStore(CURSORS);
	if (!db.objectStoreNames.contains(CURRENT)) db.createObjectStore(CURRENT);
	if (!db.objectStoreNames.contains(VERSIONS)) {
		const versions = db.createObjectStore(VERSIONS);
		versions.createIndex(LOWER_INDEX, 'lower');
		versions.createIndex(UPPER_INDEX, 'upper');
	}
	if (!db.objectStoreNames.contains(BLOCKS)) {
		const blocks = db.createObjectStore(BLOCKS, {keyPath: 'number'});
		blocks.createIndex(HASH_INDEX, 'hash', {unique: true});
	}
}

/**
 * A version is a COMPLETE row: the id columns, plus every declared field, with
 * the ones the mutation did not list written as NULL rather than carried
 * forward. A store that carried them forward would be keeping deltas while
 * claiming to keep versions.
 */
function completeRow(
	entity: NormalizedEntity,
	id: readonly string[],
	values: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const row: Record<string, unknown> = {};
	entity.id.forEach((column, index) => (row[column] = id[index]));
	for (const field of Object.keys(entity.fields)) {
		row[field] = values?.[field] ?? null;
	}
	return row;
}

/**
 * Abort the transaction and return the error to throw.
 *
 * The rejection of the transaction promise is swallowed deliberately: the caller
 * is about to be told what happened in better words than `AbortError`, and an
 * unobserved rejection would surface as an unhandled one.
 *
 * A caller may hand over a MESSAGE (the refusals that are caller bugs) or a
 * built ERROR (`StoreWriterChangedError`, which is a lost race and has to be
 * distinguishable by type). Aborting is what makes both of them leave the store
 * byte-identical.
 */
function abort(tx: IDBTransaction, settled: Promise<void>, reason: string | Error): Error {
	settled.catch(() => undefined);
	tx.abort();
	return typeof reason === 'string' ? new Error(reason) : reason;
}
