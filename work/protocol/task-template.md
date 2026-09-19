---
title: '<Human Readable Title>'
slug: <url-safe-slug>
spec: <source-spec-slug> # slug of the work/specs/ready/<slug>.md this task derives from. REQUIRED iff `covers` is set; OMIT for a self-contained chore/refactor (covers: []).
# humanOnly: true     # gate axis 1 (DECIDED, NARROW): NEVER-for-agents BY NATURE (secrets/release/security). Survives even in the pool work/tasks/ready/. OMIT otherwise — "review this before the agent builds" is the POSITION's job (the task is BIRTHED in work/tasks/backlog/), NOT humanOnly's.
# needsAnswers: true  # gate axis 2 (DISCOVERED): open questions block autonomous work. OMIT otherwise. List them in the body.
# promptGuidance.testFirst: true  # optional per-item NUDGE override: pin the test-first nudge ON (true) or OFF (false) for THIS task, regardless of the repo's resolved policy. OMIT to inherit (spec, else repo). NEVER an acceptance criterion — `verify` still decides pass/fail.
blockedBy: [] # slugs that must reach work/tasks/done/ first; [] = startable now
# THREE OR MORE blockers: use the BLOCK form below, never the inline one. An inline list past
# Prettier's printWidth is reformatted into a multi-line FLOW list, which the runner parses as
# EMPTY -- so the item becomes claimable before its blockers land, with no warning. `check:graph`
# refuses it, and a fan-in is exactly where it bites (see ADR-FORMAT.md on the last task in a chain):
#   blockedBy:
#     - first-blocking-slug
#     - second-blocking-slug
covers: [] # optional: user-story numbers within `spec` this task covers
---

<!-- open-questions -->
<!--
  TRANSIENT BLOCK — stripped by the apply rung on full resolution.
  While the task has unresolved questions blocking autonomous build:
    1. Set `needsAnswers: true` in the frontmatter above.
    2. List the questions under the `## Open questions` heading below.
    3. Clear the flag (and let apply strip this block) once they are answered.
  Delete the whole fenced block — markers and all — if the task launches fully resolved.
-->

## Open questions

1. <question one>
2. <question two>

<!-- /open-questions -->

## What to build

A concise description of this vertical task — the end-to-end behaviour (a thin path through every layer: schema → logic → API/UI → tests), NOT a layer-by-layer implementation plan. Avoid specific file paths / code snippets (they go stale).

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose (state machine, reducer, schema, type shape), inline just the decision-rich part and note it came from a prototype.

## Acceptance criteria

- [ ] Criterion 1 (verifiable / demoable on its own)
- [ ] Criterion 2
- [ ] Tests cover the new behaviour (mirror the repo's existing test style)
- [ ] **If this task makes code write to a SHARED / GLOBAL location** (a real home/config dir, a system path, a shared service, an external tool's managed store): tests ISOLATE that location (point it at a temp/scratch dir via the relevant env/config) AND assert the real one is UNTOUCHED after the run. Omit only if the task writes nothing outside its own temp fixtures.

## Blocked by

- None — can start immediately. (or: list the blocking slugs, mirroring `blockedBy` in the frontmatter.)

## Prompt

> Self-contained instructions to paste into a fresh agent context. An agent should be able to start from THIS FILE ALONE — no conversation history needed. State the goal, the relevant domain vocabulary, where to look in the codebase (by module/concept, not brittle paths), the seams to test at, and what "done" means. Reference any `work/notes/findings/*.md` or ADRs that constrain the work.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code in `tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal"). Building on a stale task produces wrong-but-compiling work.
>
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. When the task did not specify some behaviour and you have to CHOOSE (a new refusal/exit code, a clamp that reaches a second code path, a fail-loud-vs-fail-safe asymmetry, keeping vs collapsing a now-redundant distinction), do not leave the choice silent for a reviewer to reverse-engineer. That block is the ONE sanctioned channel for build-time rationale, and the runner transcribes it verbatim into the done record in the same commit as the done-move. So do NOT try to write the done record, the commit message, or the PR body yourself (you do no git and must not edit the task body), and do NOT open a `work/notes/observations/decisions-<slug>.md` note (an observation is a SPOTTED, UNVERIFIED signal, not a decision you made). If the choice meets the ADR gate (hard to reverse + surprising without context + a real trade-off, see `ADR-FORMAT.md`), ALSO write the durable WHY as an ADR in `docs/adr/` and name it in the block. An un-recorded in-scope decision is a review FINDING, not a silent default.

---

### Claiming this task

```sh
# atomically claim it (works with a GitHub remote OR a local --bare remote):
dorfl claim <slug> --arbiter <remote>      # default --arbiter origin
# then start work on the updated main:
git fetch <remote> && git switch -c work/<slug> <remote>/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/<slug>.md work/tasks/done/<slug>.md
```
