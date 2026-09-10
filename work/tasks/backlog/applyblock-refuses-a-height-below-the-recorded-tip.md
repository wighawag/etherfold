---
title: 'applyBlock refuses a height that is not above the recorded tip'
slug: applyblock-refuses-a-height-below-the-recorded-tip
spec: a-second-writer-writes-nothing
blockedBy: [every-mutating-path-carries-a-writer-token]
covers: [16]
---

## What to build

`applyBlock` refuses a DUPLICATE height today ("block N is already recorded"), which is narrower than the invariant a single writer actually maintains: every applied block is ABOVE the recorded tip. Tighten it, so a writer holding a stale cursor is refused rather than accepted at a height the tip has already passed.

This is a TIGHTENING and not a behaviour change, and that was established by reading rather than by choosing. `applyEventStream` (`@etherfold/processor-entities`) is the one production caller: it takes the stream's fork point, calls `revertTo(fork)` FIRST, and only then applies the grouped blocks in stream order. Its own docstring states the property it relies on: "Revert precedes apply, which is also what makes replay safe. A store records a block plainly and a re-applied block raises on purpose. `revertTo(fork)` drops every block above the fork, and the canonical events in the same stream are all at or above `fork + 1`". So after the revert the tip is at or below the fork and every apply is strictly above it.

It is a separate task from the guard deliberately, so that it can be reverted alone if a path is ever found that legitimately applies below the tip.

## Acceptance criteria

- `applyBlock` refuses a height that is not strictly above the recorded tip, with a message that names both heights.
- An EMPTY store admits any height: there is no tip to be above.
- The tip is read inside the same transaction as the write, so a revert lowering it and an apply above it cannot interleave with another writer.
- The existing duplicate-height and duplicate-hash refusals still hold and still say what they say.
- Every existing suite stays green, including the replay path, the rebuild path and bootstrap from a snapshot, which install into a store with no tip.
- Conformance carries the case on every backend.
- A changeset accompanies the change (`pnpm changeset`). This touches PUBLISHED packages and `pnpm changeset status --since=main` is part of the acceptance gate, so a missing changeset is a red gate for a reason unrelated to the work.

## Blocked by

`every-mutating-path-carries-a-writer-token`, because both checks read state inside the same writing transaction and doing them in one place is cheaper than doing them twice.

## Prompt

Read `work/specs/proposed/a-second-writer-writes-nothing.md`, then `packages/processor-entities/src/apply.ts` in full: `applyEventStream` is the one production caller and its docstring is the evidence that this tightening is safe. Then read `applyBlock` in `packages/state-store-indexeddb/src/store.ts` and `packages/state-store-sqlite/src/store.ts`.

Before you build, CONFIRM the premise yourself rather than trusting this task: check the replay path, the rebuild-chunk path and `bootstrapFromSnapshot` for any call that applies a block at or below an existing tip. The reading says none does, and if you find one, that is a STOP: report it rather than weakening the check to accommodate it.

Domain vocabulary: a **fetch is not a replay** (ADR-0042). A fetch is raw logs carrying no verdicts, so retractions are derived by comparing the cursor's window against incoming blocks. A replay is a stored emission stream that already records what was applied and what was taken back, so the engine honours those verdicts. Both route through `applyEventStream`, and both revert before they apply.

Done means a stale writer cannot land a block at a height the tip has passed, an empty store still accepts its first block, and nothing on the replay or bootstrap paths regressed.
