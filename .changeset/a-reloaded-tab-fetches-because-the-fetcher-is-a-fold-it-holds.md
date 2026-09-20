---
'@etherfold/core': patch
'@etherfold/browser': patch
---

**The generation that FETCHES a stream is the oldest one the container HOLDS, not the oldest one REGISTERED** (ADR-0088). A browser tab that reloads after a promotion goes on indexing instead of opening healthy and asking the node for nothing.

The defect was measured rather than argued. Over a DURABLE generation registry (opt-in; both browser entry points still default to a memory one), session 1 folds on generation A, a save registers B beside it, the default `on-catch-up` policy promotes B, and `dropOnPromotion` defaults to false -- so A survives as `predecessor`, which is exactly what a revert window IS. Session 2 is a full page load of B's bundle, which is all a tab can supply, since A's code is not in it. B is canonical so the container opened, but `follows` was derived from every record the registry carried, and A was older and still registered: B became a follower of a stream nothing writes.

```
chain reads:        {eth_chainId: 1}   <- the load-time handshake, and nothing else
eth_getLogs ranges: []                 <- none, ever
node tip:           107
tab cursor:         lastToBlock 105, latestBlock 105
reported phase:     "at-tip"
```

The last line is why it was worse than a stall: a follower never calls `eth_blockNumber`, so `latestBlock` stayed where the last fetch left it and the host's own pacing rule compared 105 with 105 and reported the tab LIVE while the chain was two blocks ahead. There is a UI attached to that and nothing about it looks wrong.

`fetcherOf` is UNCHANGED, and so is ADR-0044's follower rule and the registry: a stream still has one fetcher, it is still the oldest generation registered on it, it is still derived and stored nowhere. What narrowed is the SET the container asks it about -- the folds it HOLDS -- so the answer is always a generation that exists. Nothing is elected, nothing is persisted, no generation is dropped to make room: the revert target survives the fix untouched.

**`Indexer.open` now has two phases**, and that is the substance rather than the predicate. It REGISTERS every spec before it builds any engine, then derives `follows` for each over the complete fold set. `follows` freezes the read-only stream view into an engine's config at construction, so a derivation over a half-built held set answers per spec ORDER: measured, with the same two folds listed edited-first, TWO generations decided they fetched, the same range was asked of the node twice and one block's log was stored twice. The phase boundary cannot be earlier than registration, because a fold arriving as a module derives its identity inside `createProcessor` (ADR-0086) and genuinely cannot be named before it is built.

**Nothing else moved.** A generation added at RUNTIME beside a live fold still follows (by then the held set is complete). The other reload -- a changed handler with no promotion -- is still a loud `CanonicalGenerationNotHeldError` and not a stall. The drop path's question (`wouldStrandAFollower`) is deliberately still asked over the REGISTERED records, because what deleting a record would strand is not a question about what this process holds. On the default memory registry a reload registers afresh and fetches exactly as before.

Two tabs holding one canonical fold still both fetch, because each has its own registry instance; that hazard is not introduced here and its answer is the single-indexer lease.
