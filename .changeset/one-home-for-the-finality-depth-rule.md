---
'@etherfold/state-store': patch
'@etherfold/state-store-patch': patch
---

**A malformed `finalityDepth` is now refused on every retention kind, not only on a window.**

`resolveRetention` returned early for `'revert-only'`, `'unbounded'` and the default, so its non-negative-integer check on `finalityDepth` was only ever reached by `{blocks: N}`. All three versioned backends nevertheless stored whatever they were given and passed it to `retentionFloor`, whose `revert-only` floor is `tip - finalityDepth`. So a negative depth put the prune floor **above the tip** (measured: tip 1000, depth -5, floor 1005), and `prune` would then delete every closed version — including the ones reorg revert has to reopen. Accepted by `MemoryStateStore`, `VersionedStateStore` and `IndexedDBStateStore`.

`PatchStateStore` was the only backend that refused it, because it carried a private copy of the check whose comment admitted it was a copy. That is the tell: a validation rule enforced on one backend and absent on three.

The check is hoisted above the early returns and exported as **`assertFinalityDepth`**, which `PatchStateStore` (which resolves no retention at all) now calls instead of its own. `'revert-only'` and `'unbounded'` still do not require a depth — only a window does, and that requirement is unchanged.

A guard test asserts the rule has exactly one implementation across the `state-store*` packages, so a fifth backend cannot quietly grow a fourth copy.
