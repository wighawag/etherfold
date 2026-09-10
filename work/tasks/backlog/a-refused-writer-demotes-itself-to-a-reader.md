---
title: 'A refused writer demotes itself to a reader'
slug: a-refused-writer-demotes-itself-to-a-reader
spec: a-second-writer-writes-nothing
blockedBy: [the-seam-splits-into-a-readable-and-a-writable-store]
covers: [3, 6, 7, 8]
---

## What to build

A writer whose mutation is refused has not hit an error the application should show. It has learned it lost, and the right response is to stop being a writer.

Name the refusal **`StoreWriterChangedError`** and give a generation the demotion path: drop the in-memory `LastSync`, which is now a lie, stop fetching, and continue as a reader.

The name is fixed HERE rather than left to the builder, because another task asserts it by name and two builders inventing two names is the failure that produces.

It must be DISTINCT from the existing duplicate-height refusal, because the two mean opposite things: "applying the same block twice is a caller bug" says fix your code, while this says you no longer hold the claim and nothing was written.

## Acceptance criteria

- [ ] `StoreWriterChangedError` is raised when a mutation is refused for a lost claim, distinguishable from the duplicate-height and duplicate-hash refusals without string matching.
- [ ] It states that nothing was written.
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

Domain vocabulary: a **generation** is one indexed lineage, a stream plus a fold over it. A **follower** is a generation that folds a stream another generation is indexing into: it fetches NOTHING and writes no segment. That is the shape a demoted writer becomes, so read how a follower already behaves (`packages/core/src/generation/rebuild.ts`, `packages/cli/src/followers.ts`) before inventing a new state.

`work/specs/proposed/one-tab-indexes-and-the-others-read.md` needs this same demotion when a tab loses a lease. You are not building that; you are making sure it has one function to call.

Done means losing a race is a state change rather than a stack trace, and the tab that lost keeps showing correct data.
