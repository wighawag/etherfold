/**
 * ## The sync cursor at the seam: one OPAQUE STRING under one key
 *
 * A processor has to remember how far it has got, and until now that memory was
 * a SQL table in `@etherfold/processor-sqlite`. A browser deployment on
 * IndexedDB has no SQL to write it into, so "how far have I got" had to become
 * something every backend can answer or the seam's promise -- one processor,
 * several backends -- stopped at the first deployment that was not SQLite.
 *
 * It lives HERE, on the store, for a reason that is not filing: **only the store
 * holds the transaction the block write happens in**, so only the store can move
 * the cursor and the block it describes as ONE unit
 * (`StateStore.applyBlock`'s third argument). A cursor kept anywhere else is a
 * second round trip, and a crash inside that window leaves state ahead of the
 * cursor, which is not self-healing: the restart replays a block the store
 * already holds, `applyBlock` refuses it as the caller bug it normally is, and
 * the indexer wedges until a human intervenes.
 *
 * ## Why a string, and never a typed cursor
 *
 * The thing a processor actually keeps is `LastSync<ABI>`, a `@etherfold/core`
 * type carrying `EventBlock<ABI>`s of decoded events. Typing this port with it
 * would make `@etherfold/state-store` depend on core, invert ADR-0016's
 * dependency direction and drag viem into every storage primitive -- the exact
 * leak ADR-0018 exists to prevent and
 * `state-store-sqlite/test/no-platform-leakage.test.ts` pins.
 *
 * So the store persists a string and knows nothing about what it means. The
 * codec is the processor's (`serializeLastSync` / `deserializeLastSync` in
 * `@etherfold/processor-entities`), it was already plain JSON with a bigint
 * tag, and it was already backend-neutral, so this costs nothing.
 *
 * ## What the key is, and what it is NOT
 *
 * It is a plain string a caller chooses to name WHICH cursor it is reading, so
 * a store can hold more than one without this contract inventing a scheme for
 * them. It is deliberately **not** the indexer's `ContextIdentifier` (the
 * source / config / processor hashes): the neutral processor writes one fixed
 * key on purpose, because the core's discard-and-clear path only runs when
 * `load` RETURNS a cursor, and a cursor keyed by context would answer "nothing
 * stored" after a processor upgrade and silently index on top of the previous
 * processor's rows. See `SYNC_CURSOR_KEY` in `@etherfold/processor-entities`.
 *
 * ## The port is a SHARED namespace, and the seam itself uses two keys of it
 *
 * The sync cursor is this port's first user, not its definition. Because the
 * slot is durable, unversioned, never reverted and never pruned, it is also
 * where the seam keeps the two small facts a store must not forget across a
 * reload: `SNAPSHOT_ORIGIN_KEY` (`snapshot.ts` -- the block a bootstrapped
 * store's rows came from, so it cannot claim history it never received) and
 * `RETENTION_ENFORCEMENT_KEY` (`enforcement.ts` -- the floor the last prune
 * pass ran at, so a store pruned before the process died does not come back
 * saying never). A caller choosing its own key should avoid those two.
 */

/**
 * A cursor write to be applied WITH a block, in the same transaction.
 *
 * Handed to `StateStore.applyBlock`. The store's obligation is atomicity in
 * both directions: if the block applies the cursor moves with it, and if the
 * block is refused the cursor is exactly where it was. A store that wrote it
 * separately would be reintroducing the window this port exists to close.
 */
export type CursorWrite = {
	/** Which cursor. See the module note: a name, not a context hash. */
	readonly key: string;
	/** Opaque to the store. Whatever the caller can read back and understand. */
	readonly value: string;
};
