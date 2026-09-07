# A keeper REPORTS what it found, and the CALLER repairs it

`ExistingStream.fetchFrom` returns a VERDICT (`StreamRead`: `stream` / `absent` / `inconsistent` / `does-not-reach-back`) instead of `{lastSync, eventStream} | undefined`, and it no longer CLEARS anything. The repair it used to perform moved to `IndexerGeneration.readStoredStream`, which clears and re-indexes exactly as before. This is ADR-0068's principle applied one level further: that one moved the policy for a read that FAILED, this one moves the policy for a read that found something WRONG.

## The problem: one nullable, five meanings, two opposite contracts

`undefined` meant all of: nothing is stored; segments with no cursor record, just destroyed; a gap in the ordinals, just destroyed; a segment that does not parse, just destroyed; a cursor whose segment count is wrong, just destroyed; and a perfectly good stream that starts above the block asked for, also just destroyed. On the SQL reader (`storedEmissionStream`) the same value meant those shapes reported with **nothing deleted at all**. Two implementations of one seam, the same return, opposite contracts.

A caller could not tell "there is nothing here" from "there was something here and it is gone now", and three separate defects came out of that:

- **A follower could delete its writer's stream.** `readOnlyStream` no-ops `clear` precisely so a follower cannot damage the stream the indexing generation owns, but the clear was happening INSIDE `fetchFrom`, beneath the view. A snapshot-seeded generation keeps a stream starting at block N; give it a follower and the follower's first `load()` asks from `defaultFromBlock`, hits `startBlock > fromBlock`, and wipes the writer's history. Recorded since 2026-09-06 and fixed here.
- **The seed installer had to probe from `Number.MAX_SAFE_INTEGER`** purely to stay out of that branch, because asking the natural question (from the capture's own coverage start) destroyed the stream it was only asking about.
- **Damage and emptiness were the same answer to an installer.** That one was masked: the keeper destroyed the damage before answering, so the install proceeded into a subtree the keeper had just emptied on its own initiative. Correct by accident, and only while the repair stayed in the read.

## What each caller does now

- **`IndexerGeneration`** clears and re-indexes on every non-`stream` verdict, logging the keeper's own reason. Behaviour is unchanged, deliberately: the intricate load-path branching below `readStoredStream` was not touched, because that helper still hands it the `| undefined` shape it has always branched on. What changed is WHO decided.
- **A FOLLOWER** reaches the same code through `readOnlyStream`, whose `clear` is a no-op, so the repair runs into it and the writer's stream survives. The guarantee ADR-0044 documented is now actually delivered.
- **`installStreamSeed`** treats only `absent` as permission to write. Damage is refused rather than silently repaired-then-installed-over, which is what ADR-0067's "install only into an EMPTY subtree, and a caller that wants to replace one CLEARS it deliberately" always meant.
- **`storedEmissionStream`** reports the same verdicts and, as before, deletes nothing. The two implementations of this seam finally agree about what a read may do.

## Why `does-not-reach-back` is its own verdict

Nothing is wrong with such a stream. It is a legitimate history that opens above the block this caller asked from, and a caller asking from higher up would be served it. Folding it into `inconsistent` would have re-created, one level down, the conflation this ADR exists to remove.

## Cost

A breaking change to a seam third parties implement, done now for the same reason as ADR-0068: two implementations and a handful of call sites, all in this repository, and nothing published. After `publish-etherfold-and-deprecate-old-names` lands it stops being a refactor.

The mechanical cost fell almost entirely on tests, which is the honest signal that the production change was small: a `streamOf` narrowing helper in each test world, and a set of assertions that now name the verdict they always meant. Several of those assertions got sharper as a result -- the damage cases assert BOTH the verdict and that the rows survive, where they used to assert only that the subtree had been emptied.

## What this does NOT change

The write side. `saveNewEvents` still raises through to `promiseToSave`, which counts, paces, freezes and does not process the batch until it succeeds; a swallowed write failure would let the state advance past events the stream never received, which is a HOLE. And the REPAIR itself is unchanged in substance: an inconsistent stream is still cleared and rebuilt rather than repaired, because repairing it would cost more machinery than the re-index it saves.
