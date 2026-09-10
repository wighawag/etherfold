import type {StateStoreCapabilities} from './capabilities.js';
import type {CursorWrite} from './cursor.js';
import type {RetentionEnforcement} from './enforcement.js';
import type {EntityIdPrefix, Listing} from './listing.js';
import type {PruneOptions, PruneReport} from './retention.js';
import type {BlockPointer, BlockUpdate, EntityId, Mutation, NormalizedEntity} from './types.js';
import {writerToken, type WriterToken} from './writer.js';

/**
 * The READS a store answers, plus what it declares and how it is opened.
 *
 * This is the half a consumer needs to RENDER: the four reads, the bounded
 * listing among them, the cursor read, the capability report, the declarations,
 * and `migrate`. A value of this type cannot mutate the store, and that is the
 * point -- "a reader cannot write" is a fact of the TYPE rather than a rule to
 * remember, which is the move ADR-0044 already made for the stream seam by
 * handing a follower a read-only stream view instead of asking it to behave.
 *
 * `migrate` is here DELIBERATELY, and it is the one member that looks
 * out of place. It is SCHEMA rather than data, it is idempotent, and it runs on
 * every open -- including from `createBrowserStateStore`, which several tabs of
 * one app all call. Putting it on the writing side would make merely OPENING a
 * second handle take the store away from the writer that has it (ADR-0075 states
 * the same exclusion for the writer token, for the same reason).
 *
 * ## What this type is TODAY, and what it becomes
 *
 * `StateStore` below still carries the mutating members, so every consumer
 * written against it compiles unchanged while the migration happens one package
 * at a time. When the last of them holds `WritableStateStore` instead, the
 * mutating members go and `StateStore` becomes this type; until then, this name
 * is how a consumer says it only reads.
 */
export interface ReadableStateStore {
	/** What this store keeps and what it can answer. Readable before `migrate`. */
	readonly capabilities: StateStoreCapabilities;

	/** The declared entities, after validation. */
	readonly declarations: ReadonlyMap<string, NormalizedEntity>;

	/**
	 * Bring the storage to the declared shape. Idempotent, so it is safe on every
	 * boot.
	 *
	 * It is NOT a mutating path in the writer-token sense and must never claim:
	 * opening a store is not writing to it, and every tab of one app opens.
	 */
	migrate(): Promise<void>;

	/**
	 * The cursor stored under `key`, or `undefined` if nothing was ever written
	 * there.
	 *
	 * Opaque: whatever string the caller last wrote, byte for byte.
	 */
	readCursor(key: string): Promise<string | undefined>;

	/**
	 * Whether this store's retention is actually being ENFORCED against its
	 * storage: no floor to enforce, a floor and never pruned, or a floor and
	 * pruned to a block.
	 *
	 * The second half of retention only happens if a host schedules it (`prune`,
	 * below), so a host that rolled its own loop and never does gets the refusals
	 * of a bounded store and the footprint of an unbounded one. This is what makes
	 * that state discoverable instead of silent.
	 *
	 * It is ASYNCHRONOUS and separate from `capabilities` because the answer is
	 * DURABLE: a store pruned before the process died must not come back saying
	 * never, so it lives in storage, and the capability getter is synchronous and
	 * readable before the storage is even open. See `enforcement.ts`.
	 *
	 * It is a read, so it never claims the writer token and never writes -- which
	 * is why it is on THIS side of the split and `prune` is not.
	 */
	readRetentionEnforcement(): Promise<RetentionEnforcement>;

	/** One entity as it stands at the tip. */
	getCurrent<T = Record<string, unknown>>(entity: string, id: EntityId): Promise<T | undefined>;

