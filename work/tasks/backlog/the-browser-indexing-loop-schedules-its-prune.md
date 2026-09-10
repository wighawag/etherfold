---
title: 'The browser indexing loop schedules the prune its retention implies'
slug: the-browser-indexing-loop-schedules-its-prune
spec: a-configured-window-is-actually-pruned
blockedBy: []
covers: [1, 4, 6, 7, 8, 12]
---

## What to build

A browser deployment whose store has a retention floor must actually reclaim the versions below it. Nothing in `@etherfold/browser` calls `prune` today (verified: zero mutating calls in `packages/browser/src`), so retention refuses reads and frees nothing, and a long-lived tab accumulates versions on a user's device without limit.

Give the browser indexing loop a scheduled prune. The seam already provides the shape: `prune(options)` takes a `maxVersions` budget and returns a `PruneReport` carrying `complete`, so bounded work that reports whether it finished is already expressible. This task is about calling it on a schedule the host owns.

**The trigger is a FLOOR, not a window.** `retentionFloor` (`packages/state-store/src/retention.ts`) returns a floor for `'window'` AND for `'revert-only'` when a `finalityDepth` is stated, and `undefined` for `'unbounded'` and for `revert-only` with no depth. So the condition is "this store has a floor", never "a window is set". Getting this wrong leaves a `revert-only` deployment refusing every historical read while retaining every version for ever, which is the exact defect this spec exists to kill, on the setting a browser app is told to prefer.

Pruning is not an extra a deployment opts into on top of retention: a floor exists because the deployment said it keeps only that much, so dropping what falls outside it is the meaning of the setting.

## Acceptance criteria

- [ ] A browser store WITH a floor physically drops versions below it, observed as the stored version count falling, never as a statement being issued.
- [ ] A `revert-only` store with a `finalityDepth` prunes, because it has a floor. This case is asserted explicitly and is the one a binary window-or-not implementation gets wrong.
- [ ] An `unbounded` store, and a `revert-only` store with no depth, schedule nothing: there is no floor and no cost is paid.
- [ ] The LIVE version of an entity survives a prune however old it is. This is the property a naive "drop everything below the floor" destroys.
- [ ] Each pass is bounded by a budget and the loop continues until the report says `complete`, so a large backlog never blocks one cycle.
- [ ] Applying a block performs no deleting: `prune` is never reached from the apply path.
- [ ] Tests assert the above behaviourally (what a read returns, how many versions remain).
- [ ] Evidence for reclamation on IndexedDB comes from the real-engine browser run in `packages/browser/browser/`, not from `fake-indexeddb`, whose write path is not the engine's.
- [ ] A changeset accompanies the change (`pnpm changeset`). This touches PUBLISHED packages and `pnpm changeset status --since=main` is in the acceptance gate.

## Blocked by

None, can start immediately.

## Prompt

Read `work/specs/tasked/a-configured-window-is-actually-pruned.md` for the framing, then `packages/state-store/src/retention.ts` in full. The three functions that matter are `resolveRetention`, `retentionFloor` (read every arm of its switch, including `revert-only`) and `pruneBudget`; the two types are `PruneOptions.maxVersions` and `PruneReport.complete`. Then read `prune` in `packages/state-store-indexeddb/src/store.ts`: it is a range scan over the `upper` index, and a LIVE version has `upper: null`, which is not a valid IndexedDB key and is therefore absent from that index entirely. That is what keeps a prune from destroying current state, and it is worth understanding before you trust it.

Where to look for the loop: `@etherfold/browser`'s indexing hook (`packages/browser/src/IndexerState.ts`) owns the cycle. Understand how it drives the engine before choosing where a scheduled prune attaches. The constraint is that it must not sit inside the path that applies a block.

Domain vocabulary: **retention** is measured in BLOCK NUMBERS and in nothing else, never a duration and never a count of updates (ADR-0019). **`prune`** is an explicit call the HOST schedules and never a side effect of a write (ADR-0022), because it costs time proportional to what it drops.

The measured trap: event-bearing blocks on the real stream are median 429 blocks apart, so do NOT reason about a window as though it held N updates.

Out of scope, deliberately: do not change any default, and in particular do not bound the browser's default retention. That is a separate decision and bounding at the finality depth is measurably the wrong answer.

Done means a store with a floor shrinks, a store without one is untouched, and no block apply pays for a delete.
