import {entityKey, idValues, mustGet} from './entities.js';
import {
	assertListingLimit,
	compareIds,
	hasIdPrefix,
	prefixValues,
	type EntityIdPrefix,
	type Listing,
} from './listing.js';
import type {StateStore} from './store.js';
import type {EntityId, Mutation, NormalizedEntity} from './types.js';

/**
 * The write surface a handler gets for ONE block.
 *
 * `get` is read-your-writes WITHIN the block being processed: it answers from
 * the mutations already staged for this block, and falls through to the store's
 * current state otherwise. That matters because a handler that increments a
 * counter must see the value an earlier event in the same block wrote, which is
 * the behaviour the in-memory path gets for free by mutating one object. It is
 * load-bearing rather than theoretical: on the real stratagems stream, 16,871 of
 * 66,113 reads were served from the block's own staging area.
 *
 * Blocks below the one being processed are always already flushed, because a
 * block is applied before the next block's handlers run: one block is exactly
 * one atomic unit. So `get` never has to reason about more than the current
 * block.
 *
 * Reads are uniformly async, on every backend. The alternative, typing them as
 * `T | Promise<T>`, is infectious at every call site for the benefit of saving a
 * microtask on a path whose cost is dominated by fetching logs.
 */
export type MutationContext = {
	/** The entity as it stands, including mutations staged earlier in this block. */
	get<T = Record<string, unknown>>(entity: string, id: EntityId): Promise<T | undefined>;
	/**
	 * Write the WHOLE row. Unlisted declared fields become NULL, mirroring the
	 * store's close-then-insert: a version is a complete row, not a delta. To
	 * change one field, use `update`.
	 */
	set(entity: string, id: EntityId, values: Record<string, unknown>): void;
	/**
	 * Sugar, and nothing more: `get`, spread, `set`.
	 *
	 * It is spelled as sugar rather than as a second primitive so the storage
	 * model stays visible. A partial write still opens a complete new version;
	 * there is no such thing as writing one column of a version.
	 */
	update(entity: string, id: EntityId, values: Record<string, unknown>): Promise<void>;
	/**
	 * The children of a key: the rows whose declared id STARTS WITH `prefix`, in
	 * ascending id order, at most `limit` of them, including this block's writes.
	 * The order is the store's own, UTF-8 byte order (`compareIds`, ADR-0021), so
	 * a row staged in the block is cut by the limit exactly as a stored one is.
	 *
	 * This is how a one-to-many is read: children are their own entity keyed by
	 * their parent, and the collection is DERIVED HERE rather than stored, so
	 * appending a child costs one row and no maintenance of an array, a count or
	 * an index. `{epoch: 7}` under `id: ['epoch', 'position', 'playerIndex']` is
	 * every placement of epoch 7.
	 *
	 * The limit is REQUIRED and there is no predicate, no ordering and no offset:
	 * see `listing.ts` for why the bound is the design rather than a detail. If the
	 * answer is cut off, `truncated` says so, because a handler that mistakes a
	 * truncated collection for the whole of it (a cascade delete that stops early)
	 * leaves orphans behind silently.
	 */
	list<T = Record<string, unknown>>(entity: string, prefix: EntityIdPrefix, limit: number): Promise<Listing<T>>;
	/** Close the live version without opening a new one: absent from this block on, readable before it. */
	delete(entity: string, id: EntityId): void;
};

/** A staging area for one block, plus the mutations it has collected. */
export type StagedBlock = {
	/** What the handlers are handed. Named `state` because that is the handler's parameter. */
	state: MutationContext;
	/**
	 * The block's mutations, COALESCED per business key in first-touch order.
	 *
	 * Emitting every write would be correct but would leave zero-width versions
	 * (`_lower === _upper`) that no as-of read can ever match, so it would grow
	 * the store with rows that are invisible by construction.
	 */
	mutations(): Mutation[];
};

/**
 * Open a staging area over a store, for exactly one block.
 *
 * This is implemented ONCE, above the backend interface, which is why
 * read-your-writes is a property of the seam rather than of whichever store is
 * wired in. A backend cannot get it subtly wrong because a backend does not
 * implement it.
 */
