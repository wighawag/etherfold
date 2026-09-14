---
title: 'A replay never asks below a stream''s start block, and a stream too young to answer says so differently from a damaged one'
slug: a-replay-never-asks-below-a-streams-start-block
blockedBy: []
covers: []
---

## What to build

Stop a follower asking a stored stream for blocks that precede the stream, and make the two very different things that answer "does not reach back" distinguishable.

The read start for a fold is the lower of "carry on from where I stopped" and "the bottom of the unconfirmed window", floored. Both terms are wanted: the second deliberately pulls the start BACKWARDS by the finality depth when a fold is level, because anything inside that window can still reorg and must be re-read rather than trusted.

The defect is the floor. It is zero, not the stream's start. So while a fold is still within the finality depth of the block its stream begins at, the replay asks from BELOW that, the keeper honestly answers that it does not reach back, and the caller cannot make progress. It resolves itself once the chain moves finality blocks past the start, which on a live chain is seconds, and never in a fixture that sits level with its own start block. It has already cost two rounds of debugging in two packages, and both fixtures now carry a deliberate lead to avoid it.

The same condition produces two different behaviours, which is what makes it confusing rather than merely wasteful. A generation reading its OWN cached stream clears it and re-indexes, which is self-healing and cheap while a stream is young. A follower reaches the same code through a read-only view whose clear is a no-op by design, so that a follower can never destroy the stream its writer is still appending to. It therefore cannot repair and cannot progress, and returns the identical stop reason on every call.

So there are two halves. **Do not ask below the start**, which removes the condition. And **make the answer say which kind it is**, because "this stream is younger than the finality window, wait" and "this stream genuinely cannot serve that range, intervene" want opposite responses from a caller and are currently indistinguishable.

## Acceptance criteria

- [ ] A fold level with its own stream's start block makes progress, rather than asking below the start and being told the stream does not reach back.
- [ ] A follower and a rebuild both advance in that situation, not only a generation reading its own cached stream.
- [ ] The unconfirmed-window property is preserved exactly: a fold that is level still re-reads the window a reorg can reach, and clamping the start never causes a block inside that window to be skipped. Asserted, since this is the property the floor change could quietly break.
- [ ] A caller can tell a stream that is too young to answer yet from one that genuinely cannot serve the range asked for, without parsing a message.
- [ ] Whatever a caller consults to decide "call again" versus "this needs a human" gives the right answer for both cases.
- [ ] The two fixtures that currently carry a deliberate lead to dodge this are re-examined: if the lead is now only working around this defect, it is removed, and if it is load-bearing for another reason that reason is written down where the lead is.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

None. It can start immediately.

## Prompt

The goal is that a young stream is not indistinguishable from a broken one, and that neither a follower nor a rebuild can be stuck on a condition that is only about the stream's age.

Read `work/notes/observations/a-rebuild-cannot-start-within-finality-of-a-streams-start-block.md`, which has the located expression, the two divergent behaviours and the candidate fix. Then read `getFromBlock` in `@etherfold/core`'s engine utilities together with the documented helper beside it, which describes "the earliest block a source can have anything to say about" as the floor that function returns before anything has been indexed. The fix is to apply that floor on the other branch too. **Verify it rather than assuming it**: that value is the SOURCE's earliest block while the defect is about the STREAM's start, and the two can diverge for a stream installed from a seed rather than fetched from the beginning. If they can differ in a way that matters, the right floor is the stream's own start and the source value is not a substitute for it.

Treat this as a change to the read-start rule for EVERY fold, because it is. Clamping upwards cannot skip a block that exists, since blocks below a stream's start are not in it, but that argument deserves a test rather than confidence, and the case that matters is a level fold with a reorg reaching into its window.

On the second half, read **ADR-0069** for the rule that a keeper reports what it found and the caller repairs it, and note that the repair available to a follower is deliberately nothing at all. So the distinction being added is for the caller's benefit, and it should be a fact the caller can branch on rather than a string it matches.

