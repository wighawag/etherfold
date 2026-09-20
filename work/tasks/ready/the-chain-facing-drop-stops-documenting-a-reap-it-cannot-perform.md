---
title: 'The chain-facing drop stops documenting and logging a stream reap it can no longer perform'
slug: the-chain-facing-drop-stops-documenting-a-reap-it-cannot-perform
blockedBy: []
covers: []
---

## What to build

A small, contained correctness pass over prose and one dead log branch, left behind by ADR-0087. No behaviour changes, because the behaviour is already right -- it is the documentation and the logging that still describe the retired rule.

**What is stale.** `Indexer.dropSuperseded` in `packages/core/src/container.ts` opens its JSDoc by saying it drops a superseded generation's state store, its record, "and its stream if it was the last one folding it". `dropReplaced` in the same file describes its drop the same way, as a reap "where no registered generation is left folding it". Neither can happen any more: ADR-0087 removed every automatic reap, `deleteGeneration` takes `reapStream` and it defaults to FALSE, and both of these call it with no options at all.

**There is a THIRD site, and it is the most misleading of the three.** `wouldStrandAFollower`'s JSDoc in the same file says that dropping a writer another held generation follows "would also reap the stored stream out from under it and send it back to the chain for a history it already has -- which on a browser's public node may not be served at all". That reap is the retired automatic one, and here it is doing real work: it reads as the JUSTIFICATION for the whole predicate. Correct it in the same pass, or the observation's subject is still half present after this task lands.

Be careful with this one, because the surrounding reasoning is CORRECT and must survive. On the chain-facing container a generation genuinely does write a stream, so stranding a follower is a real hazard and the predicate stays exactly as it is. What is stale is only the claim that the drop would also REAP the stream. Fix the clause, keep the argument, and change no behaviour.

**And two log branches cannot fire.** Because `reaped` is always `undefined` at both call sites, the clause `, reaping the stream <digest> with it` in `dropSuperseded`'s success log, and `, and the stream <digest> was reaped with it, no registered generation being left on it` in `dropReplaced`'s, are unreachable. `dropReplaced` also keeps a local `reaped` variable whose only purpose is to feed that dead clause.

This was captured rather than fixed by the task that noticed it, because that task's fence excluded `packages/*/src`: see the observation `drop-superseded-still-documents-a-reap-it-can-no-longer-perform`.

**Check it rather than taking this on trust.** The claim is that `reaped` is provably always absent on these paths, which is what makes deleting the branches safe rather than merely tidy. Confirm that both call sites pass no options and that the default is what this task says it is; if a caller has since started asking for a reap, the branch is LIVE and this task is wrong, which is a finding and a reason to stop rather than to edit.

**What must NOT change.** The reap itself still exists and is still reachable where an operator ASKS for it -- `reclaim` and `deleteStream` on the receiving side are untouched, and so is `deleteGeneration`'s `reapStream` option. This task removes descriptions of an AUTOMATIC reap on two chain-facing paths, not the ability to reap.

## Acceptance criteria

- [ ] All THREE stale reap claims in `packages/core/src/container.ts` are corrected: `dropSuperseded`'s JSDoc, `dropReplaced`'s JSDoc, and the reap clause inside `wouldStrandAFollower`'s JSDoc. The first two should describe what the drop actually takes -- the registry row and the state namespace -- because the stream's survival is the point of ADR-0087's second half and saying it plainly beats merely deleting a false clause. The third keeps its strand argument intact and loses only the reap.
- [ ] The two unreachable log clauses are removed, along with the `reaped` local that exists only to feed one of them. Verified unreachable rather than assumed: both call sites pass no options and `reapStream` defaults to false.
- [ ] No behaviour change. The generation drop still drops exactly what it drops today, and the operator-asked reap paths (`reclaim`, `deleteStream`, and `deleteGeneration`'s `reapStream` option) are untouched and still work.
- [ ] `CONTEXT.md` needs NO edit, and this was checked before the task was written: it already says "every AUTOMATIC reap is gone (registering into an occupied `successor` slot, and drop-on-promotion), deletion is a VERB (`reclaim`, `deleteStream`), and `deleteGeneration` reaps only when a caller ASKS." Confirm that is still what it says and leave it alone; if it has drifted, that is a finding.
- [ ] Tests: this changes no behaviour, so new tests are not expected. If an existing test asserts on the removed log text, it is updated; if none does, say so after checking rather than adding one to have added one.
- [ ] A patch changeset for `@etherfold/core` accompanies the change (`pnpm changeset`). This edits `packages/core/src/container.ts`, which is a published package, and `pnpm changeset status --since=main` is part of the gate, so expect to need one rather than discovering it when the gate refuses.

## Blocked by

None -- can start immediately.

## Prompt

The goal is that the chain-facing container stops describing, in prose and in a log line, a stream reap that ADR-0087 made unreachable.

Read `docs/adr/0087-a-stream-is-written-by-whoever-fetches-it-and-outlives-every-fold-over-it.md`, particularly its second half ("a stream outlives every fold over it") and its amendment about the registry sweep, and the observation `drop-superseded-still-documents-a-reap-it-can-no-longer-perform`, which is where this was spotted and which names the exact symbols.

This is a deliberately small task and the main way to get it wrong is to widen it. The chain-facing `Indexer` still has a live strand clause that declines dropping a generation whose stream another held fold follows, and that clause is CORRECT there, because on that runtime the thing which fetches genuinely is a generation -- ADR-0087 was deliberately not extended to the browser engine, which its own amendment states. Do not remove it, and do not "harmonise" the two containers: the difference between them is real and `CONTEXT.md` now teaches it deliberately.

The second way to get it wrong is to treat a log-text change as free. Check whether anything asserts on those strings before you delete them.

The seam is the core package's own container; the change is comments, one local and two string branches.

Done means: the two methods describe the drop they actually perform, the dead clauses are gone, nothing else moved, and the operator-asked reap still works.

FIRST, check this task against current reality. Its central factual claim -- that `reaped` is always absent on these two paths -- is exactly the kind of premise that a later change can falsify. Verify it before you edit, and if it is false, stop and say so.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do not write the done record, the commit message or the PR body yourself.