export function createMutationContext(store: StateStore): StagedBlock {
	const pending = new Map<string, Mutation>();
	const keyOf = (entity: string, id: EntityId): string => entityKey(mustGet(store.declarations, entity), id);

	const context: MutationContext = {
		/**
		 * The block's staging area first, the store underneath it.
		 *
		 * A staged row is built by `stagedRow`, the same construction `list` uses,
		 * so a row's SHAPE does not depend on when in the block it was written: the
		 * id columns are there and a declared field the write did not list is NULL,
		 * exactly as the store will hold it one block later. Handing back
		 * `staged.values` (only what `set` was passed) instead would make a field
		 * present or `undefined` according to timing, and `undefined` is a legal
		 * value meaning "not set" rather than an error a handler would notice.
		 */
		get: async <T>(entity: string, id: EntityId): Promise<T | undefined> => {
			const declaration = mustGet(store.declarations, entity);
			const staged = pending.get(entityKey(declaration, id));
			if (staged) {
				if (staged.type === 'delete') return undefined;
				return stagedRow(declaration, idValues(declaration, staged.id), staged.values) as T;
			}
			return store.getCurrent<T>(entity, id);
		},
		set: (entity: string, id: EntityId, values: Record<string, unknown>): void => {
			pending.set(keyOf(entity, id), {type: 'upsert', entity, id, values});
		},
		update: async (entity: string, id: EntityId, values: Record<string, unknown>): Promise<void> => {
			const declaration = mustGet(store.declarations, entity);
			const current = await context.get<Record<string, unknown>>(entity, id);
			// only DECLARED fields survive the spread: `get` answers with the row as
			// the store holds it, which on a versioned backend carries the version
			// columns, and those must not travel back in as values.
			const merged: Record<string, unknown> = {};
			for (const field of Object.keys(declaration.fields)) {
				if (current && field in current) merged[field] = current[field];
			}
			context.set(entity, id, {...merged, ...values});
		},
		/**
		 * The store's range scan with this block's staging area merged into it.
		 *
		 * Read-your-writes is the part most likely to be got wrong here, because a
		 * listing cannot simply fall through to the store the way `get` does: a row
		 * written earlier in the block is not in the store yet, a row deleted earlier
		 * in the block still is, and the answer has to be BOTH bounded and correct.
		 *
		 * Hence the fetch budget. A row this block deleted occupies a slot in the
		 * store's answer and none in ours, so asking the store for exactly `limit`
		 * rows could come back short; asking for `limit + (staged keys under this
		 * prefix)` cannot, because that is the most the staging area can subtract.
		 * Scanning the staging area itself is a walk over ONE block's mutations
		 * (median 7, max 457 on the real measured stream), never over the store.
		 */
		list: async <T>(entity: string, prefix: EntityIdPrefix, limit: number): Promise<Listing<T>> => {
			const declaration = mustGet(store.declarations, entity);
			const values = prefixValues(declaration, prefix);
			assertListingLimit(declaration, limit);

			const staged = new Map<string, {id: readonly string[]; row?: Record<string, unknown>}>();
			for (const [key, mutation] of pending) {
				if (mutation.entity !== declaration.name) continue;
				const id = idValues(declaration, mutation.id);
				if (!hasIdPrefix(id, values)) continue;
				staged.set(key, {
					id,
					row: mutation.type === 'upsert' ? stagedRow(declaration, id, mutation.values) : undefined,
				});
			}

			const stored = await store.listCurrent<Record<string, unknown>>(entity, prefix, limit + staged.size);
			const merged: {id: readonly string[]; row: Record<string, unknown>}[] = [];
			for (const row of stored.rows) {
				// a key this block has touched is answered from the block, never twice
				if (staged.has(entityKey(declaration, row as EntityId))) continue;
				merged.push({id: idValues(declaration, row as EntityId), row});
			}
			for (const {id, row} of staged.values()) {
				if (row) merged.push({id, row});
			}
			merged.sort((a, b) => compareIds(a.id, b.id));

			return {
				rows: merged.slice(0, limit).map(({row}) => row as T),
				// the store's own flag still counts: with the budget above, a store that
				// reported more can only have rows we have not seen.
				truncated: merged.length > limit || stored.truncated,
			};
		},
		delete: (entity: string, id: EntityId): void => {
			pending.set(keyOf(entity, id), {type: 'delete', entity, id});
		},
	};

	return {state: context, mutations: () => [...pending.values()]};
}

/**
 * A row staged in this block, in the shape the store would have given it back.
 *
 * The id columns are included and every declared field is present, unlisted ones
 * as NULL, because a version is a COMPLETE row and because an answer can come
 * from two places at once: a caller must not be able to tell which of them a row
 * came from. The one difference it cannot hide is the version columns, which a
 * staged row has none of: it has no version yet.
 *
 * `get` and `list` share it, which is the point of it being a function. They
 * disagreed once -- a listing filled the row and `get` handed back the values
 * `set` was passed -- and the shape of a row then depended on which read asked
 * for it and on how late in the block the write had happened.
 */
function stagedRow(
	entity: NormalizedEntity,
	id: readonly string[],
	values: Record<string, unknown>,
): Record<string, unknown> {
	const row: Record<string, unknown> = {};
	entity.id.forEach((column, index) => (row[column] = id[index]));
	for (const field of Object.keys(entity.fields)) {
		row[field] = values?.[field] ?? null;
	}
	return row;
}
