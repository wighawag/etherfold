---
'@etherfold/state-store': minor
'@etherfold/state-store-indexeddb': minor
'@etherfold/state-store-sqlite': minor
'@etherfold/state-store-conformance': minor
'@etherfold/state-store-patch': patch
---

**Two instances of one indexer can no longer corrupt one state store: every mutating path now carries a WRITER TOKEN, checked inside the same atomic unit as the write it guards** (ADR-0075).

A writer CLAIMS the store on its first mutation. A second writer's first mutation claims in turn, which invalidates the first claim, so the earlier writer's next mutation is refused whole with the new `StoreWriterChangedError` -- nothing applied, nothing applied late, the store byte-identical. Claiming is IMPLICIT, so no caller changes and no caller can forget; it does not block and does not expire, so a writer killed mid-block leaves a store the next claim simply takes over.

Guarded: `applyBlock`, `revertTo`, `writeCursor`, `clearCursor`, `prune`, plus `applyBlocks` and `drop` on the SQL backend. `migrate` is deliberately NOT guarded and never claims, because it runs on every open and several tabs of one app all open.

This is ADR-0054's guarded batch with a revision token, applied one level down, not a second mechanism. On IndexedDB the check and the write are in one serialisable `readwrite` transaction, so the fencing is EXACT rather than best-effort. On SQLite every statement is guarded on the token and the same batch reads it back, because `remote-sql` reports no affected-row count.

**The claim is scoped to one unit of STORAGE**, because the token lives inside it: the `databaseName` on IndexedDB, the database plus ADR-0053's table namespace on SQL. So two unrelated indexers on one origin never contend, two generations of one indexer addressed apart both keep writing, and two generations sharing one storage by misconfiguration are now REFUSED where they used to corrupt each other silently.

**If you implement `StateStore`:** `StateStoreCapabilities` has a new REQUIRED `singleWriter: boolean`. Report `true` only if you enforce it on every mutating path; a backend whose storage is an instance field (`MemoryStateStore`, `@etherfold/state-store-patch`) reports `false` honestly, because a token there could only ever be compared with itself.

**If you run the conformance suite:** it takes an optional third argument. A backend claiming `singleWriter` must pass `{twoWriters: {sharingStorage, addressedApart}}` -- two handles on ONE storage, and two handles ADDRESSED APART -- because `StateStoreFactory` is a fresh database per call and cannot express either. A backend that claims the guarantee and supplies no affordance fails a case saying so.

**If you deploy on D1:** a prune round now costs three queries rather than two (the guarded DELETE plus its read-back), and names one fewer row id per statement, because the guard is that statement's other bound parameter. `d1PruneBudget` accounts for both.

The IndexedDB schema version moved to 3 for the new `writer` object store; the upgrade is `contains`-guarded, so an existing database gains it and keeps every row.
