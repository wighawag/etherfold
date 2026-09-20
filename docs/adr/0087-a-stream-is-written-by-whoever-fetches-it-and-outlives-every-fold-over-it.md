# A stream is written by whoever FETCHES it, never by a GENERATION, and it OUTLIVES every fold over it

**The invariant is that a stored stream has one writer and that writer is the thing FETCHING it, not one of the folds reading it.** A generation is a stream plus a fold over it (ADR-0044); today it is also, for exactly one generation per stream, the thing that APPENDS. That third role is an accident of where the code puts the call, and it is the root of a measured data-loss defect. We propose to separate it: the deployment fetches a stream and appends to it, every generation reads it, and no generation is ever the writer. And because the stream is then nobody's property, we propose the second half plainly: **a stream is never deleted because the last fold over it went away.**

> **Amended 2026-09-20, when the `accepted, not yet implemented` line came off.** This is IMPLEMENTED on the RECEIVING runtime (server and CLI), which is the one the defect below was measured on and the one Consequences names: the election is gone, `writesStream` and `reconcileWriters` with it, one `StreamWriter` per stream is positioned from the stream's own **coverage claim**, and no fold is handed the pen. The CHAIN-FACING `Indexer` (a browser tab) is deliberately NOT restructured, so the headline reads *whoever FETCHES a stream writes it*: there the thing that fetches IS a generation (`IndexerGeneration` opens `load()` with `eth_chainId`), so "which generation fetched this" and "which generation writes it" are ONE fact, and ADR-0044's follower rule is untouched, including the clause that declines dropping a generation whose stream another held fold follows. What registration order answers there is which generation FETCHES, never which NON-FETCHING fold holds the pen, and it is the second of those this ADR retired. The residue is that on that runtime the registered fetcher can still be a generation the tab holds no fold for, which is the shape the receiving side was in; WHETHER a tab reaches it is being MEASURED rather than assumed, and is tasked separately (`the-reloaded-tab-stall-is-measured-on-the-configuration-a-tab-actually-has`, named by slug rather than by path because its folder changes when it lands). Extending this decision to the browser engine, by splitting `IndexerGeneration`'s fetch from its fold, is a restructure nothing has asked for and would be its own decision.

## The defect that forced it

Restart a deployment with a changed processor, over the same database, and **nothing appends to the stored stream** while the new generation folds happily. No refusal, no warning, and the state looks fine (the task `a-restarted-deployment-hands-over-the-write-duty-it-cannot-discharge`, named by slug rather than by path because its folder changes when it lands).

The mechanism is the one-writer rule working exactly as specified, in a shape nobody considered it against. `writerOf` names the OLDEST generation registered on the stream, which is the incumbent. The process holds no fold for the incumbent, because the previous processor's code is not in the build. So the write duty belongs to a generation that is not present to discharge it, and the generation that IS present is correctly refused it. `reconcileWriters` does not repair it: `shouldWrite` is already `false` and matches, so it is a no-op rather than a hand-over.

**The obvious fix is wrong, and that was measured rather than argued.** Handing the duty to the fold that is present stores the history a SECOND time: the restarted successor's state is empty, so it fetches from `defaultFromBlock` and re-appends a range the stream already covers. Measured on the defect's own scenario: `_emissions` holds 4 rows where 2 are correct. That is the duplicate-history failure `ReceivingIndexer.add`'s own JSDoc, ADR-0052 and ADR-0055 forbid, and the same shape ADR-0071 section 1 measured when it rejected ITS candidate rule.

Nor can the hand-over be made safe by timing it. `reconcileWriters` runs once per fetch cycle, so the fold is observed BELOW the stream's coverage and then ABOVE it and never ON it. Handing over below duplicates the overlap; handing over above leaves a HOLE between the coverage and the new writer's first `expectedFromBlock` -- the silent, permanent, self-consistent damage `CONTEXT.md` defines under "hole versus gap". There is no observation point that is neither.

## Why the answer is to move the duty off the generation entirely

Three things make this a smaller change than it sounds, and all three were checked against the code rather than assumed.

**The appender is ALREADY owned by the deployment.** `packages/cli/src/folding.ts` builds it as `server.emissionAppenderFor(db, context.indexer)` -- from the database handle and the indexer NAME, with no generation in it. The container then hands it to at most one fold, gated on a per-generation flag: `...(this.options.appendEmissions && writesStream ? {appendEmissions: ...} : {})` (`receivingContainer.ts`). So the stream is already the deployment's; what exists is a GATE deciding which fold gets to hold the pen, not a per-generation appender.

