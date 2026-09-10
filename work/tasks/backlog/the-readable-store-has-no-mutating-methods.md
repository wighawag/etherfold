---
title: 'The readable store has no mutating methods and the guard has no unguarded door'
slug: the-readable-store-has-no-mutating-methods
spec: a-second-writer-writes-nothing
blockedBy:
  [
    a-refused-writer-demotes-itself-to-a-reader,
    two-tabs-contending-for-one-height-leave-one-winner,
    the-processor-layer-holds-a-writable-store,
    the-browser-package-holds-a-writable-store,
    the-cli-holds-a-writable-store,
    the-workload-and-cf-worker-hold-writable-stores,
  ]
covers: []
---

## What to build

The CONTRACT step, and the only one in this sequence that can break a caller. By the time it runs there are none left, which is what its `blockedBy` fan-in encodes.

Remove the mutating members from the readable seam type, and remove the implicit claim the first task added so a single writer would notice nothing. After this, a reader cannot write because the type says so, and every mutation goes through a store opened for writing and therefore holding a token it claimed.

Remember what this does NOT touch: concrete backend classes keep their full surface, so the hundreds of mutating call sites in `packages/state-store-sqlite/test`, `packages/state-store-indexeddb/test` and `packages/state-store-patch/test` construct concretely, hold the CLASS type, and are unaffected. If you find yourself editing those suites, the split was done at the wrong level and that is a STOP.

## Acceptance criteria

- [ ] The readable seam type carries reads, `migrate`, the capability report and the cursor read, and no mutating member.
- [ ] The implicit claim is gone: a mutation without a claimed token cannot be expressed, rather than being tolerated.
- [ ] Nothing holds a readable-typed store and mutates it, verified by the fact that it compiles.
- [ ] The backend test suites are UNTOUCHED by this task.
- [ ] The conformance suite is no longer parameterised over two shapes: there is one.
- [ ] Every existing suite is green, and the browser contention case still passes (it was written against the implicit claim, so check it explicitly and update it if the claim's removal changed how it opens its stores).
- [ ] The full gate passes: format, ADR check, refs check, changeset status, build, typecheck, test.
- [ ] A changeset accompanies the change (`pnpm changeset`). This touches PUBLISHED packages and `pnpm changeset status --since=main` is in the acceptance gate.

## Blocked by

`a-refused-writer-demotes-itself-to-a-reader`, `two-tabs-contending-for-one-height-leave-one-winner`, `the-processor-layer-holds-a-writable-store`, `the-browser-package-holds-a-writable-store`, `the-cli-holds-a-writable-store`, `the-workload-and-cf-worker-hold-writable-stores`. This fan-in IS the safety property: the removal cannot start until nothing depends on what it removes.

## Prompt

Read `work/specs/tasked/a-second-writer-writes-nothing.md`.

Before removing anything, VERIFY the premise: grep `packages/*/src`, `platforms/*/src` and `examples/*/src` for calls to the mutating methods on a value typed as the readable seam. The migration batches should have left none. If you find one, that is not something to fix inline: it means a batch missed a call site, so STOP and report which one, so the batch is completed rather than patched over from here.

Two places will show up in a naive grep and are OUT OF SCOPE: the backend TEST suites (they construct concretely and hold the class type, not the seam type) and `docs/spikes/`, which is frozen evidence and is excluded from the workspace test filter. Do not edit either.

This task's diff should be mostly DELETIONS. If it is growing new logic, something is wrong: the design landed in the earlier steps and this one removes the scaffolding that made them non-breaking.

Domain vocabulary: this completes the STRUCTURAL form of the one-writer rule that ADR-0044 already applies to streams, where "the writer is handed the keeper, every follower is handed a read-only stream view". After this task the same sentence is true of state.

Done means a reader cannot write, a writer cannot write without having claimed, and every test in the repository is green.
