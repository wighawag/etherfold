---
'@etherfold/core': minor
'@etherfold/browser': patch
'@etherfold/server': patch
---

**`degradingStream` is DELETED, and a stream keeper whose substrate cannot be read now RAISES from `fetchFrom` and `clear` instead of answering absent** (ADR-0068).

The rule it encoded is unchanged and still enforced: a cache that cannot be read costs a re-index, never the indexer. What moved is WHERE it is applied. It was a wrapper each keeper put around itself, so it bound every caller -- and "absence is safe" is a statement about the LOAD PATH, which responds to an absent stream by re-indexing. It is false for `installStreamSeed`, which responds to absence by WRITING.

Told "empty" about a subtree that was merely unreadable, the installer appended a seed underneath a stream that was really there. Measured, with a valid seed against a real stream whose reads were failing while its writes worked: `{status: 'installed'}` returned, two segments where there had been one, and the cursor's `lastToBlock` moved backwards from 600 to 200 while `startBlock` stayed at 500. Silent, permanent, and re-folded by every later generation.

**If you implement `ExistingStream`:** stop wrapping yourself in `degradingStream` (it no longer exists) and let your substrate errors propagate. The write side is unchanged and always raised.

**If you consume it:** `IndexerGeneration` catches and re-indexes exactly as before, so an app sees no difference. `installStreamSeed` gains one refusal reason, `subtree-unreadable`, deliberately distinct from `subtree-not-empty` -- one says "there is a stream here", the other says "I cannot tell whether there is". It writes nothing and clears nothing, and is usually transient.

Done now rather than later because nothing is published yet: two implementations and four call sites, all in this repository. After the publish task lands it is a breaking change to a seam with implementors outside our control.
