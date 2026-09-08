---
'@etherfold/core': minor
'@etherfold/server': minor
---

**`ReplaySource.readChunk` returns a VERDICT, and `RebuildReport` says WHY a chunk stopped** (ADR-0070). This finishes ADR-0069, which corrected `ExistingStream.fetchFrom` and missed its bounded sibling reading the same `_emissions` rows.

```ts
type ReplayRead<ABI> =
	| ({status: 'chunk'} & ReplayChunk<ABI>)
	| {status: 'absent'}
	| {status: 'does-not-reach-back'; startBlock: number}
	| {status: 'inconsistent'; reason: string};
```

`readChunk` returned `undefined` both for "nothing has ever been stored here" and for "a perfectly good stream that starts ABOVE where this fold resumes". The first is transient -- the writer may append. The second recurs on every call for ever, because the resume point comes from the fold's own durable checkpoint, and a **seeded** stream is the shape that produces it. Collapsed, a host could only keep polling: `origin.level` stayed false, so the follower never inherited a vacant write duty and never promoted, while burning a scheduled invocation per cycle and reporting it as an ordinary "not finished yet".

`RebuildReport.absent` is **replaced** by `stopped: RebuildStop` (`stream-consumed` / `budget` / `nothing-stored` / `does-not-reach-back` / `undecodable` / `inconsistent`). `complete` now answers one question, as `PruneReport.complete` does. Three stop reasons cannot be fixed by retrying, and **`retryCanAdvance(stopped)`** is the exported derivation that says which -- previously the only discriminator was an undocumented `toBlock === undefined && !absent`.

**If you implement `ReplaySource`:** return the verdict. `inconsistent` has no in-repo producer and exists so a third-party store has somewhere to report damage.

**If you schedule `rebuildMore`:** loop on `retryCanAdvance(report.stopped)`, not on `complete === false` alone. The latter spins for ever on three of the six reasons.
