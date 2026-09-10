---
title: 'Every mutating path carries a writer token, checked in the transaction that writes'
slug: every-mutating-path-carries-a-writer-token
spec: a-second-writer-writes-nothing
blockedBy: []
covers: [1, 2, 11, 12, 13, 16, 17, 18, 19, 20, 21, 22]
---

## What to build

Two instances of one indexer writing to one state store corrupt it, and today only one of the five mutating paths would notice. `applyBlock` reads the block record and the hash index inside the transaction it writes in, which is a genuine compare-and-swap and holds. Nothing else has a precondition of any kind: the cursor write inside that same transaction is unconditional, `writeCursor` and `clearCursor` have no block record incidentally protecting them, `prune` computes a floor against a tip another writer may have moved, and `revertTo` has nothing at all and is the only one that can leave a WRONG state rather than an exception.

Add a **writer token**: one record inside the storage it guards, read and checked in the SAME atomic unit as every mutation. Claiming swaps the token for a fresh unique one, so an earlier writer's next mutation is refused before anything is written.

This is the EXPAND step, so it lands behind the surface that exists today and changes no caller: claiming is IMPLICIT on first write, meaning a single writer behaves exactly as it does now. That is deliberate and it is enough, because two writers each claiming implicitly is already the full guarantee: the second claim invalidates the first, and the first's next write is refused. **This task alone closes the corruption hole.**

The guard is on the TOKEN and never on the cursor VALUE: the cursor is an opaque string at the seam (ADR-0027) and the store must not begin comparing or parsing what it holds.

## Acceptance criteria

- Every mutating path on every backend is guarded: `applyBlock` including its cursor write, `revertTo`, `writeCursor`, `clearCursor`, `prune`.
- A second claim invalidates the first, and the first writer's next mutation on any of those paths is refused.
- A refused call leaves the store byte-identical to how it found it: nothing partially applied, nothing applied late.
- The check happens inside the same atomic unit as the write it guards, so there is no window between checking and writing.
- The token is opaque: nothing compares it for order or parses it.
- Behaviour for a SINGLE writer is unchanged, on every backend, which the existing suites must continue to demonstrate.
- The conformance suite carries the cases, parameterised by the factory, so every backend answers the same question. Memory and patch backends carry the guard too.
- A test lands a rival's write in the exact window between a writer's read and its write, and removing the guard turns it red. No `setTimeout` races.
- An ADR records the rationale and names its relationship to ADR-0054: this is the same mechanism on a substrate that makes it easier, not a second invention.
- A changeset accompanies the change (`pnpm changeset`). This touches PUBLISHED packages and `pnpm changeset status --since=main` is part of the acceptance gate, so a missing changeset is a red gate for a reason unrelated to the work.

## Blocked by

None, can start immediately.

## Prompt

Read `work/specs/proposed/a-second-writer-writes-nothing.md` in full, especially its "What is unguarded today" section and its Task order, then `docs/adr/0054-a-registry-commit-over-remote-sql-is-a-guarded-batch-with-a-revision-token.md`.

ADR-0054 is the whole design, one level down, and its opening line hands you the primitive: "IndexedDB gives that for free (`readwrite` transactions serialise across tabs)". That ADR needed a revision token because `RemoteSQL` cannot read, run JS and write inside one transaction; the state store on IndexedDB CAN, so there the check and the write sit in one serialisable transaction and the fencing is EXACT rather than best-effort. On SQLite over `remote-sql` it is ADR-0054's mechanism unchanged: guard every statement on the token, swap it as the last write of the same batch, read it back inside that batch to learn whether you won.

Domain vocabulary: the **storage identity** is what the token is scoped to, and it needs no new concept because the token lives INSIDE that storage. On IndexedDB that is the `databaseName`; on SQLite it is the database plus ADR-0053's table namespace, which that backend already validates in its constructor. That scoping is deliberately what makes two unrelated indexers on one origin never contend, two correctly separated generations still write at once, and two generations sharing one database by misconfiguration refused LOUDLY where today they corrupt each other silently.

Read `packages/state-store-indexeddb/src/store.ts` (see how `applyBlock` already aborts its transaction on a duplicate height, and copy that shape) and `packages/state-store-sqlite/src/store.ts`.

The alternative to refuse: a guard that is available and unused. ADR-0054 rejects it in as many words, because a read-then-write that merely LOOKS atomic passes every single-writer test and the state it corrupts is invisible afterwards. So the guard is not optional on any path.

An opaque token and not a counter: ADR-0054's own reason for rejecting a counter does not apply here, so this is uniformity alone, one mechanism satisfied two ways so the conformance suite can ask both backends the same question.

Done means two writers cannot corrupt one store on any backend, a single writer notices nothing, and the ADR explains why this is ADR-0054 rather than a new idea.
