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

## Decisions

- **A THIRD seam name, `StateStoreBackend` (= the reads plus the five mutating verbs), against ADR-0077's "three names during the migration and two afterwards".** ADR-0077 assumed only the shapes a CONSUMER holds need naming; three kinds of code hold the implementor's surface and can hold neither consumer shape — a backend's `implements` clause (left as `implements StateStore`, a backend that forgot `prune` would compile and fail at runtime), every factory (`StateStoreFactory`, `WorkloadStoreFactory`, `BrowserStateStoreFactory`, `createBrowserStateStore`), and `openForWriting` plus the two full-surface wrappers. Alternative considered: spell `StateStore & StateStoreMutations` at each — rejected on the count (fifteen sites, a name that says nothing about who holds it, nowhere to document what a backend owes). Coherence: "backend" is the word this repo already uses for exactly this (the conformance suite is "what a backend must pass"), it names an IMPLEMENTOR while the other two name HOLDERS, and it REPLACES two scaffolding names rather than adding a third to them. Touches: every backend class, every store factory, `CONTEXT.md`'s StateStore + conformance-suite entries. Recorded in **ADR-0079**.
- **`openForWriting` takes a `StateStoreBackend`, not a store already narrowed to its reads.** ADR-0077's sketch wrote `openForWriting(store: StateStore)` when `StateStore` meant the readable shape, which would let a reader widen its own handle back and leave the narrowing saying nothing. Requiring the backend costs no caller (every site that claims is the site that built the store) and makes the narrowing one-way. The alternative kept the sketch's letter and needed a cast to `clearCursor` inside the seam module. Touches: ADR-0078's demotion story, which already says a demoted writer builds a NEW store; asserted by a new `@ts-expect-error` in `writable-seam.test.ts`.
- **A cap-refused generation now leaves an EMPTY namespace behind, and I changed a landed acceptance criterion's test to say so.** `a-changed-context-creates-a-successor-instead-of-clearing` asserted "no orphan tables, no orphan record"; claiming migrates (ADR-0077) and `ReceivingIndexer.add` builds state → processor → record, with the cap enforced at the record, so a host that claims in `createState` performs DDL before the refusal. The order cannot be swapped: the record is keyed on the processor's version hash, which needs the processor, which needs the state (ADR-0043), and a pre-check on the count alone would refuse re-opening a generation the container already holds — the case `create` deliberately resolves. The test now asserts the narrower truth (no registry row; the namespace carries no state; the only row in it is the claim), and `receivingContainer.ts`'s doc sentence, which claimed the state factories create no storage until the first write, is corrected. Alternatives, both in `@etherfold/core` and both out of this fence: a `dropState` on the refusal path, or a cap pre-check taking the identity. Touches: `@etherfold/core`'s `add()` contract and that done task's criterion. Recorded in **ADR-0079**.
- **`VersionedStateEventProcessor` claims on FIRST USE rather than in its constructor.** Claiming is asynchronous and that constructor is not, and it is `new`ed at eighty call sites. Alternative considered: an async factory replacing the constructor — rejected because it changes eighty sites and turns a documented construction-time refusal (a processor with no `version`) into a rejected promise at thirty-two of them. Safe here for a reason specific to this class: the store is one it built and nothing else holds, so there is no rival between the constructor and the first fold. It is still an EXPLICIT claim (`openForWriting`); what the narrowing removed is a mutation nobody claimed for, not a claim at a particular line. `getVersionHash`/`getCodeFingerprint` now call the shared `entityProcessorVersionHash`/`processorCodeFingerprint` (one formula, two callers — not two spellings) because a host reads both before anything folds. Touches: `@etherfold/processor-sqlite`'s public class. Recorded in **ADR-0079**.
- **`createBrowserStateStore` deliberately does NOT claim, so `createState` is now `async () => openForWriting(await createBrowserStateStore(...))`.** This is the user-visible default: a tab that only RENDERS opens the same database, so claiming in the store factory would have every reading tab take the store from the tab that is indexing (spec stories 4 and 6). Building a store and becoming its writer are two acts. Alternative considered: claim inside `createBrowserStateStore` so the documented example was unchanged — rejected for exactly that reason. Touches: `BrowserGenerationSpec.createState`, both examples, the browser README and `IndexerState`'s two doc examples.
- **The conformance factory hands over the BACKEND, so every case mutates the store it is given directly.** The alternative was one shape = the claimed handle, which would have rewritten fourteen case files and lost the undecorated declaration-probe question the suite doc names. Backend test files are untouched, which is what the "concrete classes unchanged" criterion needs. Touches: `StateStoreFactory`, `StorePair`, `WorkloadStoreFactory` (kept matching it, as its doc promises).
- **`openForWriting` / `openForReading` / `WRITER_CLAIM_KEY` are re-exported from `@etherfold/processor-entities`**, beside the bootstrap primitives and for the same stated reason: they are on the same boot path, so an app calling `openAndBootstrap` does not need a second import to say which of the two it is doing. Additive; touches that package's public surface (in the changeset).
- **`packages/state-store-patch/test/sparse-stream.test.ts`'s `award` narrowed to `StateStoreBackend`, not to `WritableStateStore`.** It is a backend suite driving concrete `PatchStateStore` instances, so requiring a claim there would add a claim to a suite whose subject is the class; the seam-typed mutation the task wanted gone is gone either way, because the READABLE type no longer carries `applyBlock`. `pointsOf` beside it stays `StateStore`, which now documents that its reads come through the consumer seam.
