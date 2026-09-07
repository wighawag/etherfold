---
'@etherfold/core': patch
---

A published stream seed can now be FETCHED from a list of locations and INSTALLED by writing through the public keeper seam, so a generation folds it with `eth_chainId` as the only call a node ever sees.

`installStreamSeed` (`stream/seedInstall.ts`) takes an ORDERED list of locations, the keeper the generation will be handed, and the RESOLVED stream config, and returns an outcome as DATA: installed, with where it came from and how far it reaches, or not installed with a reason (`no-locations`, `unreachable`, `unreadable-format`, `does-not-reach-back`, `subtree-not-empty`). Failover walks the list, so an unreachable mirror is logged and skipped and a BUILD-EMBEDDED artifact at a relative, hostless path listed last is reached like any other location (ADR-0066).

Installing is a run of ordinary `saveNewEvents` calls and nothing else (ADR-0063): no new keeper operation, no substrate access, and no second copy of the segmentation rules. The block arithmetic is the whole of it -- the first batch carries the seed's own coverage start, each later batch continues the previous exactly, and the last claims the coverage END above the last event-bearing block -- and the stored `context` is the seed's own, verbatim.

An install goes only into an EMPTY subtree and refuses anything else, including its own half-written prefix, which a caller CLEARS deliberately before installing again (ADR-0067). The refusal is non-destructive as well as non-writing: the keeper's only read CLEARS a subtree whose stored `startBlock` is above the block it was asked from, so the emptiness probe asks from a block no cursor can start above, and refusing an install can never be what deletes the stream it refused.

**It is deliberately NOT exported from the package entry yet**, because it verifies nothing: it does not check that the seed is for this stream, that its bytes match a pin, that its events are coherent, or that the capture was taken far enough below the chain head. Those admission checks all run before the first write, and the export lands with them.

Nothing existing changes; this is additive and reachable only from core's own tests for now.