	/**
	 * The rows whose declared id starts with `prefix`, at the tip, in ascending
	 * id order, at most `limit` of them.
	 *
	 * This is the derived collection a one-to-many is read through, and the
	 * REQUIRED limit is the whole reason it can be asked of any backend: the
	 * operation is a key-prefix range with a bound, which is an indexed range scan
	 * on every substrate. `truncated` says whether more matched, because a set that
	 * exactly fills the limit is otherwise indistinguishable from a cut-off one.
	 */
	listCurrent<T = Record<string, unknown>>(entity: string, prefix: EntityIdPrefix, limit: number): Promise<Listing<T>>;

	/**
	 * The same listing as of a block NUMBER: the children that were live then.
	 *
	 * Refused, not answered from the tip, by a store whose retention does not
	 * cover that block -- the same contract as `getAsOf`, for the same reason.
	 */
	listAsOf<T = Record<string, unknown>>(
		entity: string,
		prefix: EntityIdPrefix,
		at: number,
		limit: number,
	): Promise<Listing<T>>;

	/**
	 * One entity as of a block NUMBER.
	 *
	 * `undefined` means the entity was absent at that block. A store that cannot
	 * answer historical reads at all reports `asOf: false` and refuses rather
	 * than answering from the tip.
	 */
	getAsOf<T = Record<string, unknown>>(entity: string, id: EntityId, at: number): Promise<T | undefined>;
}

/**
 * The five verbs that CHANGE a store, and therefore the five a writer claims for.
 *
 * They are declared apart from the reads so that the two halves can be handed
 * out separately (`openForWriting` / `openForReading`). Every one of them is
 * guarded on the writer token by a backend that reports `singleWriter`, checked
 * inside the same atomic unit as the write it guards (`writer.ts`, ADR-0075).
 */
export interface StateStoreMutations {
	/**
	 * Apply one block: the block itself plus every mutation, as ONE atomic unit.
	 *
	 * Which blocks get recorded is the CALLER's judgement: every block handed
	 * over is recorded, including one that carried no mutation, and nothing else
	 * is. A block that carries a log of ours which changes nothing is still a
	 * block a consumer can legitimately pin.
	 *
	 * **The height must be ABOVE the recorded tip**, which is wider than refusing a
	 * duplicate and is the invariant a single writer maintains anyway: a caller
	 * reverts to the fork BEFORE it applies the branch that replaces it (see
	 * `applyEventStream` in `@etherfold/processor-entities`), so every apply lands
	 * above what the store holds. An offer at or below the tip is therefore a writer
	 * working from a position the store has passed -- a backgrounded tab resuming on
	 * a stale cursor, a second instance -- and taking it would open a version
	 * underneath the live one rather than after it. The tip is read inside the same
	 * atomic unit as the write, so a revert lowering it and an apply above it cannot
	 * interleave with another writer. An EMPTY store has no tip and admits whatever
	 * height its caller starts at, which is what a fresh index, a rebuild resuming
	 * mid-chain and a bootstrap installing a snapshot all need.
	 *
	 * `cursor` joins that unit. It is how a processor's "I have got this far"
	 * stops being a separate round trip: the block and the cursor that describes
	 * it move together or neither moves, so a crash can never leave state ahead of
	 * the cursor (a wedge, since the replay re-applies a block the store holds) nor
	 * a cursor ahead of the state (silent loss, since the replay skips a block
	 * nothing applied). A backend with no transaction to join must still not write
	 * the cursor when the block fails. See `cursor.ts`.
	 */
	applyBlock(block: BlockPointer, mutations?: readonly Mutation[], cursor?: CursorWrite): Promise<void>;

	/**
	 * Move a cursor on its own, with no block.
	 *
	 * Needed because progress is not only blocks. A processor that scanned a range
	 * carrying none of its logs has advanced and written nothing, and it must be
	 * able to say so or it re-scans that range on every restart forever. It is
	 * also how a BOOTSTRAP installs a cursor that belongs to rows it did not
	 * compute.
	 *
	 * It is NOT the way to record progress that a block DID cause: pass the cursor
	 * to `applyBlock` instead, which is the whole point of it being here.
	 */
	writeCursor(key: string, value: string): Promise<void>;

