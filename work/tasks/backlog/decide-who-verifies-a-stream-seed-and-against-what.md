---
title: 'Decide who verifies a stream seed, and against what'
slug: decide-who-verifies-a-stream-seed-and-against-what
spec: a-generation-can-be-seeded-from-a-published-artifact
blockedBy: [decide-what-a-mismatched-seed-digest-does]
covers: [3]
promptGuidance.testFirst: false
---

## What to build

A DECISION: what a client must be satisfied of before it folds a downloaded stream, and who establishes it.

A stream seed is more dangerous than a state snapshot, and the reason is structural rather than a matter of degree. A bad snapshot installs rows and reports a floor at its own block; it is one generation's starting state, and the store refuses reverts beneath it. A bad STREAM carries EVENTS, which the processor folds, and which every LATER generation on that stream re-folds, because re-folding a stored stream instead of re-fetching it is exactly what the generation model buys. A poisoned stream is therefore inherited by successors that never downloaded anything. So the question is not "is a stream seed defended like a snapshot", it is "what does a stream seed have to prove, given that it is worse".

What to settle:

- WHO establishes trust: the publisher (signing, or publishing alongside the client build so the seed is as trusted as the code that fetches it), the client (re-deriving something checkable), or a third party. The deployment reality the spec starts from is relevant evidence, not decoration: a filter change means the user is getting a new client build anyway, so the seed can ship with, or be pinned by, that build. Decide whether that IS the trust boundary or only looks like one.
- AGAINST WHAT: what is actually checkable without a node, since the node's inability to serve old logs is the premise of seeding. Candidates worth weighing rather than listing: an integrity digest over the artifact; structural coherence (ordinals contiguous, block order monotonic where it must be, reorg verdicts coherent, the coverage claim consistent with the events it covers, no event outside the captured filter); spot-checking a bounded sample against the node where recent blocks ARE servable; and the identity check already decided by `decide-what-a-mismatched-seed-digest-does`, which this decision must build on rather than restate.
- WHAT REFUSAL LOOKS LIKE, consistently with the sibling rule: refused-not-installed, and with which reason vocabulary. A half-installed seed must be defined too: either impossible by construction, or discarded.
- WHAT IS EXPLICITLY NOT DEFENDED, and why that residue is accepted. An honest boundary beats an implied one.

Out of scope, per the spec: the snapshot's own verification, which is already owned by the landed work behind ADR-0040, and the publishing pipeline (who builds and hosts an artifact), which is `work/notes/ideas/publishing-snapshots-of-versioned-state.md`.

## Acceptance criteria

- [ ] The decision states who establishes that a seed is trustworthy, and the trust boundary it relies on, in terms a build task can implement without re-litigating it.
- [ ] The decision states what is checked before any event is folded, distinguishing checks that need no node from checks that do, and it says which are mandatory versus advisory.
- [ ] The reasoning explicitly addresses why a stream seed needs at least as much defence as a state snapshot, including the inheritance effect (a successor re-folds a stored stream it never downloaded).
- [ ] Refusal is defined, consistently with the sibling identity rule, including what happens to a partially installed seed.
- [ ] What is deliberately NOT defended is stated, with the accepted residue named rather than left silent.
- [ ] The decision builds on the identity rule from `decide-what-a-mismatched-seed-digest-does` instead of restating or contradicting it, and does not re-decide the snapshot path's verification.
- [ ] Recorded as an ADR in `docs/adr/` if it meets the ADR gate. If an ADR is written, its number is the next free one at the time of writing and is re-checked after any rebase, since `check:adr` fails the gate on a duplicate. If it does NOT meet the gate, the rule is stated in full in the `## Decisions` block of the final report, with the reason it did not, so the runner transcribes it into the done record that `emit-the-sliced-build-plan-for-seeding` reads. The build plan does not exist yet, so it is not a destination; and a decision we made is not a `work/notes/findings/` entry, which is verified EXTERNAL ground truth.
- [ ] No package under `packages/` changes behaviour; this task ships a decision, not an implementation. `CONTEXT.md` is NOT edited by this task.
- [ ] The repo acceptance gate is green.

