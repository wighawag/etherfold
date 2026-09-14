---
title: 'A successor that was never canonical is SUPERSEDED by a newer one, instead of holding a slot for ever'
slug: a-successor-that-was-never-canonical-is-superseded
spec: a-reconfigure-is-not-an-outage
blockedBy: []
covers: []
needsAnswers: true
---

## What to build

An ENABLER for its spec rather than a story of its own: that spec's premise is that reconfiguring is cheap enough to do whenever you want, and a bound that refuses after a handful of reconfigures is the premise failing in practice rather than a separate concern.

The missing half of the generation lifecycle: a successor that is still catching up, and that a newer successor has just made pointless, stops existing.

Today the container knows one kind of supersession, and it is a PROMOTION: the incumbent becomes the predecessor and is RETAINED, because the pointer must be able to move back to it. There is no notion of a successor that was **never** canonical becoming dead work when a newer one arrives for the same role. So it keeps its registry row, keeps its state namespace, and keeps being advanced by the scheduled bounded rebuild, re-folding the same stream as the newer successor and competing with it for the same database handle.

That is wasted work in every case, and a wall in the case that matters. A generation cap "REFUSES at the bound and never evicts", which is the right mechanism against slow accumulation and the wrong one against CHURN: under churn the count grows for a reason nobody will ever want. A developer whose source change lands first and whose processor follows a moment later (possibly after a failed compile) produces several successors in a row, reaches `maxGenerations` within a few saves, and has to delete generations by hand. A browser tab, at two of each, reaches it on the second.

So bound the count by retiring what is provably dead rather than by raising the cap, which only moves the wall.

**The rule is narrow and the narrowness is the whole safety argument.** A generation is dead work only while it has NEVER been canonical. A generation that was ever canonical is what a revert moves back to and must be retained on exactly the terms it is retained on today. So this adds one predicate and retires on it; it must not touch the retention of a predecessor, and it must not be reachable for the canonical generation under any circumstances.

Dropping is not a new mechanism either: deleting a generation is already a `DROP` of its table namespace, injected by whoever named the tables, and the registry already exposes deletion. What is new is deciding WHEN, without being asked.

## Acceptance criteria

- [ ] Registering a successor retires an existing successor that is still catching up and has never been canonical, so a run of N rapid changes leaves one successor rather than N.
- [ ] A generation that HAS been canonical is never retired by this path, including the incumbent and any predecessor kept for a revert. Asserted directly, since this is the property that makes it safe.
- [ ] The retired generation's state is actually reclaimed (its namespace dropped), not merely unregistered, so the slot and the disk both come back.
- [ ] A rapid succession of changes no longer reaches the generation cap: a loop of several changes in a row keeps registering rather than being refused.
- [ ] A succession of SOURCE changes, each making a new stream, no longer reaches `maxStreams` either, since retiring the previous never-canonical successor frees its stream slot. This is what makes the cross-stream rule above testable rather than a claim.
- [ ] The stream a retired successor was folding is untouched if anything else still needs it, and the one-writer rule is unaffected: retiring a follower never disturbs the generation that writes its stream.
- [ ] A retirement is REPORTED, naming what was dropped and why, so an operator watching a dev loop sees bounded churn rather than silent deletion.
- [ ] The generation caps are UNCHANGED. This task bounds the count; it does not raise the bound.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

None. It can start immediately, and it is worth landing before the reconfigure trigger, which makes churn much easier to produce.

## Prompt

The goal is that a development loop can change its mind as often as it likes without an operator having to go and delete things.

Read `work/notes/observations/rapid-change-succession-hits-the-generation-cap.md` for the scenario and the three constraints that shape it. Then read `@etherfold/core`'s receiving container: the caps and the reasoning printed above them (`SERVER_GENERATION_CAPS`, and the rule that a cap refuses and never evicts), the registration path at open, and the existing supersession vocabulary, which is entirely about a promotion's predecessor and is NOT what this task is about. `ADR-0053` is why deleting a generation is a namespace `DROP`, and `ADR-0044` is why a follower holds a read-only view of a stream it does not own.

The decision most likely to be got wrong is the predicate. "Not canonical right now" is NOT the test: a predecessor kept for a revert is not canonical right now either, and retiring it would silently destroy the thing story 4 promises. The test is "has NEVER been canonical", and it is answered IN MEMORY, from what this container has done since it opened.

That is a DECISION, not an oversight, and an earlier draft of this task got it wrong by asserting a durable registry field that does not exist. `GenerationRecord` is `GenerationId & {createdAt}` and the durable row is `{stream, processor, createdAt}`; the only ever-canonical fact in the system is the in-memory one (`everCanonical`, a set of held folds in `receivingContainer.ts`, and the flag on the entry in `container.ts`). Nor can it be derived from what is stored: with the pointer at C and a newer generation N, "N was never canonical" and "N was canonical and the pointer was reverted away from it" are indistinguishable from the schema, and those are exactly the two cases that must not be confused.

So NARROW the predicate to what one process can honestly answer: retire only a fold THIS container added as a successor AFTER `open`, that was not canonical when it was added, and that the pointer has not named since. A generation this process did not add is NEVER retired.

State the residual rather than hiding it: across a restart nothing is retired, so a deployment that reconfigures by RESTARTING still accumulates generations until the cap refuses. That is correct rather than a gap. A cap is the right mechanism against slow accumulation and the wrong one against churn, and churn is what arrives through `add` on a live container; restart-paced accumulation is deploy-paced, and refusing at start-up while naming what to delete is what that path already chose deliberately. It also fails in the safe direction ADR-0057 already records for `everCanonical`: a fold this process has not seen the pointer on is treated as a revert, and nothing is dropped.

The second: do not make this a cap-pressure eviction. Retiring on "we are near the bound" would make the behaviour depend on how full the registry happens to be, which is how a deterministic lifecycle becomes a heuristic. A superseded successor is dead the moment a newer one takes its role, whether the registry holds two generations or none to spare.

The third is ANSWERED here rather than left to you: "the same role" means successor to the current incumbent, REGARDLESS OF STREAM. Retiring only same-stream successors would not remove the wall, because the scenario opens with a SOURCE change and a source change makes a new stream. `maxStreams` is counted as the distinct streams among registered generations (`generation/registry.ts`), so two source edits reach 2 of 2 and the next registration is refused with generations still well under their own bound. Retiring the previous never-canonical successor whatever stream it sits on is what frees the stream slot as well. Drop the retired generation's own state namespace, and leave the STORED STREAM alone: the cap is reclaimed even though the raw logs are not.

The seam to test at is the container with a registry over a real database, registering successors in a row and asserting on what the registry holds afterwards and on what a revert can still reach.

Done means: several changes in a row leave one successor catching up, the incumbent and any predecessor are untouched, the cap is never reached, and the disk comes back.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. The two decisions that used to sit here (what "the same role" means across streams, and where the never-been-canonical fact is read from) are ANSWERED above and are not yours to re-open; record instead what you had to decide in order to implement them, such as how a retirement is REPORTED and how the in-memory set is kept in step with `add` and with a pointer move. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.