	/**
	 * Forget a cursor. A no-op where none was written.
	 *
	 * Paired with wiping the state it points at, never on its own: a cursor
	 * without its state would have a caller resume into an empty store.
	 *
	 * It is a MUTATION even when it deletes nothing, and a backend that claims
	 * `singleWriter` must claim on it anyway. That is what `openForWriting` rests
	 * on: clearing a key nothing ever wrote is the one seam verb that is a
	 * guaranteed no-op, so it is how a claim is taken without touching a byte.
	 */
	clearCursor(key: string): Promise<void>;

	/**
	 * Delete the versions the declared retention no longer covers, and report what
	 * went.
	 *
	 * **It is an EXPLICIT call, and that placement is the decision.** The window
	 * bounds what a read may ask about at all times, whether or not this ever runs;
	 * what this adds is the other half, bounding the BYTES. It is deliberately not
	 * a side effect of `applyBlock`, because a prune costs real time (1.1 s at
	 * 62,553 versions, measured in
	 * `work/notes/findings/sqlite-in-the-browser.md`) and a block carries a median
	 * of 7 mutations, so folding it in would stall whichever block happened to
	 * cross a threshold by a second for work that block did not ask for. Which
	 * block pays, and how often, is the host's scheduling decision, and a store is
	 * the wrong place to invent one. An amortised policy is `maxVersions` on a
	 * schedule; a background policy is this call on a timer. Both are built ON this
	 * verb rather than instead of it.
	 *
	 * The caller is the writer: a store has one, and pruning between blocks is safe
	 * exactly where applying a block is.
	 *
	 * Pruning a store that has no floor to prune at (`unbounded`, or `revert-only`
	 * with no declared finality depth) is a NO-OP and never an error: "keep
	 * everything" is a legitimate answer to "drop what is unreachable", and a host
	 * that prunes on a timer must not have to ask what it is holding first.
	 *
	 * The LIVE version of an entity is never dropped, however old it is. A row
	 * written once at block 12,082,307 and never touched again is still the current
	 * state, and deleting by age alone destroys it (see `retentionFloor`).
	 */
	prune(options?: PruneOptions): Promise<PruneReport>;

	/**
	 * Roll the state back to `keepUpTo`, dropping everything above it.
	 *
	 * Afterwards the store IS the state as of `keepUpTo`: versions opened above
	 * the fork are gone and versions the dead branch closed are live again, so a
	 * counter that a reorged block incremented goes back DOWN. That is the
	 * canonical bug this design exists to make impossible.
	 */
	revertTo(keepUpTo: number): Promise<void>;
}