**The comparison that keeps a stream honest needs only two numbers, and both belong to the writer.** ADR-0038 made the ENGINE the arbiter of whether an append is safe, on the grounds that it "is the only place that holds both numbers". Those numbers are `streamLastToBlock` -- set from the keeper's own stored cursor (`indexer.ts`, `this.streamLastToBlock = lastSyncStored.lastToBlock`) -- and the state's `lastSync.lastToBlock`. Whoever fetches a stream can read the first from the keeper directly, because that is where it comes from today. The arbiter moves WITH the duty rather than needing a new home.

**It STRENGTHENS ADR-0044 rather than bending it.** That ADR rejected a head-following poller decisively, because "the successor's state becomes a function of ITS OWN FETCH rather than of the stream, so re-folding the stored stream later yields a DIFFERENT state: a generation stops being a stream plus a fold over it". Under this proposal NO generation fetches, so every generation's state is a function of the stream BY CONSTRUCTION. The invariant stops needing to be defended and starts being structural.

It is also the same move this codebase has now made twice in a row, with good results: ADR-0084 replaced an inferred, in-memory fact (the candidate set) with a durable one (slots), and `promotion-arms-from-the-slot-so-a-restart-can-finish-an-upgrade` then DELETED the `opened` flag because the slot already carried the fact. "Which generation writes this stream" is the last inferred fact of that shape, and it is inferred from registration ORDER, which is exactly the kind of proxy that breaks when the thing it stands for (is that fold present?) is not what it measures.

## A latent hazard this exposes, which is worth fixing whatever is decided

`streamCanReceive()` reads:

```ts
if (this.streamLastToBlock === undefined || !this.lastSync) return true;
return this.streamLastToBlock >= this.lastSync.lastToBlock;
```

An UNKNOWN stream position defaults to PERMISSIVE. That is safe today only because the pen is held by a fold that has already loaded the stream, so the `undefined` case is unreachable in practice. Any change to who writes makes that default dangerous. It should refuse rather than permit when the position is unknown.

> **Amended 2026-09-19, measured.** The condition above is TWO different facts and only one of them may refuse.
>
> **`!this.lastSync` may refuse**, and doing so is inert: `promiseToIndex` loads before it fetches and `load` sets `lastSync` on every branch it returns through, so nothing reaches it today.
>
> **`this.streamLastToBlock === undefined` must STAY PERMISSIVE.** It is not an unknown position, it is the documented ABSENCE of a stream (`forgetStoredStream`: "there is no stream on disk any more, so nothing constrains the next write"). Refusing there declines the first save of every fresh deployment, and it destroys the case `streamSeedInstall.test.ts` protects by name (`locallyIndexedAbove`): a stream lost while its STATE survived is re-opened by the next save at the state's resume point, and the new subtree RECORDS that resume point as its own `startBlock`, so a read from below it is answered `does-not-reach-back` rather than served. That is an honest partial stream, not a hole; refusing left it never written and that suite red in two cases.
>
> This paragraph also mis-attributed the duplicate. The naive hand-over measured in "The defect that forced it" wrote through `StreamBuilder.storeStream` over an append-only `EmissionAppender`, which reads nothing back and has NO hole guard of any kind. `streamCanReceive` is `IndexerGeneration`'s, over an `ExistingStream` that `load` always reads first, and the duplicate was never on its path. **The hazard is real and it is in the other method**, so guarding it belongs with whoever moves the write duty.

## The second half: a stream outlives every fold over it

Today a stream is reaped "where no registered generation is left folding it", and that reaping rides two paths. One is the operator's `reclaim` verb, which `CONTEXT.md` is careful to call "a VERB an operator RUNS and deliberately NOT a garbage COLLECTOR: nothing fires it on a timer or at `open`, because an automatic reclaim deletes with nobody present". The other is AUTOMATIC: registering into an occupied `successor` slot drops the replaced generation, and its stream with it if nothing else folds it. Save twice in a tab and the second save can delete a stream.

That is backwards, and it is the one place this codebase deletes an expensive thing to reclaim a cheap one. The stream is what CHAIN FETCHES bought; state is derived and can be recomputed from it, while the stream can only be re-fetched from a node that frequently refuses historical ranges. Its entire reason for existing is that a later generation re-folds it locally instead of going back to the chain.

