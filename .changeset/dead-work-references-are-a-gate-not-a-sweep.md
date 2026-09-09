---
'@etherfold/core': patch
'@etherfold/processor-entities': patch
'@etherfold/state-store-conformance': patch
---

**Comments and docstrings that cited a `work/` artifact by a path it no longer has now cite one that resolves, and a gate keeps it that way.**

No behaviour changes here at all: every source edit is inside a comment. What changed is that the citations were dead. A spec moving `work/specs/proposed/` to `work/specs/tasked/`, or a task moving to `work/tasks/done/`, is the workflow working as designed, and it silently breaks every reference to the old path. Thirty-four such references had accumulated across ADRs, guides, spike READMEs, findings, ideas, specs and seven packages' source, and nothing in the acceptance gate had ever read a path written in prose, so all of them were green.

`pnpm check:refs` (`scripts/check-work-refs.mjs`) now resolves every `work/{specs,tasks,notes}/<folder>/<slug>.md` written in a navigable surface, and distinguishes the two failures that need different fixes: an artifact that MOVED (it names where it went) and one that is GONE (it tells you to cite what replaced it). Historical and terminal surfaces are exempt by design, because a dead path is CORRECT in a frozen record: `.changeset/`, `CHANGELOG.md`, `work/tasks/done/`, `work/tasks/cancelled/`, `work/specs/dropped/`, and `work/notes/observations/` (an observation whose subject is a broken reference has to be able to quote it).

Eleven of the dead references were a second, sharper shape worth naming: they pointed at OBSERVATIONS that had been correctly deleted. The work contract discharges a spent observation by deleting it, with git history as the archive, so a durable comment that cites one by path is a dangling pointer by construction, created by the protocol working rather than by anyone forgetting. Those now cite the observation's SLUG, which is stable, greppable in history, and makes no claim that a file is there to open.

Two were not observations and got real answers instead: `InvalidationVerdict`'s docstring pointed at an idea note retired in `8549133f` and now points at `stream-grafting-what-we-established`, which superseded it; and an idea note pointed at a task rewritten into `abi-versions-are-block-ranged` by `6f2c905b`.
