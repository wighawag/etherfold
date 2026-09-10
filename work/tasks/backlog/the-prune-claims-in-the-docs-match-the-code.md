---
title: 'The prune claims in the docs match the code'
slug: the-prune-claims-in-the-docs-match-the-code
spec: a-configured-window-is-actually-pruned
blockedBy: []
covers: [14]
---

## What to build

`work/notes/findings/sqlite-in-the-browser.md` states that "`@etherfold/state-store-sqlite` has no pruning at all, so every backend it ships today is effectively `unbounded`". That was true when it was written and is now false: both `IndexedDBStateStore.prune` and `VersionedStateStore.prune` are implemented, and the SQLite one is budgeted and logs what it dropped.

The claim is quoted and load-bearing, so correct it where a reader will meet it, without rewriting the finding's measurements or its conclusions.

The corrected statement is narrower and still worth having: no HOST in the repository schedules a prune, so retention is advisory in every DEPLOYMENT even though both backends implement it.

## Acceptance criteria

- The superseded claim is corrected in place, as a dated amendment rather than a silent edit, so a reader can see what changed and when.
- The corrected text distinguishes the two things that are now different: the backends implement pruning, and no host calls it.
- No measurement, table or conclusion in the finding is altered: this is a correction to a claim about CODE, not to evidence.
- Any other place stating that no backend prunes is corrected the same way.
- `pnpm check:refs` and `pnpm check:adr` stay green.

## Blocked by

None, can start immediately.

## Prompt

Read `work/notes/findings/sqlite-in-the-browser.md` and find the sentence about pruning being absent (it sits near the end, beside the note that retention is enforced by pruning). Then read `packages/state-store-sqlite/src/store.ts` and `packages/state-store-indexeddb/src/store.ts` to confirm the current truth for yourself before writing anything.

Domain vocabulary: a **finding** is VERIFIED external or domain ground truth and is durable; it is corrected by amendment rather than by rewriting, because its value is that its claims can be traced. Retention has two halves, refusing a read outside the window (`assertRetained`, at the seam) and physically dropping versions (`prune`), and only the second is missing a caller.

Do not turn this into a code change. If you find further drift while reading, capture it as a `work/notes/observations/` note rather than fixing it here.

Done means a reader meeting the old claim is not misled, and the amendment says what is true now and what was true then.
