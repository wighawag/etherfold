---
'@etherfold/browser': minor
'@etherfold/state-store': patch
---

**A writer whose mutation is refused now DEMOTES itself to a reader instead of raising at your app** (ADR-0078).

Losing the store is not an application error: it is a writer learning it lost a race it could not have avoided (ADR-0075). So `@etherfold/browser` stops fetching and folding, DROPS the in-memory `LastSync` that is now a lie, narrows every store it was folding into to `openForReading`, and goes on ANSWERING READS from the store the winner is writing. The tab that lost keeps showing correct data.

**New: `demoteToReader`**, one exported function for the two ways of losing -- a refused write (`'write-refused'`, which the hook calls for itself) and a lost lease (`'lease-lost'`, which a caller electing one indexing tab calls through `indexer.demoteToReader(...)`). It is not the inverse of `promote`: that moves the canonical pointer between generations, this drops the write duty over the storage they fold into.

**New: `syncing.demotion`** (`{reason, reading}`), reported beside `syncing.streamSeed` and deliberately NOT inside `syncing.error`, plus a `named-logs` warning -- because a tab that silently stops indexing for ever is the quiet failure the writer guard exists to end. `status` returns to `Idle`. It clears on `dispose()`.

**BREAKING: `indexMore()`, `indexMoreAndCatchupIfNeeded()` and `indexToLatest()` now answer `Promise<LastSync | undefined>`.** `undefined` means DEMOTED and means nothing else. Throwing was rejected because both browser loops swallow exceptions and retry on a timer, so the refusal would be retried for ever against a store that will never accept it again; returning the last cursor was rejected because that is the very value the demotion exists to drop (`checkTxInclusion` answers from it). A caller that ignores the return value needs no change.

**`startAutoIndexing()` on a demoted tab returns `false` and starts nothing.** A demoted writer never re-claims on its own: a backend does not re-mint a claim it has committed, so indexing again means `dispose()` plus a fresh `init` over a store built FRESH, which re-reads everything.

A demoted writer is deliberately NOT a follower. A follower is read-only on the STREAM axis and a full writer of STATE (it re-folds through `EventProcessor.process`, so it calls `applyBlock` constantly); a demoted writer must stop writing state, so "become a follower" would keep mutating, keep being refused, and loop.

`@etherfold/state-store` is unchanged in behaviour: what is new there is the assertion that the refusal a lost writer meets stays OUTSIDE the `BlockUnavailableError` family (that family is a read this store cannot answer; this is the write path, and the mutation did not happen).
