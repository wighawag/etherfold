---
'etherfold': minor
'@etherfold/core': minor
---

**An uploaded processor survives a restart, including one still catching up** (ADR-0092's, ADR-0084's and ADR-0093's amendments of 2026-09-26). An upload is now a deployment and not a session.

- **The pending successor folds from `open`.** `ReceivingIndexer.open` instantiates the generation `successor` names from its stored bundle when the process holds no fold for it, through the same `instantiateGeneration` seam the canonical generation and a revert use. The policy then speaks about it as it does about any added fold: under `on-catch-up` it is promoted once it has caught up, and the incumbent's instantiated fold stops. This runs after the configured fold is added and after the canonical generation. `predecessor` is still not instantiated at open.
- **A START may not silently replace a different pending successor.** New `ReceivingIndexerOptions.confirmReplacingSuccessorAtStart` (and the `SuccessorReplacementAtStart` type) is asked from `open` alone, before anything is registered, where the configured fold would replace a DIFFERENT generation `successor` names. Throwing refuses the start with the registry untouched. `add` (a re-read, an upload) is never asked.
- **`--override` on every start with a configured processor: `etherfold run`, `build` and `index`.** A start that would replace a different pending successor asks at a terminal, naming both generations, and is otherwise REFUSED by name unless `--override` is given. All three open the same container over the same slots, so a re-run `build -p X` or an `index -p X` against a database holding an upload still catching up no longer deletes it silently. A pipeline that redeploys per commit while the previous successor is still catching up now passes `--override` once. `fetch`, `serve` and `upload` refuse the flag. A `-p` naming the canonical processor or the pending successor changes nothing.

ADR-0085's `accepted, not yet implemented` status is removed: the upload chain is complete.
