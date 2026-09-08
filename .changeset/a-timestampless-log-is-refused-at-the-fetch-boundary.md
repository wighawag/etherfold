---
'@etherfold/core': minor
'@etherfold/processor-entities': patch
'@etherfold/browser': patch
---

**A fetched range holding a log with no readable `blockTimestamp` is now REFUSED at the fetch boundary, naming the NODE.** Both deployment shapes refuse it: the single-process `IndexerGeneration` on the node's answer, and the split `LogFetcher` before it pushes anything to a receiver that could not have caught it. The new error is `TimestamplessLogError`, exported from `@etherfold/core` and carrying `retryable: false`, so a fetcher host stops and tells somebody instead of asking a node forever for a field it does not serve.

`blockTimestamp` on the log is `ethereum/execution-apis#639`, served by geth >= 1.16.0, reth, besu, erigon, anvil and `@nomicfoundation/edr >= 0.20.0`. A node that serves it is entirely unaffected by this: no new call, no new failure, nothing about the cycle changes. What changes is that a node which does NOT serve it is refused one round trip in, rather than silently compensated for at a request per event-bearing block, or refused a whole range later at the fold.

**The message is long on purpose.** Every cause is node-level and each has a DIFFERENT fix, so "missing blockTimestamp" alone would send an operator to the wrong one. It names the standard, the minimum implementations that serve it, and the four situations an operator can be in: the node predates the change; it is a Hardhat version bundling an older EDR (3.16.0 still ships edr 0.19.0, and the fix is a package-manager override to `@nomicfoundation/edr@>=0.20.0`, not waiting for a Hardhat release); it is forking a node that predates the change; or it is answering from an EDR RPC response cache written before the change, which needs its `rpc_cache` dropped.

The refusal is PERMANENT machinery rather than a transitional guard (ADR-0073), because the last two of those causes survive any version bump: a forked node's history predates the change whatever version forks it, and EDR's on-disk RPC cache is version-segmented, so entries written before the change keep answering without the field.

**While `stream.alwaysFetchTimestamps` is set the refusal does not fire**, because the fallback resolves the timestamp and there is nothing to refuse. That flag, and this condition with it, are deleted by a later change; the refusal itself stays.

`blockPointer`'s fold-time refusal in `@etherfold/processor-entities` is UNCHANGED and is not replaced by this one. The two guards sit on different entry points: a stream can reach a fold without passing a fetcher at all -- a seed install writes through the keeper seam, a fixture reader replays a captured stream -- so a fetch-boundary check would never see either. Neither of them guesses a value: a zero or interpolated timestamp does not fail, it answers confidently about the wrong block for as long as the store lives.

The tolerant reading of the field is untouched (`parseLogBlockTimestamp`: a 0x-prefixed hex quantity or a bare decimal one, and anything else dropped rather than coerced). "Unreadable" and "absent" therefore reach the refusal as one outcome, which is the intent: neither may become a number.

`@etherfold/processor-entities` and `@etherfold/browser` carry TEST-ONLY changes here and no API or behaviour change of their own: the first gains the case pinning that the two guards are not redundant, the second has a fake node that now serves the field, as every supported node does.
