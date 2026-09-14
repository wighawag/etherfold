---
'@etherfold/core': patch
'@etherfold/browser': patch
'@etherfold/server': patch
---

**A replay never asks below the block its source starts at.** `getFromBlock` is floored at `defaultFromBlock` on BOTH of its branches; it used to be floored at `0` on the one that matters.

The read start for a fold is the lower of "carry on from where I stopped" (`lastToBlock + 1`) and "the bottom of the unconfirmed window" (`latestBlock - finality`). Both terms are wanted: the second deliberately pulls the start BACKWARDS by the finality depth when a fold is level, because anything inside that window can still reorg and must be re-read rather than trusted. The defect was the floor under them.

A stored stream begins where its first batch was accepted from. So while a fold sat within `finality` blocks of that, the replay asked for blocks BELOW the stream, the keeper honestly answered `does-not-reach-back` (ADR-0069), and the caller made no progress:

- an indexing generation reading its OWN cached stream cleared it and re-indexed, which is self-healing and merely wasteful;
- a **follower** and `rebuildMore` could do neither. Their `clear` is a no-op by design (ADR-0044) so they cannot repair, and their `latestBlock` comes from the read that was just refused, so the chain moving on never changed the comparison either. It recurred identically on every call, for ever, and `retryCanAdvance` correctly reported a condition needing a human for a stream with nothing whatever wrong with it.

Both fixtures that carried a deliberate lead to dodge this (`@etherfold/browser` and `@etherfold/server`'s state-moved transports) now run level with their own start block, which is what keeps the fix asserted from outside core.

**What this changes for a caller:** `does-not-reach-back` -- on `StreamRead` and on `ReplayRead`/`RebuildStop` -- now means ONE thing, so the verdict alone tells "wait" from "intervene". `absent`/`nothing-stored` is the writer not having appended yet and a retry is right; `does-not-reach-back` is a stored stream that cannot serve this source at all (a subtree whose first save began mid-history, or a seed installed from above where this client asks), and no poll fixes it. A fold level with its own stream's start block no longer produces either: it is served.

**What it does NOT change:** the unconfirmed-window property. Clamping UP cannot skip a block, because there is no block below the floor to skip -- `defaultFromBlockOf` is the lowest `startBlock` any contract in the source declares, and every block the window can hold was fetched from at or above it. A level fold still re-reads every block a reorg can reach, asserted in `packages/core/test/utils.test.ts`.

The floor is the SOURCE's earliest block and deliberately not the STREAM's own start: `getFromBlock` is computed on both halves of the wire from the source alone (`StreamBuilder.expectedFromBlock`, and `generateStreamToAppend`'s `UnexpectedFromBlockError`, which is ADR-0004's resumption protocol), and the side holding no keeper cannot know where a stored stream begins.
