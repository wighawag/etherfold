import {
	assertListingLimit,
	assertRetained,
	assertFinalityDepth,
	BlockNotRetainedError,
	blockNotAboveTip,
	boundedListing,
	compareIds,
	entityKey,
	hasIdPrefix,
	idValues,
	mustGet,
	normalizeBlockHash,
	normalizeEntities,
	prefixValues,
	pruneBudget,
	pruneRecord,
	retentionEnforcementOf,
	retentionFloor,
	RETENTION_ENFORCEMENT_KEY,
	type BlockPointer,
	type EntityDeclaration,
	type EntityId,
	type EntityIdPrefix,
	type Listing,
	type Mutation,
	type NormalizedEntity,
	type PruneOptions,
	type PruneReport,
	type CursorWrite,
	type Retention,
	type RetentionEnforcement,
	type StateStoreBackend,
	type StateStoreCapabilities,
} from '@etherfold/state-store';
import {RevertBeyondPatchHistoryError} from './errors.js';
import {applyPatches, produceWithPatches, type Patch} from './immer.js';

/** One complete row: the id columns and every declared field, unlisted ones NULL. */
type Row = Record<string, unknown>;
/** The rows of one entity, keyed by the stringified business key. */
type EntityRows = {[key: string]: Row};
/** The whole of the current state, as a plain object: entity -> key -> row. */
type LightState = {[entity: string]: EntityRows};

/** The separator `entityKey` uses; a bucket is already per entity, so the name is dropped. */
const SEPARATOR = '\u0000';

/** The retention this store has, and the only one it can have. */
const REVERT_ONLY: Retention = {kind: 'revert-only'};

/**
 * What this store reports, which is the seam's report plus one word of its own.
 *
 * `durability` is not at the seam because every other backend answers it by
 * existing on disk, and inventing a field every backend must fill would be a
 * change to the shared contract for one implementation's benefit. It is on the
 * REPORT rather than only in the README because that is where a caller already
 * looks at startup: a browser tab that reloads to an empty store should learn it
 * from the capability it read, not from a support ticket.
 */
export type PatchStateStoreCapabilities = StateStoreCapabilities & {
	/** Nothing survives the process. State and reverse patches are both in memory. */
	readonly durability: 'memory-only';
};

export type PatchStateStoreOptions = {
	/**
	 * The reorg depth this deployment protects against, in block numbers.
	 *
	 * It is this store's WHOLE retention and therefore its prune floor: `prune`
	 * drops the reverse patches of blocks at or below `tip - finalityDepth`, which
	 * is the same comparison every other backend prunes on
	 * (`retentionFloor`). Leaving it unset states no floor, so nothing is ever
	 * pruned and the patch log grows with the stream -- fine for a test, and not
	 * what a long-running tab wants.
	 */
	readonly finalityDepth?: number;
	/**
	 * Accepted only as `'revert-only'`, which is what this store is.
	 *
	 * It is here so that a deployment can write the retention the same way it
	 * writes it for every other backend and get an ERROR if it asks this one for
	 * a window, rather than a store quietly reporting less than it was set to. A
	 * window would be a claim about ANSWERS this representation cannot make: see
	 * the class documentation.
	 */
	readonly retention?: 'revert-only';
};

