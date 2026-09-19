---
title: 'A restarted generation RE-FOLDS the stream it already has instead of re-fetching the chain, and an unknown stream position REFUSES'
slug: a-restarted-generation-re-folds-its-stream-instead-of-re-fetching-the-chain
blockedBy: [run-and-build-drive-the-folds-they-hold-rather-than-one-captured-receiver]
covers: []
---

## What to build

Two changes in `@etherfold/core`, both small, both load-bearing for everything ADR-0087 does afterwards.

**One: `follows` is derived from the REGISTRY, not from this process's in-memory fold array.** `ReceivingIndexer.add` decides whether a fold follows its stream with `this.folds.some((fold) => fold.streamDigest === context.stream)`. That array is EMPTY at `open`, so a generation arriving by RESTART is never a follower: it gets a receiver and re-fetches the whole chain from the source's start block even though the stored stream already holds that history under the same digest. Measured: the fake chain's recorded `eth_getLogs` ranges begin at the source's `startBlock` while `_emissions` already covers the range (`work/notes/observations/a-restarted-run-refetches-the-whole-chain-instead-of-refolding-the-stored-stream.md`). ADR-0044 already says a generation on a SHARED stream is a follower that fetches nothing; the code simply disobeys it.

This has a worked precedent IN THIS REPO, and it is the shape to follow rather than to invent. The chain-facing twin had the identical defect from the identical source and it was fixed by deriving from `writerOf`: `packages/core/src/container.ts` carries a long block recording that ADR-0071's rejection of the `writerOf` form has EXPIRED, twice over, and why the set question it fell back to is wrong for a record that ALREADY EXISTS. Read that block; the receiving twin's fix is the same expression for the same reason, and the reload sibling `a-reloaded-container-makes-its-canonical-generation-a-follower` is the same family.

Note how close the machinery already is. `add` ALREADY computes `writesStream` from `registry.writerOf(...)` after the record exists. `follows` is the exact complement of it -- the writer exists and is not me -- so the two facts collapse into one derivation with one home, which is precisely ADR-0087's point.

**Two: an UNKNOWN stream position must REFUSE rather than permit.** `streamCanReceive()` in `packages/core/src/indexer.ts` reads `if (this.streamLastToBlock === undefined || !this.lastSync) return true`, so a fold that has never learned where the stream reaches takes the PERMISSIVE branch. That is safe today only because the pen is held by a fold that already loaded the stream, so the case is unreachable. It is exactly why the naive write-duty hand-over DUPLICATED history when it was measured: the fold handed the pen had never learned the stream's position, took the permissive branch, and `streamRemainderOf` had nothing to strip against, so `_emissions` ended with 4 rows where 2 were correct. ADR-0087 changes who writes, which makes that default dangerous. Fix it HERE, before anything rests on it.

## Acceptance criteria

- [ ] A deployment restarted over the same database with a changed processor RE-FOLDS the stored stream rather than re-fetching it: asserted by the chain reads the run actually made, not by a flag -- zero historical `eth_getLogs` for a range the stream already covers.
- [ ] `follows` and `writesStream` are derived from ONE reading of the registry, so a reader cannot get a fold that neither follows nor writes, nor one that does both.
- [ ] The derivation is taken from the records as they stand AFTER whatever this registration displaces, not from the list read at the top of `add`. Registering into an occupied `successor` slot can DROP the current writer, which changes the answer.
- [ ] Nothing partial survives a refusal: a fold refused for having no stream to re-fold leaves no registry row and no state namespace behind, exactly as the cap refusal already promises.
- [ ] `streamCanReceive()` REFUSES when the stream position is unknown, and the change is shown NOT to alter any path that works today -- say which paths reach the unknown case now and what each does.
- [ ] A deployment that holds its own incumbent, a reload on the canonical generation, and a reconfigure through the running endpoint all behave exactly as they do today.
- [ ] A host that supplies NO stream to re-fold gets a deliberate, stated answer on restart rather than an incidental one, since this change makes that case reachable where it was not before.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`run-and-build-drive-the-folds-they-hold-rather-than-one-captured-receiver`. This is a hard dependency and it was measured, not assumed: making this change first puts **25 CLI tests red**, 17 of them on `the opening fold of this ReceivingIndexer has no receiver`, because `run` and `build` cannot hold a follower as their opening fold until that task restructures the assembly.

## Prompt

The goal is that restarting a deployment with a changed processor costs a LOCAL re-fold of a stream already on disk instead of a full re-fetch of the chain, which is what the architecture already describes and the code does not do.

Read ADR-0044 for why a generation on a shared stream fetches nothing, and ADR-0087, which makes this a REQUIRED part of a larger proposal and says so in terms. Then read `Indexer.add` in the chain-facing container, whose `follows` was already moved onto `writerOf` and whose comment block explains why the in-memory question is wrong; then `ReceivingIndexer.add`, which is the twin that still asks it.

**Two hazards were measured while scoping this, and both pass a compile.**

The first is ORDER. The refusal for "a follower with nothing to re-fold" currently fires EARLY, before any state or record exists, and that placement is load-bearing: `receivingContainer.test.ts` asserts a refused fold leaves nothing behind. Moving the refusal after the record to get an easier derivation makes that test fail with a registry holding two records where one is correct. But the derivation also cannot simply read the list at the top of `add`, because `replaceTheSuccessor` runs in between and can drop the very generation that was the writer. The answer has to be a derivation that knows the arriving IDENTITY and reads the records as they stand after the displacement, before the record is created. Both constraints are real; satisfy both.

The second is that **five `receivingContainer.test.ts` cases encode the CURRENT WRONG BEHAVIOUR as expected.** They open a second container over the same registry with a changed processor and expect it to get a receiver -- which is the defect. Under the fix those folds become followers, and a container given no stream to re-fold is refused instead. Do not soften the fix to keep them green, and do not silently delete them: work out for each whether it should now assert the follower path or should supply a stream to re-fold, and say what you did. If you conclude one of them is testing something real that the fix breaks, that is a STOP and a needs-attention signal, not something to paper over.

On `streamCanReceive`, the decision most likely to be got wrong is treating it as cosmetic. It is a real refusal on a real path; find what reaches the unknown case today and show the change is inert there, with evidence rather than an assertion. If it is NOT inert, that is a finding worth more than the fix.

The seam to test at is the container's own suite for the derivation, and a CLI deployment stood up over a real handle, stopped, and re-run with an edited bundle for the end-to-end claim. Assert the chain READS, because a flag can be right while the behaviour is wrong.

Done means: a restart re-folds instead of re-fetching, measured on the wire; one derivation with one home; nothing partial left by a refusal; and an unknown stream position refuses.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). The measurements here were taken against the tree this was written on and before its blocker landed; re-take them. If what you find contradicts this body, say so and build what is right rather than what is written here.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT: where the derivation reads the records, what happens to each of the five tests that encode today's behaviour, what a host with no stream to re-fold gets on restart, and what you found about `streamCanReceive`'s reachability. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.
