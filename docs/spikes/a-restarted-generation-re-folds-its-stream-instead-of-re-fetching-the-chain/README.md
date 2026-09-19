# The narrow fix, built and measured: a restarted deployment re-folds its stream and then stops indexing

The task `a-restarted-generation-re-folds-its-stream-instead-of-re-fetching-the-chain` was BUILT, measured, and STOPPED. This folder is the evidence, so whoever picks it up does not pay for the measurement twice.

`the-narrow-fix-and-its-measurement.patch` is the whole change, applied against `04033103` (the tree with `run-and-build-drive-the-folds-they-hold-rather-than-one-captured-receiver` landed). Apply it with `git apply`. It holds three things: the registry-derived `follows` / `writesStream` in `ReceivingIndexer.add` (with `replaceTheSuccessor` split into a pure plan and a performing half so the derivation can read the records as they will STAND and the refusal can still leave the registry untouched), the `streamCanReceive` half-change, and the two test suites that measure it.

## What the change DOES deliver

With the patch applied, `pnpm --filter @etherfold/core test` is green (1196 passed) and the end-to-end measurement in `packages/cli/test/aRestartReFoldsTheStoredStream.test.ts` passes: a `run` stood up over a real libSQL handle, stopped, and re-run with an edited bundle re-folds the stored emission stream to the same tip its predecessor reached, and asks the node for **not one** `eth_getLogs` range at or below that tip. Before the change those ranges began at the source's `startBlock`. The derivation is one `writerOf` reading with two complementary halves, and a refused fold leaves no registry row and drops none either.

## The measurement that stopped it

The same test records every method the restarted deployment asked the node for. It is:

```
["eth_chainId"]
```

Zero `eth_getLogs`, and zero `eth_blockNumber`. The restarted deployment re-folds the stored stream, is promoted, serves reads, reports healthy -- and never fetches a block again, for ever.

The mechanism is exact. A restart registers the successor BESIDE the incumbent, so `writerOf` still names the incumbent, which is registered and not HELD. `ReceivingIndexer.reconcileWriters` hands the wire only to the fold `writerOf` names, so `shouldWrite` is already `false`, equals `fold.writesStream`, and the loop `continue`s. That is the same no-op ADR-0087's own section "The defect that forced it" identifies. A follower has no receiver, `liveIngestions()` is therefore empty, and the fetch side has nowhere to push.

So the claim ADR-0087 makes for this option -- that the restarted generation "lands on the coverage, and is handed the wire by machinery that already exists" -- is false against the tree, and it is contradicted three paragraphs earlier in the same document.

On `build` (`stopAtTip`) it is worse than a stall: `driveCycles` classifies `NoLiveReceiverError` as `nothingToFeed` and re-throws it BEFORE the exit `rebuildMore`, so a re-run `build` with changed bytes fails outright without folding anything.

## The second finding: `streamCanReceive`'s unknown case is two different facts

ADR-0087 asks for `streamCanReceive()` to refuse when the stream position is unknown, quoting `if (this.streamLastToBlock === undefined || !this.lastSync) return true`. The two halves were separated and measured; they do not get the same answer.

- **`!this.lastSync` refuses**, and that is inert: `promiseToIndex` loads before it fetches and `load` sets `lastSync` on every branch it returns through, so nothing reaches it. The patch makes this change.
- **`streamLastToBlock === undefined` must stay permissive.** It is not an unknown position, it is the documented absence of a stream (`forgetStoredStream`: "there is no stream on disk any more, so nothing constrains the next write"). Refusing there declines the first save of every fresh deployment, and it also breaks the case `packages/core/test/streamSeedInstall.test.ts` protects by name (`locallyIndexedAbove`): a stream lost while its STATE survived is re-opened by the next save at the state's resume point, and the new subtree RECORDS that resume point as its own `startBlock`, so a read from below it is answered `does-not-reach-back` rather than served. That is an honest partial stream, not a hole. Refusing left it never written and that suite red in two cases.

And the duplicate the ADR attributes to this method was never on this path: the hand-over it measured writes through `StreamBuilder.storeStream` over an `EmissionAppender`, which is append-only, reads nothing back and has no hole guard at all, while `streamCanReceive` is `IndexerGeneration`'s, over an `ExistingStream` that `load` always reads first. The hazard is real; it is in the other method.

## The third finding: it is eleven tests across two packages, not five

The task body names five `packages/core/test/receivingContainer.test.ts` cases that encode today's behaviour. There are eleven, and the extra six are the ones the blocker's own commit added or left:

| where | cases | why |
| --- | --- | --- |
| `packages/core/test/receivingContainer.test.ts` | 5 | a second container over the same registry expected a receiver. All five re-scoped in the patch: four now supply both ends of the stream and assert the follower path, and the cap pair keeps testing the cap by becoming legitimate followers first. |
| `packages/cli/test/aChangedContextCreatesASuccessor.test.ts` | 6 | its hand-rolled container supplies `appendEmissions` and no `replay`, so every successor now meets the follower refusal. Needs the read end supplied AND decodable stored emissions: its `transferEvent` fixture writes `topics: []`, which no replay can `reparse`. |
| `packages/cli/test/aRerunBuildSettlesItsPointer.test.ts` | 3 | `build` throws `NoLiveReceiverError`. Not repairable inside this task's fence. |
| `packages/cli/test/aSuccessorLandsInADurableSlot.test.ts` | 1 | `maxStreams` is reached where it was not before. |
| `packages/cli/test/anIndexProcessAdvancesItsSuccessor.test.ts` | 1 | the case that deliberately disables the rebuild schedule and relies on the WIRE to advance the restarted successor, which is the behaviour this change deletes. |
