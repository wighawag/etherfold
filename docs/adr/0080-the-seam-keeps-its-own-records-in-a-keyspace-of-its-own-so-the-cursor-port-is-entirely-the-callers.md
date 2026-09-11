# The seam keeps its OWN records in a keyspace of its own, so the cursor port is entirely the CALLER's

The sync cursor port (ADR-0027) is a keyed slot for an opaque string under a **caller-chosen** key, and the seam then put three of its own facts in it: the snapshot origin (ADR-0028), the retention-enforcement record (ADR-0076) and the writer claim (ADR-0077). Each arrived as "one more key rather than a new port on four backends", which was cheap and right at the time, and together they turned a caller's namespace into a shared one with a reserved list. We decided: **the seam's own records move into a keyspace of their own, addressed by a CLOSED union of three keys through a small port on `StateStoreBackend` (`readSeamRecord` / `writeSeamRecord` / `clearSeamRecord`), and the cursor port goes back to being entirely the caller's.** `writeCursor('snapshotOrigin', ...)` is now a cursor with an odd name that collides with nothing: no reserved names, no refusals, nothing to document or remember.

## Why a convention was not good enough

Two of the three collisions are SILENT and neither looks like a failure. Overwrite the snapshot origin and a bootstrapped store stops reporting its floor, so it answers `getAsOf` below its snapshot -- about rows it does not have -- with `undefined`, which is an ordinary answer a caller acts on and which is wrong; that is the exact plausible-wrong-number failure ADR-0028 exists to prevent, arriving through the door ADR-0028's own fix opened. Overwrite the enforcement record and a pruned store reports `never-pruned`, which asks a human to look at a store that is fine and, worse, makes the report's one real signal untrustworthy. A convention that fails this way fails invisibly, in an app that did nothing wrong: the cursor key is the app's to choose, and `snapshotOrigin` is a perfectly reasonable name for an app that also tracks where its own data came from.

## Why NOT a guard on the writable handle, which is the obvious fix

Refusing reserved key names on `writeCursor` looks like a two-line change and breaks bootstrap. `openSnapshotAware` composes **above** the claim on the real boot path (`openAndBootstrap` claims, then wraps), so `SnapshotAwareStateStore` writes its own marker THROUGH a `ClaimedStateStore` and is indistinguishable at runtime from a caller doing the same thing. A guard there refuses the seam its own namespace and turns the bootstrap suite red. The dead end was recorded in `cursor.ts` before this ADR and cost a previous attempt a full gate run; separating the namespaces is what the guard was reaching for, and it needs no runtime check at all, because the seam writes where a caller cannot.

## What the three records cost, and why the port carries only two of them

`retentionEnforcement` needed no interface change: every backend already writes it INSIDE its own prune transaction (which is what keeps the floor recorded and the floor deleted against from drifting) and reads it back in its own `readRetentionEnforcement`. It simply moved to the private location. `snapshotOrigin` and `writerClaim` are SEAM-LEVEL -- the snapshot layer decorates an arbitrary backend, and `openForWriting` claims through the seam -- so those two need calls, and that is the whole of the new port.

The port is on **`StateStoreBackend` and never on `StateStore`**, so a reader cannot reach it at all: each of the three already has the read a consumer actually wants (the floor arrives narrowed into `capabilities`, the prune record arrives shaped as `readRetentionEnforcement`, and the claim is `openForWriting`'s business). That is ADR-0077's split applied to the seam's own memory.

The keys are a CLOSED union rather than a second string namespace, because an open one would only move the question: whoever owned it would have to publish which names it had taken. Three fixed keys cannot grow by accident, a typo is a compile error, and a caller has no string it could pass.

## What each backend does, and why this was cheap NOW

The project is greenfield -- nothing published, and no database exists in any browser or on any server -- so the creation path is edited directly and no migration is owed. IndexedDB's writer object store is schemaless with out-of-line keys, so it holds all four values (the backend's token under `writer`, the three records under their own names) and is renamed `seam` to say so; its `prune` transaction gets NARROWER as a result, since `cursors` is no longer in it. SQLite gets a `_seam` sibling table with the same two columns as `_cursor`, **in the table namespace** with `_blocks`, `_cursor` and `_writer` (ADR-0053), because each of these facts is about ONE generation's state. The reference store and the patch store get a second `Map`.

`_seam` is a sibling of `_writer` rather than more rows in it: `_writer` pins exactly one row (`CHECK (id = 0)`) and means one thing, WHO holds this store, and relaxing that check would turn the table the writer guard's subquery reads into a general keyspace for no gain over one more two-column table.

## Consequences

- A `major` on `@etherfold/state-store`: `StateStoreBackend` grows three members, so every implementor outside this repository must add them, and `SNAPSHOT_ORIGIN_KEY`, `RETENTION_ENFORCEMENT_KEY` and `WRITER_CLAIM_KEY` are GONE from the public surface (they existed so a host could avoid them, which is the obligation this removes). `@etherfold/processor-entities` stops re-exporting the two it carried.
- The conformance suite gains a chapter (`the seam's own records`), asked of every backend, because "a separate keyspace" is a claim about STORAGE and only a backend has any: at the seam two `Map`s would satisfy it and prove nothing about a substrate with one namespace it was tempting to reuse.
- ADR-0027's port is unchanged in everything but its tenancy, and ADR-0028, ADR-0076 and ADR-0077 keep their mechanisms: a persisted floor, a durable prune record, and a claim taken by a clear that is a guaranteed no-op. Only WHERE each lives moved, which is why those three are superseded in part rather than replaced.
