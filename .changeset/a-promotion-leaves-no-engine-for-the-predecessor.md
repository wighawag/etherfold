---
'@etherfold/core': minor
'etherfold': patch
---

**A promotion leaves NO live engine for the generation it superseded, however that generation arrived** (ADR-0092's third amendment).

On a `ReceivingIndexer` given `instantiateGeneration` (the CLI's `run`, `build`, `index` and `node`), a promotion now stops folding the generation it moved the pointer off, whether this process instantiated it from stored bytes, built it from an upload, or was opened with it. It is RETAINED: registered, with its state and its stored bundle, and named by `predecessor`. A revert onto it instantiates it again from that bundle and it folds again. So within one `node` session, upload v1, upload v2, promote: v1 is `predecessor` and nothing in the process folds it (the admin listing reports it `instantiable`, and `/status` lists the canonical generation alone).

What does NOT change:

- **A host with no `instantiateGeneration`** (the server package's hosts, an embedder that injects none) keeps folding the superseded generation, because there a revert could not rebuild it. The same holds for a generation with no stored bundle.
- **A push-fed host keeps folding a generation superseded by a promotion onto ANOTHER stream**, so that stream still accepts the pushes another process sends (ADR-0087's amendment). On the SAME stream it stops, since the new canonical fold keeps that stream's writer live.
- `dropOnPromotion` still deletes instead; a revert still stops folding what it moved away from; an arrival of the predecessor still re-arms it as successor.

`etherfold` carries a comment change only; the behaviour arrives through `@etherfold/core`.
