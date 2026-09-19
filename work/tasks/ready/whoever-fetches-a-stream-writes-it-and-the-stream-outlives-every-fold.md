---
title: 'Whoever FETCHES a stream is the thing that appends to it, and a stream is never deleted because the last fold over it went away'
slug: whoever-fetches-a-stream-writes-it-and-the-stream-outlives-every-fold
blockedBy: [a-restarted-generation-re-folds-its-stream-instead-of-re-fetching-the-chain]
covers: []
---

## What to build

The substance of ADR-0087, in its two halves. Read the ADR first; this task builds what it decided and nothing beyond it.

**Half one: the write duty comes off the GENERATION.** Today the thing that appends to a stored stream is one generation per stream -- the one `writerOf` ELECTS by registration order -- and that third role is an accident of where the call sits. It is the root of a measured data-loss defect: the elected writer can be a generation this process holds no fold for, so the duty belongs to something absent and nothing appends while a present fold folds happily.

Under ADR-0087 the deployment that FETCHES a stream appends to it and every generation READS it. So `writesStream`, `writerOf`'s role as an ELECTION, and `reconcileWriters` all go. The ADR is explicit that `writerOf` may SURVIVE as the answer to "who fetched this", but nothing derives a DUTY from registration order any more.

Three things make this smaller than it sounds, and the ADR checked all three against the code rather than assuming them: the appender is ALREADY built from the database handle and the indexer NAME with no generation in it, so what exists is a GATE deciding which fold holds the pen rather than a per-generation appender; the two numbers that keep a stream honest both belong to whoever fetches; and it STRENGTHENS ADR-0044 rather than bending it, because under it no generation fetches, so every generation's state is a function of the stream by construction.

**Half two: a stream outlives every fold over it.** A stream is reaped today "where no registered generation is left folding it", and that reaping rides the operator's `reclaim` verb AND an automatic path: registering into an occupied `successor` slot drops the replaced generation, and its stream with it if nothing else folds it. Save twice in a tab and the second save can delete a stream.

Remove the AUTOMATIC reap. `reclaim` and `deleteStream` keep working exactly as they do, guards and all. What goes is deletion nobody asked for.

**This half is a requirement, not a nicety, and it is the one thing here most likely to be quietly under-built.** The stream is what chain fetches BOUGHT. State is derived and recomputable from it; a stream can only be re-fetched from a node that frequently refuses historical ranges. "No registered generation folds it" is precisely the state a stream is in BETWEEN an old fold being dropped and a new one being built, which is when its value is highest. A stream nobody reads costs storage; a stream that was deleted costs a re-fetch that may be refused outright.

**A third automatic deleter exists and ADR-0087 does not name it. Do not let it undo this.** `openGenerationRegistry` runs a SWEEP on every open that drops any stream subtree "claimed by no registered generation". A stream kept after its last generation is dropped is, by that rule, exactly an orphan -- so removing the reap alone would keep the stream for the life of the process and lose it at the next restart. That passes a green gate and is wrong, and it is wrong in the precise window the keep exists for. Read the sweep's own reasoning before you touch it: its stated purpose is collecting subtrees written before generations existed, which no departure could ever fire a reap for, and that purpose is untouched by this. Work out what makes a deliberately-kept stream DISTINGUISHABLE from a pre-generation orphan across a restart, and build that. If you conclude the answer meets the ADR gate in `work/protocol/ADR-FORMAT.md`, write the ADR and name it.

**Do NOT introduce an elected-writer POINTER**, meaning a mutable record naming the current writer. ADR-0087 rejects it explicitly and the reasons are not stylistic: it turns a derivable fact into a coordinated one, two processes holding different folds can disagree, it can oscillate, `writerOf` stops being a pure function every reader evaluates independently, and delete-succession stops being atomic with the delete. "Whoever fetches it writes it" needs no election at all, which is the entire point.

## Acceptance criteria

