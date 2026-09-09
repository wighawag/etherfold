---
title: 'Only the block record guards a second writer, so `revertTo`, the cursor writes and `prune` corrupt state instead of being refused'
slug: a-second-writer-is-guarded-only-where-a-block-record-happens-to-sit
observed: 2026-09-09
source: 'design discussion on a browser query surface. Read from `packages/state-store-indexeddb/src/store.ts`, `packages/browser/src/storage/state-store/BrowserStateStore.ts`, `packages/browser/src/IndexerState.ts` and `packages/state-store-indexeddb/browser/multi-tab.spec.ts` at ad8d8b1f. READ, not executed: no failing case was run, so the severity ordering below is reasoned from the code rather than observed.'
---

ADR-0054 already records the primitive this rests on, in its opening line: "IndexedDB gives that for free (`readwrite` transactions serialise across tabs)". `applyBlock` uses it correctly, for exactly one thing. Inside the one `readwrite` transaction it opens over `CURRENT`/`VERSIONS`/`BLOCKS`/`CURSORS`, it reads `blocks.get(block.number)` and `blocks.index(HASH_INDEX).getKey(hash)` and refuses on either. That is a genuine compare-and-swap and it holds against a concurrent writer.

**Nothing else on the mutating surface has a precondition of any kind.** Five paths, in increasing severity:

1. **The cursor write inside `applyBlock` is unconditional.** `tx.objectStore(CURSORS).put(cursor.value, cursor.key)` overwrites whatever is there. The block half of the same transaction is guarded and the cursor half is not.
2. **`applyBlock` refuses a DUPLICATE height, not a non-monotonic one.** The invariant a single writer actually maintains is "above the recorded tip"; what is enforced is "not exactly this height, and not this hash". One `blocks.openCursor(null, 'prev')` inside the transaction that already exists would close the difference.
3. **`writeCursor` / `clearCursor`** are the no-block paths, so no block record incidentally protects them. These are how a writer holding a stale in-memory `LastSync` moves the recorded position BACKWARDS, silently. On the next load the cursor disagrees with the data, the indexer re-fetches, and every re-application hits the refusal in (2), which presents as a wedged store rather than as the lost update it is.
4. **`prune`** drops versions against a retention floor computed from a tip another writer may have moved.
5. **`revertTo` has no precondition at all**, and it is the destructive one: it deletes versions above a fork point while another writer may be folding above it. This is the only path in the list that can leave a WRONG state rather than an exception.

**The four-tab browser case does not cover this, and says so itself.** `browser/multi-tab.spec.ts`: "Each tab owns its own block heights (a block is applied once, by definition), writes its own rows". It proves the substrate tolerates four concurrent connections, which is the claim ADR-0024 needs from it (three of four tabs failed at OPEN on both SQLite VFSs). It is not evidence that two indexers can share a database, and was never meant to be.

**Nothing elects a writer.** No `navigator.locks`, no `BroadcastChannel`, no lease anywhere in `@etherfold/browser`. The store's refusal in (2) names the caller as the bug ("applying the same block twice is a caller bug") and it is right to, but no caller is in a position to avoid it.

**A second writer is reachable INSIDE one tab, not only across tabs.** `createState` is called once per generation and is handed a `GenerationContext`, so an app CAN name a database per generation, but `databaseName` defaults to `etherfold-state` and the documented example (`createState: () => createBrowserStateStore(myProcessor.entities)`) ignores the context. Two generations of one indexer legitimately write at the same time (a canonical generation and a follower rebuilding), so following the documented example puts two writers into one `BLOCKS` store in a single tab. Worth checking against ADR-0053 ("a generation is a table namespace and a named indexer is a database"), which suggests the namespace is meant to be part of the addressing here and does not appear to be.

**Fix shape:** ADR-0054's guarded batch with a revision token, one level down, and easier than the case it was written for. That ADR needed the token because `RemoteSQL` cannot read, run JS and write inside one transaction; the state store on IndexedDB can, so the check and the write sit in one serialisable transaction and the fencing is exact rather than best-effort. A writer claims the store by swapping the token, every mutating call carries the token its writer believes it holds, and a mismatch is refused before anything is written. The consequence worth having is that leader election then becomes an OPTIMISATION (avoid duplicated RPC work) rather than a correctness requirement: a zombie leader waking from a throttled background tab is refused deterministically instead of racing.

Carried into `work/specs/proposed/a-second-writer-writes-nothing.md`.
