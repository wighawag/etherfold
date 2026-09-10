# The narrowed seam has THREE names, and a claim taken at construction precedes the generation cap

ADR-0077 split the storage seam additively: `ReadableStateStore` was the shape a consumer holds to read, `WritableStateStore` what `openForWriting` hands back, and `StateStore` the whole surface a backend implements, carrying both halves so that every consumer compiled unchanged while they migrated one package at a time. Its consequences said there would be "three seam type names during the migration and two afterwards", with `ReadableStateStore` folded into `StateStore` when the mutating half left it.

The migration is now complete and there are **three**, not two, and the third is what a BACKEND implements. We decided: **`StateStore` is the reads (the readable shape folded in, so a value of the seam type cannot mutate); `StateStoreBackend` is `StateStore` plus the five mutating verbs, which is what a factory hands over and what a backend class declares; `WritableStateStore` is a `StateStoreBackend` plus the `token` that says a claim was taken.** One hierarchy, no intersections at any call site, and the two scaffolding names ADR-0077 introduced for the expand phase (`ReadableStateStore`, `StateStoreMutations`) are both gone.

## Why the third name exists rather than an intersection or an absence

ADR-0077's "two afterwards" quietly assumed the only shapes that need naming are the ones a CONSUMER holds. They are not. Three kinds of code hold the implementor's surface and cannot hold either consumer shape:

- **A backend class**, which declares it (`implements StateStoreBackend`). Left as `implements StateStore` after the narrowing, a backend that forgot `prune` would compile and fail at runtime, which is the check the `implements` clause is there for.
- **A factory**, which hands one over and does not fold: `StateStoreFactory` in `@etherfold/state-store-conformance` (every case mutates the store it is given), `WorkloadStoreFactory`, `BrowserStateStoreFactory` and `createBrowserStateStore`.
- **`openForWriting` itself**, plus the two wrappers that delegate the whole surface (`ClaimedStateStore`, `SnapshotAwareStateStore`).

Spelling it `StateStore & StateStoreMutations` at each of those was the alternative, and it was rejected on the count: fifteen sites, a name that says nothing about WHO holds it, and no single place to document what a backend owes. `StateStoreBackend` reuses the word this repository already uses everywhere for exactly this thing (a **conformance suite** is what "a backend must pass to earn its place behind the seam"), and it sits at the right layer -- it names an IMPLEMENTOR, while the other two name HOLDERS.

`openForWriting` takes a `StateStoreBackend` and therefore cannot be handed a store already narrowed to its reads. That is deliberate and it is stronger than ADR-0077 stated: a reader that could re-open its own handle for writing would leave the narrowing saying nothing. It costs nothing, because every caller that claims is the site that BUILT the store. What a demoted writer does is unchanged and is what ADR-0078 already says it does: build a NEW store and open that, which forces the re-read.

## A claim is a WRITE, so it happens before the generation cap can refuse

`openForWriting` migrates (ADR-0077, for the same reason `openSnapshotAware` does). A host that claims inside its `createState` factory -- which is where the claim belongs, because that factory is the one place that knows this process means to INDEX -- therefore performs DDL before `ReceivingIndexer.add` reaches the generation cap.

**So a cap-refused generation now leaves an empty namespace behind**, and the acceptance criterion of `a-changed-context-creates-a-successor-instead-of-clearing` ("no orphan tables, no orphan record") is met on the record and no longer on the tables. `packages/cli/test/aChangedContextCreatesASuccessor.test.ts` asserts the narrower truth instead: no registry row, the namespace carries no state, and the only row anywhere in it is the claim itself.

**The order cannot be swapped, and that is why this is a consequence rather than a defect.** The cap is enforced when the record is written, the record is keyed on the processor's version hash, the hash comes from the processor, and the processor is built over the state (ADR-0043: state first, then the fold). A pre-check on the COUNT alone would refuse re-opening a generation the container already holds, which is the case `create` deliberately RESOLVES rather than refuses. What is left behind is bounded and inert: the namespace is a digest of the identity rather than a fresh name, so raising the bound reuses it verbatim; nothing reads it while no record names it; and dropping a generation still drops exactly its own tables. The two ways to reclaim it, if it ever matters, are a `dropState` on the refusal path or a cap pre-check the registry could answer with the identity in hand -- both in `@etherfold/core`, and neither needed to make this correct.

## A synchronous constructor claims on FIRST USE, not at construction

`VersionedStateEventProcessor` (`@etherfold/processor-sqlite`) builds its own store from a `RemoteSQL` handle and is `new`ed synchronously by all eighty of its call sites. It cannot claim in its constructor, because claiming is asynchronous. It claims once, memoised, on the first operation that needs the fold (`load` / `process` / `prune` / `reset` / `clear`).

This is NOT the implicit claim ADR-0075 shipped and this migration removed. What was removed is a MUTATION NOBODY CLAIMED FOR: the type now says a writer must hold a claim, and this class obtains one explicitly through `openForWriting`. Deferring it costs nothing here for a reason specific to this class: the store is one it BUILT and nothing else holds a handle to, so there is no rival to lose it to between the constructor and the first fold. The alternative was an async factory replacing the constructor, which changes eighty call sites and turns a documented construction-time refusal (a processor with no `version`) into a rejected promise at thirty-two of them; that refusal stays exactly where it was, in the constructor.

The two members that were delegated to the inner fold and are now computed directly are `getVersionHash` and `getCodeFingerprint`, because a host reads both BEFORE anything is folded -- the version hash names the state's table namespace (ADR-0053). They call the same shared functions the inner fold calls (`entityProcessorVersionHash`, `processorCodeFingerprint`), so this is one formula called from two places and not two spellings of it. `configure` stays synchronous and the config is re-applied to the fold on every operation, so a `configure` before the claim and one after mean the same thing.

## Consequences

- **`ReadableStateStore` and `StateStoreMutations` are deleted.** Nothing outside this repository holds either (nothing is published), and both existed only so the expand phase could be additive.
- **A consumer that only reads holds `StateStore` and the compiler refuses a mutation through it.** `packages/state-store/test/writable-seam.test.ts` asserts that with `@ts-expect-error` lines the typecheck evaluates, which is the only way to assert a compile error.
- **The conformance suite is asked ONCE again.** ADR-0077's two-shape parameterisation (`throughAClaimedWriter`) goes with the migration it existed for; what the claimed handle owes is asked by the `a writer claims by opening` chapter and by the seam's own suite.
- **`openForWriting` / `openForReading` are re-exported from `@etherfold/processor-entities`**, beside the bootstrap primitives, because they are on the same boot path: an app that calls `openAndBootstrap` needs to say which of the two it is doing.
- **A host that builds a store must now say whether it INDEXES.** `createBrowserStateStore` deliberately does not claim: a tab that only renders opens the same database, and claiming there would have every reading tab take the store from the tab that is indexing. Building a store and becoming its writer are two acts.
