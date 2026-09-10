---
title: 'The prune claims in the docs match the code'
slug: the-prune-claims-in-the-docs-match-the-code
spec: a-configured-window-is-actually-pruned
blockedBy: []
covers: [14]
---

## What to build

`work/notes/findings/sqlite-in-the-browser.md` states that the SQLite backend "has no pruning at all, so every backend it ships today is effectively `unbounded`". That was true when written and is now false: both backends implement `prune`, and the SQLite one is budgeted and logs what it dropped.

The claim is quoted and load-bearing, so correct it where a reader meets it, without touching the finding's measurements or conclusions.

The corrected statement is narrower and still worth having: no HOST in the repository schedules a prune, so retention is advisory in every DEPLOYMENT even though both backends implement it.

## Acceptance criteria

- [ ] The superseded claim is corrected in place as a DATED AMENDMENT, not a silent edit, so a reader can see what changed and when. The sentence is in `work/notes/findings/sqlite-in-the-browser.md`.
- [ ] The correction distinguishes the two things now different: the backends implement pruning, and no host called it.
- [ ] The same correction is applied to the one other place repeating it, a docstring under `docs/spikes/sqlite-in-the-browser/`. Amending a spike docstring is in scope; changing spike BEHAVIOUR is not.
- [ ] No measurement, table or conclusion in the finding is altered. This corrects a claim about CODE, not evidence.
- [ ] `grep -rn "no pruning at all" work/notes docs/spikes` returns only text carrying the dated amendment. The grep is scoped ON PURPOSE: the same phrase occurs in `work/tasks/done/` records, which are historical and must NOT be rewritten to satisfy a gate.
- [ ] `pnpm check:refs` and `pnpm check:adr` stay green.

## Blocked by

None, can start immediately.

## Prompt

Read `work/notes/findings/sqlite-in-the-browser.md` and find the pruning sentence (near the end, beside the note that retention is enforced by pruning). Then read `prune` in `packages/state-store-sqlite/src/store.ts` and `packages/state-store-indexeddb/src/store.ts` and confirm the current truth yourself before writing anything.

Domain vocabulary: a **finding** is VERIFIED ground truth and is durable. It is corrected by AMENDMENT rather than rewriting, because its value is that its claims can be traced to when they were measured.

Note the gate barely covers this task: `.prettierignore` excludes `docs/` and `*.md`, so `format:check` never sees your edits and an empty diff would pass everything else. The grep criterion above is the real check; satisfy it honestly.

If you find further drift while reading, capture it as a `work/notes/observations/` note rather than fixing it here.

Done means a reader meeting the old claim is not misled, and the amendment says what is true now and what was true then.

## Decisions

- **The amendment does NOT say "no host called it", because that is no longer true, and I proceeded rather than stopping.** Acceptance criterion 2 asks the correction to distinguish "the backends implement pruning, and no host called it", and the task's What-to-build proposes the narrower claim "no HOST in the repository schedules a prune, so retention is advisory in every DEPLOYMENT". That second premise has itself gone stale since the task was written: `the-browser-indexing-loop-schedules-its-prune` (e4755317) and `the-cli-schedules-the-prune-its-retention-implies` (27b6e65e) both landed, so the browser loop and the CLI's `run`/`build` do schedule one. Writing the task's suggested sentence would have put a NEW false claim into a finding, which is exactly the failure this task exists to repair. I therefore satisfied the criterion's INTENT (separate what the backend can do from what a host actually calls) with the verified current state: backends prune; browser and CLI `run`/`build` schedule it; `etherfold index` and bespoke hosts do not. Alternative considered: STOP and route to needs-attention as drift. I judged it not load-bearing and trivially reversible: it is a prose amendment in a note, the core premise of the task (the finding's backend claim is false and must be corrected in place) is intact and confirmed against the code, and the task's own Prompt instructs me to confirm the current truth myself before writing. This touches no code, no flag and no other task; it does mean a reviewer comparing the amendment to criterion 2 word-for-word will see a deliberate divergence, which is why it is recorded here.
- **The superseded sentence is retained verbatim with an inline marker rather than rewritten into past tense.** A finding's value is that a claim can be traced to when it was measured, so the amendment adds and never overwrites. The practical consequence is that the grep phrase still exists in `work/notes/`, which is why the dated marker sits on the SAME LINE as the phrase: any future grep for the stale claim lands on text that immediately declares itself superseded. Alternative considered: editing the sentence to past tense (would have removed the phrase from the grep but made the old claim unquotable and the diff a silent edit).
- **No observation note opened for the spec-level repetitions.** `work/specs/tasked/one-processor-everywhere.md:66` and `work/specs/tasked/a-configured-window-is-actually-pruned.md:14` still carry the old claim, but both specs are explicitly launch snapshots ("records intent at creation, NOT maintained"), so that is contract-sanctioned staleness rather than drift worth a signal, and the grep criterion scopes them out on purpose.
