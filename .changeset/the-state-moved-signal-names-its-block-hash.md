---
'@etherfold/core': minor
'@etherfold/processor-entities': minor
'@etherfold/state-moved-conformance': minor
'@etherfold/server': patch
---

The state-moved signal's `applied` notification names the HASH of the block it applied, on every transport (ADR-0083, amended 2026-09-30).

- `@etherfold/core`: `StateApplied` (the `'applied'` case of `StateMoved`) gains `hash: string`, beside `block`: `{kind: 'applied', block, hash, coherence, entities, generation}`. `'retracted'` and `'repointed'` are unchanged. The fold report that feeds it, `AppliedBlock`, gains `hash` too, and both containers relay it untouched from the one assembly they publish from. It is the hash the store recorded, so it equals the `extensions.blockHash` a GraphQL answer names while that block is the tip, and a reader pins its re-read to exactly the block it was told about with `block: {hash}`. A custom `EventProcessor` that implements `setFoldReporter` must now report `hash` on an applied block.
- `@etherfold/processor-entities`: the fold reports each applied block's hash, normalised to the store's spelling (lower case, `normalizeBlockHash`) here, since core cannot import the storage seam (ADR-0016).
- `@etherfold/state-moved-conformance`: an applied notification's exact key set now includes `hash`, and a transport adapter supplies a new required verb, `recordedHashAt(block)`, the hash the store behind the canonical fold recorded. The suite asserts the notification's hash equals it, and that a block that replaced another at the same height is named by a different hash. That case relies on `retract()` REPLACING the block it takes back (a different block at `forkPoint + 1`, under a different hash), which is now stated on the verb; an adapter whose retraction only withdraws must serve a replacement.
- `@etherfold/server`: documentation only; `/{indexer}/state-moved` carries the new field unchanged.
