---
title: 'The seam narrows so a reader cannot write, in one atomic change'
slug: the-seam-narrows-and-a-reader-cannot-write
spec: a-second-writer-writes-nothing
blockedBy:
  [
    the-seam-splits-into-a-readable-and-a-writable-store,
    a-refused-writer-demotes-itself-to-a-reader,
    two-tabs-contending-for-one-height-leave-one-winner,
    the-browser-indexing-loop-schedules-its-prune,
    the-cli-schedules-the-prune-its-retention-implies,
  ]
covers: []
---

## What to build

Remove the mutating members from the readable seam type and narrow every consumer that holds one, so a reader cannot write because the type says so.

**This is ONE task and it cannot be split into per-package batches.** That is the correction this task exists to encode. An earlier cut split it four ways and it does not work: narrowing a SHARED TYPE is atomic by construction, because the moment `EntityEventProcessor`'s constructor parameter becomes the writable shape, every package that constructs it with a seam-typed value stops typechecking, and tests are inside the gate (`tsconfig.typecheck.json` includes `**/*.ts`). The dependents live in packages a per-package fence forbids touching, so each batch would go red outside its own scope and correctly STOP. Expand-then-migrate-then-contract works when call sites move one at a time; type annotations on a shared type are coupled through the type checker and do not.

So: the expand step already landed additively, and this is the whole contract in one typecheck unit.

**What narrows** (measured, not assumed): the seam type itself, plus the sites that hold a `StateStore`-typed value and mutate through it. Those are in `@etherfold/processor-entities` (the largest, including `EntityEventProcessor`'s constructor and `applyEventStream`), `@etherfold/browser` (type positions only, it constructs and hands on), the CLI package `etherfold`, and `@etherfold/conformance-workload-stratagems`. Expect roughly thirty `StateStore` annotations across those four packages; `@etherfold/processor-sqlite` and `platforms/cf-worker` hold none, because both build a CONCRETE `VersionedStateStore` and concrete classes keep their full surface.

**Three places will show up in a grep and are NOT the class-type case**, so check them explicitly rather than assuming the blanket rule:

- `packages/state-store-patch/test/sparse-stream.test.ts` has a helper typed `async function award(store: StateStore, ...)` that calls `applyBlock`. It is a seam-typed mutation inside a backend suite, so it narrows with the rest. It is the one known exception to "backend suites hold the class type".
- `packages/state-store-indexeddb/browser/workload.ts` and `packages/browser/browser/workload.ts` hold seam-typed stores and drive `applyEventStream` / `EntityEventProcessor` through them. Both `browser/` directories are typechecked (ADR-0030: every workspace directory is typechecked), so they narrow too.
- `docs/spikes/` is frozen evidence and is OUTSIDE the workspace test filter. Do not edit it.

## Acceptance criteria

- [ ] The readable seam type carries the reads, `declarations`, `migrate`, the capability report and the cursor read, and no DATA-mutating member. `migrate` stays deliberately: it is schema, it runs on every open, and making it claim would break a shipped pattern (see the split task).
- [ ] Every site that mutates through a seam-typed value holds the writable shape instead, across all four packages plus the three named exceptions above.
- [ ] The implicit claim from the guard task is gone: a mutation without a claimed token cannot be expressed.
- [ ] Concrete backend classes are UNCHANGED and keep their full surface, including the SQL tier's `queryCurrent` / `queryAsOf` / `applyBlocks` / `drop`. `createD1Store` keeps returning the concrete class.
- [ ] The conformance suite is no longer parameterised over two shapes: there is one.
- [ ] `CONTEXT.md` is updated where this makes it false: the **StateStore** glossary entry lists a mutating surface that has moved, the **prune** entry is titled `StateStore.prune`, and the **conformance suite** entry says "a `StateStore` backend". Pin **storage identity** there too, since three tasks now depend on the term and no artifact defines it.
- [ ] Every existing suite is green, including the browser contention case, which was written against the implicit claim and may need updating here.
- [ ] The full gate passes: format, ADR check, refs check, changeset status, build, typecheck, test.
- [ ] A changeset accompanies the change (`pnpm changeset`). This touches PUBLISHED packages and `pnpm changeset status --since=main` is in the acceptance gate.

## Blocked by

`the-seam-splits-into-a-readable-and-a-writable-store` (the shapes must exist), `a-refused-writer-demotes-itself-to-a-reader` and `two-tabs-contending-for-one-height-leave-one-winner` (both edit the same surface and the same suite), and BOTH prune-scheduling tasks. That last pair is the cross-spec edge that matters: they add `store.prune(...)` calls on seam-typed values, and this task removes `prune` from the readable seam. Landing this first would leave both of them written against a seam that no longer has the method.

## Prompt

Read `work/specs/tasked/a-second-writer-writes-nothing.md`, then the task `the-seam-splits-into-a-readable-and-a-writable-store` for the exact type shapes and the ONE call signature of `openForWriting`.

Start by MEASURING, not by trusting this task: grep for `StateStore` annotations across `packages/*/src`, `packages/*/test`, `packages/*/browser`, `platforms/*/src` and `examples/*/src`, and separate the ones that mutate from the ones that only read. The counts in this task were measured at authoring time and may have moved; the point of measuring is that your list, not this list, is what you narrow.

Your diff should be mostly type annotations and deletions. If it is growing new logic, something is wrong: the design landed in the earlier tasks and this one removes the scaffolding that made them non-breaking.

Domain vocabulary: this completes the STRUCTURAL form of the one-writer rule that ADR-0044 already applies to streams, where a follower is handed a read-only stream view (`readOnlyStream`) rather than being asked to behave. After this task the same property holds for state. Note the two rules have OPPOSITE arbiters and should not be conflated: a stream's writer is the OLDEST surviving generation (`writerOf`, derived, never raced), while a state store's writer is the LAST claimant. Say so in `CONTEXT.md` when you pin the term.

Done means a reader cannot write, a writer cannot write without having claimed, `CONTEXT.md` describes the seam that now exists, and every test in the repository is green.
