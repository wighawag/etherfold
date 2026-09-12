---
'@etherfold/core': minor
---

**A fetch range that could never reach the tip is refused, instead of wedging the cursor for ever.**

Every cycle rewinds by the unconfirmed window before it fetches (`getFromBlock` takes `min(lastToBlock + 1, latestBlock - finality)`), so a range CEILING at or below `stream.finality` re-asks for blocks that are already folded and stops short of the ones that are not. With `finality: 3` and `maxBlocksPerFetch: 2`, a cursor at 103 asks for 102..103, applies nothing, and asks for 102..103 again, for ever -- measured at 50+ identical `eth_getLogs` ranges in three seconds. Nothing refused it and nothing said so: the indexer went on reporting that it was catching up, truthfully, having stopped indexing.

`fetch.maxBlocksPerFetch` at or below `stream.finality` now throws the new `FetchRangeBelowFinalityError`, which carries both numbers and names both ways out. It is refused at CONSTRUCTION, where the two values are first in hand, and on the reconfigure path too, since that can introduce the same pair.

It is a refusal rather than a clamp because both numbers are deliberate statements about a deployment -- how deep a reorg it tolerates, and how wide a range its node will serve -- so quietly raising one to satisfy the other would overrule an operator on exactly the axis they were being explicit about.

Only the CEILING is checked. `fetch.numBlocksToFetchAtStart` may legitimately sit below the finality depth, because the fetcher adapts it upwards towards `maxBlocksPerFetch`; the ceiling is the one it can never grow past. A deployment that configures no ceiling is unaffected, and the narrowest width that still reaches the tip (`finality + 1`) keeps working.
