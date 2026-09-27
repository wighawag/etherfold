---
date: 2026-09-27
---

# A snapshot installed over a store that computed its own state is laid on top of it

Seen while building `a-published-snapshot-carries-the-history-it-was-asked-for`. `bootstrapFromSnapshot` (`packages/processor-entities/src/snapshot.ts`) installs a snapshot whenever the local cursor is BELOW the best candidate's `takenAt`, not only when there is no cursor. On a store that carries no `snapshotOrigin` (it indexed itself), `SnapshotAwareStateStore.bootstrap` then applies the floor's live rows on top of the existing state: a row the fold deleted between the local tip and the floor survives as a stale row, and a floor at or below the local recorded tip is refused by `applyBlock` instead. That task made the install wipe a store that already carries a snapshot origin (a previous or interrupted install), and deliberately left the self-computed case alone as out of scope.
