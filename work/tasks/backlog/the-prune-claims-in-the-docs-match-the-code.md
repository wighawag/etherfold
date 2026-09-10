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
- [ ] `grep -rn "no pruning at all" docs work` returns only text carrying the dated amendment.
- [ ] `pnpm check:refs` and `pnpm check:adr` stay green.

## Blocked by

None, can start immediately.

## Prompt

Read `work/notes/findings/sqlite-in-the-browser.md` and find the pruning sentence (near the end, beside the note that retention is enforced by pruning). Then read `prune` in `packages/state-store-sqlite/src/store.ts` and `packages/state-store-indexeddb/src/store.ts` and confirm the current truth yourself before writing anything.

Domain vocabulary: a **finding** is VERIFIED ground truth and is durable. It is corrected by AMENDMENT rather than rewriting, because its value is that its claims can be traced to when they were measured.

Note the gate barely covers this task: `.prettierignore` excludes `docs/` and `*.md`, so `format:check` never sees your edits and an empty diff would pass everything else. The grep criterion above is the real check; satisfy it honestly.

If you find further drift while reading, capture it as a `work/notes/observations/` note rather than fixing it here.

Done means a reader meeting the old claim is not misled, and the amendment says what is true now and what was true then.
