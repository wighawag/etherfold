---
title: 'The browser indexing loop schedules the prune its retention implies'
slug: the-browser-indexing-loop-schedules-its-prune
spec: a-configured-window-is-actually-pruned
blockedBy: []
covers: [1, 4, 6, 7, 8, 12]
---

## What to build

A browser deployment that configures a retention window must actually reclaim the versions that window no longer covers. Today nothing in `@etherfold/browser` ever calls `prune`, so a configured window refuses reads and frees nothing, and an unbounded browser store grows without limit on a user's device.

Give the browser indexing loop a scheduled prune. The seam already provides everything needed: `prune(options)` takes a `maxVersions` budget and returns a `PruneReport` carrying `complete`, so bounded work that reports whether it finished is already expressible and this task is about calling it on a schedule the host owns.

A prune must never become a side effect of a write (ADR-0022): it costs time proportional to what it drops, so it is scheduled beside the indexing cycle, not folded into one.

An `unbounded` deployment (the default) must be unaffected: there is no floor, so a prune is a no-op and should not be scheduled at a cost.

## Acceptance criteria

- A browser deployment configured with a retention window physically drops versions the window no longer covers, observed as a count of stored versions falling, not as a statement being issued.
- The LIVE version of an entity survives a prune however old it is. This is the property a naive "drop everything below the floor" destroys, and it must be asserted.
- Pruning is bounded per call and the loop continues until the report says `complete`, rather than blocking on one unbounded pass.
- No prune runs as a side effect of applying a block: applying a block does no deleting.
- An `unbounded` deployment behaves exactly as it does today.
- Pruning is UNCONDITIONAL when a window is set: it is not a second opt-in on top of configuring retention. Setting a window is a deployment saying it keeps only that much, so dropping what falls outside it is the meaning of the setting rather than an addition to it.
- Tests cover the above at the behavioural level (what a read returns, how many versions are stored), never by asserting which statement ran.
- The evidence for reclamation on IndexedDB comes from the real-engine browser run, not from `fake-indexeddb`, whose write path is not the engine's.
- A changeset accompanies the change (`pnpm changeset`). This touches PUBLISHED packages and `pnpm changeset status --since=main` is part of the acceptance gate, so a missing changeset is a red gate for a reason unrelated to the work.

## Blocked by

None, can start immediately.

## Prompt

Read `work/specs/proposed/a-configured-window-is-actually-pruned.md` for the full framing, then `packages/state-store/src/retention.ts` for `PruneOptions`, `PruneReport` and `resolveRetention`, and `packages/state-store-indexeddb/src/store.ts` for the backend's own `prune` (a range scan over the `upper` index, deliberately, so it does not full-scan).

Domain vocabulary you need: **retention** is measured in BLOCK NUMBERS and never in a count of updates or a duration (ADR-0019); its floor is the finality depth. **`prune`** is an explicit call the HOST schedules and never a side effect of a write (ADR-0022). A **version** is one complete row with a half-open block-validity range, and a LIVE version has `upper: null`, which is not a valid IndexedDB key and is therefore unreachable from the `upper` index at all: that is exactly what keeps a prune from destroying current state.

Where to look: `@etherfold/browser`'s indexing hook is where the cycle lives. Understand how it drives the engine before deciding where a scheduled prune belongs; the constraint is that it must not be inside the path that applies a block.

The trap to avoid: retention is in block numbers and event-bearing blocks on the real measured stream are median 429 apart, so do NOT reason about a window as though it contained N updates. Do not change any default in this task, and in particular do not bound the browser's default retention: that decision belongs to a separate task and bounding at the finality depth is measurably the wrong answer.

Done means a browser deployment with a window set actually shrinks, an unbounded one is untouched, and neither pays a delete inside a block apply.
