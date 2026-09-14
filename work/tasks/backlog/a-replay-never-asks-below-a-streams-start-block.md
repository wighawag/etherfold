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