/**
 * The light `StateStore`: current state as a plain object, history as immer
 * reverse patches, reorg revert by replaying them backwards.
 *
 * It is the cheapest legitimate implementation of the seam. A browser tab that
 * only needs current state and reorg safety pays nothing for versioned rows,
 * while running the SAME processor as the server: hand this store to
 * `@etherfold/processor-entities` in place of `@etherfold/state-store-sqlite`
 * and the handlers do not change, because a handler writes through
 * `MutationContext` and names no backend.
 *
 * ## It advertises `revert-only`, and that is a measured result
 *
 * Not a limitation to apologise for and not a cost problem. Backwards replay is
 * CORRECT wherever the patches exist: the finding
 * (`work/notes/findings/sqlite-in-the-browser.md`) replayed a dense stream
 * backwards and matched the recorded state at every depth to 64, on Chromium,
 * Firefox, WebKit and node, at a cost linear in depth (126 ms at depth 64 on a
 * laptop).
 *
 * What removes the capability is SPARSITY. History is pruned by BLOCK-NUMBER
 * distance from the tip (`tip - finalityDepth`, the one comparison the seam
 * prunes on), while a real stream carries only event-bearing blocks, which on
 * the launched stratagems game on Base are median **429 blocks apart**. At a
 * finality of 64, exactly ONE block's reversals survive: the tip's. So there is
 * nothing left to replay for an as-of read, and no tuning returns it: raising
 * the depth past the finality it protects would be inventing a window this
 * representation cannot honour on the next contract.
 *
 * Hence: `revertTo` works and is the reason this backend exists, every as-of
 * read is a `BlockNotRetainedError`, and the report says `revert-only` rather
 * than a window. The patch log's SIZE follows the same fact -- 1,702 KB (223% of
 * the state) on a dense synthetic stream, 4.4 KB (1% of it) on the real one,
 * because almost everything is pruned immediately.
 *
 * ## Memory-only, and it says so
 *
 * State and patches both live in the process and go with it. Persisting them is
 * a decision this store deliberately does not make: serialising the whole state
 * blob on every save was the retired `keepStateOnIndexedDB` strategy, which
 * belonged to the `KeepState` seam ABOVE this one and is deleted with it
 * (ADR-0037), and row-level persistence is `@etherfold/state-store-indexeddb`'s
 * job. `capabilities.durability` says
 * `memory-only` so a caller learns it at startup, and a reload is an empty store
 * that must re-index (or hydrate from a snapshot). See ADR-0023.
 *
 * ## What it is NOT
 *
 * Not `MemoryStateStore`, which keeps VERSIONED ROWS in a Map and can therefore
 * answer as-of reads: that one is the executable definition of the seam, this
 * one is the cheap deployment. Not the incumbent light path either, which has no
 * concept of history at all and would answer a historical read from the tip --
 * the single failure mode this design exists to prevent, and worse than an error
 * because it is plausible.
 */
export class PatchStateStore implements StateStoreBackend {
	private readonly entities: ReadonlyMap<string, NormalizedEntity>;
	private readonly finalityDepth: number | undefined;
	private readonly blocks = new Map<number, BlockPointer>();
	private readonly hashes = new Map<string, number>();
	/** Block number -> the patches that UNDO that block, in the order immer produced them. */
	private readonly reversals = new Map<number, Patch[]>();
	/** The sync cursors, opaque strings under caller-chosen keys. See `cursor.ts`. */
	private readonly cursors = new Map<string, string>();
	private state: LightState;
	private tip: number | undefined;

	constructor(declarations: Iterable<EntityDeclaration>, options: PatchStateStoreOptions = {}) {
		this.entities = normalizeEntities(declarations);
		assertRevertOnly(options.retention);
		this.finalityDepth = assertFinalityDepth(options.finalityDepth);

		// one bucket per declared entity, up front, so a mutation never has to
		// create one and a patch never carries the creation of a container.
		const state: LightState = {};
		for (const entity of this.entities.keys()) state[entity] = {};
		this.state = state;
	}

	get declarations(): ReadonlyMap<string, NormalizedEntity> {
		return this.entities;
	}

	/**
	 * `revert-only`, always, plus the durability this representation has.
	 *
	 * It is not derived from what the deployment set, because there is nothing to
	 * derive: this store cannot answer a historical read at any depth, so any
	 * other claim would be fiction. `asOf: false` is what makes
	 * `assertRetained` refuse every as-of read at the seam's own boundary rather
	 * than at one written here.
	 *
	 * `singleWriter: false` for the same reason it is `memory-only`: the state and
	 * the patch log are instance fields, so no second writer can reach them, and a
	 * writer token here could only ever be compared with itself -- a guarantee
	 * that is green, tested and vacuous (`writer.ts`). Two handles on this store
	 * are two stores.
	 */
	get capabilities(): PatchStateStoreCapabilities {
		return {retention: REVERT_ONLY, asOf: false, singleWriter: false, durability: 'memory-only'};
	}

	/** Nothing to create: the shape is the declaration, validated at construction. */
	async migrate(): Promise<void> {}