/**
 * The seam: what a store must do for a processor to run on it.
 *
 * Twelve verbs and one report, chosen because they are the whole of what
 * processing a chain needs and because each of them is cheaply implementable on
 * every substrate we have measured (versioned SQL rows, an object store, an
 * in-memory map, a patch log). Anything a particular backend can do BETTER stays
 * on that backend's own class: `@etherfold/state-store-sqlite` keeps a richer
 * query surface (`queryCurrent` / `queryAsOf`, with caller-supplied SQL) and
 * block addressing by hash and time, because a server has a query planner and a
 * handler does not.
 *
 * The direction of the constraint is what makes this work: the mutation surface
 * a handler writes through is the MORE constrained one, so a freer substrate can
 * implement it, while backing arbitrary nested object mutation with versioned
 * rows cannot be done without materialising the store.
 *
 * The listing is the one SET read, and its BOUND is what keeps it cheap
 * everywhere: a prefix of the declared id plus a required limit, never a
 * predicate and never a caller-supplied ordering (see `listing.ts`).
 *
 * Deliberately absent, and each absence is a decision:
 *
 * - **Block addressing by hash or time.** `getAsOf` takes a resolved block
 *   NUMBER, so the seam owes nothing to a block table. Resolving a hash or a
 *   timestamp to a number, and refusing an address that resolves to nothing
 *   (`NoSuchBlockError`, ADR-0015), is the read layer above.
 *
 * Present, and it USED to be on that list: **the sync cursor**. It was left out
 * on the grounds that where a processor keeps `LastSync` is the processor
 * package's business (ADR-0016), which is true of the MEANING and turned out to
 * be the wrong conclusion about the STORAGE. A cursor kept outside the store is
 * a second round trip after the block it describes, and a crash in that window
 * wedges the indexer for good. Only the store holds the transaction, so only the
 * store can close it -- and the cost is a handful of lines per backend over one
 * key and one opaque string, which is what keeps ADR-0016 intact: the store
 * still does not know what a `LastSync` is. See `cursor.ts`.
 *
 * ## This type is what a BACKEND implements, and it is being narrowed
 *
 * A concrete backend implements the whole of it, reads and mutations alike, and
 * always will: it is the storage, so it can do everything the storage can do.
 * What is moving is what a CONSUMER holds. `openForWriting` hands back a
 * `WritableStateStore` and `openForReading` hands back a `ReadableStateStore`,
 * and once every consumer holds one of those two, the mutating half of this type
 * is deleted and `StateStore` becomes `ReadableStateStore` (ADR-0077). Until
 * then it carries both halves, so nothing has to migrate on anyone else's
 * schedule.
 *
 * ## Every MUTATING verb is guarded, on a backend that claims it
 *
 * `applyBlock`, `revertTo`, `writeCursor`, `clearCursor` and `prune` are the
 * mutating surface here, and a store reporting `singleWriter` carries a WRITER
 * TOKEN on every one of them, checked inside the same atomic unit as the write
 * it guards (`writer.ts`, ADR-0075). A backend with mutating verbs of its own
 * (`applyBlocks` and `drop` on `@etherfold/state-store-sqlite`) owes them the
 * same guard: the promise is about the STORAGE, so a path that skips it is a
 * hole in it.
 *
 * `migrate` is deliberately EXCLUDED and must not claim. It runs on every open,
 * including from `createBrowserStateStore`, so claiming there would make merely
 * OPENING a second handle -- which is what several tabs of one app do -- take
 * the store away from the writer that has it.
 */
export interface StateStore extends ReadableStateStore, StateStoreMutations {}

/**
 * A store this caller has CLAIMED: the reads, the mutations, and the token that
 * says the claim was taken rather than assumed.
 *
 * The `token` is what makes this type unforgeable. Without it a
 * `WritableStateStore` would be structurally identical to a `StateStore`, so any
 * store would satisfy it and "you may write because you claimed" would be a
 * comment rather than a compile error. With it, the only way to obtain one is
 * `openForWriting`, which claims. That is the same structural move ADR-0044
 * makes for streams: a follower is HANDED a read-only view rather than asked to
 * behave.
 *
 * **It is deliberately NOT the token in the storage.** The value a backend
 * compares inside its transactions stays private to that backend, because a
 * token a caller can read is a token a caller can hand back, and ADR-0075
 * rejected exactly that shape: a guard whose provenance rests on caller
 * discipline is a read-then-write that merely looks atomic. This one names the
 * claim at the seam and is compared with nothing.
 */
export interface WritableStateStore extends ReadableStateStore, StateStoreMutations {
	/** Names THIS claim. Opaque, compared with nothing; see the note above. */
	readonly token: WriterToken;

	/**
	 * Apply several blocks, packing as many as fit into each round trip.
	 *
	 * OPTIONAL because it is ONE backend's (`@etherfold/state-store-sqlite`, where
	 * backfill is bound by round trips rather than by SQLite work), and it is
	 * declared here at all only because this handle WRAPS the store: a caller that
	 * used to reach the method on the concrete class would otherwise lose it
	 * behind the seam. Feature-detect it (`store.applyBlocks?.(...)`); a backend
	 * without it is not deficient, it simply has nothing to pack.
	 */
	applyBlocks?(updates: readonly BlockUpdate[]): Promise<void>;
}

