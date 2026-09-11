/**
 * ## The seam's OWN records: a private keyspace beside the caller's
 *
 * Three small facts have to survive a reload, and none of them belongs to the
 * caller: **where a bootstrapped store's rows came from** (`snapshotOrigin`, so
 * it cannot claim history it never received), **the floor the last prune pass
 * ran at** (`retentionEnforcement`, so a store pruned before the process died
 * does not come back saying never) and **the claim itself**
 * (`writerClaim`, the guaranteed no-op mutation `openForWriting` takes the
 * store with).
 *
 * They used to live at the CURSOR PORT, under reserved key names, and that was
 * a collision waiting to happen rather than a design: the cursor port is a
 * namespace the CALLER chooses keys in, so an app that stored its own position
 * under `snapshotOrigin` overwrote the marker and the store then answered
 * historical reads it had no rows for. Neither of the two dangerous cases looks
 * like a failure -- an overwritten origin makes a bootstrapped store claim
 * history it has no rows for, and an overwritten enforcement record makes a
 * pruned store report it never pruned -- so nothing downstream could tell the
 * wrong answer from a right one.
 *
 * With this port the cursor port is ENTIRELY the caller's again.
 * `writeCursor('snapshotOrigin', ...)` is a cursor with an odd name that
 * collides with nothing, there is no reserved list to document, and a host
 * choosing cursor keys has nothing to remember.
 *
 * ## Why a CLOSED set of keys and not a second string namespace
 *
 * A second open keyspace would only move the question: whoever owns it would
 * have to publish which names it had taken. The keys here are a fixed union of
 * three, so the namespace cannot grow by accident, a typo is a compile error,
 * and a caller cannot address it at all -- there is no string it could pass.
 *
 * ## Why it is on `StateStoreBackend` and never on `StateStore`
 *
 * A READER has no business with any of it, and each of the three has a read at
 * the seam that is the answer a consumer actually wants: the snapshot floor
 * arrives narrowed into `capabilities`, the prune record arrives shaped as
 * `readRetentionEnforcement`, and the claim is `openForWriting`'s business
 * alone. Putting the port on the backend interface keeps all three out of the
 * shape a consumer holds, which is the same move the split itself makes
 * (ADR-0077): a reader cannot reach it because the TYPE does not have it.
 *
 * ## Why this and not a guard on the writable handle
 *
 * Refusing reserved key names on `writeCursor` is the obvious guard, and it
 * cannot work. `openSnapshotAware` composes ABOVE the claim on the real boot
 * path (`openAndBootstrap` claims and then wraps), so `SnapshotAwareStateStore`
 * writes its own marker THROUGH a claimed handle and is indistinguishable at
 * runtime from a caller doing the same thing. A guard there refuses the seam its
 * own namespace and takes the bootstrap path down with it. SEPARATING the two
 * namespaces is what a guard was reaching for, and it needs no runtime check at
 * all: the seam writes where a caller cannot, so there is nothing to enforce.
 *
 * ## Two of the three travel through the port; one never does
 *
 * `snapshotOrigin` and `writerClaim` are SEAM-LEVEL -- the snapshot layer wraps
 * an arbitrary backend and the claim is taken through the seam -- so they are
 * reached by calls, and every backend has to answer them identically.
 * `retentionEnforcement` is written by the backend ITSELF, inside the same
 * transaction as the deletion it describes, and read back by that backend's own
 * `readRetentionEnforcement`. It is a member of this keyspace rather than of a
 * fourth private one because it is the same KIND of fact and wants the same
 * durability; it simply never needs to cross the interface.
 */

/**
 * Every record the seam keeps inside a store, as a closed set.
 *
 * Exported so the conformance suite can walk it: each of these must survive
 * independently of the others AND of a cursor that happens to share its name,
 * on every backend.
 */
export const SEAM_RECORD_KEYS = ['snapshotOrigin', 'retentionEnforcement', 'writerClaim'] as const;

/**
 * WHICH of the seam's records. Not a caller-chosen string: see the module note.
 *
 * - `snapshotOrigin` -- the block a bootstrapped store's rows came from
 *   (`snapshot.ts`).
 * - `retentionEnforcement` -- the floor the last prune pass ran at
 *   (`enforcement.ts`); written by a backend inside its own prune, never
 *   through the port.
 * - `writerClaim` -- the key `openForWriting` clears in order to claim
 *   (`store.ts`). Nothing ever writes it.
 */
export type SeamRecordKey = (typeof SEAM_RECORD_KEYS)[number];
