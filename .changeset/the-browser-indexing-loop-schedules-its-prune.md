---
'@etherfold/browser': minor
---

The browser indexing loop now SCHEDULES the prune its retention implies, so a store that states a floor actually reclaims what falls below it.

Retention has two halves and only one of them ran here. A window has always bounded what a READ may ask about (`assertRetained`, on every backend); `prune` is what drops the versions it no longer covers, and ADR-0022 makes that an explicit call the HOST schedules, deliberately, because it costs time proportional to what it drops. Nothing in this package called it. A tab that configured `{blocks: N}` therefore got the refusals of a bounded store and the footprint of an unbounded one, on a device under a quota, for as long as it stayed open. The measured workload reached 4,072 live rows against 29,393 versions, so unbounded is roughly seven times the live set and the ratio grows with churn.

`createIndexerState`'s cycle now prunes the state of every generation it holds, once per advance, after the advance has been published.

**The trigger is a FLOOR, not a window.** `retentionFloor` returns one for `revert-only` too wherever a `finalityDepth` was stated (that kind keeps superseded versions exactly as long as reorg revert needs them, and the depth is how long that is), so a `revert-only` deployment prunes as well. Reading the trigger as "a window is set" is what would leave the setting a browser app wanting reorg safety and no history is told to prefer refusing every historical read while retaining every version for ever.

**Nothing changes for a store with no floor**, which is the default: `unbounded`, and `revert-only` with no depth, delete nothing. The call is made unconditionally rather than guarded, because a prune is a no-op wherever there is no floor (ADR-0022) and the capability report carries no finality depth, so a host holding the seam cannot tell the two `revert-only` cases apart anyway.

**No default is changed.** `retention` still defaults to `unbounded` everywhere; what a deployment already said it keeps is now what it keeps.

New: `createIndexerState(..., {pruneBudget})`, how many versions ONE pass may delete, defaulting to the exported `DEFAULT_PRUNE_BUDGET` (1,000). The budget is per PASS and never a limit on what is reclaimed: an unfinished pass leaves the rest for the next cycle, so a tab that ran unbounded for a month before a window was configured drains its backlog over cycles instead of stalling on one delete. It is not a way to turn pruning off, which is what `retention` is for. A prune that throws is logged and the cycle carries on: indexing is what the tab is for.

Applying a block still performs no deleting, which is asserted rather than trusted (`test/scheduledPrune.test.ts` watches the seam and no `prune` is ever in flight while an `applyBlock` is). The reclamation itself is measured in a real engine, on real IndexedDB, in `browser/indexing.spec.ts`.
