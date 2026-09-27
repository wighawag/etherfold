---
'@etherfold/core': minor
'@etherfold/server': minor
'etherfold': minor
---

`etherfold publish --seed` also writes the stream seed of the stream the canonical generation folds, keyed by stream (ADR-0095).

`@etherfold/core`: the coverage claim a fold writes beside its stored stream (`StreamCoverage.source`, written by `StreamWriter` and `StreamBuilder`) now carries the stream's FULL source identity, the per-event source hash entries `sourceHashesOf` answers (each with its `streamHash`), instead of the 32-bit whole-source wire context. `streamDigestOfSourceHashes(coverage.source, config)` is therefore the very stream digest the claim is filed under, which is what lets a stream seed be built from the database alone. No migration: a database folded before this records only the wire context, and `publish --seed` refuses it by name.

`@etherfold/server`: `producePublication(db, {seed: true})` also produces a stream seed in core's envelope (`StreamSeed`): the stored stream (`_emissions`) read back through `storedEmissionReplaySource` in bounded reads (`seedReadBudget`, default 10,000), from the stream's start block up to the SAME cut as the state snapshot, stripped by `storedStreamOf` and COMPACTED (every matched apply/retract pair dropped, ADR-0006), so it carries exactly the final chain, installs under core's unchanged coherence check, and two producers of one chain and cut publish the same bytes. Its source identity is the one the coverage claim records, and its digest is asserted to be the canonical generation's stream. The body is gzipped under `streamSeedBodyName(contentHash)`, it is reported on `ProducedPublication.seed` (`ProducedStreamSeed`), and the index gains a `seeds` map keyed by stream digest (`PublishedStreamSeed`), which `mergePublicationIndex` merges replacing only its own stream's entry and `parsePublicationIndex` refuses when it is not a map. A seed is refused as `no-stored-stream` when nothing stored reaches the cut, and as `no-stream-identity` when the database records no full source identity or one that does not digest to the generation's stream.

`etherfold`: `etherfold publish --seed` writes the seed beside the snapshot and prints its body, stream digest, coverage, event count and the content hash a release pins (`pinnedStreamSeedContentHash`, the install's `expectedContentHash`). Without `--seed` nothing about the stream is written. Every other command refuses the flag by name.