## Blocked by

- `decide-what-a-mismatched-seed-digest-does`. The identity check is the floor this decision builds on (a seed that is not for this stream is refused before anything else is asked of it), and both tasks may write an ADR into the same numbered directory.

## Prompt

> Decide what a client must be satisfied of before it folds a downloaded stream seed, and who establishes it. Source spec: `work/specs/tasked/a-generation-can-be-seeded-from-a-published-artifact.md`, an EXPLORATION spec whose done is confidence plus a de-risked build plan. Your deliverable is a RULE, recorded durably. Not an implementation.
>
> FIRST, check this task against current reality (it is a launch snapshot). Read what the earlier tasks in this spec landed: the seam ADR from `pin-the-seam-a-published-stream-arrives-through`, the wire-shape finding from `measure-what-a-published-stream-costs-to-install-and-pick-its-shape`, and the identity rule from `decide-what-a-mismatched-seed-digest-does`. Your rule sits on top of those. If any landed differently from what this task assumes, decide against what actually landed; if one contradicts the premise here, route to needs-attention with the discrepancy.
>
> The asymmetry that motivates the whole task, stated so you do not have to rediscover it: a state snapshot seeds a FOLD and its damage is bounded by the generation that adopted it (ADR-0028 gives it a retention floor; ADR-0040 refuses one a client cannot read). A stream seed seeds the STREAM, and a stored stream is re-folded by every later generation over it, including successors that downloaded nothing, which is precisely what makes a processor-only change free in this model (ADR-0044, ADR-0055, ADR-0056). So a bad stream propagates where a bad snapshot does not.
>
> What is checkable without a node is the crux, because a node that will not serve old logs is the premise of seeding, so "verify against the chain" is mostly unavailable exactly where it is most wanted. Weigh integrity (a digest over the artifact, and whether it is signed and by whom), structural coherence (contiguous ordinals, block ordering, reorg verdicts, the coverage claim matching the events, nothing outside the captured filter), a bounded spot-check against blocks the node WILL serve, and the deployment fact that a filter change ships a new client build anyway, so a seed can be pinned by the same build that fetches it. Decide whether that pinning is the real trust boundary or a boundary that only looks like one because the artifact and the code arrive from the same host.
>
> Read `bootstrapFromSnapshot` in `@etherfold/processor-entities` for the existing shape of "decline with a reason rather than throw", and ADR-0040 for the settled refused-not-installed stance. Do not re-decide the snapshot's own verification (out of scope, already owned) and do not design the publishing pipeline (`work/notes/ideas/publishing-snapshots-of-versioned-state.md` owns that). Do not build the check: the source spec puts building the seeding capability out of scope, and a spike that quietly ships is the named failure mode.
>
> Say what you deliberately do NOT defend, and why the residue is acceptable. An unstated gap is the one a later reader assumes was covered. If your rule meets the ADR gate (hard to reverse, surprising without context, a real trade-off; see `work/protocol/ADR-FORMAT.md`), write it as an ADR in `docs/adr/`, taking the next free number and re-checking after any rebase, since `check:adr` is in the acceptance gate. Otherwise state the rule IN FULL, with the reason it missed the gate, in the `## Decisions` block of your final report: the runner transcribes that into your done record, which is where the build-plan task is told to look. Do not park it in `work/notes/findings/` (that bucket is verified external ground truth, not a decision we made) and do not write into a build plan that does not exist yet. Do not edit `CONTEXT.md` (the next task in this spec owns that edit). Do no git operations.
>
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. The runner transcribes it into the done record; do not write the done record, the commit message or the PR body yourself, and do not open a `decisions-*` note.
