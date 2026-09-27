---
title: 'A snapshot installed over a store that computed its own state replaces it'
slug: a-snapshot-install-replaces-a-self-computed-store
blockedBy: []
covers: []
---

## What to build

Resolve `work/notes/observations/a-snapshot-install-overlays-a-self-computed-store.md`. `bootstrapFromSnapshot` (`packages/processor-entities/src/snapshot.ts`) installs a snapshot whenever the local cursor is BELOW the best candidate's `takenAt`, not only when there is no cursor. `SnapshotAwareStateStore.bootstrap` (`packages/state-store/src/snapshot.ts`) wipes the store first (`revertTo(-1)`) only when it already carries a snapshot origin. On a store that INDEXED ITSELF (no origin), the floor's live rows are laid on top of the existing state:

- a row the local store holds that was deleted on-chain between its own tip and the snapshot's floor is not in the snapshot (a floor carries only live rows), so it survives as a stale row, silently;
- a floor at or below the local recorded tip is refused by `applyBlock`, so a history snapshot fails to install.

Decided with the maintainer on 2026-09-27: WIPE, then install. Any store that holds state (a snapshot origin, OR any recorded block / cursor of its own) is replaced whole before the floor is written, exactly as a previous install already is, once the new document's head and floor have been checked (so a refused document still changes nothing). "A tab that is behind starts from the snapshot" stays the one rule; catching up from the local cursor instead was rejected, because the gap after a long absence is the historical `eth_getLogs` range a public node may refuse, which is what a snapshot exists to avoid.

Update the comment above `bootstrap` ("An earlier install") to cover the self-computed case, and retire the observation (delete it; re-point any non-exempt citation).

## Acceptance criteria

- [ ] A store that indexed itself to a block below a snapshot's `takenAt`, holding a row that the chain deleted before the snapshot's floor, ends after the install with exactly the snapshot's state: the deleted row is absent, and every read answers as a fresh install of the same snapshot does.
- [ ] A history snapshot whose floor is at or below the self-indexed store's tip installs (no `applyBlock` refusal), and answers as of every block from its floor as a fresh install does.
- [ ] A snapshot refused before anything is written (another processor, an unreadable format, a declaration mismatch) leaves the self-indexed store exactly as it was.
- [ ] A store already at or ahead of the snapshot is left alone (no install, no wipe), as today.
- [ ] Covered on every backend that installs a snapshot (memory, SQLite, IndexedDB, and the tip-only patch store), through the conformance suite or the existing per-backend snapshot suites, and once through `openAndBootstrap`.
- [ ] Changesets for every published package changed (0.x: patch or minor).

## Blocked by

- None: can start immediately.

## Prompt

> Goal: a snapshot install over a self-indexed store replaces it (see What to build). Look at `bootstrap` in `packages/state-store/src/snapshot.ts` (the existing wipe for a store with a snapshot origin), `bootstrapFromSnapshot` / `openAndBootstrap` in `packages/processor-entities/src/snapshot.ts`, and the backends' `revertTo(-1)`; check that the tip-only patch store can wipe a self-indexed state, and record in `## Decisions` how if it needs anything.
>
> FIRST, check this task against current reality: if the install already wipes a self-indexed store, route to needs-attention saying so.
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.

## Decisions

- **The wipe is unconditional, not "only if the store holds state".** The snapshot-aware handle has no verb that says whether the store holds rows, a recorded block or a cursor, and wiping an empty store does nothing. This covers every case the task lists without adding a new query to the store interface. The alternative was to add a "has state" check (a tip or block-count verb) to every backend, which would widen the interface for no change in behaviour. It touches `SnapshotAwareStateStore.bootstrap` only.
- **The install also clears the document's cursor key (`head.cursor.key`), before the rows are wiped.** A revert leaves cursors alone by design. Without the clear, a download cut short over a self-indexed store would leave its old cursor over snapshot rows. The next boot's `openAndBootstrap` would then see that cursor, keep local state, and index on from the wrong state without reporting anything. Clearing first means any interruption leaves no cursor, which is the case the next boot already reinstalls. I considered leaving cursors alone to match the existing previous-install wipe, and rejected it for that reason. This also changes the previous-install case, and it matches what `EntityEventProcessor.reset()` does (revert plus clear cursor).
- **The patch store's `revertTo(keepUpTo < 0)` wipes without reverse patches.** Blocks are numbered from 0 and the store starts empty, so the state below block 0 is always empty. I limited it to `keepUpTo < 0` rather than "below every recorded block", because the existing test `refuses a retraction deeper than the patches it still holds` (`processor-entities/test/patch-backend.test.ts`) relies on a non-negative revert below the first block still being refused. This touches `EntityEventProcessor.reset()` on a pruned patch store, which now works instead of throwing.
- **The `openAndBootstrap` coverage uses a store with recorded blocks and rows but no sync cursor.** `openAndBootstrap` keeps local state whenever any cursor exists, so a self-indexed store with a cursor never reaches the install through it. The only self-indexed state it can install over is one with no readable cursor. I did not change `openAndBootstrap`'s rule; the behind-the-snapshot case with a cursor is covered through `bootstrapFromSnapshot`.
- **Only the declared columns are compared in the conformance equality check.** SQLite returns its own `_rowid`, `_lower` and `_upper` columns, which differ between a wiped store and a fresh one. The `_` namespace belongs to the store, so the comparison strips it using the existing `declaredColumns` fixture.
