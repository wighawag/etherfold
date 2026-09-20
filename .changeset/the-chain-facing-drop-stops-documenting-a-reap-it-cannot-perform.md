---
'@etherfold/core': patch
---

**The chain-facing `Indexer` stops describing, and stops logging, a stream reap it can no longer perform.** ADR-0087 removed every AUTOMATIC reap -- `deleteGeneration` reaps only where a caller ASKS, and `reapStream` defaults to false -- but `dropSuperseded` and `dropReplaced` still opened their documentation with a drop that took "its stream if it was the last one folding it", and each carried a log clause naming the reaped digest that no call site could ever reach. Both methods now say what the drop actually takes, which is the registry row and the state store, and say plainly that the stream is KEPT.

`wouldStrandAFollower`'s justification is corrected in the same pass and its ARGUMENT is unchanged. On this runtime the thing that FETCHES a stream genuinely is a generation (ADR-0087 was deliberately not extended to the browser engine), so dropping a writer another held generation follows really would leave that one folding a stream nothing appends to, and the predicate still declines exactly as it did. What was stale is only the clause claiming such a drop would also reap the stored stream out from under the follower.

No behaviour change: the two drops delete precisely what they deleted before, and the operator-asked reap paths (`reclaim`, `deleteStream`, and `deleteGeneration`'s `reapStream` option) are untouched. What changes for a reader of the logs is the text: the unreachable `reaping the stream <digest> with it` branches are gone, replaced by the statement that the stream outlives the fold, matching what the receiving container already says.
