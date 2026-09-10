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
- [ ] An `unbounded` store, and a `revert-only` store with no depth, DELETE nothing and do no unbounded work. The host may call unconditionally: ADR-0022 states a prune "is a no-op wherever there is no floor, so a host may schedule it unconditionally", and a host holding the seam cannot tell whether a `revert-only` store has a floor anyway, because the capability report carries no depth. Do NOT invent a new seam read to answer that question.
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

## Decisions

- **The prune attaches to `advanceOnce` (every drive verb), not to `_auto_index` alone.** The README tells apps to call `indexMore` / `indexMoreAndCatchupIfNeeded` on each new head rather than using the timer, so scheduling only inside the auto-index loop would leave the recommended wiring never pruning. Alternative considered: `_auto_index` only (rejected for that reason); inside `Indexer.indexMore` in core (rejected: that is the container's apply path, and the scheduling decision is the host's per ADR-0022). Touches every caller of the hook's drive verbs: a cycle now costs one tip read plus a bounded delete pass per generation.
- **A user-visible default budget, `DEFAULT_PRUNE_BUDGET = 1000`, plus a `pruneBudget` option on `createIndexerState`.** A pass has to be bounded or a backlog blocks a cycle, so a number had to be chosen; 1,000 is argued from the measured IndexedDB prune rate (6.3 s at 62,553 versions on the full-scan prototype) against the loop's 4 s resting interval, and drains the measured workload's whole unbounded footprint in ~30 cycles. Alternatives: no budget at all (one unbounded delete on the cycle that first meets a large backlog), and no knob (a host with a different responsiveness budget could not express it, and the "comes back for the rest" behaviour would be untestable). It reuses the seam's existing vocabulary (`PruneOptions.maxVersions`, `pruneBudget`, `d1PruneBudget`) rather than inventing a word, and it is deliberately **not** an off switch: `retention` is where a deployment says it wants nothing dropped.
- **A misconfigured budget is a REFUSAL at `createIndexerState`.** `pruneBudget({maxVersions})` from `@etherfold/state-store` is called once at hook construction, so `0` throws in the seam's own words where the app wrote it. Alternative: let it throw on the first cycle inside the try/catch, which would turn the seam's deliberate loud refusal into one log line per cycle for ever while the store grew. Touches anyone passing the new option; nothing else can reach the new throw.
- **A prune that throws is logged and the cycle continues.** Indexing is what the tab is for, and a failed delete leaves a store larger than it asked to be rather than a wrong answer. Alternative: propagate, which would stop indexing on a transient IndexedDB failure (and, under `_auto_index`, turn it into the retry-with-backoff path). Deliberately **not** published on `syncing`: whether a store's retention is actually enforced is the sibling task `a-store-reports-whether-its-retention-is-enforced`'s concept, and inventing a second report here would fork it.
- **Which stores get pruned: the generations the container currently holds, keyed by generation identity.** `HeldGeneration` deliberately does not carry the store, so the hook records the pair in its own factory wrapper. Alternative: a flat set of every store the hook ever built (simpler, but goes on pruning a generation dropped on promotion, whose database the registry's `dropState` may have deleted). Known limit, documented at the map: a store handed in already built through `updateProcessor` was not built by a factory here, so a swap onto a genuinely different store is prunable again after the next `init` (the ordinary hot-reload case rebuilds the processor over the same store).

None of these met the ADR gate: each is local to `@etherfold/browser`, reversible in a line, and ADR-0022 already carries the load-bearing decision they implement.
