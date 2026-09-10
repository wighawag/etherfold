---
title: 'The readable store has no mutating methods and the guard has no unguarded door'
slug: the-readable-store-has-no-mutating-methods
spec: a-second-writer-writes-nothing
blockedBy:
  [
    a-refused-writer-demotes-itself-to-a-reader,
    the-processor-layer-opens-its-store-for-writing,
    the-browser-package-opens-its-store-for-writing,
    the-server-and-cli-open-their-stores-for-writing,
    the-cf-worker-platform-opens-its-store-for-writing,
    the-conformance-workload-opens-its-store-for-writing,
  ]
covers: [8, 11, 20]
---

## What to build

The CONTRACT step, and the only one in this sequence that can break a caller. By the time it runs there are none left, which is what its `blockedBy` fan-in encodes.

Remove the mutating methods from the readable store type, and remove the implicit claim that the first task added so a single writer would notice nothing. After this, a reader cannot write because the type says so, and the guard has no unguarded door left: every mutation goes through a store that was opened for writing and therefore holds a token it claimed.

## Acceptance criteria

- The readable store type carries reads, the capability report and the cursor read, and no mutating method.
- The implicit claim is gone: a mutation without a claimed token is not possible to express, rather than being tolerated.
- Nothing in the repository calls a mutating method on a store it did not open for writing, verified by the fact that it compiles.
- The conformance suite is no longer parameterised over two shapes: there is one.
- Every existing suite is green, including the browser contention case.
- The full gate passes: format, ADR check, refs check, changeset status, build, typecheck, test.
- A changeset accompanies the change (`pnpm changeset`). This touches PUBLISHED packages and `pnpm changeset status --since=main` is part of the acceptance gate, so a missing changeset is a red gate for a reason unrelated to the work.

## Blocked by

Every migration batch, plus the demotion task. This fan-in IS the safety property: the removal cannot start until nothing depends on what it removes.

## Prompt

Read `work/specs/tasked/a-second-writer-writes-nothing.md` and its Task order; this is step 7 of 7.

Before removing anything, VERIFY the premise: grep the whole repository, including tests, examples and platforms, for calls to the mutating methods on a store that was not opened for writing. The migration tasks should have left none, and if you find one, that is not something to fix inline here: it means a migration batch missed a call site, and the honest move is to STOP and report which one, so the batch is completed rather than patched over from this task.

Note that this task's diff should be mostly DELETIONS. If it is growing new logic, something is wrong: the design landed in the earlier steps and this one only takes away the scaffolding that made them non-breaking.

Domain vocabulary: this completes the STRUCTURAL form of the one-writer rule that ADR-0044 already applies to streams, where "the writer is handed the keeper, every follower is handed a read-only stream view". After this task the same sentence is true of state.

Done means a reader cannot write, a writer cannot write without having claimed, and every test in the repository is green.
