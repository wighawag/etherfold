import {blockAlreadyRecorded, blockHashAlreadyRecorded, blockNotAboveTip, normalizeBlockHash} from './blocks.js';
import type {Retention, StateStoreCapabilities} from './capabilities.js';
import type {CursorWrite} from './cursor.js';
import {entityKey, idValues, mustGet, normalizeEntities} from './entities.js';
import {pruneRecord, retentionEnforcementOf, type RetentionEnforcement} from './enforcement.js';
import {
	assertListingLimit,
	boundedListing,
	compareIds,
	hasIdPrefix,
	prefixValues,
	type EntityIdPrefix,
	type Listing,
} from './listing.js';
import type {SeamRecordKey} from './records.js';
import {
	assertRetained,
	pruneBudget,
	resolveRetention,
	retentionFloor,
	type PruneOptions,
	type PruneReport,
	type RetentionOptions,
	type RetentionSetting,
} from './retention.js';
import type {StateStoreBackend} from './store.js';
import type {BlockPointer, EntityDeclaration, EntityId, Mutation, NormalizedEntity} from './types.js';

export type MemoryStateStoreOptions = RetentionOptions & {
	/**
	 * What the deployment asks this store to keep. Defaults to `unbounded`.
	 *
	 * Validated at construction rather than at the first read it would have
	 * answered wrongly: a window below the finality depth is refused here, naming
	 * both numbers. What is set is what gets REPORTED, because this store enforces
	 * it on both halves -- a read outside the window is refused, and `prune` drops
	 * the versions the window no longer covers.
	 */
	readonly retention?: RetentionSetting;
};

/** One version of one entity: a complete row plus its half-open validity range. */
type Version = {values: Record<string, unknown>; lower: number; upper: number | null};

/**
 * One business key and every version of it, oldest first.
 *
 * The id is kept beside the versions rather than parsed back out of the map key
 * because a listing needs it: the rows of a prefix scan are found by comparing
 * ids, and ordered by them.
 */
type Row = {entity: string; id: readonly string[]; versions: Version[]};

/**
 * The reference `StateStoreBackend`: versioned rows in a Map.
 *
 * It is here for two reasons and neither of them is production use. A contract
 * with no runnable implementation is a document, not a specification, so this is
 * the executable one; and "a processor runs unchanged on two backends" needs a
 * second backend that owes nothing to SQL to be worth asserting.
 *
 * Its behaviour matches `@etherfold/state-store-sqlite` DOWN TO THE SHARP EDGES,
 * on purpose. Re-applying a block raises here as it does there (a primary-key
 * violation), an unlisted declared field goes to NULL here as it does there, and
 * a business key is stringified here as it is there. A lenient reference
 * implementation would be worse than none: it would let a caller bug through in
 * a test and surface it in production.
 *
 * What it is NOT: durable, or a browser backend. It holds every retained version
 * in memory for as long as the process lives and goes with the process;
 * `@etherfold/state-store-indexeddb` is the browser answer (ADR-0024).
 */
export class MemoryStateStore implements StateStoreBackend {
	private readonly entities: ReadonlyMap<string, NormalizedEntity>;
	/** entity key -> that key's versions, oldest first. */
	private readonly rows = new Map<string, Row>();
	private readonly blocks = new Map<number, BlockPointer>();
	private readonly hashes = new Map<string, number>();
	/** The sync cursors, opaque strings under caller-chosen keys. See `cursor.ts`. */
	private readonly cursors = new Map<string, string>();
	/**
	 * The seam's own records, in a map of their OWN so a caller's cursor key can
	 * never land on one. See `records.ts`.
	 */
	private readonly records = new Map<SeamRecordKey, string>();
	private readonly provided: Retention;
	private readonly finalityDepth: number | undefined;
	private tip: number | undefined;

	constructor(declarations: Iterable<EntityDeclaration>, options: MemoryStateStoreOptions = {}) {
		this.entities = normalizeEntities(declarations);
		// resolved at CONSTRUCTION: a retention below the finality floor is a
		// configuration error, and it should land where it was configured rather
		// than on the first read that would have been served wrongly.
		this.provided = resolveRetention(options.retention, options);
		this.finalityDepth = options.finalityDepth;
	}

