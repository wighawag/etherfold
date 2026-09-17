---
title: 'The CHAIN-FACING container holds its generations in slots, so a browser tab survives an afternoon of reloads'
slug: the-chain-facing-container-holds-its-generations-in-slots
spec: a-save-replaces-the-pending-successor
blockedBy: [a-successor-lands-in-a-durable-slot-that-holds-one]
covers: [3]
needsAnswers: true
---

## What to build

The same decision, in the twin where it matters most.

`a-successor-that-was-never-canonical-is-superseded` scoped itself to the RECEIVING container and deliberately left `Indexer` (`container.ts`, chain-facing, what a browser tab runs) unchanged. That was defensible for an IN-MEMORY rule and is wrong for a durable one, because the browser is the shape that suffers worst from exactly what slots fix. A page reload is a fresh process with an empty memory, so no in-memory rule survives it. `BROWSER_GENERATION_CAPS` is two of each, the tightest in the system. And a developer reloads a tab constantly. So today's rule protects the long-lived server process, which accumulates slowly, and misses the tab, which accumulates every few minutes and hits a cap of two almost at once.

Port slots to the chain-facing container: the same three durable slots, the same replacement on registering into an occupied `successor`, the same rule that `canonical` and `predecessor` are unreachable from a replacement. The twins are not identical and this is why it is a task of its own: the chain-facing container keeps `everCanonical` as a boolean on the entry rather than a set of held folds, its caps are the browser's own numbers, and its state lives in a keyspace per generation rather than a table namespace.

## Acceptance criteria

- [ ] Registering a successor in the chain-facing container while one is pending REPLACES it, leaving the incumbent plus one.
- [ ] That holds across a RELOAD, which for this container is the restart case: a fresh container over the same durable storage replaces what it finds in the slot rather than adding beside it.
- [ ] A browser-shaped deployment at `BROWSER_GENERATION_CAPS` no longer reaches its bound through repeated reconfiguration, which is the practical deliverable.
- [ ] `canonical` is never touched by a replacement, and a generation a revert needs is never replaced. Asserted directly, as in the receiving twin.
- [ ] The retired generation's state is actually reclaimed in this container's own storage shape, not merely unregistered.
- [ ] The two containers now say the same thing with the same words, so a reader moving between them meets one concept and not two dialects of it.
- [ ] The caps are UNCHANGED.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`a-successor-lands-in-a-durable-slot-that-holds-one`. The receiving container goes first because it owns the reconfigure endpoint and the richer test setup, so the shape is settled there and ported here rather than designed twice.

## Prompt

The goal is that an in-browser indexer can be reconfigured as often as a developer likes without meeting a cap of two.

Read **ADR-0084** and then the receiving container's implementation of it, which landed first and is the reference. Then read the chain-facing `Indexer` in `@etherfold/core`, particularly its `everCanonical` flag on the entry, its `arrangeDrop`, and how its state is stored per generation; plus the browser package's host, which is what actually runs it. ADR-0053 contrasts the two storage shapes (a keyspace per generation in the browser against a table-name namespace in SQL), and that contrast is the main reason this is a port rather than a copy.

The decision most likely to be got wrong is how much to share. There is a real temptation to hoist the slot logic into something both containers import, and a real cost to it: the two differ in storage, in caps, in what a fold IS, and a shared abstraction that papers over those tends to grow options until it is harder to read than either. Decide deliberately between sharing the rule and repeating it, say which you chose, and if you repeat it, make the two read alike so the duplication is legible.

The second: the browser's cap of two is not headroom, it is the whole budget. Under three slots a tab could name `canonical`, `successor` and `predecessor` and exceed two generations. Work out what the browser's numbers mean under slots BEFORE you build, and if `predecessor` retention cannot coexist with a cap of two, say so rather than quietly dropping the revert promise: that is a needs-attention signal, not a silent trade.

The third: this container is what a user's app holds. A reload that briefly answers nothing is worse here than anywhere, because there is a UI attached to it.

The seam to test at is the browser package's existing indexer tests over its real storage, reconfiguring repeatedly and asserting on what survives, plus a second container opened over the same storage to stand in for the reload.

Done means: a tab reconfigures repeatedly and holds one successor, a reload does not accumulate, the revert target survives, and the two containers describe generations in the same words.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise -- route the task to needs-attention with the discrepancy as the reason.

> **FORWARD-POINTER (planted by the conductor).** ADR-0084 carries `status: accepted, not yet implemented`. That line is a claim about the code and it expires when the code lands. `a-successor-lands-in-a-durable-slot-that-holds-one` deliberately left it in place, saying the LAST task in the family removes it, and THIS IS THAT TASK: the receiving slot, the arming and the reclaim verb have all landed by the time this one starts, and the chain-facing twin is the last of ADR-0084's family. So REMOVE that status line from `docs/adr/0084-*.md` as part of this change. Check rather than assume -- confirm the other three are in `work/tasks/done/` -- and say which you did. (ADR-0085's line is NOT yours: `an-hmr-update-reconfigures-the-tab-it-is-running-in` removes that one.)

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. Whether the rule is shared or repeated, and what the browser caps mean under three slots, are both such decisions. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.

## Requeue 2026-09-17

GATE-3 BLOCK, requeued to CONTINUE from this branch. Keep everything already built; one defect to fix.

THE DEFECT. A reload over durable storage builds the CANONICAL generation as a FOLLOWER, so the tab silently stops fetching while its status and state still look healthy. Your own observation note (a-reloaded-container-makes-its-canonical-generation-a-follower) found it and is why this was catchable; the point it makes is decisive, that a loud cap refusal became a silent stall, and that is a regression this change introduces by making the path reachable.

THE CAUSE, which is narrower than that note assumed. `Indexer.add`'s comment says `writerOf` and `alreadyOnThisStream` 'now give the same answer here, always', because 'a record being added always sorts LAST'. That holds only while the record being added is NEW. On a reload the container re-adds a generation that is ALREADY REGISTERED, so `create` finds the existing record and it keeps its earliest `createdAt` and sorts FIRST. With canonical A and leftover successor B: `writerOf` names A (correct, A writes) while `alreadyOnThisStream` is non-empty and makes A follow (wrong). The two forms diverge in exactly one case, a record that already exists, which is what a reload is.

THE FIX, three parts. (1) Derive `follows` from `writerOf` in `Indexer.add`, and correct that comment, which is now provably wrong rather than conservative. (2) Add the assertion that would have caught this: the existing reload test checks slot contents and never checks that the reloaded container still FETCHES. (3) Amend ADR-0071, whose rejection of the `writerOf` form is superseded now that ADR-0072 supplies the stable ordering it lacked.

DO NOT widen this. The reconciliation half is NOT needed: `readOnlyStream` being baked in at construction only matters when the writer changes while a fold is held, and the reload case needs only the INITIAL derivation to be right. Do not touch the receiving container, which already uses `writerOf` correctly.

KEEP everything else: the slot port, the replacement rule, the reload replacement case, canonical and predecessor unreachable from a replacement, the IndexedDB database actually deleted, `everCanonical` removed from the entry, the cap arithmetic (a third generation REFUSED rather than the revert target evicted) and its ADR-0084 amendment, the removed ADR-0084 status line, and your observation note. Full reasoning is on PR #159.
