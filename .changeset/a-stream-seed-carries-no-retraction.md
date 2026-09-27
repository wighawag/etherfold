---
'@etherfold/core': minor
---

`@etherfold/core`: `installStreamSeed` now refuses as `incoherent` any stream seed carrying a retraction (`removed: true`), whatever producer it declares. A `stored-stream` seed used to be allowed a matched apply/retract pair; that allowance was unreachable in practice (the reorg that produces a retraction also puts two block hashes at one height, which the same check refuses), and the only `stored-stream` producer (`publish --seed`) compacts every matched pair away, so a seed is always the compacted final chain (ADR-0065, as amended). The ordering and duplicate rules now apply to every event, and `StreamSeedProducer.kind` is provenance only. A seed that installed before because it carried a matched pair is now refused.