	get declarations(): ReadonlyMap<string, NormalizedEntity> {
		return this.entities;
	}

	/**
	 * What was configured, because this store enforces all of it.
	 *
	 * `unbounded` by default (keep everything, answer at any depth). A window is
	 * reported as a window: reads outside it are refused by `getAsOf` / `listAsOf`
	 * at all times, and `prune` drops the versions it no longer covers.
	 * `revert-only` refuses every historical read while `revertTo` keeps working.
	 *
	 * `singleWriter: false`, honestly and permanently. This store's storage is
	 * three instance fields, so a second writer cannot reach it and a writer token
	 * here could only ever be compared with itself: green, tested, and meaningless
	 * (`writer.ts`). Two handles are two stores, and the reference implementation
	 * says so rather than claiming a guarantee its representation makes vacuous.
	 */
	get capabilities(): StateStoreCapabilities {
		return {retention: this.provided, asOf: this.provided.kind !== 'revert-only', singleWriter: false};
	}

	/** Nothing to create: the shape is the declaration, and it is already validated. */
	async migrate(): Promise<void> {}

	/**
	 * Apply one block, all of it or none of it.
	 *
	 * Every mutation is resolved against the declarations BEFORE anything is
	 * written, so a mutation naming an entity that was never declared leaves the
	 * store exactly as it found it. That mirrors the SQL store, where one block
	 * is one batch and therefore one transaction.
	 *
	 * A height must be ABOVE the recorded tip, which is wider than refusing a
	 * duplicate and is the invariant a single writer actually maintains: the caller
	 * reverts to the fork BEFORE it applies the branch that replaces it, so every
	 * apply lands above what the store holds. An empty store has no tip and admits
	 * whatever height its caller starts at.
	 *
	 * The `cursor` is part of that unit and is written LAST, after the point where
	 * anything can still refuse: there is no transaction to join here, so "all or
	 * nothing" is ordering instead, and the ordering has to be the safe one. A
	 * cursor written before the block could survive a rejected block and send the
	 * next run past state nothing ever applied.
	 */
	async applyBlock(block: BlockPointer, mutations: readonly Mutation[] = [], cursor?: CursorWrite): Promise<void> {
		const hash = normalizeBlockHash(block.hash);
		if (this.blocks.has(block.number)) {
			throw blockAlreadyRecorded(block.number);
		}
		if (this.hashes.has(hash)) {
			throw blockHashAlreadyRecorded(hash, this.hashes.get(hash));
		}
		// AFTER the two above, so the ordinary caller bug -- re-applying a block --
		// keeps the message that names it, and this one answers the case that message
		// cannot: a height the tip has passed and nothing ever recorded.
		if (this.tip !== undefined && block.number <= this.tip) {
			throw blockNotAboveTip(block.number, this.tip);
		}

		const planned = mutations.map((mutation) => {
			const entity = mustGet(this.entities, mutation.entity);
			return {mutation, entity, key: entityKey(entity, mutation.id), id: idValues(entity, mutation.id)};
		});

		this.blocks.set(block.number, {...block, hash});
		this.hashes.set(hash, block.number);
		if (this.tip === undefined || block.number > this.tip) this.tip = block.number;

		for (const {mutation, entity, key, id} of planned) {
			let row = this.rows.get(key);
			if (!row) {
				row = {entity: entity.name, id, versions: []};
				this.rows.set(key, row);
			}
			const versions = row.versions;

			const live = versions.find((version) => version.upper === null);
			if (live) live.upper = block.number;

			if (mutation.type === 'upsert') {
				const values: Record<string, unknown> = {};
				entity.id.forEach((column, index) => (values[column] = id[index]));
				// a version is a COMPLETE row: a declared field the mutation did not
				// list is written as NULL, not left at its previous value.
				for (const field of Object.keys(entity.fields)) {
					values[field] = mutation.values?.[field] ?? null;
				}
				versions.push({values, lower: block.number, upper: null});
			}
		}

		if (cursor) this.cursors.set(cursor.key, cursor.value);
	}

	/** The opaque string last written under `key`, or `undefined`. */
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

