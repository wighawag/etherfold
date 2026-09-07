---
'@etherfold/core': minor
'@etherfold/browser': minor
'@etherfold/server': minor
---

**`ExistingStream.fetchFrom` returns a VERDICT and no longer CLEARS anything** (ADR-0069).

It was `Promise<{lastSync, eventStream} | undefined>`. It is now `Promise<StreamRead>`:

```ts
type StreamRead =
	| {status: 'stream'; lastSync: StoredLastSync; eventStream: StoredLogEvent[]}
	| {status: 'absent'}
	| {status: 'inconsistent'; reason: string}
	| {status: 'does-not-reach-back'; startBlock: number};
```

That `undefined` carried five meanings, four of which the keeper had just DESTROYED the subtree over, while the SQL reader used the same value for the same shapes having deleted nothing. Two implementations of one seam, opposite contracts, one return value. Three defects came out of it, and all three close here:

- **A follower could delete its writer's stream.** `readOnlyStream` no-ops `clear` so a follower cannot damage the stream the indexing generation owns, but the clear happened inside `fetchFrom`, beneath the view. A snapshot-seeded generation keeps a stream starting at block N; its follower asks from the source's start block, hits `startBlock > fromBlock`, and wiped the writer's history. The guarantee ADR-0044 documented is now actually delivered.
- **`installStreamSeed` had to probe from `Number.MAX_SAFE_INTEGER`** purely to avoid that branch. The probe is no longer destructive at any block.
- **Damage and emptiness were the same answer to an installer**, masked only because the keeper destroyed the damage first. Damage is now refused rather than repaired-then-installed-over.

**If you implement `ExistingStream`:** return the verdict, and stop clearing on a read. Report `inconsistent` with a reason and let the caller decide; the caller that wants a repair calls `clear` itself.

**If you consume it:** narrow on `status`. `IndexerGeneration` is unchanged in behaviour -- it clears and re-indexes on every non-`stream` verdict, exactly as it did when the keeper did it for it -- so an app sees no difference.

The write side is untouched: `saveNewEvents` still raises through to the caller that counts, paces and freezes, because a swallowed write failure would leave a HOLE.
