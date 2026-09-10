---
title: 'The seam splits into a readable and a writable store, additively'
slug: the-seam-splits-into-a-readable-and-a-writable-store
spec: a-second-writer-writes-nothing
blockedBy: [every-mutating-path-carries-a-writer-token]
covers: []
---

## What to build

Make "a reader cannot write" a fact of the TYPE rather than a rule to remember, so the ability to mutate is obtainable only by claiming and a token can be neither forged nor forgotten.

**The split is at the INTERFACE, and the concrete backend classes are unchanged.** That is the load-bearing decision and it is what keeps this task small: the mutating call sites in this repository are overwhelmingly TESTS that construct a backend concretely (`new VersionedStateStore(...)`, over 150 mutating call sites in the SQLite suite alone) and then mutate it. Those hold the CLASS type, not the seam type, so they are untouched by a change to the seam and must stay untouched. Only code that holds a `StateStore`-typed value migrates. MEASURE that set yourself rather than trusting a number here; at authoring time it was around thirty annotations across four packages, and it includes two `browser/` harnesses and one backend test helper that a naive src-only grep misses.

Additive, so nothing breaks yet: the base type keeps its mutating members for now, callers migrate in their own tasks, and the final contract task removes them.

```ts
type WriterToken = string;

/** The seam as consumers will hold it: reads, the capability report, the cursor read. */
type StateStore = { /* declarations, getCurrent, getAsOf, listCurrent, listAsOf, readCursor, capabilities, migrate */ };

/** What a claim hands back. Concrete backends keep implementing this whole shape. */
type WritableStateStore = StateStore & {
  readonly token: WriterToken;
  applyBlock(block, mutations, cursor?): Promise<void>;
  applyBlocks?(...): Promise<void>;   // SQLite only, per its own class
  revertTo(blockNumber): Promise<void>;
  writeCursor(key, value): Promise<void>;
  clearCursor(key): Promise<void>;
  prune(options?): Promise<PruneReport>;
};

/** Claiming SWAPS the stored token, so an earlier writer's next mutation is refused.
 *  It does not block and does not wait: a loser is not queued, it has lost. */
declare function openForWriting(store: StateStore): Promise<WritableStateStore>;
declare function openForReading(store: StateStore): StateStore;
```

**Exactly ONE site per storage claims, and a second open by the same holder is IDEMPOTENT.** This is load-bearing, not a detail: the shipped generation pattern hands ONE store instance to EVERY generation (`createState: () => store` in `packages/browser/test/{callShape,generationContainer,invalidation,promotion}.test.ts`, and the documented example in `IndexerState.ts` ignores its `GenerationContext` so every generation lands in the default database). If each generation claimed independently, building a successor would invalidate the canonical generation and the guard would refuse the process against ITSELF, breaking the spec's own stories 4 and 5. So: the host factory that builds a store claims, everything downstream RECEIVES the writable handle, and `openForWriting` called twice on one instance returns the same claim rather than a fresh one.

Construction rather than a lease on an open store, because three questions then stop existing: `migrate` writes, so a lease would have a write outside the guard on day one; bootstrap writes too and is simply a writer here; and a demoted writer re-opens, which forces the re-read correctness wants, so "what does a dead lease do mid-fold" never needs an answer.

`covers: []` deliberately: this traces to the spec's Solution rather than to a user story, and the ADR criterion below is what keeps its rationale from vanishing.

## Acceptance criteria

- [ ] `openForWriting` and `openForReading` exist with ONE export site and ONE signature, stated in the module that owns the seam.
- [ ] `openForWriting` is IDEMPOTENT per store instance: a second call on the same instance returns the same claim and does not invalidate the first handle. A test covers it, and a test covers two generations built over ONE store instance both writing, which is the shipped pattern.
- [ ] Opening for writing swaps the stored token, so an earlier writer's next mutation is refused. It does not block and does not wait.
- [ ] A store held as the readable type has no mutating members in its type, so calling one is a compile error.
- [ ] Concrete backend classes are UNCHANGED and still expose their full surface, so every test that constructs one concretely compiles and passes unmodified. `git diff` must not touch `packages/state-store-sqlite/test`, `packages/state-store-indexeddb/test` or `packages/state-store-patch/test`.
- [ ] The EXISTING seam surface keeps working, so every current consumer compiles and passes without modification. This is what makes the migration tasks independent.
- [ ] Conformance runs over both shapes.
- [ ] An ADR records why the split is at the interface with concrete classes unchanged, and why construction beat a lease.
- [ ] A changeset accompanies the change (`pnpm changeset`). This touches PUBLISHED packages and `pnpm changeset status --since=main` is in the acceptance gate.

## Blocked by

`every-mutating-path-carries-a-writer-token`: this exposes the claim that task's guard already performs implicitly.

## Prompt

Read `work/specs/tasked/a-second-writer-writes-nothing.md` for the framing. The type sketch above is the decision; it is stated here rather than referenced, because it exists nowhere else.

The rule that must not break: EXISTING CALLERS COMPILE AND PASS UNCHANGED. If you find yourself editing `@etherfold/browser` or the CLI to make this land, stop: that is the next tasks' work, and doing it here collapses the migration into one unreviewable change.

Read `packages/state-store/src/store.ts` for the seam and `packages/state-store/src/snapshot.ts` for `openSnapshotAware`, which writes and therefore belongs on the writing side. Note `migrate` is on the readable type deliberately: it runs on every open, including from `createBrowserStateStore`, and making it claim would break `packages/browser/test/entityBootstrap.test.ts`, which opens a second store on one database while the first is live. Check that test early.

Precedent: ADR-0044 makes the one-writer rule STRUCTURAL for streams, by handing a follower a read-only stream view (`readOnlyStream`) rather than asking it to behave. This is that move for state. The one existing case that swallows writes instead, `readOnlyStream`, did so for a documented reason that does not apply here.

Done means both shapes exist, both are conformant, and `git diff` touches no consumer package and no backend test suite.