	/** The seam's own record under `key`. A separate map from the cursors, deliberately. */
	async readSeamRecord(key: SeamRecordKey): Promise<string | undefined> {
		return this.records.get(key);
	}

	/** Write one of the seam's records. See `records.ts`. */
	async writeSeamRecord(key: SeamRecordKey, value: string): Promise<void> {
		this.records.set(key, value);
	}

	/** Forget one of the seam's records. A no-op where none was written. */
	async clearSeamRecord(key: SeamRecordKey): Promise<void> {
		this.records.delete(key);
	}

	async getCurrent<T = Record<string, unknown>>(entity: string, id: EntityId): Promise<T | undefined> {
		return this.read<T>(entity, id, (version) => version.upper === null);
	}

	/**
	 * One entity as of a block number, or a refusal.
	 *
	 * The refusal is the seam's (`assertRetained`), not a second copy written
	 * here, and it comes BEFORE the read: a historical read this store's declared
	 * retention does not cover throws rather than answering, because an as-of read
	 * quietly served from the tip is a plausible wrong number nothing downstream
	 * can tell apart from a true one.
	 */
	async getAsOf<T = Record<string, unknown>>(entity: string, id: EntityId, at: number): Promise<T | undefined> {
		await assertRetained(this.capabilities, at, () => this.tip);
		return this.read<T>(entity, id, (version) => version.lower <= at && (version.upper === null || at < version.upper));
	}

	/** The children of a prefix at the tip: a sorted walk, bounded by the limit. */
	async listCurrent<T = Record<string, unknown>>(
		entity: string,
		prefix: EntityIdPrefix,
		limit: number,
	): Promise<Listing<T>> {
		return this.scan<T>(entity, prefix, limit, (version) => version.upper === null);
	}

	/** The same, as of a block number, refused where the retention does not reach. */
	async listAsOf<T = Record<string, unknown>>(
		entity: string,
		prefix: EntityIdPrefix,
		at: number,
		limit: number,
	): Promise<Listing<T>> {
		await assertRetained(this.capabilities, at, () => this.tip);
		return this.scan<T>(
			entity,
			prefix,
			limit,
			(version) => version.lower <= at && (version.upper === null || at < version.upper),
		);
	}

	/**
	 * Drop versions opened above the fork, then re-open the ones it closed.
	 *
	 * The same two moves the SQL store makes, in the same order and for the same
	 * reason: a version the dead branch closed must become live again, and it can
	 * only do so once the dead branch's own version is gone, or two versions of
	 * one business key would be open at once.
	 */
	async revertTo(keepUpTo: number): Promise<void> {
		// the cursors are deliberately untouched: how far the CALLER got is not
		// entity state, and the caller moves it when it applies the canonical branch.
		for (const [key, row] of this.rows) {
			const kept = row.versions.filter((version) => version.lower <= keepUpTo);
			for (const version of kept) {
				if (version.upper !== null && version.upper > keepUpTo) version.upper = null;
			}
			if (kept.length === 0) this.rows.delete(key);
			else row.versions = kept;
		}
		for (const [number, block] of this.blocks) {
			if (number > keepUpTo) {
				this.blocks.delete(number);
				this.hashes.delete(block.hash);
			}
		}
		// the tip moves DOWN with the revert: a retention window is a distance from
		// it, so a stale tip would refuse reads that are inside the window again.
		this.tip = undefined;
		for (const number of this.blocks.keys()) {
			if (this.tip === undefined || number > this.tip) this.tip = number;
		}
	}