/**
 * The cursor-port key `openForWriting` clears in order to claim.
 *
 * Nothing ever WRITES it, which is the whole of why it exists: clearing a key
 * that was never written is the one seam verb that is a guaranteed no-op on
 * every backend ("Forget a cursor. A no-op where none was written"), and it is
 * still a MUTATION, so a backend that enforces a single writer claims on it. So
 * an open takes the store without touching a byte a caller can observe, using
 * the surface every backend already implements rather than a claim verb the
 * concrete classes would all have had to grow.
 *
 * It is exported so that a host choosing its own cursor keys can avoid it, the
 * same way `SNAPSHOT_ORIGIN_KEY` is.
 */
export const WRITER_CLAIM_KEY = 'writerClaim';

/**
 * One claim per store INSTANCE, so a second open is the same claim.
 *
 * Keyed by the store handed in AND by the handle handed back, so
 * `openForWriting(await openForWriting(store))` is idempotent too. A `WeakMap`
 * because the entry must not outlive the store: this is a fact about that
 * instance, not a registry of every store the process ever built.
 */
const claims = new WeakMap<ReadableStateStore, Promise<WritableStateStore>>();

/**
 * CLAIM a store, and get back the handle that may write to it.
 *
 * ```ts
 * const store = await openForWriting(await createBrowserStateStore(processor.entities));
 * await store.applyBlock(block, mutations, cursor);
 * ```
 *
 * ## What it DOES, in order
 *
 * It migrates (the same reason `openSnapshotAware` does: claiming is a write,
 * and a store that has not been migrated has nothing to write to), then it takes
 * the claim by clearing `WRITER_CLAIM_KEY`, which changes nothing and is a
 * mutation, so a backend that enforces a single writer SWAPS its stored token
 * there. An earlier writer's next mutation is then refused
 * (`StoreWriterChangedError`), and it is refused from the moment this call
 * returns rather than from the moment this writer gets round to writing.
 *
 * **It does not block and it does not wait.** There is no queue and no lease: a
 * loser is not waiting its turn, it has lost. A writer whose claim is taken
 * learns so on its next mutation and demotes itself to a reader.
 *
 * ## It is IDEMPOTENT per store instance, and that is load-bearing
 *
 * A second call on the same instance returns the SAME handle and does not claim
 * again. The shipped generation pattern hands ONE store instance to EVERY
 * generation (`createState: () => store`), so if each generation claimed
 * independently, building a successor would invalidate the canonical generation
 * and the guard would refuse the process against ITSELF. One storage, one
 * claim.
 *
 * ## Construction, not a lease
 *
 * The claim belongs to the store INSTANCE and is released by nothing, so there
 * is no expiry to tune, no held state a crash can strand, and no answer needed
 * to "what does a dead lease do mid-fold". A demoted writer builds a new store
 * and opens that, which forces the re-read correctness wants anyway. A handle
 * that has already LOST cannot re-claim through here: the backend never re-mints
 * a claim it has committed (ADR-0075), so the clear is refused and that refusal
 * travels out of this call.
 */
export function openForWriting(store: StateStore): Promise<WritableStateStore> {
	const claimed = claims.get(store);
	if (claimed !== undefined) return claimed;

	const claiming = claim(store).catch((error: unknown) => {
		// a claim that never landed is not a claim, so the next open tries again.
		// A claim that landed and was later TAKEN is a different thing and stays
		// refused: the backend, not this map, is what remembers that.
		claims.delete(store);
		throw error;
	});
	claims.set(store, claiming);
	return claiming;
}

async function claim(store: StateStore): Promise<WritableStateStore> {
	await store.migrate();
	await store.clearCursor(WRITER_CLAIM_KEY);

	const handle = new ClaimedStateStore(store, writerToken());
	claims.set(handle, Promise.resolve(handle));
	return handle;
}

