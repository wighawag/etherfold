---
title: 'Emit the sliced build plan for seeding a generation, and say whether it is buildable'
slug: emit-the-sliced-build-plan-for-seeding
spec: a-generation-can-be-seeded-from-a-published-artifact
blockedBy: [decide-who-verifies-a-stream-seed-and-against-what]
covers: [5]
promptGuidance.testFirst: false
---

## What to build

The exploration's terminal deliverable: a de-risked, SLICED build plan for seeding a generation from a published artifact, in a form the follow-on build spec can be tasked from atomically, with no fiction in it.

Four decisions precede this one: the arrival seam and what installing writes, the artifact's measured wire shape, the identity rule when digests disagree, and what a client must verify before folding. This task folds them into one plan: the vertical tracer-bullet tasks the build would consist of, their order, the seam each one lands on, and which recorded decision governs each. A slice that cannot name the decision it rests on is a slice that is still fiction, and saying so is a valid outcome of this task.

The plan lands as a follow-on BUILD spec draft in `work/specs/proposed/` (the staging position for agent-authored specs, so no auto-tasker can race a human over it), carrying `taskedAfter: [a-generation-can-be-seeded-from-a-published-artifact]`. Its user stories must ALL be committed and build-taskable: a story still gated on an unresolved question does not belong in it, because a spec whose stories span confidence tiers is the mis-scope the tasking protocol refuses to task. If, after the four decisions, part of the capability is still not confidently buildable, do NOT pad the spec with it. Say what remains open, and either leave that part out of the draft entirely or record it as a separate, clearly-gated follow-on that a human authors.

Two shapes must be reflected in the slicing rather than assumed away. The captured STREAM and the state SNAPSHOT are not equivalent: a stream seed composes with the generation model because a successor can re-fold it, while a snapshot-seeded generation is a LEAF that cannot serve a later processor-only change and reports a retention floor at its block. And the snapshot path already EXISTS, so the plan should say which slices are new build and which are reuse or extension of what is there.

This task also owns the one shared-file edit the whole spec needs: `CONTEXT.md`'s `seeding` entry, updated to say what was decided, so the vocabulary entry stops describing only the two shapes and starts describing the pinned seam and the rules. No other task in this spec touches that file.

## Acceptance criteria

- [ ] A follow-on BUILD spec draft exists in `work/specs/proposed/`, with `taskedAfter: [a-generation-can-be-seeded-from-a-published-artifact]` in its frontmatter, following `work/protocol/spec-template.md`.
- [ ] Every user story in that draft is committed and build-taskable: none is gated on an unresolved question, and each names the recorded decision (ADR or finding) that makes it buildable.
- [ ] The plan names the vertical slices, their order, the seam each lands on, and what makes each one demoable on its own, rather than a layer-by-layer implementation plan.
- [ ] The plan distinguishes new build from reuse/extension of the existing state-snapshot path, and reflects that a stream seed composes with later generations while a snapshot-seeded generation is a leaf with a retention floor.
- [ ] Anything still NOT confidently buildable after the four decisions is stated explicitly and kept OUT of the buildable draft, rather than padded in as a speculative story.
- [ ] `CONTEXT.md`'s `seeding` entry is updated to describe what was decided (the arrival seam, the artifact shape, the identity and verification rules), replacing prose that describes only the two shapes.
- [ ] The plan cites each of the four preceding tasks' recorded outputs by name, so a future author reaches the reasoning without re-deriving it.
- [ ] No package under `packages/` changes behaviour; this task ships a plan, not an implementation.
- [ ] The repo acceptance gate is green.

## Blocked by

- `decide-who-verifies-a-stream-seed-and-against-what`, which is itself the tail of the chain through the identity rule, the wire-shape measurement and the arrival seam. All four answers are inputs to this plan.

## Prompt

> Fold this exploration's four decisions into a de-risked, sliced BUILD PLAN for seeding a generation from a published artifact, and say honestly whether it is buildable. Source spec: `work/specs/tasked/a-generation-can-be-seeded-from-a-published-artifact.md`, an EXPLORATION spec whose entire definition of done is confidence plus this plan. You are writing the plan, NOT the capability: building seeding is explicitly out of the source spec's scope.
>
> FIRST, read what actually landed, not what this task assumes landed. The four preceding tasks are `pin-the-seam-a-published-stream-arrives-through` (how a seed arrives and what installing writes), `measure-what-a-published-stream-costs-to-install-and-pick-its-shape` (the measured wire shape, in `work/notes/findings/` with evidence in `docs/spikes/`), `decide-what-a-mismatched-seed-digest-does` (the identity rule), and `decide-who-verifies-a-stream-seed-and-against-what` (the verification rule). Their records are in `docs/adr/`, `work/notes/findings/` and their done records in `work/tasks/done/`. If a decision is missing or contradicts another, do not paper over it in the plan: route to needs-attention with the discrepancy, because a build plan resting on a contradiction produces exactly the fiction this exploration existed to prevent.
>
> The plan's form is a follow-on BUILD spec draft in `work/specs/proposed/` (staging: agent-authored specs land there and a human promotes, which also keeps an auto-tasker from racing the human), carrying `taskedAfter: [a-generation-can-be-seeded-from-a-published-artifact]`, and following `work/protocol/spec-template.md`. Read `work/protocol/TASKING-PROTOCOL.md` §2a before writing it: a spec is tasked atomically or not at all, so a draft mixing committed stories with gated ones is a spec that will be refused and split. Give it only stories you would stake the build on, each pointing at the decision that makes it real. If something is still not confidently buildable, say so plainly and leave it out. That is a legitimate, useful outcome, and it is far cheaper than a story an agent builds convincingly and wrongly.
>
> Vocabulary and constraints the slicing must respect (`CONTEXT.md`, and the ADRs it names): a **generation** is a stream plus a fold over it, taking its starting stream as an INPUT; a seeded stream is keyed by the same **stream digest** as a fetched one; a **snapshot**-seeded generation is a LEAF (ADR-0028's retention floor, and it cannot serve a later processor-only change because there is no stream under it to re-fold), while a captured **stream** seed composes with the model. A fixture is not a keeper (ADR-0059) and the keeper seam takes only raw stored events (ADR-0060), so installing writes rather than points. The state-snapshot remote path already exists (`bootstrapFromSnapshot` in `@etherfold/processor-entities`), so mark which slices are new build and which extend what is there.
>
> You also own the single shared-file edit for this whole spec: update `CONTEXT.md`'s `seeding` entry so it describes what was decided rather than only the two shapes. No other task in this spec touches that file, so there is nothing to coordinate with. Just keep the entry in the register the rest of that document uses.
>
> Done means: a follow-on build spec draft a tasker could decompose atomically without inventing anything, an explicit statement of whatever remains unbuildable, and the `CONTEXT.md` entry updated. Change no production code. Do no git operations.
>
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. The runner transcribes it into the done record; do not write the done record, the commit message or the PR body yourself, and do not open a `decisions-*` note.
