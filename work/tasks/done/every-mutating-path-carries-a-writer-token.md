---
title: 'Every mutating path carries a writer token, checked in the transaction that writes'
slug: every-mutating-path-carries-a-writer-token
spec: a-second-writer-writes-nothing
blockedBy: []
covers: [1, 2, 4, 5, 9, 10, 11, 12, 13, 16, 17, 18, 19, 20, 21, 22]
---

## What to build

Two instances of one indexer writing to one state store corrupt it, and only one mutating path would notice. `applyBlock` reads the block record and the hash index inside the transaction it writes in, which is a genuine compare-and-swap and holds. Nothing else has a precondition: the cursor write inside that same transaction is unconditional, `writeCursor` and `clearCursor` have no block record incidentally protecting them, `prune` reads the tip OUTSIDE the transaction it then deletes in, and `revertTo` has nothing at all and is the only one that can leave a WRONG state rather than an exception.

Add a **writer token**: one record inside the storage it guards, read and checked in the SAME atomic unit as every mutation. Claiming swaps it for a fresh unique value, so an earlier writer's next mutation is refused before anything is written.

This is the EXPAND step: it lands behind the surface that exists today and changes no caller, because claiming is IMPLICIT on first write. That is enough on its own, because two writers each claiming implicitly is already the full guarantee. **This task alone closes the corruption hole.**

**The mutating surface is seven methods, not five.** `applyBlock`, `revertTo`, `writeCursor`, `clearCursor`, `prune`, plus `applyBlocks` (the SQLite multi-block path) and `drop` (SQLite, called from the CLI). `migrate` is deliberately EXCLUDED and must not claim: it runs on every open, including from `createBrowserStateStore`, and a claim there would break the existing tests that open a second store on one database while the first is live.

**Not every backend can hold a meaningful guard, and pretending otherwise produces a vacuous test.** `MemoryStateStore` and `PatchStateStore` keep their storage in instance fields, so no second writer can reach it and a token there can only ever be compared with itself: green, tested, and meaningless, which is exactly the shape ADR-0054 refuses. So a store REPORTS whether it can enforce a single writer, and the conformance suite selects the contention cases on that claim, which is the mechanism the suite already uses for capabilities.

## Acceptance criteria

- [ ] All seven mutating paths are guarded on every backend that CLAIMS it can enforce a single writer. `migrate` is not guarded and does not claim.
- [ ] A second claim invalidates the first, and the first writer's next mutation on any guarded path is refused with `StoreWriterChangedError`. The name is fixed HERE because this task is what throws it; a later task owns the demotion that catches it. Declare it ONCE, in `@etherfold/state-store` beside the other seam errors, because every backend throws it and core catches it, and `errors.ts` already records why two classes of one name in two packages break `instanceof` across the boundary.
- [ ] A refused call leaves the store byte-identical. For `applyBlocks`, which is many batches, state and test the semantics explicitly: the guard is checked per batch, so a refusal mid-sequence leaves earlier batches applied and later ones not.
- [ ] The check happens inside the same atomic unit as the write it guards. `prune` currently reads the tip outside its delete transaction; close that.
- [ ] The token is opaque: nothing compares it for order or parses it.
- [ ] The guard is on the TOKEN and never on the cursor VALUE, so the store stays ignorant of what the cursor string means (ADR-0027).
- [ ] A store reports whether it can enforce a single writer. Memory and patch report that they cannot, honestly, rather than passing a self-comparison.
- [ ] **Two stores with DIFFERENT storage identities both write concurrently and neither is refused** (distinct `databaseName` on IndexedDB, distinct table namespace on SQLite). This is the do-not-over-refuse half and it is asserted, not assumed.
- [ ] **Two generations of ONE indexer, correctly addressed apart, both write concurrently and neither is refused.**
- [ ] **A writer abandoned mid-flight leaves a store the next claim can take over** with no manual clear and no waiting: claiming does not block and does not expire.
- [ ] Behaviour for a SINGLE writer is unchanged on every backend, demonstrated by the existing suites passing unmodified.
- [ ] Conformance carries all of the above, parameterised by the factory and gated on the reported claim.
- [ ] A test lands a rival's write in the exact window between a writer's read and its write, and removing the guard turns it red. No `setTimeout` races.
- [ ] An ADR records the rationale, names its relationship to ADR-0054, and records the two rejected alternatives so they are not re-proposed: an OPTIONAL token argument (the shape ADR-0054 refuses, because a guard available and unused passes every single-writer test) and a REQUIRED token argument on each method (the honest fallback if the blast radius prices out, which forces presence but not provenance).
- [ ] A changeset accompanies the change (`pnpm changeset`). This touches PUBLISHED packages and `pnpm changeset status --since=main` is in the acceptance gate.

## Blocked by

None, can start immediately.

## Prompt

Read `work/specs/tasked/a-second-writer-writes-nothing.md` in full, especially its "What is unguarded today" section, then `docs/adr/0054-a-registry-commit-over-remote-sql-is-a-guarded-batch-with-a-revision-token.md`.

ADR-0054 is this design one level down, and its opening line hands you the primitive: "IndexedDB gives that for free (`readwrite` transactions serialise across tabs)". It needed a revision token because `RemoteSQL` cannot read, run JS and write inside one transaction; the state store on IndexedDB CAN, so there the check and the write sit in one serialisable transaction and the fencing is EXACT rather than best-effort. On SQLite over `remote-sql` it is ADR-0054's mechanism unchanged: guard every statement on the token, swap it as the last write of the same batch, read it back inside that batch to learn whether you won.

