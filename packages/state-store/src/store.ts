import type {StateStoreCapabilities} from './capabilities.js';
import type {CursorWrite} from './cursor.js';
import type {RetentionEnforcement} from './enforcement.js';
import type {EntityIdPrefix, Listing} from './listing.js';
import type {PruneOptions, PruneReport} from './retention.js';
import type {BlockPointer, EntityId, Mutation, NormalizedEntity} from './types.js';

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
export interface StateStore {
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
	 * The cursor stored under `key`, or `undefined` if nothing was ever written
	 * there.
	 *
	 * Opaque: whatever string the caller last wrote, byte for byte.
	 */
	readCursor(key: string): Promise<string | undefined>;

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
	 * Whether this store's retention is actually being ENFORCED against its
	 * storage: no floor to enforce, a floor and never pruned, or a floor and
	 * pruned to a block.
	 *
	 * The second half of retention only happens if a host schedules it (`prune`,
	 * above), so a host that rolled its own loop and never does gets the refusals
	 * of a bounded store and the footprint of an unbounded one. This is what makes
	 * that state discoverable instead of silent.
	 *
	 * It is ASYNCHRONOUS and separate from `capabilities` because the answer is
	 * DURABLE: a store pruned before the process died must not come back saying
	 * never, so it lives in storage, and the capability getter is synchronous and
	 * readable before the storage is even open. See `enforcement.ts`.
	 *
	 * It is a read, so it never claims the writer token and never writes.
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
