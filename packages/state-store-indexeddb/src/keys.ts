import {
	idValues,
	prefixValues,
	type EntityId,
	type EntityIdPrefix,
	type NormalizedEntity,
} from '@etherfold/state-store';

/**
 * The storage layout, which is three object stores and three indexes.
 *
 * ```
 * current   [entity, ...id]         -> {lower, values}        the tip read and the tip listing
 * versions  [entity, ...id, lower]  -> {lower, upper, values} the history, for as-of and for revert
 * blocks    number                  -> {number, hash, timestamp}
 * cursors   key                     -> the opaque string the caller wrote
 * seam      'writer'                -> the token of whoever claimed this database
 *           <seam record key>       -> the opaque string the SEAM wrote
 * ```
 *
 * **The entity name is part of the KEY rather than the name of a store**, which
 * is the one structural difference from the SQL backend and it is deliberate.
 * Creating an object store in IndexedDB requires a version change and therefore
 * an upgrade transaction that no other tab may hold a connection through, so a
 * store per entity would turn "the processor declares one more entity" into a
 * schema migration that a second open tab BLOCKS. With the entity in the key the
 * schema never moves with a processor's declarations, and every access path a table would have
 * given is still a key range, because a key range on `[entity, ...]` is exactly
 * "that entity's rows".
 *
 * **The schema version is this PACKAGE's, not a processor's**, and the
 * distinction is the whole reason for the layout above. A processor declaring
 * one more entity is still not a migration and still cannot be blocked by a
 * second open tab; what moves the version is this package growing an object
 * store of its own.
 *
 * **Each id column is keyed by its UTF-8 BYTES, not by its string** (`idKey`),
 * and the entity name, which a key range only ever matches exactly, stays a
 * string. The listing's id order is UTF-8 byte order on every backend
 * (ADR-0021), and IndexedDB compares a STRING key by UTF-16 code unit, which
 * disagrees with it for an id above U+FFFF against one from U+E000 to U+FFFF; a
 * binary key compares bytewise on Chromium, Firefox and WebKit, so the key
 * order the listing's range scan walks is the listing's order, with nothing
 * sorted after the scan. The evidence is
 * `docs/spikes/the-listings-id-order-per-backend/README.md`.
 *
 * The price is that devtools shows the id part of a key as opaque bytes. The
 * READABLE form is kept where it already was: `values` carries every id column
 * as its plain string (`completeRow` in `store.ts`), so a record still says
 * which row it is. Do not drop the id columns from `values` on the grounds that
 * the key has them: the key has them only as bytes.
 *
 * `values` is the COMPLETE row (id columns and every declared field, unlisted
 * ones NULL), so a version means the same thing here as everywhere else. It is
 * duplicated between `current` and `versions` for the live version, which is the
 * shape the measurements in `work/notes/findings/sqlite-in-the-browser.md` were
 * taken on: it buys a tip read that is ONE `get` (305 us on Chromium, against
 * 1,246 for the wasm-SQLite candidate) and a tip listing that never reads a
 * superseded version, and it costs one extra copy of the live set.
 */

/**
 * The version this package opens its database at. `open(name, version)` takes
 * one, so there is no not having it; what it MEANS is decided here.
 *
 * **Bump it when THIS PACKAGE changes an object store or the key layout**,
 * which are the only things that can need one: a processor declaring one more
 * entity is not a migration here, because the entity name is part of the KEY
 * rather than the name of a store (above), and that is what keeps an upgrade
 * transaction, which a second open tab BLOCKS, out of the ordinary path.
 *
 * - **1**: the stores above, with id columns as STRING keys (UTF-16 key order).
 * - **2**: id columns as their UTF-8 BYTES (`idKey`), so the key order is the
 *   listing's order (ADR-0021).
 *
 * Nothing climbs a ladder between them. `upgrade` (in `store.ts`) DISCARDS a
 * database written below `KEY_LAYOUT_SINCE` and rebuilds it empty, rather than
 * re-keying it row by row: nobody holds a database worth keeping (nothing is
 * published), and a state that is discarded is refolded from the stream, while
 * one read under the wrong layout would answer in the wrong order silently.
 * Adding a store stays CONVERGENT (every creation is `contains`-guarded), so a
 * bump for a new store needs no per-step branch either.
 */
export const SCHEMA_VERSION = 2;

/**
 * The first `SCHEMA_VERSION` whose keys this code can read: an existing
 * database at a lower version was written with id columns as string keys and is
 * discarded at the version change, never read. Raise it (to the new
 * `SCHEMA_VERSION`) only when the key layout changes again; a new object store
 * does not.
 */
export const KEY_LAYOUT_SINCE = 2;
export const CURRENT = 'current';
export const VERSIONS = 'versions';
export const BLOCKS = 'blocks';
/**
 * The sync cursors: one opaque string per caller-chosen key.
 *
 * It is here, in the store, rather than beside it because a cursor has to be
 * written in the SAME transaction as the block it describes and only the store
 * opens that transaction. The reasoning is at the seam, in
 * `@etherfold/state-store`'s `cursor.ts`. Nothing in this package knows what the
 * string means.
 */