**Storage identity is what the token is scoped to, and it needs no new concept because the token lives INSIDE that storage.** On IndexedDB that is the `databaseName`; on SQLite it is the database plus ADR-0053's table namespace, which that backend already validates in its constructor. That scoping is what makes two unrelated indexers on one origin never contend, two correctly separated generations still write at once, and two generations sharing one database by misconfiguration are REFUSED where today they corrupt each other silently. "Refused" means the write does not land and the loser learns it: the loudness is a REPORTED state rather than an exception reaching the application, because a later task turns the refusal into a demotion. The spec warns by name that scoping this to an origin, a tab, a connection or a lock name outside the database breaks the do-not-over-refuse criteria above.

Read `applyBlock` in `packages/state-store-indexeddb/src/store.ts` and copy the shape it already uses to abort its transaction on a duplicate height. Read `prune` in the same file and note it calls `tipBlockNumber()` outside the `readwrite` transaction that then deletes, and that the transaction spans only the versions store, so guarding it means widening it.

On the conformance suite: `StateStoreFactory` is documented as "a fresh database per call", so it CANNOT express two handles on one storage. Do not change that type. Add an OPTIONAL second-handle affordance to the suite's options, which backends that can share storage provide and others omit; the suite already reads a capability report from a probe store and selects the cases a backend has claimed it can pass, so use that mechanism rather than inventing one.

Done means two writers cannot corrupt one store on any backend that claims to prevent it, two writers on DIFFERENT storage never interfere, a single writer notices nothing, and the ADR explains why this is ADR-0054 rather than a new idea.

## Decisions

**`singleWriter` is a REQUIRED capability field, not optional.** Chosen so a new backend must answer the question rather than inherit a default; the alternative (optional, absent = false) would have let a backend that *does* enforce it silently claim nothing, and a backend that does not silently look honest. Touches every `StateStoreCapabilities` literal (six test files updated) and any future backend. On coherence: the repo already has a **one-writer rule** meaning "only the indexing generation appends to a stream" (ADR-0044, stream keeper). This is a different seam and a different mechanism, so I kept the word and documented the distinction at both ends (`capabilities.ts`, CONTEXT.md) rather than inventing a third term.

**A backend that claims `singleWriter` and supplies no `twoWriters` FAILS a conformance case saying so.** Considered: skipping the chapter silently (what every other optional affordance would do). Rejected because the cases are selected on the CLAIM, and skipping the only cases that can catch a fiction is how the report stops meaning anything. Touches any backend author outside this repo: the suite's third argument is now effectively mandatory for such a backend.

**`prune` claims/checks even when there is no floor to prune at.** A no-op prune still takes the claim, on both backends, so the rule is uniform ("every mutating path refuses a lost writer") and a conformance case can state it without knowing the store's retention. The alternative (check only when something will be deleted) makes an `unbounded` store's prune the one mutating path a lost writer may still call. Cost: on SQLite the check rides the tip read it already made, so no extra round trip; on IndexedDB it is inside the transaction already open. Touches hosts that prune on a timer: the pruner now claims the store.

**`drop` (SQLite) is guarded by a compare-and-swap on the claim's RELEASE, not by the DDL.** `DROP TABLE` takes no `WHERE`, so `DELETE FROM _writer WHERE token = ?` plus the read-back in one batch decides it, and the drops follow. Considered a "poison pill" statement that makes the batch error when the token differs (obscure and engine-dependent) and leaving `drop` unguarded (a hole in a promise about the storage). Consequence stated in the ADR: the drops are not in the same transaction as the check. An UNCLAIMED handle still takes over and may drop — necessary, because the server registry's `dropState` builds a fresh handle, and refusing would make disposing of a generation impossible.

**D1's prune arithmetic moved, in another package.** The guard is one more bound parameter on `dropVersionsStatement`, whose default sat exactly on D1's 100-parameter cap, so `prune` now names one fewer row id per statement; and a round costs three queries rather than two, so `QUERIES_PER_PRUNE_ROUND` went 2→3 and `d1PruneBudget` returns smaller budgets on both plans. Leaving the constant at 2 would have been a documented derivation that had quietly become false. Touches `platforms/cf-worker`.

**A refused writer stays refused; a writer whose FIRST write failed re-claims.** Both backends keep `token` plus a `claimed` flag set only when the claim's transaction/batch commits. Re-claiming after a loss would let two writers take the store in turns (the corruption at half speed); not re-claiming after a *failed* first write would leave a handle permanently refusing itself after an ordinary duplicate-height error. Touches the demotion task, which acts on the first half.

**`browser/multi-tab.spec.ts` had to change, and I made the minimal correction rather than the contention case.** That spec wrote from four tabs into one database concurrently, which the guard now forbids, so it would have gone red. It now counts a `StoreWriterChangedError` as an OUTCOME, asserts every tab still OPENED the shared database (the ADR-0024 claim it exists for), that `wrote + refused` accounts for every attempt, that nothing failed for any other reason, and that a fifth connection finds exactly the rows the tabs were told they wrote. The real contention case (same heights, one winner per height, torn-state audit, three engines, results recording, the no-guard experiment) is untouched and remains `work/tasks/backlog/two-tabs-contending-for-one-height-leave-one-winner.md`. Note for whoever picks that up: its "Blocked by" says `StoreWriterChangedError` is created by the demotion task, but it is created here.

**Browser result artifacts were left as they were.** I ran the Chromium project to verify (numbers above), but Firefox and WebKit binaries for the pinned Playwright version are not installed here, so refreshing only Chromium would have left `docs/spikes/indexeddb-row-backend-browser-default/results/` internally inconsistent for cross-engine comparison (timings and pass counts from different dates). I restored all three files; recording a three-engine run belongs to the follow-on task, which already owns that path.