	/**
	 * Apply one block, all of it or none of it, and keep what undoes it.
	 *
	 * Every mutation is resolved against the declarations BEFORE the state is
	 * touched, so a mutation naming an undeclared entity leaves the store exactly
	 * as it found it and its block unrecorded. The produce that follows cannot
	 * fail halfway either: immer either returns the next state or throws, and the
	 * assignment is one statement.
	 *
	 * The reverse patches are immer's, which is the whole mechanism (ADR-0001):
	 * they are what undoes the change, they are bounded by the finality depth
	 * when the host prunes, and they need no snapshot of the state as of an
	 * earlier block -- which is exactly what a light path does not have.
	 *
	 * A height must be ABOVE the recorded tip, and not merely unused: a caller
	 * reverts to the fork before it applies the branch replacing it, so an offer at
	 * or below the tip is a writer working from a position this store has passed.
	 * An empty store has no tip and admits whatever height it is started at.
	 *
	 * The `cursor` is written LAST, after the point where anything can still
	 * refuse: there is no transaction to join here, so "all or nothing" is
	 * ordering, and the ordering has to be the safe one. Note what this store's
	 * `durability: 'memory-only'` already says about the result -- the cursor goes
	 * with the process, exactly as the state does, so a reload is an empty store
	 * with no cursor rather than a cursor pointing at state that is gone.
	 */
	async applyBlock(block: BlockPointer, mutations: readonly Mutation[] = [], cursor?: CursorWrite): Promise<void> {
		const hash = normalizeBlockHash(block.hash);
		if (this.blocks.has(block.number)) {
			throw new Error(
				`block ${block.number} is already recorded: applying the same block twice is a caller bug, ` +
					`and a reorged height must be reverted before its replacement is applied.`,
			);
		}
		if (this.hashes.has(hash)) {
			throw new Error(`block hash ${hash} is already recorded, at height ${this.hashes.get(hash)}.`);
		}
		// AFTER the two above, so the ordinary caller bug -- re-applying a block --
		// keeps the message that names it, and this one answers the case that message
		// cannot: a height the tip has passed and nothing ever recorded.
		if (this.tip !== undefined && block.number <= this.tip) {
			throw new Error(blockNotAboveTip(block.number, this.tip));
		}

		const planned = mutations.map((mutation) => {
			const entity = mustGet(this.entities, mutation.entity);
			const id = idValues(entity, mutation.id);
			return {mutation, entity, key: id.join(SEPARATOR), id};
		});

		const [next, , reversal] = produceWithPatches(this.state, (draft: LightState) => {
			for (const {mutation, entity, key, id} of planned) {
				const rows = draft[entity.name];
				if (mutation.type === 'upsert') {
					rows[key] = completeRow(entity, id, mutation.values);
				} else if (key in rows) {
					// guarded: deleting an absent key would still be recorded as a
					// change, and its inverse would put the key back holding nothing.
					delete rows[key];
				}
			}
		});

		this.state = next;
		this.reversals.set(block.number, reversal);
		this.blocks.set(block.number, {...block, hash});
		this.hashes.set(hash, block.number);
		if (this.tip === undefined || block.number > this.tip) this.tip = block.number;

		if (cursor) this.cursors.set(cursor.key, cursor.value);
	}

	/** The opaque string last written under `key`, or `undefined`. See `cursor.ts`. */
	async readCursor(key: string): Promise<string | undefined> {
		return this.cursors.get(key);
	}

	/** Move a cursor with no block behind it. See `StateStoreBackend.writeCursor`. */
	async writeCursor(key: string, value: string): Promise<void> {
		this.cursors.set(key, value);
	}

	/** Forget it. A no-op where none was written. */
	async clearCursor(key: string): Promise<void> {
		this.cursors.delete(key);
	}

	/** One entity as it stands at the tip. */
	async getCurrent<T = Record<string, unknown>>(entity: string, id: EntityId): Promise<T | undefined> {
		const declaration = mustGet(this.entities, entity);
		const row = this.state[declaration.name][entityValuesKey(declaration, id)];
		// a copy: the stored row is immer-frozen, and a caller spreading a read
		// back into `update` must not be handed the store's own object.
		return row === undefined ? undefined : ({...row} as T);
	}

	/**
	 * Refused. There is no depth at which this store answers a historical read.
	 *
	 * Note what this method does NOT do: read anything. `assertRetained` throws
	 * for a `revert-only` store, and the line after it throws the same error
	 * again rather than falling through, so there is no edit short of deleting
	 * both statements that turns a historical read into a tip read. That is the
	 * single failure mode this backend exists to prevent, and it is worse than an
	 * error because a tip value served as history is plausible.
	 */
	async getAsOf<T = Record<string, unknown>>(entity: string, id: EntityId, at: number): Promise<T | undefined> {
		await assertRetained(this.capabilities, at, () => this.tip);
		throw new BlockNotRetainedError(at, undefined, 'no-historical-reads', REVERT_ONLY);
	}

