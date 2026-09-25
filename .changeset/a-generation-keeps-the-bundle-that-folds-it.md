---
'@etherfold/core': minor
'@etherfold/server': minor
'@etherfold/browser': minor
'@etherfold/utils': minor
'etherfold': minor
---

**A Node deployment now KEEPS the bundle that folds each generation it registers, beside that generation's state, and deletes it with the generation** (ADR-0092, the storage half).

Nothing reads the bytes back into a processor yet: that is the next step. What this makes true is that the code is durably present, is exactly the octets whose hash is the generation's identity (ADR-0086), and is bounded by the registered generations.

`@etherfold/core`:

- `GenerationRegistry.create(id, {slot, bundle})` stores `bundle` with the record in the SAME commit, and `GenerationRegistry.bundleOf(id)` reads it back. A registration that RESOLVES an existing generation writes no bytes.
- `GenerationRegistryWrite.bundle` carries the bytes of `put`, and a `remove` takes EVERYTHING a substrate keeps under the identity, bundle included. So every deletion (`deleteGeneration`, which a reclaim, a replaced successor and a drop on promotion all reach, and `deleteStream`) takes the code by taking the row, with no second deletion path.
- `GenerationRegistryPort.readBundle(id)` is a new REQUIRED port operation. The memory substrate keeps the bytes in the same entry as the record.
- `ReceivedGenerationSpec.bundle` is REQUIRED, and `ReceivingIndexer.add` refuses a fold with none before anything is built or registered. Optional bundling would make two invisible classes of generation, resumable and frozen.
- `ReceivingIndexer.resolveGeneration` now RESOLVES only, and refuses an identity it has not registered (`UnknownGenerationError`). It used to register one, which was a second registration route with no bytes to store.

`@etherfold/server`: `_generations` gains a nullable `bundle BLOB` column, written by the same guarded `INSERT` as the row and removed by the same `DELETE`. `generationRegistryPortOnSQL` implements `readBundle`. The schema version is unchanged: nothing is published, so no existing database has to be told.

`@etherfold/browser`: the IndexedDB registry port stores NO bundle, because a tab retains no code (ADR-0089). `readBundle` answers `undefined`, and a registration carrying a bundle is REFUSED rather than stored or silently dropped.

`@etherfold/utils`: `ProcessorArrival.bundle` carries the octets a bundle arrival read and hashed, present exactly where `identity` is, so the bytes stored are the bytes that were named rather than a second read of the path.

`etherfold`: the folding wiring hands the container the arrival's bytes with its identity (`requireArrivedBundle`, `ArrivedBundle`). The test seam `IndexingDependencies.processorIdentity` / `IndexDependencies.processorIdentity` is REPLACED by `processorBundle: Uint8Array`: a substituted arrival states the BYTES it stands for, its identity is derived from them and they are stored like any bundle's. A bare name with no bytes behind it can no longer register a Node generation.
