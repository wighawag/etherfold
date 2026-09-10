---
title: 'A refused writer demotes itself to a reader'
slug: a-refused-writer-demotes-itself-to-a-reader
spec: a-second-writer-writes-nothing
blockedBy: [the-seam-splits-into-a-readable-and-a-writable-store]
covers: [3, 6, 7, 8]
---

## What to build

A writer whose mutation is refused has not hit an error the application should show. It has learned it lost, and the right response is to stop being a writer.

The refusal `StoreWriterChangedError` is thrown by the guard task and declared in `@etherfold/state-store`. This task gives a generation the demotion path: drop the in-memory `LastSync`, which is now a lie, stop fetching, and continue as a reader.

You are not naming or declaring the error: it already exists when this task starts. You are deciding what a generation DOES when it catches one.

It must be DISTINCT from the existing duplicate-height refusal, because the two mean opposite things: "applying the same block twice is a caller bug" says fix your code, while this says you no longer hold the claim and nothing was written.

## Acceptance criteria

- [ ] A demoted generation folds NOTHING and holds a store opened for reading. It is explicitly NOT a follower: a follower re-folds a stored stream through `EventProcessor.process` and therefore calls `applyBlock` constantly, so "become a follower" would produce a generation that keeps mutating, keeps being refused, and loops.
- [ ] After demotion the generation issues no further mutation on any guarded path, asserted rather than assumed.
- [ ] A demotion is OBSERVABLE: it is a reported state on the generation plus a warning through `named-logs`. Without this, an app following the documented `createState` example gets a generation that silently stops indexing for ever, which is precisely the quiet failure the spec exists to kill.
- [ ] It is NOT a member of the `BlockUnavailableError` family. That family is about a read this store cannot answer, which a caller fixes by re-pinning or widening retention; this is the write path and the mutation did not happen. The same reasoning already keeps `RevertBeyondSnapshotError` out of it.
- [ ] A generation that catches it drops its in-memory cursor, stops fetching, and answers reads, rather than propagating an exception to the application.
- [ ] A demoted writer does not resume writing on its own: it becomes a writer again only by claiming again, which re-reads everything.
- [ ] The demotion is a SINGLE exported function, called from the refusal handler and callable from a caller-supplied hook, so a later lease-loss caller reuses it. Assert that one exists, not that a future spec will like it.
- [ ] Tests cover the error being raised on each guarded path, and a generation demoting rather than throwing outward.
- [ ] A changeset accompanies the change (`pnpm changeset`). This touches PUBLISHED packages and `pnpm changeset status --since=main` is in the acceptance gate.

## Blocked by

`the-seam-splits-into-a-readable-and-a-writable-store`: there must be an explicit claim to lose before losing it means anything.

## Prompt

Read `work/specs/tasked/a-second-writer-writes-nothing.md`. The framing to build to: losing is a DEMOTION, not an error the app renders.

Where the demotion lives: a generation's loop, which is `packages/core/src/container.ts` and `packages/core/src/receivingContainer.ts` on the core side, and the auto-index loop in `packages/browser/src/IndexerState.ts` on the browser side. Read both before choosing where the single function belongs.

Domain vocabulary, and the trap this task exists to avoid. A **follower** is a generation that folds a stream another generation is indexing into: it fetches nothing and writes no SEGMENT. It is read-only on the STREAM axis and a full writer on the STATE axis, because it re-folds through `EventProcessor.process`, which persists a cursor in the same transaction as each block (`packages/core/src/generation/rebuild.ts`). A demoted writer is restricted on the OPPOSITE axis: it must stop writing STATE. So do not model demotion on a follower; read that code to understand why it is not the answer.

`work/specs/proposed/one-tab-indexes-and-the-others-read.md` needs this same demotion when a tab loses a lease. You are not building that; you are making sure it has one function to call.

Done means losing a race is a state change rather than a stack trace, and the tab that lost keeps showing correct data.

## Decisions

- **The demotion lives in `@etherfold/browser`, not in `@etherfold/core` beside `pause`.** A demoted writer must HOLD ITS STORE AS A READER, and the core has no store: on both containers the state is an opaque type parameter from a caller's `createState`, and `@etherfold/core` does not depend on `@etherfold/state-store` (ADR-0016's direction). The browser hook is the only place with all three halves (the stores it built, the loop that fetches, the surface an app subscribes to) and is where the lease-loss caller will live. Alternatives: core with the store half re-implemented per runtime (two demotions with one name), or the seam (which knows nothing about generations or fetching). **Touches**: the receiving container (server/CLI, `receivingContainer.ts`) gets NO demotion — deliberate, since a second writer there is an operator misconfiguration rather than a tab that must keep rendering, and the honest server behaviour is the refusal reaching the host that scheduled the call. Recorded as ADR-0078.
- **`indexMore` / `indexMoreAndCatchupIfNeeded` / `indexToLatest` now answer `Promise<LastSync | undefined>`; `undefined` means DEMOTED and nothing else.** A user-visible, breaking signature change. Alternatives: throwing (rejected — both browser loops swallow exceptions and retry on a timer, so the refusal would be retried for ever) and returning the last cursor (rejected — that is the very value the demotion drops, and `checkTxInclusion` answers from it). **Touches** every app driving the loop and the browser test fixture `indexToTip`, which now raises naming the demotion. Nothing is published, so it costs a changeset.
- **`syncing.demotion` is reported for the INDEXER, not per generation.** A claim is scoped to one unit of STORAGE (ADR-0075) and the shipped pattern hands one store to every generation (ADR-0077), so a per-generation `demoted` flag would report a state no backend can produce. **Touches** the acceptance wording "a reported state on the generation" — read as the reported state of the thing that lost the claim.
- **Named `demoteToReader`, never `demote`.** `promote` already means moving the canonical pointer BETWEEN generations, and a bare `demote()` beside it on the same object would read as its inverse. The `...ToReader` suffix names the axis; the JSDoc, the glossary entry, the README and the ADR all state the distinction explicitly. The word itself is not new: ADR-0075/0077 and the source spec already say "demoted writer".
- **`'lease-lost'` is in the reason union although nothing in the tree produces it yet.** The lease spec (`one-tab-indexes-and-the-others-read`) needs a reason to pass and would otherwise invent one; it is asserted by a test that calls the function that way, not deferred to a future spec. **Touches** that spec only.
- **`startAutoIndexing()` on a demoted tab returns `false` and starts nothing** rather than throwing a new error. `false` is the answer it already gives for "a loop is already running", so no new refusal type was introduced on a user-visible path.
- **A refused `prune` inside the scheduled pass is re-raised rather than logged** (that catch otherwise swallows everything), so the one refusal handler demotes. A swallowed refusal would leave a tab that had learnt it lost and carried on indexing until its next write said so again.
- **The refusal is recognised by `instanceof` OR `error.name === 'StoreWriterChangedError'`.** Same reasoning as `isOutOfSpace` in `@etherfold/core`: a bundled app can hold two copies of `@etherfold/state-store`, and an unrecognised refusal is retried for ever.
