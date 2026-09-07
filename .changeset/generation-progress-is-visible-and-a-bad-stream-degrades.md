---
'@etherfold/core': minor
'@etherfold/browser': minor
---

A non-canonical generation REPORTS ITS PROGRESS, and a generation whose stream is unusable DEGRADES to a full re-index rather than breaking.

**`SyncingState.nonCanonicalGenerations` (`@etherfold/browser`)** — every generation this indexer holds that is not answering reads, each with `{record, follows, lastToBlock, blocksBehind}`. It is the FACT and the DISTANCE and deliberately nothing else: only the developer knows whether their reconfigure made the old answers WRONG or merely INCOMPLETE, so the app decides whether to render, dim or hide and this library picks none of them. Do not add a `shouldRender`, a `stale` flag or a percentage here — a percentage needs a span to divide by, and which span is a presentation decision the two reported cursors already support.

- `lastToBlock` is `undefined` before a generation has loaded, which is a different claim from being level at block 0.
- `blocksBehind` is floored at zero, so a generation AHEAD of the canonical one (which `manual` allows) reads as "not behind" rather than as a negative number.
- A generation LEAVES the list the moment the canonical pointer names it, and the generation the pointer moved OFF enters it — it is retained, which is what makes moving the pointer BACK a revert, and "a generation you could revert to exists" is the same fact reported the same way.

**`HeldGeneration.lastSync` (`@etherfold/core`)** — how far ONE held generation's fold has got, or nothing before it has loaded. A getter, like `pauseState`, so a caller holding the object watches a distance close instead of reading the value it had when the object was built. The container already kept every generation's cursor (the promotion trigger is a comparison between two of them); this exposes it rather than recording it twice.

**`saveNewEvents` deliberately raises THROUGH, and that asymmetry must not be "fixed".** Its call site is the one that catches (`IndexerGeneration.promiseToSave`): it counts the failure, paces the retry, freezes the cache after too many — and until then it does not process the batch at all. A swallowed write failure would report success there, so the state would advance past events the stream never received, leaving a HOLE that no later check can see and no reload repairs. A failure is swallowed exactly where nobody is listening for it, and reported exactly where somebody acts on it.
