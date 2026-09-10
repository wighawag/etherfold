---
title: 'A refused writer demotes itself to a reader'
slug: a-refused-writer-demotes-itself-to-a-reader
spec: a-second-writer-writes-nothing
blockedBy: [a-store-opens-for-writing-or-for-reading]
covers: [3, 6, 7, 10]
---

## What to build

A writer whose mutation is refused has not hit an error the application should show. It has learned it lost, and the correct response is to stop being a writer.

Give the refusal its own named error and give a generation the demotion path: drop the in-memory `LastSync`, which is now a lie, stop fetching, and continue as a reader.

The error must be DISTINCT from the existing duplicate-height refusal, because the two mean opposite things and a caller responds differently: "applying the same block twice is a caller bug" says fix your code, while this one says you no longer hold the claim and nothing was written.

## Acceptance criteria

- A dedicated error type is raised when a mutation is refused for a lost claim, distinguishable from the duplicate-height and duplicate-hash refusals without string matching.
- It states that nothing was written.
- A generation that catches it drops its in-memory cursor, stops fetching, and answers reads, rather than propagating an exception to the application.
- A demoted writer does not resume writing on its own: it may become a writer again only by claiming again, which re-reads everything.
- The demotion is ONE code path, reusable by the lease-loss case a later spec needs, rather than two paths that happen to do the same thing.
- Tests cover: the error is raised on each guarded path, and a generation demotes rather than throwing outward.
- A changeset accompanies the change (`pnpm changeset`). This touches PUBLISHED packages and `pnpm changeset status --since=main` is part of the acceptance gate, so a missing changeset is a red gate for a reason unrelated to the work.

## Blocked by

`a-store-opens-for-writing-or-for-reading`, because there must be an explicit claim to lose before losing it means anything.

## Prompt

Read `work/specs/tasked/a-second-writer-writes-nothing.md`, particularly "Losing is not throwing at the app", and `work/specs/proposed/one-tab-indexes-and-the-others-read.md`, which needs this same demotion when a tab loses a lease. Build one path both can use.

Domain vocabulary: a **generation** is one indexed lineage, a stream plus a fold over it. A **follower** is a generation that folds a stream another generation is indexing into: it fetches NOTHING and writes no segment. That is the shape a demoted writer becomes, so read how a follower already behaves before inventing a new state.

The error family to NOT join: `BlockUnavailableError` (`NoSuchBlockError`, `BlockNotRetainedError`) is about a read this store cannot answer, which a caller fixes by re-pinning or widening retention. This is the write path, and the mutation did not happen. Keep them apart, on the same reasoning that keeps `RevertBeyondSnapshotError` out of that family.

Done means losing a race is a state change rather than a stack trace, and the browser tab that lost keeps showing correct data.