	/** The children of a prefix at the tip: a sorted walk, bounded by the limit. */
	async listCurrent<T = Record<string, unknown>>(
		entity: string,
		prefix: EntityIdPrefix,
		limit: number,
	): Promise<Listing<T>> {
		const declaration = mustGet(this.entities, entity);
		const values = prefixValues(declaration, prefix);
		assertListingLimit(declaration, limit);

		const rows = this.state[declaration.name];
		const found: {id: readonly string[]; row: Row}[] = [];
		for (const key of Object.keys(rows)) {
			const id = key.split(SEPARATOR);
			if (!hasIdPrefix(id, values)) continue;
			found.push({id, row: rows[key]});
		}
		found.sort((a, b) => compareIds(a.id, b.id));

		// one MORE than the limit, which is how `truncated` is a fact rather than a guess
		return boundedListing(
			found.slice(0, limit + 1).map(({row}) => ({...row}) as T),
			limit,
		);
	}

	/** Refused, exactly as `getAsOf` is, and for the same reason. */
	async listAsOf<T = Record<string, unknown>>(
		entity: string,
		prefix: EntityIdPrefix,
		at: number,
		limit: number,
	): Promise<Listing<T>> {
		await assertRetained(this.capabilities, at, () => this.tip);
		throw new BlockNotRetainedError(at, undefined, 'no-historical-reads', REVERT_ONLY);
	}

	/**
	 * Undo every block above `keepUpTo` by replaying its reverse patches
	 * backwards, or refuse.
	 *
	 * Highest block first, because each block's reversal was produced against the
	 * state as it stood when that block was applied: undoing them out of order
	 * would apply a patch to a state it was never the inverse of.
	 *
	 * The refusal is checked over the WHOLE range before anything is replayed, so
	 * a store that cannot fully honour the revert is left untouched rather than
	 * half-reverted. A partly-undone reorg is the plausible wrong state this
	 * design refuses to produce (`RevertBeyondPatchHistoryError`).
	 */
	async revertTo(keepUpTo: number): Promise<void> {
		// the cursors are deliberately untouched: how far the CALLER got is not entity
		// state, and the caller moves it when it applies the canonical branch.
		const above = [...this.blocks.keys()].filter((number) => number > keepUpTo).sort((a, b) => b - a);
		if (above.length === 0) return;

		const missing = above.filter((number) => !this.reversals.has(number)).sort((a, b) => a - b);
		if (missing.length > 0) {
			throw new RevertBeyondPatchHistoryError(keepUpTo, missing, this.deepestRevert(), this.finalityDepth);
		}

		let state = this.state;
		for (const number of above) {
			state = applyPatches(state, this.reversals.get(number) as Patch[]);
		}
		this.state = state;

		for (const number of above) {
			this.reversals.delete(number);
			const block = this.blocks.get(number) as BlockPointer;
			this.hashes.delete(block.hash);
			this.blocks.delete(number);
		}

		// the tip moves DOWN with the revert: the prune floor is a distance from it
		this.tip = undefined;
		for (const number of this.blocks.keys()) {
			if (this.tip === undefined || number > this.tip) this.tip = number;
		}
	}

	/**
	 * Drop the reverse patches the retention floor puts out of reach, oldest
	 * first.
	 *
	 * The floor is the seam's (`retentionFloor`), which for `revert-only` is
	 * `tip - finalityDepth`: this store keeps history for exactly as long as
	 * reorg revert needs it, and a deployment that declared no depth has stated
	 * no floor and gets no pruning rather than a guessed one.
	 *
	 * Two things it does NOT drop. The current state: a row is a row here, not a
	 * version, so pruning history cannot touch it -- which is the failure mode
	 * (`the live version of a row written once and never revisited`) that a
	 * versioned backend has to write an explicit predicate to avoid. And the
	 * block records: they are what makes re-applying a height raise and what a
	 * revert measures against, they are three fields each, and dropping them
	 * would trade a correctness property for nothing.
	 *
	 * `versionsDeleted` counts BLOCKS whose reversals went, since one block's
	 * reverse patches are this backend's unit of history, and `maxVersions`
	 * budgets the same unit.
	 */
	async prune(options: PruneOptions = {}): Promise<PruneReport> {
		const tip = this.tip;
		const floor = tip === undefined ? undefined : retentionFloor(REVERT_ONLY, tip, this.finalityDepth);
		const budget = pruneBudget(options);
		if (floor === undefined) return {tip, floor: undefined, versionsDeleted: 0, complete: true};

		const unreachable = [...this.reversals.keys()].filter((number) => number <= floor).sort((a, b) => a - b);
		const doomed = budget === Number.POSITIVE_INFINITY ? unreachable : unreachable.slice(0, budget);
		for (const number of doomed) this.reversals.delete(number);

		// AFTER the deletion, so the record can never claim a pass that did not
		// happen. It rides the cursor map like every other cursor, which on this
		// backend means it goes with the process exactly as the state does.
		const record = pruneRecord(floor);
		if (record !== undefined) this.cursors.set(RETENTION_ENFORCEMENT_KEY, record);

		return {tip, floor, versionsDeleted: doomed.length, complete: doomed.length === unreachable.length};
	}

