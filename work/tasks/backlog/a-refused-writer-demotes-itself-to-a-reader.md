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
