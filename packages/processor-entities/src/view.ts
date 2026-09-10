import type {EntityId, EntityIdPrefix, Listing, StateStore, StateStoreCapabilities} from '@etherfold/state-store';

/**
 * ## What `process` returns when the state is a store rather than an object
 *
 * The `EventProcessor` contract is
 * `process(eventStream, lastSync) => ProcessResultType`, shaped for a processor
 * whose state is an in-memory object it can simply hand back. Materialising a
 * store into such an object would defeat the point: the store exists so that
 * "state at block N" is an index probe rather than something held in memory, and
 * it can hold more history than fits there.
 *
 * The core settles the question. `indexer.ts` never inspects the value: the
 * outcome of `process` and the `state` from `load` go to `_onStateUpdated`,
 * which forwards them to the optional `onStateUpdated` callback and nothing
 * else. So the return value is purely a channel to the consumer, and the
 * question is what the consumer most usefully receives. A read handle is O(1) to
 * produce, has stable identity across every call, and says exactly what it is.
 *
 * ## It is the SEAM TIER, and the omissions are the design
 *
 * There is no `queryCurrent` / `queryAsOf` here, and there is no stub throwing
 * "not supported on this backend" either. Those two take caller-supplied SQL and
 * exist only where a query planner does; a handle that is handed out whatever the
 * backend must not pretend otherwise. Leaving them OFF THE TYPE is what turns
 * "this deployment cannot answer that" into a compile error at the call site,
 * where the consumer can still choose a different backend, instead of a runtime
 * throw in a browser tab. `VersionedStateView` in `@etherfold/processor-sqlite`
 * is the tier that does have them, and it is reached by choosing SQLite on
 * purpose.
 *
 * The same split runs through the rest of the repo: `createReadSurface` (seam
 * tier, generated from declarations) against `createQuerySurface` (SQL tier), and
 * `MutationContext.list` (a bounded id-prefix listing) against a backend's own
 * richer reads. Two tiers, one schema source, ADR-0021's line.
 *
 * ## It is READ-ONLY on purpose
 *
 * Handing back the store itself would put `applyBlock` and `revertTo` in the
 * hands of a UI callback, where a stray call corrupts the chain of versions with
 * no way to tell afterwards. The writer is the processor, and it is the only
 * writer -- which is now a fact of the TYPE as well: this holds the seam as a
 * `StateStore`, and the mutating verbs are not on it (ADR-0077).
 */
export class EntityStateView {
	constructor(private readonly store: StateStore) {}

	/**
	 * What history this state can answer about, readable before anything is asked
	 * of it.
	 *
	 * This is the point of the report being on the read handle: a consumer that
	 * needs as-of reads discovers at startup whether they are available, instead
	 * of discovering it from a refusal in production or, worse, from a plausible
	 * wrong number. On a `revert-only` backend (the light store) it says `asOf:
	 * false` before a single read is attempted.
	 */
	get capabilities(): StateStoreCapabilities {
		return this.store.capabilities;
	}

	/** One entity at the tip. */
	getCurrent<T = Record<string, unknown>>(entity: string, id: EntityId): Promise<T | undefined> {
		return this.store.getCurrent<T>(entity, id);
	}

	/**
	 * One entity as of a block NUMBER.
	 *
	 * `undefined` means the block is known and the entity was absent from it. A
	 * block outside the retention this view reports throws
	 * `BlockNotRetainedError` rather than being served from the tip, because an
	 * as-of read answered from the tip is a plausible wrong number nothing
	 * downstream can tell apart from a true one (ADR-0019).
	 *
	 * A block NUMBER and not an address: resolving a hash or a timestamp needs a
	 * block table the seam does not require, so it belongs to the backends that
	 * have one (`VersionedStateView`, on SQLite).
	 */
	getAsOf<T = Record<string, unknown>>(entity: string, id: EntityId, at: number): Promise<T | undefined> {
		return this.store.getAsOf<T>(entity, id, at);
	}

	/**
	 * The rows whose declared id starts with `prefix`, at the tip, ascending, at
	 * most `limit` of them, with `truncated` saying whether more matched.
	 *
	 * The seam's one SET read, and how a one-to-many is meant to be read: children
	 * keyed by their parent, derived when read (ADR-0021).
	 */
	listCurrent<T = Record<string, unknown>>(entity: string, prefix: EntityIdPrefix, limit: number): Promise<Listing<T>> {
		return this.store.listCurrent<T>(entity, prefix, limit);
	}

	/**
	 * The same listing as of a block NUMBER: the children that were live then.
	 *
	 * Same refusal as `getAsOf` outside the declared retention. An EMPTY listing
	 * means the block is known and the prefix had no children then.
	 */
	listAsOf<T = Record<string, unknown>>(
		entity: string,
		prefix: EntityIdPrefix,
		at: number,
		limit: number,
	): Promise<Listing<T>> {
		return this.store.listAsOf<T>(entity, prefix, at, limit);
	}
}