	/**
	 * Whether the retention this store reports is enforced against its storage.
	 *
	 * This backend is `revert-only` by construction, so the answer turns entirely
	 * on whether a finality depth was declared: without one it has stated no floor
	 * and reports `no-floor`, and with one it has a floor and must be pruned like
	 * any other store. That is the case a host testing for a WINDOW gets wrong,
	 * and it is this backend's ordinary configuration.
	 *
	 * Nothing here survives the process (`durability: 'memory-only'`), so the
	 * durability the report promises elsewhere is vacuous here rather than false:
	 * a store that did not survive cannot come back claiming anything.
	 */
	async readRetentionEnforcement(): Promise<RetentionEnforcement> {
		return retentionEnforcementOf(
			REVERT_ONLY,
			this.finalityDepth,
			this.tip,
			this.cursors.get(RETENTION_ENFORCEMENT_KEY),
		);
	}

	/**
	 * The blocks whose reverse patches are still held, ascending: how deep a
	 * revert can still go.
	 *
	 * Not part of the seam, because on a versioned backend the same question
	 * is answered by the retention window. It is here because on THIS backend the
	 * honest depth is a fact about the stream rather than about the setting -- on
	 * a sparse one a declared depth of 64 leaves a single block -- and a host that
	 * wants to know before it asks should be able to.
	 */
	retainedReversals(): number[] {
		return [...this.reversals.keys()].sort((a, b) => a - b);
	}

	/**
	 * The block recorded at a height, or `undefined`.
	 *
	 * Not part of the seam: addressing state by hash or by time is the read
	 * layer above the seam. This is here so a test, or a host deciding what to
	 * re-index, can see what was recorded.
	 */
	async getBlock(number: number): Promise<BlockPointer | undefined> {
		const block = this.blocks.get(number);
		return block && {...block};
	}

	/**
	 * The lowest `keepUpTo` a revert can still honour, or `undefined` if none can.
	 *
	 * Reversals are pruned oldest-first, so the blocks without them are a PREFIX
	 * of the recorded blocks and the boundary is one number: the highest recorded
	 * block that can no longer be undone.
	 */
	private deepestRevert(): number | undefined {
		let deepest: number | undefined;
		for (const number of this.blocks.keys()) {
			if (this.reversals.has(number)) continue;
			if (deepest === undefined || number > deepest) deepest = number;
		}
		return deepest;
	}
}

/** The bucket key of one business key: the id values, in declared column order. */
function entityValuesKey(entity: NormalizedEntity, id: EntityId): string {
	return idValues(entity, id).join(SEPARATOR);
}

/**
 * A complete row: the id columns, then every declared field, unlisted ones NULL.
 *
 * The same rule the versioned backends follow, because it is the MODEL's rule
 * and not storage's: `set` writes a whole row, so a declared field a mutation
 * did not list is empty in the new row rather than carried forward from the old
 * one. A light backend that spread the previous row instead would be storing
 * deltas while the author was told they were storing versions, and the
 * difference would surface as a stale field on one backend only.
 */
function completeRow(entity: NormalizedEntity, id: readonly string[], values: Record<string, unknown>): Row {
	const row: Row = {};
	entity.id.forEach((column, index) => (row[column] = id[index]));
	for (const field of Object.keys(entity.fields)) {
		row[field] = values?.[field] ?? null;
	}
	return row;
}

/**
 * Refuse any retention but `revert-only`, naming why rather than downgrading.
 *
 * A store may claim a window only if it ENFORCES one, and the honest report for
 * a store that was ASKED for a window it cannot serve is an error at
 * construction, not a quieter claim at run time: a deployment that wrote
 * `{blocks: 128}` believes it can read history, and it should find out where it
 * configured it rather than at the first refused read.
 */
function assertRevertOnly(retention: unknown): void {
	if (retention === undefined || retention === 'revert-only') return;
	throw new Error(
		`invalid retention for the patch store: ${JSON.stringify(retention)}. This backend keeps history as immer ` +
			`reverse patches, which undo a reorg and cannot reconstruct a past state to read, so 'revert-only' is the ` +
			`only retention it can honour: a window would be a claim about ANSWERS it has no way to give, and on a real ` +
			`sparse stream (event-bearing blocks median 429 blocks apart) a window of 64 blocks holds one event-bearing ` +
			`block anyway. Use @etherfold/state-store-sqlite, or MemoryStateStore, where history must be readable.`,
	);
}
