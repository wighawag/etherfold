import {cursorSyncedThrough, taggedBnReplacer, taggedBnReviver, type Abi, type LastSync} from '@etherfold/core';

/**
 * ## The sync cursor: what it MEANS, given that the store keeps it
 *
 * The storage is the store's (`StateStore.readCursor` / `writeCursor` /
 * `clearCursor`, and `applyBlock`'s third argument), and it is an OPAQUE STRING
 * under one key. This module is the other half: the codec that turns a
 * `LastSync<ABI>` into that string and back, and the rule for what string goes
 * with which block.
 *
 * The split is ADR-0016's dependency direction made literal. `LastSync<ABI>` is a
 * `@etherfold/core` type carrying `EventBlock<ABI>`s of decoded events, so a
 * store typed against it would drag viem into every storage primitive
 * (ADR-0018, pinned by `state-store-sqlite/test/no-platform-leakage.test.ts`).
 * The store persists a string; only the processor knows what it means.
 *
 * ## Why the cursor is not plain JSON
 *
 * `LastSync.unconfirmedBlocks` carries the actual `LogEvent`s of the
 * reorg-eligible window, and a decoded event's `args` hold **BigInt** values for
 * every `uint256` the ABI declares. `JSON.stringify` throws outright on a
 * BigInt, so a plain stringify works on every hand-built test cursor and fails
 * on the first real `Transfer` a chain produces.
 *
 * BigInts are therefore tagged on the way out and rebuilt on the way in. The tag
 * is an object with a single reserved key rather than the `"123n"` string
 * convention, because a suffix convention has to guess: it cannot tell a real
 * BigInt from a string a contract emitted that happens to end in `n`, and
 * guessing wrong silently rewrites event data.
 *
 * The codec itself is `taggedBnReplacer` / `taggedBnReviver` in
 * `@etherfold/core`, and it is now the repo's ONLY BigInt convention: the wire
 * batches a log-fetcher pushes carry the same decoded events, and every storage
 * adapter that used to suffix moved onto it (ADR-0029). Two copies of a codec
 * whose failure mode is silently rewriting event data is exactly the drift worth
 * paying an import to avoid.
 */

/**
 * The key the neutral processor keeps its cursor under, on every backend.
 *
 * ## One key, not one key per context
 *
 * The state is keyed by `{source, config, processor}` and the obvious reading is
 * that the cursor is keyed the same way. It is NOT, and the reason is
 * load-bearing rather than an economy.
 *
 * The core's discard path only fires when `load` RETURNS something whose context
 * does not match (`indexer.ts`: the mismatch branch is inside `if (loaded)`, and
 * it is the branch that calls `processor.clear()`). A cursor keyed by context
 * would answer "nothing stored" after a processor upgrade, `load` would return
 * `undefined`, the core would start a fresh sync, and `clear()` would never be
 * called: the previous processor's entity rows would still be sitting in the
 * store, and the new run would index on top of them.
 *
 * So there is ONE cursor and the context travels INSIDE it, where the core
 * already validates it. Keying it would also imply a multi-tenancy the rest of
 * the storage does not have, since entity rows carry no context and two contexts
 * sharing a store would collide on rows long before they collided on a cursor.
 *
 * This is why `cursor.ts` at the seam is careful to call the argument a KEY and
 * not a context: the seam's key names WHICH cursor, and a `ContextIdentifier` is
 * a different thing that happens to live inside the value.
 */
export const SYNC_CURSOR_KEY = 'lastSync';

/** Serialize a cursor, BigInts included. Exported so the round-trip can be tested directly. */
export function serializeLastSync<ABI extends Abi>(lastSync: LastSync<ABI>): string {
	return JSON.stringify(lastSync, taggedBnReplacer);
}

/** The inverse of `serializeLastSync`. */
export function deserializeLastSync<ABI extends Abi>(text: string): LastSync<ABI> {
	return JSON.parse(text, taggedBnReviver) as LastSync<ABI>;
}

/**
 * A cursor parsed from what a store handed back, or `undefined`.
 *
 * A stored string that does not parse is treated as "never synced" rather than
 * thrown: the recovery from a corrupt cursor is a fresh sync, and that is
 * exactly what `undefined` triggers.
 */
export function parseStoredCursor<ABI extends Abi>(stored: string | undefined): LastSync<ABI> | undefined {
	if (stored === undefined) return undefined;
	try {
		return deserializeLastSync<ABI>(stored);
	} catch {
		return undefined;
	}
}

/**
 * The same cursor, as it stood when only blocks up to `blockNumber` had been
 * applied.
 *
 * ## Why an intermediate cursor exists at all
 *
 * One `process(eventStream, lastSync)` call can carry MANY blocks, and each of
 * them is its own atomic `applyBlock`. The `lastSync` the core hands over
 * describes the END of that stream, so writing it with the FIRST block would put
 * the cursor ahead of the state: a crash there and the restart resumes past
 * blocks nothing ever applied, silently. Writing it only with the LAST block puts
 * the cursor behind the state for the whole of the run, and that is the wedge
 * `sync-cursor-write-is-not-atomic-with-the-block-it-describes`
 * recorded -- the restart replays a block the store already holds, `applyBlock`
 * refuses it as the caller bug it normally is, and no number of restarts clears
 * it.
 *
 * So every block gets the cursor that describes IT, and the state and the cursor
 * move in lockstep, one atomic step per block.
 *
 * ## What is truncated, and what deliberately is not
 *
 * - `lastToBlock` becomes `blockNumber`, which is the whole point: it is what
 *   `getFromBlock` resumes from.
 * - `unconfirmedBlocks` is cut to the ones at or below it. They are ascending, so
 *   this is a prefix, and it has to be one: the engine treats the last
 *   unconfirmed block as the boundary above which events are new, and an
 *   unconfirmed block ABOVE the resume point would make the blocks between them
 *   invisible on the next round.
 * - `latestBlock` is NOT truncated. It is the chain tip that was observed, not
 *   progress through it, and lowering it would widen the re-fetch window for no
 *   reason.
 * - `context` is not touched: it is the identity the core validates, and it is
 *   the same identity whichever block of the stream this is.
 *
 * The last block of a stream needs none of this and gets the `lastSync` itself,
 * so the common case (one block, or the tip of a backfill) costs no truncation
 * at all. See `applyEventStream`.
 *
 * ## Why this is a re-export and not an implementation
 *
 * The engine needs the SAME narrowing one level up: `promiseToFeed` hands each
 * BATCH a cursor the processor persists, and it has to be true on its own for
 * exactly the reason above. Two copies of a rule this subtle is how the halves
 * drift, so it lives once in `@etherfold/core` as `cursorSyncedThrough` and is
 * re-exported here under the name this package's callers already use.
 */
export const syncedThrough = cursorSyncedThrough;
