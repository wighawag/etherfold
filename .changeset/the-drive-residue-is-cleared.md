---
'@etherfold/core': patch
'@etherfold/processor-entities': patch
---

**A tightened provider cap no longer collapses the next request to a single block, and two refusal messages stop naming a mechanism that does not exist.**

`RangeLogFetcher` learns two numbers about a provider: a CEILING it has been refused at, and the largest span it has been SERVED. Those two could go incoherent. A provider that tightens mid-run, or that states a cap smaller than a span it has already answered, left the ceiling BELOW the safe span, and the error-path bisection then read `Math.floor((ceiling - safeSpan) / 2)` -- a negative step, so the `Math.max(1, ...)` guard fired and the fetcher asked for ONE BLOCK, paying a round trip per block until it climbed back. `lowerBlockCeilingTo`, the only writer of the ceiling, now drops a safe span the new ceiling contradicts: the ceiling is the fresher evidence, and a width cannot be both known-safe and at or above a width that is refused. This is the rule the configured-range path already applied to a seeded `learnedRange`, now stated once at the only place the pair can go wrong.

The same bisection was also missing its BASE. The error path asked for `floor((ceiling - safeSpan) / 2)` where the success path asks for `safeSpan + floor((ceiling - safeSpan) / 2)`, so a fetcher that knew a safe span asked for less than one that knew nothing (the no-safe-span branch asks for `ceiling - 1`). Knowing more made it slower. It now bisects up from the safe span at both sites.

Neither is a correctness bug -- both cost round trips and recover on the following call -- but the first is the shape that makes a backfill against a tightening endpoint look wedged.

**The `blockTimestamp` refusals no longer tell an operator to look for the wrong thing.** `TimestamplessLogError` (`@etherfold/core`) and `blockPointer`'s fold-time refusal (`@etherfold/processor-entities`) both listed, among the causes of an absent `blockTimestamp`, "an EDR RPC response cache written before the change". That reads backwards: `@nomicfoundation/edr@0.20.0` moved the cache to `rpc_cache/v2` and IGNORES everything else in `rpc_cache`, so pre-change entries are not served at all. The real hazard is a CURRENT-format entry that recorded an absence from a FORKED remote predating the spec change, and it persists until `rpc_cache` is dropped. Both messages now say that, as do ADR-0073 and ADR-0002. The conclusion is unchanged -- the refusal is still permanent machinery, because the forked-node cause stands on its own -- but an operator following the old wording would have gone looking for a stale cache that EDR had already stopped reading.

Also removed: `packages/core/src/internal/utils/extra.ts`, imported by nothing and holding the only `eth_call` in the package. It was built and typechecked but unreachable, and it was the one place a reader grepping the core for provider calls found a method the engine does not declare.
