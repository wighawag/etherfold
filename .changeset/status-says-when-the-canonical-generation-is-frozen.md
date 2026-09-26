---
'@etherfold/core': minor
'@etherfold/server': minor
'etherfold': minor
---

**`/status` now says which generation answers reads, where it stands, and whether it folds here, even when this process holds no fold for it** (ADR-0047's 2026-09-26 amendment).

A Node deployment can serve a canonical generation that nothing in the process folds: its stored code could not be built at `open`, a revert crossed a filter change, or the host injects no `instantiateGeneration` (ADR-0092). The admin listing already reported that as `folding: frozen` with a reason; `/status` said nothing, so a frozen deployment looked like a stalled one or a quiet chain.

- `@etherfold/server`: the `/status` cursor envelope carries a new optional `canonical` report beside `value` and `generations` (`CanonicalReport` on the reporter side, `ReportedCanonical` on the response): the generation's digest, `folding` (`held` / `instantiable` / `frozen`) with `frozen: {reason, message}` where frozen, typed from `@etherfold/core`'s `GenerationFolding`, and its `value`. Additive: nothing existing is removed or renamed, and `generations` is still one entry per fold the host HOLDS.
- `@etherfold/core`: `ReceivingIndexer.foldingOf(generation)` answers `folding()`'s question for ONE generation, by the same derivation, so a reporter asking about the canonical generation reads one stored bundle rather than every one.
- `etherfold` (CLI): `run` and `index` fill the canonical report. Where nothing here folds the canonical generation, its position is read from its own namespace through an UNCLAIMED store with no engine, and becomes the top-level `value` too, which is what that field always meant. `foldingStatusReport` takes the new `stateOf` reader as its second argument (`FoldingAssembly.stateOf`), and `readStatusReport` takes optional `canonicalFolding` and `canonicalState`.
