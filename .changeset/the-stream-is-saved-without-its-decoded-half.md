---
'@etherfold/core': minor
---

**What a stream keeper is handed to persist no longer carries a decoded half.** The indexer strips `args`, `eventName` and `decodeError` on the way into `saveNewEvents`, so a keeper receives the raw log the node reported plus the reorg verdict the indexer derived, and nothing an ABI made of those bytes.

This is a BEHAVIOUR change to what `@etherfold/core` persists, not a type change: the keeper seam still declares what it declared before, and narrowing it is a follow-on change. Nothing on disk is rewritten and no migration runs — segments written before this keep their decoded half forever, and a read tolerates it and ignores it, because `LogEventFetcher.reparse` drops and re-derives that half against the source running now regardless (ADR-0034). Reuse across a decode-only change is therefore unaffected: a renamed non-indexed parameter still replays the cached stream instead of re-fetching a block.

The strip lives ONCE, in core, at the save call site. `ExistingStream` is third-party-implementable and has several implementations already, so a rule each keeper had to remember would drift; a third-party keeper needs no change and simply stops seeing fields it was never allowed to trust.

Both halves of what the saver takes are stripped, the batch and the `lastSync`'s unconfirmed window. The window is worth stripping because a keeper's copy of it is never read back AS EVENTS — the load path takes a stored cursor for its three block numbers and its context only, the live reorg window is the indexer's in-memory one, and a transaction-inclusion question is answered from the state keeper's copy — so leaving it decoded would leave the one stale thing in the stream. Both strips build NEW objects: the events are the ones the processor is about to fold, and the same `lastSync` object is handed to the state keeper on the same tick, so stripping in place would corrupt the fold's input and silently empty the live reorg window.
