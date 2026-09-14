---
title: 'A successor that was never canonical is SUPERSEDED by a newer one, instead of holding a slot for ever'
slug: a-successor-that-was-never-canonical-is-superseded
spec: a-reconfigure-is-not-an-outage
blockedBy: []
covers: []
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

The decision most likely to be got wrong is the predicate. "Not canonical right now" is NOT the test: a predecessor kept for a revert is not canonical right now either, and retiring it would silently destroy the thing story 4 promises. The test is "has NEVER been canonical", which is a different question and needs a durable answer rather than an in-memory one, since the pointer is durable and shared and this process may not have been running when it last moved. There is already a registry field that records whether the pointer has ever named a generation; find it and use it rather than inferring from the current pointer.

The second: do not make this a cap-pressure eviction. Retiring on "we are near the bound" would make the behaviour depend on how full the registry happens to be, which is how a deterministic lifecycle becomes a heuristic. A superseded successor is dead the moment a newer one takes its role, whether the registry holds two generations or none to spare.

The third: be careful what "the same role" means when the successors are on DIFFERENT streams. A processor edit after a source change produces a successor on the same stream as the previous successor, which is the common case here. Two successors on different streams may both be wanted. Decide this explicitly and say what you decided.

The seam to test at is the container with a registry over a real database, registering successors in a row and asserting on what the registry holds afterwards and on what a revert can still reach.

Done means: several changes in a row leave one successor catching up, the incumbent and any predecessor are untouched, the cap is never reached, and the disk comes back.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. What counts as "the same role" across streams, and where the never-been-canonical fact is read from, are both such decisions. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.