So: **no registered generation folding a stream is not a reason to delete the stream.** It is exactly the state a stream is in between an old fold being dropped and a new one being built, which is the moment its value is highest.

This does not make streams immortal. It makes deletion a VERB, consistent with everything else here: `reclaim` still deletes streams when an operator asks, `deleteStream` keeps its guard, and the caps still REFUSE rather than evict. What goes is the automatic reap on the successor-replacement path.

## Considered options

**Fix the hand-over, keeping the writer a generation** (a durable stand-down mark on the incumbent's record, so `writerOf` stays a pure function of the records and the duty follows what is HELD). Rejected as the primary answer, though it is a sound mechanism: it makes the duty transferable without making it correct, because the newcomer is still BEHIND the stream and the ahead/behind problem above is untouched. It also keeps a role on the generation that does not belong to it, so the next shape nobody considered finds the same class of bug again.

**An elected-writer POINTER on the stream** (a mutable record naming the current writer). Rejected. It turns a derivable fact into a coordinated one: two processes holding different folds can disagree, the pointer can oscillate, and `writerOf` stops being a pure function every reader can evaluate independently. Delete-succession also stops being atomic with the delete. "Whoever fetches it writes it" needs no election at all, which is why it is better than both this and the stand-down mark.

**Make the restarted successor a FOLLOWER, and nothing else** (the narrow fix: `add` derives `follows` from the registry rather than from this process's in-memory fold array, so a restarted generation re-folds the stored stream and lands on the coverage). This is ADR-0044's own rule, currently disobeyed, and it IS the correct behaviour. It is not rejected -- it is a REQUIRED part of this proposal. It is not sufficient alone, because it leaves the writer a generation and therefore leaves the class open.

> **Amended 2026-09-19, measured.** This entry originally said the restarted follower is "handed the wire by machinery that already exists" and that the narrow fix "can land first". **Both are false**, and the first is contradicted three paragraphs earlier in this same document.
>
> `reconcileWriters` hands the wire only to the fold `writerOf` NAMES. A restart registers the successor BESIDE the incumbent, so `writerOf` still names the incumbent, which is registered and not held; `shouldWrite` is already `false`, equals `fold.writesStream`, and the loop `continue`s. That is precisely the no-op "The defect that forced it" identifies above. This ADR credited as machinery the very no-op it condemns.
>
> Built and measured on the defect's own scenario: the restarted deployment re-folds the stored stream correctly and then asks the node for `["eth_chainId"]` and nothing else -- zero `eth_getLogs`, zero `eth_blockNumber` -- for ever. A follower has no receiver, so `liveIngestions()` is empty and the fetch side has nowhere to push. It is promoted, serves reads and reports healthy. Today's behaviour is expensive but LIVE; the narrow fix alone is cheap and DEAD, which is the silent-failure class this ADR exists to close. On `build` it is worse than a stall: `NoLiveReceiverError` is re-thrown before the exit rebuild, so a re-run `build` with changed bytes fails outright without folding anything.
>
> So the narrow fix cannot land first, and it cannot land alone. It REQUIRES the fetch to have moved off the generation's indexing loop -- which is this proposal's own "the append is driven by the FETCH, not by a fold's indexing loop" under Consequences. The two are ONE change and are tasked as one. The patch and the numbers are kept at `docs/spikes/a-restarted-generation-re-folds-its-stream-instead-of-re-fetching-the-chain/`.

**Suppress appends below the stream's coverage** (let the newcomer write and drop what is already stored). Rejected as the design, though `streamRemainderOf` already does something like it per batch. As a POLICY it carries a hazard that belongs in an ADR rather than in a defect fix: a reorg that happened below the coverage while the deployment was down is folded into the successor's STATE but suppressed from the STREAM, so a third generation re-folding that stream derives a different state. Under this proposal it cannot arise, because the fold that folds is never the fold that writes.

## Consequences

**The append is driven by the FETCH, not by a fold's indexing loop.** Today writing is a side effect of a generation advancing (`promiseToSave` calls `saveNewEvents` unconditionally, which ADR-0044 noted as the reason read-only had to be expressed at the seam). This is the real work of the proposal, and it is the part to scope carefully: the split deployment already separates fetching from folding across a wire, so the shape exists, but the combined `run` currently fuses them in one loop.

**`writesStream`, `writerOf`'s role as an ELECTION, and `reconcileWriters` all go.** What replaces them is smaller: a deployment fetches a stream or it does not. `writerOf` may survive as the answer to "who fetched this", but nothing derives a DUTY from registration order any more.

**`run` and `build` must be able to hold a follower as their opening fold.** They cannot today: `packages/cli/src/folding.ts` takes `container.ingestion`, whose getter throws for a follower, and `driveCycles` skips `rebuildMore` under `stopAtTip`, so `build` would fold nothing. This is a restructure of the CLI's fetch assembly and it is the largest single piece of work here.

**A restart with a changed processor stops re-fetching the chain.** Measured today: it re-fetches from the source's `startBlock` even though the stream already holds the history, because `add` decides `follows` from an in-memory array that is empty at `open` (`work/notes/observations/a-restarted-run-refetches-the-whole-chain-instead-of-refolding-the-stored-stream.md`). The same upgrade through the reconfigure endpoint costs a local scan. This proposal makes restart behave like reconfigure, which is the cheaper path and the one the architecture already describes.

**An unknown stream position must REFUSE rather than permit.** See the latent hazard above.

**A stream is kept when nothing folds it, and deleted only when asked.** The automatic reap on successor-replacement is removed; `reclaim` and `deleteStream` are unchanged. The cost is disk held by a stream nobody currently reads, which is the deliberate trade: a stream nobody reads costs storage, and a stream that was deleted costs a re-fetch a public node may refuse outright.

**ADR-0044's writer rule is superseded in part**, on the axis of WHICH thing writes a stream. Its central decision -- that how a successor advances is DETERMINED by its stream and never configured -- is untouched and strengthened. ADR-0071's amendment on the writer's home is superseded on the same axis. ADR-0038's arbiter moves to the writer; its rule is unchanged.

**ADR-0084 is untouched.** Slots say what a generation is FOR; this says who writes a stream. They are different facts about different things, and neither is derived from the other.

> **Amended 2026-09-19 by the build, measured.** Four things this document does not say, each of which the implementation had to decide:
>
> **The sweep on registry OPEN is the third automatic deleter and this ADR names none of it.** `openGenerationRegistry` drops every stream subtree "claimed by no registered generation", and a stream KEPT after its last fold was dropped is, by that rule, exactly an orphan -- so removing the reap alone keeps a stream for the life of the process and loses it at the next restart, silently, in the precise window the keep exists for, with a green gate. What makes a kept stream distinguishable from a PRE-GENERATION ORPHAN is a durable record of its own: the registry now holds a set of stream digests (`keptStreams`, `_generation_streams` on SQL, a `kept` level on IndexedDB), written when a generation is registered on a stream and removed only by an asked-for deletion. The sweep's own stated purpose -- collecting a subtree written before generations existed, which was never recorded -- is untouched.
>
> **`deleteStream` had to widen.** Its refusal was "this indexer holds no generation on that stream", which under the keep would make exactly the streams the keep exists for the ones an operator cannot delete. It now accepts a stream the registry RECORDS with no generation on it; the canonical-generation guard is unchanged.
>
> **The `follows` question dissolves and so does every decline built on it.** With no generation writing a stream there is no duty to strand, so `dropSuperseded` and `replaceTheSuccessor` stop RETAINING a generation "because another held fold follows the stream it writes", and `reclaim` loses its `writes-a-followed-stream` decline. One user-visible consequence, stated rather than discovered: under `dropOnPromotion` the ordinary processor upgrade now really does drop the superseded generation, where the strand clause used to decline it. What the deployment keeps instead is the STREAM, which is the expensive half.
>
> **The replay walk had a latent bug that moving the fetch makes systematic.** `generateStreamFromReplay` de-duplicates a re-offered block by WINDOW MEMBERSHIP, which cannot answer "did this fold already hold it and TAKE IT BACK" -- a retracted block has left the window, so a catch-up reaching back over its own reorg window re-applies the dead branch at a height its replacement occupies. Measured as `UNIQUE constraint failed: _blocks.number`. A block applied and retracted within ONE walk, at or below where the fold has already folded through, is now delivered neither way; a REBUILD from a fresh cursor is untouched and still reproduces the live run's applies and reverts exactly (ADR-0042).