- [ ] Nothing derives a WRITE DUTY from registration order: `writesStream` as a per-fold gate and `reconcileWriters` are gone, and no replacement elects a writer among generations.
- [ ] A deployment that fetches a stream appends to it; a generation that folds without fetching appends nothing. Asserted on a deployment holding TWO folds at once, so "every generation reads it" is shown rather than implied.
- [ ] The one-writer property still holds where it matters: one stream is appended to by one fetching deployment, and no arrangement of folds produces two appenders or a duplicated range.
- [ ] Registering into an occupied `successor` slot no longer deletes a stream, and the generation's own state namespace is still dropped as it is today.
- [ ] A stream kept because nothing folds it SURVIVES A RESTART of the deployment, asserted by re-opening over the same database and finding the bytes. A test that only re-reads within one process does not cover this.
- [ ] A pre-generation orphan subtree is still collected, so the sweep's own reason for existing is not traded away for this.
- [ ] `reclaim` still deletes streams when an operator asks, with its per-generation decline intact, and `deleteStream` keeps its guard. Both are asserted, because "still works" is the claim most likely to be assumed.
- [ ] Operator-facing text that explains a fold is not writing its stream because an older generation is, is removed or corrected: it describes a rule that no longer exists.
- [ ] `CONTEXT.md` is updated where it states the retired rule, for the concepts THIS task changes. The family's closing task owns the final coherence pass; it does not own leaving the glossary false in between.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`a-restarted-generation-re-folds-its-stream-instead-of-re-fetching-the-chain`, which is itself blocked by the CLI restructure. Both are prerequisites in substance rather than in ordering convenience: moving the duty onto whoever fetches is only safe once a restarted generation lands on the stream's coverage by re-folding it, and once an unknown stream position REFUSES instead of permitting. Landing this first reproduces the measured duplicate-history failure.

## Prompt

The goal is that a stored stream has exactly one writer, that the writer is the thing FETCHING it rather than one of the folds reading it, and that a stream is never deleted merely because the last fold over it went away.

Read ADR-0087 in full; it is the decision and it argues the shape. Then ADR-0044 for the one-writer rule this supersedes in part and for why a follower holds a read-only view, ADR-0038 for why the ENGINE is the arbiter of whether an append is safe and which two numbers that needs, and ADR-0084 for slots, which this does not touch. `CONTEXT.md` carries the retired rule in several glossary entries.

**The obvious fix is wrong and that was MEASURED rather than argued.** Handing the write duty to the fold that happens to be present stores the history a second time: the restarted successor's state is empty, it fetches from the default start block, and it re-appends a range the stream already covers. On the defect's own scenario `_emissions` ended with 4 rows where 2 were correct. Nor can it be fixed by timing the hand-over: a reconciliation once per fetch cycle observes the fold BELOW the coverage and then ABOVE it and never ON it, and handing over below duplicates while handing over above leaves a HOLE -- the silent, permanent, self-consistent damage `CONTEXT.md` defines under "hole versus gap". There is no observation point that is neither. This is why the duty moves OFF the generation instead of being made transferable; if you find yourself building a hand-over, you have taken the rejected option.

The decision most likely to be got wrong is treating the second half as tidying. It is not: work out where a stream is deleted TODAY, enumerate every path, and decide each one explicitly. The sweep on registry open is the one the ADR does not mention and the one that can silently undo this across a restart.

The second: `writerOf` is not simply deleted. It may remain as the answer to "who fetched this stream", and other things read it. Decide what survives and what it means now, and make sure no caller is left reading it as a duty.

The third: the acceptance gate cannot tell a stream that was kept from a stream that was deleted and re-fetched, if the test lets a fetch happen. Assert on the BYTES and on the chain reads, the way this family's earlier measurements did.

Done means: no generation holds a write duty, a fetching deployment appends, a stream survives having no folds over it including across a restart, the operator's delete verbs are untouched, and no elected-writer pointer was introduced.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). Two tasks land before it and may have changed the shape of what is described here. If what you find contradicts this body, say so and build what is right rather than what is written here; four builders in this family were right to contradict their own task text, and one was right to stop a task outright because its central premise was false.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT: what happened to `writerOf`, how a kept stream is distinguished from a pre-generation orphan across a restart, every deletion path you enumerated and what you decided for each, and anything you deliberately left alone. If a decision meets the ADR gate, write the ADR in `docs/adr/` and name it in the block. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.
