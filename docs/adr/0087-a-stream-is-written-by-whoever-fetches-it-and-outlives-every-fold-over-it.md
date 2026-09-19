---
status: accepted, not yet implemented
---

# A stream is written by whoever FETCHES it, never by a GENERATION, and it OUTLIVES every fold over it

**The invariant is that a stored stream has one writer and that writer is the thing FETCHING it, not one of the folds reading it.** A generation is a stream plus a fold over it (ADR-0044); today it is also, for exactly one generation per stream, the thing that APPENDS. That third role is an accident of where the code puts the call, and it is the root of a measured data-loss defect. We propose to separate it: the deployment fetches a stream and appends to it, every generation reads it, and no generation is ever the writer. And because the stream is then nobody's property, we propose the second half plainly: **a stream is never deleted because the last fold over it went away.**

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

An UNKNOWN stream position defaults to PERMISSIVE. That is safe today only because the pen is held by a fold that has already loaded the stream, so the `undefined` case is unreachable in practice. It is precisely why the naive hand-over duplicated: the newly-written-to fold never learned the stream's position, took the permissive branch, and `streamRemainderOf` had nothing to strip against. Any change to who writes makes that default dangerous. It should refuse rather than permit when the position is unknown.

## The second half: a stream outlives every fold over it

Today a stream is reaped "where no registered generation is left folding it", and that reaping rides two paths. One is the operator's `reclaim` verb, which `CONTEXT.md` is careful to call "a VERB an operator RUNS and deliberately NOT a garbage COLLECTOR: nothing fires it on a timer or at `open`, because an automatic reclaim deletes with nobody present". The other is AUTOMATIC: registering into an occupied `successor` slot drops the replaced generation, and its stream with it if nothing else folds it. Save twice in a tab and the second save can delete a stream.

That is backwards, and it is the one place this codebase deletes an expensive thing to reclaim a cheap one. The stream is what CHAIN FETCHES bought; state is derived and can be recomputed from it, while the stream can only be re-fetched from a node that frequently refuses historical ranges. Its entire reason for existing is that a later generation re-folds it locally instead of going back to the chain.

So: **no registered generation folding a stream is not a reason to delete the stream.** It is exactly the state a stream is in between an old fold being dropped and a new one being built, which is the moment its value is highest.

This does not make streams immortal. It makes deletion a VERB, consistent with everything else here: `reclaim` still deletes streams when an operator asks, `deleteStream` keeps its guard, and the caps still REFUSE rather than evict. What goes is the automatic reap on the successor-replacement path.

## Considered options

**Fix the hand-over, keeping the writer a generation** (a durable stand-down mark on the incumbent's record, so `writerOf` stays a pure function of the records and the duty follows what is HELD). Rejected as the primary answer, though it is a sound mechanism: it makes the duty transferable without making it correct, because the newcomer is still BEHIND the stream and the ahead/behind problem above is untouched. It also keeps a role on the generation that does not belong to it, so the next shape nobody considered finds the same class of bug again.

**An elected-writer POINTER on the stream** (a mutable record naming the current writer). Rejected. It turns a derivable fact into a coordinated one: two processes holding different folds can disagree, the pointer can oscillate, and `writerOf` stops being a pure function every reader can evaluate independently. Delete-succession also stops being atomic with the delete. "Whoever fetches it writes it" needs no election at all, which is why it is better than both this and the stand-down mark.

**Make the restarted successor a FOLLOWER, and nothing else** (the narrow fix: `add` derives `follows` from the registry rather than from this process's in-memory fold array, so a restarted generation re-folds the stored stream, lands on the coverage, and is handed the wire by machinery that already exists). This is ADR-0044's own rule, currently disobeyed, and it IS the correct behaviour. It is not rejected -- it is a REQUIRED part of this proposal and can land first. It is not sufficient alone, because it leaves the writer a generation and therefore leaves the class open.

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