	/**
	 * Drop the versions the retention floor puts out of reach, oldest first.
	 *
	 * The predicate is the seam's (`retentionFloor`) and the whole of it is
	 * `upper !== null && upper <= floor`: a version with NO upper bound is the LIVE
	 * one and is the current state however old it is, which is the case a prune
	 * written as "drop what is older than the floor" destroys. On the real measured
	 * stream that is not an edge case: event-bearing blocks are median 429 apart
	 * and the state contains rows written once and never revisited.
	 *
	 * Oldest first matters when a budget stops the pass: what survives a partial
	 * prune is then the newest of the unreachable versions, so the store converges
	 * towards the window from the far end rather than leaving arbitrary holes. The
	 * SQL backend orders by the same column for the same reason.
	 */
	async prune(options: PruneOptions = {}): Promise<PruneReport> {
		const tip = this.tip;
		const floor = tip === undefined ? undefined : retentionFloor(this.provided, tip, this.finalityDepth);
		const budget = pruneBudget(options);
		if (floor === undefined) return {tip, floor: undefined, versionsDeleted: 0, complete: true};

		const unreachable: Version[] = [];
		for (const row of this.rows.values()) {
			for (const version of row.versions) {
				if (version.upper !== null && version.upper <= floor) unreachable.push(version);
			}
		}
		unreachable.sort((a, b) => (a.upper as number) - (b.upper as number));

		const doomed = new Set(unreachable.slice(0, budget === Number.POSITIVE_INFINITY ? undefined : budget));
		if (doomed.size > 0) {
			for (const [key, row] of this.rows) {
				if (!row.versions.some((version) => doomed.has(version))) continue;
				row.versions = row.versions.filter((version) => !doomed.has(version));
				if (row.versions.length === 0) this.rows.delete(key);
			}
		}

		// AFTER the deletion, so the record can never claim a pass that did not
		// happen. A crash in between leaves the store reporting `never-pruned` over
		// rows that did go, which under-claims enforcement and is corrected by the
		// next pass -- the safe direction for a diagnostic.
		const record = pruneRecord(floor);
		if (record !== undefined) this.records.set('retentionEnforcement', record);

		return {tip, floor, versionsDeleted: doomed.size, complete: doomed.size === unreachable.length};
	}

	/**
	 * Whether the retention this store reports is enforced against its storage.
	 *
	 * Durable in the only sense this backend HAS a durable sense: the record sits
	 * in an instance field and goes with the process exactly as the rows do. A
	 * backend whose storage outlives the process reads back what an earlier one
	 * wrote, which is what makes the report worth having there.
	 */
	async readRetentionEnforcement(): Promise<RetentionEnforcement> {
		return retentionEnforcementOf(
			this.provided,
			this.finalityDepth,
			this.tip,
			this.records.get('retentionEnforcement'),
		);
	}

	/**
	 * The block recorded at a height, or `undefined`.
	 *
	 * Not part of the seam: addressing state by hash or by time (and refusing
	 * an address that resolves to nothing) is the read layer above the seam. This
	 * is here so a test can see what was recorded.
	 */
	async getBlock(number: number): Promise<BlockPointer | undefined> {
		const block = this.blocks.get(number);
		return block && {...block};
	}

	private read<T>(entity: string, id: EntityId, matches: (version: Version) => boolean): T | undefined {
		const declaration = mustGet(this.entities, entity);
		const found = this.rows.get(entityKey(declaration, id))?.versions.find(matches);
		return found && ({...found.values, _lower: found.lower, _upper: found.upper} as T);
	}

	/**
	 * The prefix scan: every business key of the entity, filtered and then sorted.
	 *
	 * A real backend rides an index and touches only the range (that is the whole
	 * point of the bound), and this one walks the map instead. It is the reference
	 * implementation, so the property it has to hold is the ANSWER -- ascending id
	 * order, the limit, and an honest `truncated` -- not the access path.
	 */
	private scan<T>(
		entity: string,
		prefix: EntityIdPrefix,
		limit: number,
		matches: (version: Version) => boolean,
	): Listing<T> {
		const declaration = mustGet(this.entities, entity);
		const values = prefixValues(declaration, prefix);
		assertListingLimit(declaration, limit);

		const found: {id: readonly string[]; version: Version}[] = [];
		for (const row of this.rows.values()) {
			if (row.entity !== declaration.name || !hasIdPrefix(row.id, values)) continue;
			const version = row.versions.find(matches);
			if (version) found.push({id: row.id, version});
		}
		found.sort((a, b) => compareIds(a.id, b.id));

		// one MORE than the limit, which is how `truncated` is a fact here as well
		return boundedListing(
			found
				.slice(0, limit + 1)
				.map(({version}) => ({...version.values, _lower: version.lower, _upper: version.upper}) as T),
			limit,
		);
	}
}
