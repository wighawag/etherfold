/**
 * ## The writer token: one record INSIDE the storage it guards
 *
 * Two instances of one indexer writing to one store corrupt it, and until this
 * existed only ONE mutating path would have noticed: `applyBlock` reads the
 * block record inside the transaction it writes in, which is a genuine
 * compare-and-swap, and nothing else had a precondition at all. The quiet
 * failure is the one that matters -- a cursor moved BACKWARDS by a writer
 * holding a stale `LastSync` leaves a state that is internally consistent,
 * reproducible on reload, and wrong.
 *
 * So a writer CLAIMS the store, and every mutation it makes is checked against
 * that claim inside the same atomic unit as the write. A second writer's first
 * mutation claims in turn, which INVALIDATES the first claim, so the earlier
 * writer's next mutation is refused whole (`StoreWriterChangedError`): not
 * partially applied, not applied late, not applied to a state it did not read.
 *
 * ## This is ADR-0054 one level down, not a second mechanism
 *
 * ADR-0054 guards a registry commit over `RemoteSQL` on a REVISION token, for
 * the reason its opening line gives: `RemoteSQL` cannot read, run JS and write
 * inside one transaction, so the guard has to be smuggled into a pre-built
 * statement list. That same line records the primitive this rests on --
 * "IndexedDB gives that for free (`readwrite` transactions serialise across
 * tabs)" -- and on that substrate the check and the write sit in ONE
 * serialisable transaction, so the fencing is EXACT rather than best-effort: a
 * stale writer's mutation lands NEVER, and no timing assumption is made
 * anywhere. On SQLite it is ADR-0054's mechanism unchanged: guard every
 * statement on the token, and read the token back inside the same batch to
 * learn whether you won. See ADR-0075.
 *
 * ## Claiming is IMPLICIT, and that is the decision
 *
 * A store claims on its FIRST mutation and never on `migrate`, so no caller
 * changes and no caller can forget. An OPTIONAL token argument was rejected for
 * the reason ADR-0054 rejects a read-then-write that merely looks atomic: a
 * guard that is available and unused passes every single-writer test.
 *
 * Claiming does not BLOCK and does not EXPIRE, so there is no lease to time out
 * and no held state a crash can leave behind: a writer killed mid-block leaves a
 * store the next claim simply takes over. The loser learns it lost and writes
 * nothing, which is the whole guarantee.
 *
 * ## What the token is SCOPED to: one unit of STORAGE
 *
 * The token lives inside the storage it guards, so the scope follows from an
 * identity every backend already has -- the `databaseName` on IndexedDB, the
 * database plus ADR-0053's table namespace on SQLite -- and needs no new
 * concept. That is what makes two unrelated indexers on one origin never
 * contend, two correctly separated generations still write at once, and two
 * generations sharing one storage by misconfiguration REFUSED where they used to
 * corrupt each other silently. Scoping it to an origin, a tab, a connection or a
 * lock name OUTSIDE the database would break the first two of those.
 *
 * Not every backend can hold a meaningful guard: `MemoryStateStore` and
 * `@etherfold/state-store-patch` keep their storage in instance fields, so no
 * second writer can reach it and a token there could only ever be compared with
 * itself -- green, tested, and meaningless. A store therefore REPORTS whether it
 * enforces a single writer (`StateStoreCapabilities.singleWriter`) and the
 * conformance suite selects the contention cases on that claim.
 */

/**
 * A writer token: a value only one claim could have produced.
 *
 * It is a `string` and not a branded type because nothing anywhere derives
 * meaning from it: see `writerToken` below for what is and is not asked of one.
 */
export type WriterToken = string;

/**
 * A writer token: a value only THIS claim could have produced.
 *
 * It is OPAQUE. Nothing compares two tokens for order, nothing parses one, and
 * nothing reads a time out of it -- the only question ever asked of it is
 * whether the token in the storage is byte-identical to the one this writer
 * claimed with. A monotonic counter would be the obvious alternative and is
 * refused on the same ground ADR-0054 refuses it: on a substrate whose only
 * evidence is a read-back, a loser reading `expected + 1` sees the winner's
 * value, which is the very number it was about to write, and cannot tell a win
 * from a loss.
 *
 * `crypto.randomUUID` is present on Node, Workers and browsers; the fallback is
 * for a host that predates it, and it is time plus two independent random draws
 * rather than one, so it stays unique enough among concurrent writers.
 */
export function writerToken(): string {
	const uuid = globalThis.crypto?.randomUUID?.();
	return (
		uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
	);
}