The decision most likely to be got wrong: do not fix this by giving a follower the ability to clear. The read-only view's no-op clear is what makes the one-writer rule structural, and passing a clear through would delete the live generation's history.

The seam to test at is the existing reorg and rebuild tests in core, with a stream deliberately young enough to trigger the condition.

Done means: a young stream does not stall a follower, the unconfirmed window is still re-read, and a caller can tell "wait" from "intervene".

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. Which floor you used and why (the source's earliest block or the stream's own start), and how the two kinds of "does not reach back" are distinguished at the seam, are both such decisions. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.

## Decisions

**Which floor: the SOURCE's earliest block (`defaultFromBlock`), not the stream's own start.** The task said the stream's start is the right floor *if the two can differ in a way that matters*. They can differ, but not in a way this fix can use, and not in a way that matters: `installStreamSeed` refuses a seed opening above `reachBackTo` (defaulting to `defaultFromBlockOf`), so an installed stream opens at or below the floor; and decisively, `getFromBlock` is the number *both halves of the wire* derive from the source alone (`StreamBuilder.expectedFromBlock`; `generateStreamToAppend`'s `UnexpectedFromBlockError`), so a floor derived from a stored stream would make the sender and the receiver disagree about one cursor and break ADR-0004's resumption protocol. The alternative considered and rejected was passing the stream's `startBlock` into `getFromBlock` (or re-reading from `startBlock` after a refusal): both require relaxing that from-block check, which is the one refusal that keeps a batch from applying into a hole. **Touches:** every fold's read start, `StreamBuilder.expectedFromBlock`, `installStreamSeed`'s `reachBackTo`, and both stream keepers' `startBlock` check.

**How the two kinds of "does not reach back" are distinguished: by making the young one stop producing the verdict, not by adding a variant to it.** I deliberately did not add a new `RebuildStop` reason or a new field. After the floor, the read start is never below `defaultFromBlock`, which is the lowest block *any* fold over this source ever asks from — so a stream that served the first load serves every later one, and `does-not-reach-back` is left meaning exactly one thing: a stored stream no fold over this source can be whole on. The two answers a caller branches on are therefore the existing union members: `absent`/`nothing-stored` (the writer has not appended yet, retry) and `does-not-reach-back` (intervene), and `retryCanAdvance` gives the right answer for both without change. I considered splitting the verdict on `startBlock <= foldedThrough + 1` and rejected it: **both** halves recur for ever (a refused read never moves `latestBlock`), so a second reason would buy no scheduling difference while adding a concept overlapping one ADR-0069/ADR-0070 already own. **Touches:** `StreamRead`, `ReplayRead`, `RebuildStop`, `retryCanAdvance`, and the CLI's `newlyStalledFollowers` (all unchanged in shape).

**The residual I did not build, stated so it is not mistaken for coverage.** One shape still reports `does-not-reach-back` where this particular fold has no hole: a stream that opens *mid-history* (above `defaultFromBlock`) read by a fold that has already folded past its start. That is reported as needing a human, which is right — a mid-history subtree is the damage `startBlock` exists to catch — but the fold in question is individually whole. Serving it would mean reading from `max(fromBlock, startBlock)`, which needs the from-block refusal relaxed, and that is a different task. No ADR: the change is one expression, reversible, and carries no residual trade-off; what it *did* narrow is a claim ADR-0070 makes in passing ("a seeded generation is the shape that produces it"), which I corrected in the type docs and `CONTEXT.md` rather than by amending the ADR.

**Test-double fidelity, changed as part of the fix.** `keyedStream` in `follower.test.ts` now records `startBlock` and answers `does-not-reach-back`, as both shipped keepers do. A double that served whatever it held regardless of the block asked for could not express the refusal at all, which is why the core suite never met this. **Touches:** every existing case in `follower.test.ts` (all still green).
