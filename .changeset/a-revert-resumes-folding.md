---
'@etherfold/core': minor
'@etherfold/server': minor
'etherfold': minor
---

**A revert on a Node deployment now RESUMES folding** (ADR-0092). Moving the canonical pointer onto a generation this process holds no fold for (the ordinary revert, on a process redeployed with the new processor alone) instantiates that generation from the bundle stored on its registry row, and it advances again instead of answering reads frozen at a known-good point.

`@etherfold/core`:

- `ReceivingIndexerOptions.instantiateGeneration(id, bundle)` is the host's way of turning stored bytes into a fold, injected because the loader lives in `@etherfold/utils`. It returns what `add` is handed, minus the bundle. The container calls it at a POINTER MOVE onto a generation it does not fold, and never at `open`. The identity it returns is checked against the generation's.
- `GenerationInstantiationError`: an instantiation that fails because the stored CODE is broken (no stored bundle, the host refused the bytes, they hash to another identity, or the fold's factories throw) REFUSES the move. The pointer stays where it was and the generation that answered reads still folds.
- A target on a stream this container does not fetch (a revert across a filter change) is NOT refused: the pointer moves, nothing folds it, and an error is logged saying it answers reads and does not advance. The generation moved away from keeps folding, so the fetched stream keeps a fold. This is the freeze a filter change always was.
- The generation moved away from by a move that is not a promotion (a revert) stops being folded by this process once the new canonical generation is folded here. It stays registered, keeps its state and its bundle, and a move back onto it instantiates it again.
- A container given no `instantiateGeneration` still moves the pointer onto a generation it cannot fold, and now logs an error saying nothing folds what answers reads.

`@etherfold/server`: `POST /{indexer}/admin/canonical-generation` answers `409 generation-cannot-fold` when the target cannot be instantiated, naming why, with the deployment unchanged.

`etherfold`: every folding command supplies `instantiateGeneration`, loading the stored bytes with `loadProcessorArtifact` and assembling the fold with the same `foldPartsFor` a `--processor` bundle goes through, so the resumed generation folds into the namespace it answered reads from.
