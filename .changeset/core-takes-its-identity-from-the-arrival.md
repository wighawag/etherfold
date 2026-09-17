---
'@etherfold/core': minor
---

**`@etherfold/core` takes a fold's identity from the ARRIVAL that produced it, instead of asking the processor what it is called** (ADR-0086).

A processor's identity has always been author-declared: `getVersionHash()` is the `version` field plus the entity and config declarations, and the core discards persisted state when it changes. An author who edited a handler and forgot to bump `version` got state computed by the previous logic, served for ever and silently. ADR-0086's invariant removes the possibility rather than reporting it: an author cannot STATE their processor's identity, so the engine is HANDED one, derived from what the processor IS -- the SHA-256 of a self-contained bundle's octets where a deployment read one off disk -- and never asks where it came from.

Every place this package needed the fold half of a generation now reads the identity it was handed:

- `GenerationSpec.processorIdentity` (and therefore `ReceivedGenerationSpec`), which is what both containers register the generation under;
- `IndexerGenerationOptions.processorIdentity`, a fifth constructor argument on `IndexerGeneration`, plus `processorIdentity` on `updateProcessor`'s options, so a swap compares the identity of what arrived against the identity of what is running;
- `StreamBuilderOptions.processorIdentity` and `GenerationRebuildOptions.processorIdentity`, so the two engine shapes a fold can be in (ADR-0044) name it the same way;
- `IndexerOptions.createGeneration` gains a fifth parameter carrying the resolved identity, so an injected factory cannot build an engine that answers to a different name than the registry recorded. An existing four-parameter factory still compiles.

**Nothing is removed and no caller has to move yet.** Every one of these is OPTIONAL, and absent means the identity falls back to the processor's own `getVersionHash()` exactly as it always did -- so `version`, `getVersionHash()`, `getCodeFingerprint()` and the `PROCESSOR DRIFT` report all still exist and still work. This is one MIGRATE batch of an expand -> migrate -> contract sequence (`work/protocol/TASKING-PROTOCOL.md` 3a); the later contract step is what deletes the declared path, once every package has moved.

The engine still COMPARES an identity and RENDERS it and never parses one, which is exactly what lets two derivations coexist while that migration runs.

One user-visible message changed: `updateProcessor`'s "the swap was skipped" warning no longer tells an author to bump a version hash when the identity came from an arrival, because an author who cannot declare an identity cannot bump one. It branches on whether an arrival supplied a value, never on the value itself.
