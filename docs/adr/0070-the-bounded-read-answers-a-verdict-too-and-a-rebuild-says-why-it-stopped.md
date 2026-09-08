# The BOUNDED read answers a verdict too, and a rebuild SAYS why it stopped

`ReplaySource.readChunk` returns `ReplayRead` (`chunk` / `absent` / `does-not-reach-back` / `inconsistent`) instead of `ReplayChunk | undefined`, and `RebuildReport` carries a `stopped: RebuildStop` instead of an `absent: boolean`. `retryCanAdvance(stopped)` is the one derivation a scheduler needs: whether calling again can help.

This finishes ADR-0069. That ADR corrected `ExistingStream.fetchFrom` and missed its bounded sibling, which reads THE SAME `_emissions` ROWS 130 lines further down the same file. ADR-0069's own headline claim, "the two implementations of this seam finally agree about what a read may do", was true of `fetchFrom` and false one port over.

## The conflation, and why it was not theoretical

`storedEmissionReplaySource.readChunk` returned `undefined` for two unrelated things: no coverage claim at all, and a coverage claim whose `startBlock` is above the block the fold resumes at. Its own log line said "a rebuild is told there is nothing to replay", which is the wrong sentence for the second case, and its type's doc comment stated the conflation out loud.

The difference is the entire scheduling decision:

- **nothing stored is TRANSIENT.** The writing generation simply has not appended yet. Calling again is exactly right.
- **does-not-reach-back is PERMANENT for this fold.** The resume point comes from the fold's own durable checkpoint (`getFromBlock` over `checkpoint()`), so the comparison reads the same on every call, for ever. It needs a stream reaching further back, a lower resume point, or a re-index. It never needs another poll.

A **seeded** generation is the shape that produces it, which is what makes this the same family as ADR-0063 through ADR-0069 rather than an unrelated tidy-up: a seeded stream opens at the capture's `fromBlock` rather than at the source's first block.

## What it cost, before

`receivingContainer.rebuildMore` sets `origin.level = report.complete`, and `complete` was false on every one of those calls. So a follower of a stream that does not reach back:

- never became level, so `reconcileWriters` never let it inherit a vacant write duty, and it never promoted;
- burned a scheduled invocation on every host cycle, for ever, at full rate;
- reported all of it as an ordinary "not finished yet".

A silent, permanent stall wearing the shape of ordinary progress. Nothing in the report could distinguish it, and no test could either: the in-repo test double collapsed the two answers exactly as the port did, which is precisely why nothing caught it.

## The report answered three questions with two booleans

`more()` has three non-success shapes and `RebuildReport` documented two. The middle one -- a stored emission with no raw log to decode (ADR-0034) -- returned `complete: false, absent: false`, which a host doing what the docs told it ("a scheduler loops while `complete` is false") loops on for ever at full rate. The only discriminator was an undocumented `toBlock === undefined && !absent`, i.e. a caller re-deriving a rule the report exists to state.

`complete` now answers ONE question, the same one `PruneReport.complete` and `PairCompactionReport.complete` answer, and `stopped` says why. Three of its six reasons recur identically until something outside the loop changes, and `retryCanAdvance` is where that is decided once rather than in every host.

## Why `does-not-reach-back` is its own verdict, again

The same argument ADR-0069 made: nothing is WRONG with such a stream. A fold resuming higher would be served it. Folding it into `inconsistent` would re-create, one port down, the conflation this removes.

## `inconsistent` has no in-repo producer, deliberately

The SQL reader's rows are either claimed or they are not, so it never reports it. It exists because a third party implementing `ReplaySource` over its own store has damage it can see and, without this member, nowhere to put it -- which is how the conflation being removed here got started. Adding a member to a published union is breaking; adding it now is free.

## Cost

A breaking change to a published port with one implementation, all in this repository, taken now for the third time and the last cheap one: `publish-etherfold-and-deprecate-old-names` is what ends it.

The test double was fixed first, on purpose. A double that cannot express a distinction guarantees no test asserts it, and that is the mechanism by which this survived ADR-0069 being written about the very same rows.