export const CURSORS = 'cursors';
/**
 * Everything in this database that is NOT the caller's: the writer token, and
 * the seam's own records.
 *
 * It is an object store of its own rather than keys in `cursors`, because that
 * keyspace is the CALLER's -- a caller chooses its own cursor keys (`cursor.ts`
 * at the seam) and would eventually choose one of these names, silently
 * overwriting a record whose loss does not look like a failure. It is ONE store
 * rather than two because the two kinds of record are the same kind of thing (a
 * fact about the storage rather than a fact a caller put there), they want the
 * same durability, and every guarded mutation already opens this store to check
 * the token, so writing a seam record needs no second object store in the
 * transaction.
 *
 * Out-of-line keys and no value shape, so the token (a string under `writer`)
 * and the seam's records (strings under the `SeamRecordKey` names) sit side by
 * side with nothing to declare.
 *
 * Being INSIDE the database is what scopes the claim: the identity it guards is
 * the `databaseName` and nothing else, so two unrelated indexers on one origin
 * never contend and two generations addressed apart both write. See `writer.ts`
 * at the seam and ADR-0075.
 */
export const SEAM = 'seam';

/**
 * The token key in `SEAM`: this database has exactly one holder.
 *
 * Distinct from the seam record `writerClaim` beside it, which nothing ever
 * writes and which exists only to be CLEARED -- that clear is the no-op mutation
 * a claim is taken by, and this is the value the claim swaps.
 */
export const WRITER_KEY = 'writer';

/** Unique: a hash identifies one block, and a second claim on it is a caller bug. */
export const HASH_INDEX = 'hash';
/**
 * Revert leg A: the versions a fork opened. Range scan, never a scan of the store.
 */
export const LOWER_INDEX = 'lower';
/**
 * Revert leg B and the prune: the versions that were CLOSED, ordered by when.
 *
 * A live version has `upper: null`, which is not a valid IndexedDB key, so it is
 * not in this index at all. That is not a trick, it is the property the prune
 * needs most: the LIVE version of an entity is the current state however old it
 * is, and a prune written as "drop what is older than the floor" destroys it. It
 * cannot be reached from here.
 */
export const UPPER_INDEX = 'upper';

/** One version: a complete row plus its half-open block-validity range. */
export type VersionRecord = {
	lower: number;
	/** Exclusive; `null` means live, and keeps the record out of `UPPER_INDEX`. */
	upper: number | null;
	values: Record<string, unknown>;
};

/** The live version of one business key, so a tip read is one `get`. */
export type CurrentRecord = {lower: number; values: Record<string, unknown>};

/** The block record: what `_blocks` is in the SQL backend. */
export type BlockRecord = {number: number; hash: string; timestamp: number};

const UTF8 = new TextEncoder();

/**
 * Id column values as key parts: the UTF-8 bytes of each, so IndexedDB, which
 * compares a binary key bytewise, orders them in UTF-8 byte order (ADR-0021)
 * rather than in the UTF-16 code units it compares a string key by.
 *
 * Every key built from an id or an id prefix goes through here, so a full id, a
 * listing prefix and a parent key in the accessor are encoded the same way.
 */
export function idKey(values: readonly string[]): Uint8Array<ArrayBuffer>[] {
	return values.map((value) => UTF8.encode(value));
}

/** The key of one business key's row: the entity name, then each id column as UTF-8 bytes. */
export function rowKey(entity: NormalizedEntity, id: EntityId): IDBValidKey[] {
	return [entity.name, ...idKey(idValues(entity, id))];
}

/** The key of one VERSION of that row: the row's key with the block it opened at. */
export function versionKey(row: readonly IDBValidKey[], lower: number): IDBValidKey[] {
	return [...row, lower];
}

/** The row a version key belongs to: everything but the trailing block number. */
export function rowOfVersionKey(key: readonly IDBValidKey[]): IDBValidKey[] {
	return key.slice(0, -1);
}

/**
 * The range of every key that STARTS WITH `key`, which is the whole trick.
 *
 * IndexedDB orders an array key element by element and sorts an array AFTER
 * every number, string and binary key, so `[]` is greater than any element that
 * could follow the prefix and no real key can equal the upper bound. That makes
 * `bound([...prefix], [...prefix, []])` exactly "the prefix and its
 * descendants", and it is why the listing at the seam is a prefix of the
 * declared id and nothing else: this is one indexed range scan, on a store with
 * no query planner in it (ADR-0021).
 */
export function startingWith(key: readonly IDBValidKey[]): IDBKeyRange {
	return IDBKeyRange.bound([...key], [...key, []]);
}

/**
 * The range a listing scans: the entity's rows whose id starts with the prefix.
 *
 * The prefix is validated by the seam (`prefixValues`), so a prefix that is not
 * a LEADING run of the declared id columns is refused here in the same words as
 * on every other backend rather than quietly scanning something else.
 */
export function listingRange(entity: NormalizedEntity, prefix: EntityIdPrefix): IDBKeyRange {
	return startingWith([entity.name, ...idKey(prefixValues(entity, prefix))]);
}

/**
 * The versions of one row that opened at or before `at`, so an as-of read is a
 * cursor walked BACKWARDS: the first hit is the version live then, if any.
 */
export function asOfRange(row: readonly IDBValidKey[], at: number): IDBKeyRange {
	return IDBKeyRange.bound([...row], [...row, at]);
}

/** Everything strictly above the fork point: the range both revert legs walk. */
export function above(blockNumber: number): IDBKeyRange {
	return IDBKeyRange.lowerBound(blockNumber, true);
}