/**
 * Hold a store as a READER: the same store, narrowed to what it can answer.
 *
 * ```ts
 * function render(store: ReadableStateStore) { ... }
 * render(openForReading(store));
 * ```
 *
 * It returns the very store it was handed and wraps nothing, because there is
 * nothing to intercept: the TYPE is the whole guard. That is the one way it
 * differs from `readOnlyStream` (ADR-0044), which SWALLOWS its writes -- it has
 * to, because that seam's save is driven by the indexing loop, so a follower has
 * nowhere to not call it from. Here the caller holds the handle and decides
 * every call, so a discarded write would be a mutation that looked like it
 * worked, which is the failure this whole split exists to prevent.
 */
export function openForReading(store: StateStore): ReadableStateStore {
	return store;
}

/**
 * The handle `openForWriting` hands back: the store, plus the claim.
 *
 * A WRAPPER rather than the store itself, for a blunt reason -- both guarded
 * backends keep their own claim in a field named `token`, so branding the
 * instance with the seam's token would overwrite the very value the guard
 * compares. Delegation keeps the two apart: the backend's token stays inside the
 * backend, which is where ADR-0075 put it.
 *
 * Everything here delegates and nothing here decides. In particular the guard is
 * NOT re-implemented at this level: the store underneath checks its own claim
 * inside the transaction that writes, which is the only place the check can be
 * exact.
 */
class ClaimedStateStore implements WritableStateStore {
	/** Present only when the store underneath has it; see `WritableStateStore.applyBlocks`. */
	readonly applyBlocks?: (updates: readonly BlockUpdate[]) => Promise<void>;

	constructor(
		private readonly inner: StateStore,
		readonly token: WriterToken,
	) {
		const packing = (inner as Partial<WritableStateStore>).applyBlocks;
		if (typeof packing === 'function') this.applyBlocks = (updates) => packing.call(inner, updates);
	}

	get capabilities(): StateStoreCapabilities {
		return this.inner.capabilities;
	}

	get declarations(): ReadonlyMap<string, NormalizedEntity> {
		return this.inner.declarations;
	}

	async migrate(): Promise<void> {
		return this.inner.migrate();
	}

	async applyBlock(block: BlockPointer, mutations?: readonly Mutation[], cursor?: CursorWrite): Promise<void> {
		return this.inner.applyBlock(block, mutations, cursor);
	}

	async readCursor(key: string): Promise<string | undefined> {
		return this.inner.readCursor(key);
	}

	async writeCursor(key: string, value: string): Promise<void> {
		return this.inner.writeCursor(key, value);
	}

	async clearCursor(key: string): Promise<void> {
		return this.inner.clearCursor(key);
	}

	async prune(options?: PruneOptions): Promise<PruneReport> {
		return this.inner.prune(options);
	}

	async readRetentionEnforcement(): Promise<RetentionEnforcement> {
		return this.inner.readRetentionEnforcement();
	}

	async getCurrent<T = Record<string, unknown>>(entity: string, id: EntityId): Promise<T | undefined> {
		return this.inner.getCurrent<T>(entity, id);
	}

	async listCurrent<T = Record<string, unknown>>(
		entity: string,
		prefix: EntityIdPrefix,
		limit: number,
	): Promise<Listing<T>> {
		return this.inner.listCurrent<T>(entity, prefix, limit);
	}

	async listAsOf<T = Record<string, unknown>>(
		entity: string,
		prefix: EntityIdPrefix,
		at: number,
		limit: number,
	): Promise<Listing<T>> {
		return this.inner.listAsOf<T>(entity, prefix, at, limit);
	}

	async getAsOf<T = Record<string, unknown>>(entity: string, id: EntityId, at: number): Promise<T | undefined> {
		return this.inner.getAsOf<T>(entity, id, at);
	}

	async revertTo(keepUpTo: number): Promise<void> {
		return this.inner.revertTo(keepUpTo);
	}
}
