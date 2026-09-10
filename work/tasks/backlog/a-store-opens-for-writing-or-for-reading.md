---
title: 'A store opens for writing or for reading, and both shapes work'
slug: a-store-opens-for-writing-or-for-reading
spec: a-second-writer-writes-nothing
blockedBy: [every-mutating-path-carries-a-writer-token]
covers: [6, 8, 11]
---

## What to build

Make "a reader cannot write" a fact of the TYPE rather than a rule to remember. A store is opened for reading or for writing, and only the writing one carries the mutating methods, so the ability to write is obtainable ONLY by claiming and a token can be neither forged nor forgotten.

This is still the EXPAND step: add `openForWriting` and `openForReading` ADDITIVELY, leaving the base type's mutating methods in place so nothing breaks and no caller has to move yet. The callers migrate in their own tasks; the old surface is removed in the final contract task. Both shapes must work simultaneously and the conformance suite must be parameterised over both.

Construction, not a `claim()` on an already-open store, and the reason is that three questions then stop existing: `migrate` WRITES, so a separate lease would have a write outside the guard on day one; bootstrap writes too and is simply a writer here rather than more surface to re-home; and a demoted writer constructs a fresh store, which forces exactly the re-read correctness wants, so "what does a dead lease do mid-fold" never needs an answer.

## Acceptance criteria

- Opening for writing swaps the stored token for a fresh unique one, so an earlier writer's next mutation is refused.
- Opening for writing does not block and does not wait: a loser is not queued, it has simply lost.
- A store opened for reading has no mutating methods in its type, so calling one is a compile error rather than a runtime throw.
- `migrate` belongs to the writing shape.
- The existing surface keeps working unchanged, so every current caller compiles and passes without modification. This is what makes the migration tasks independent.
- Conformance runs over both shapes.
- Every backend implements both.
- A changeset accompanies the change (`pnpm changeset`). This touches PUBLISHED packages and `pnpm changeset status --since=main` is part of the acceptance gate, so a missing changeset is a red gate for a reason unrelated to the work.

## Blocked by

`every-mutating-path-carries-a-writer-token`: this exposes the claim that task's guard already performs implicitly.

## Prompt

Read `work/specs/proposed/a-second-writer-writes-nothing.md`, its Implementation Decisions (which carry the type sketch and the reasons construction beat a lease) and its Task order (this is step 4 of 7, the expand step whose whole purpose is that nothing has to move yet).

Domain vocabulary and the precedent to follow: ADR-0044 makes the one-writer rule STRUCTURAL for streams, "the writer is handed the keeper, every follower is handed a read-only stream view". This is that move for state. Note the one existing case that swallows writes instead, `readOnlyStream`, did so for a documented reason that does NOT apply here: there read and write shared one seam and the engine's save was unconditional, so declining to write was not expressible. Here it is expressible, so it is expressed.

The rule that must not break: EXISTING CALLERS COMPILE AND PASS UNCHANGED after this task. If you find yourself editing `@etherfold/browser` or the server to make this land, stop: that is the next tasks' work and doing it here collapses the migration into one unreviewable change.

Read `packages/state-store/src/store.ts` for the seam, and `packages/state-store/src/snapshot.ts` for `openSnapshotAware`, which writes and therefore belongs on the writing side.

Done means both shapes exist, both are conformant, and `git diff` touches no consumer package.
