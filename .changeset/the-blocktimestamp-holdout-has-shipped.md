---
'@etherfold/core': patch
'@etherfold/processor-entities': patch
---

**The `blockTimestamp` holdout has shipped, so four places stop naming it as open.** Documentation and one error message only: nothing is deleted, no flag is removed, no behaviour changes.

`blockTimestamp` on the log (`ethereum/execution-apis#639`) was served by geth, reth, besu, erigon, anvil and ethereumjs, and the README, ADR-0002, `blockPointer`'s refusal and the `blockTimestamp?` docstring all named Hardhat's EDR as the one implementation that did not. It does now: `NomicFoundation/edr#1644` merged 2026-08-26 and released in `@nomicfoundation/edr@0.20.0` on 2026-09-02.

Hardhat has not bumped to it (3.16.0 still bundles edr 0.19.0), but that is not a wait: EDR is an ordinary dependency, so a project can pull it forward with a package-manager override (`pnpm.overrides`, npm `overrides`, yarn `resolutions`). The requirement is therefore on the EDR version resolved, never on the Hardhat version, and the docs now say so.

`stream.alwaysFetchTimestamps` STAYS, because two cases survive any version bump and neither improves with time: a node being FORKED that predates the spec change keeps the field absent rather than defaulting it (EDR's `Option<u64>` is deliberate, so a missing timestamp stays distinguishable from a real one), and EDR's on-disk RPC response cache replays such an absence once it has recorded one, until `rpc_cache` is dropped. (Not, as an earlier draft of this entry said, because pre-change cache entries keep answering: `@nomicfoundation/edr@0.20.0` moved the cache to `rpc_cache/v2` and ignores the rest. Same conclusion, corrected mechanism.)

`blockPointer`'s refusal now names the likely CAUSE rather than only the missing field, so an operator can act on it: an old node, a Hardhat bundling an older EDR (with the override as the fix), a forked node predating the change, or a stale EDR RPC cache.

Whether the fallback is eventually DELETED is not decided here. That is argued in `work/specs/proposed/etherfold-is-a-fold-over-logs.md`.
