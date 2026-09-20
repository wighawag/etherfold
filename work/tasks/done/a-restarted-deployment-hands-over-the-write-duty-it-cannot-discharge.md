---
title: 'A restarted deployment goes on APPENDING to the stream it fetches, so a stored stream does not silently stop growing'
slug: a-restarted-deployment-hands-over-the-write-duty-it-cannot-discharge
blockedBy: [whoever-fetches-a-stream-writes-it-and-the-stream-outlives-every-fold]
covers: []
---

## What to build

The defect this whole family exists for, closed and asserted END TO END on its own measured scenario.

> **Why the slug says "hands over".** This task launched as a defect report proposing that the write duty be HANDED OVER to the fold that is present. It was built, and it STOPPED: the diagnosis reproduced exactly, but the premise that the existing machinery could hand the duty over was false, and handing it over duplicated the whole history. ADR-0087 is the decision that came out of that stop, and under it there is no hand-over at all -- the deployment that fetches appends, so a restart never loses the pen it never held. The INTENT is unchanged and the body below is re-scoped to it. The slug is kept because it names the DEFECT (a deployment handing over a duty it cannot discharge), because two documents cite this task, and because its branch is preserved on the arbiter under it.

**The defect, as measured.** Restart a `run` deployment with a changed processor over the same database. The container comes up holding exactly one fold, the successor. Nothing appends to the stored emission stream while that successor happily consumes the wire and folds it. No refusal, no warning, and the state itself looks fine. The mechanism was the one-writer rule working exactly as specified in a shape nobody considered it against: the duty belonged to the incumbent, which is registered but not HELD, and the fold that IS present was correctly refused it.

Three tasks land before this one and between them they remove the cause. What is left, and what this task owns, is proving it on the original scenario and finishing the edges the earlier pieces were told not to reach into.

**The numbers this must land on, because they are what the family was measured against.** On the defect's own reproduction -- a `run` stood up the way the CLI's promotion-policy test stands one up, stopped, and re-run over the SAME handle with an edited bundle:

```
today                  `_emissions` holds 2 rows and NOTHING appends afterwards.
naive hand-over        `_emissions` holds 4 rows where 2 are correct: the whole history, stored twice.
what this must show    the stream GROWS from 2, with no range stored a second time.
```

A test that asserts "appends happened" without asserting that nothing was stored twice does not cover this task, because the rejected option passes it.

## Acceptance criteria

- [ ] A deployment restarted over the same database with a changed processor APPENDS to its stored stream, asserted end to end through the CLI over a real handle rather than at a unit seam.
- [ ] No range is stored twice across that restart, asserted on the stored rows against the measurement above. Both halves are required; either alone is satisfied by a behaviour this family rejected.
- [ ] A deployment that DOES hold its own incumbent is unaffected, and the reconfigure path through the running endpoint is unaffected.
- [ ] A generation that is registered but not HELD still ANSWERS READS exactly as it does today (ADR-0053: a read resolves a pointer to a table namespace, never to an engine). Nothing in this family makes an unheld generation less readable.
- [ ] The stream SURVIVES the restart-and-replace end to end: after the successor replaces what the `successor` slot held, the bytes the earlier fetches bought are still there and are what the new fold re-folds.
- [ ] The original task's criterion about whether a hand-over is permanent or returned is answered by stating that it DISSOLVED -- there is no hand-over under ADR-0087 -- rather than dropped silently. If you find a residue of transferable duty still in the code, that is a finding and this criterion is not met.
- [ ] Operator-facing output no longer explains behaviour that no longer exists, and `/status` still reports one entry per generation held.
- [ ] The citations of THIS task in `docs/adr/0087-...` and in the retention spec resolve after this task's done-move. See the note below; `pnpm check:refs` is part of the gate and it runs BEFORE the done-move, so a citation updated to `done/` here fails the gate while a citation left naming `ready/` breaks `main` after it. Neither is acceptable and the conductor removed the trap in advance; CHECK that it is still removed rather than assuming it.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`whoever-fetches-a-stream-writes-it-and-the-stream-outlives-every-fold`, and through it the two tasks before that. This is the family's fan-in: the three before it change the mechanism, and this one proves the defect is gone on the scenario that found it.

## Prompt

The goal is that restarting a deployment with a changed processor never silently stops recording the stream it is folding, and that proving it does not accept the failure the family already rejected.

Read ADR-0087, which is the decision, and its section "The defect that forced it", which is this task's subject stated by the decision itself. `work/questions/task-a-restarted-deployment-hands-over-the-write-duty-it-cannot-discharge.md` carries the full stop report and the measurements in both directions; it is the best account of the problem and it is worth reading before you write a line. ADR-0044 is why a generation on a shared stream fetches nothing; ADR-0052 and ADR-0055 are why a duplicated range is corruption rather than waste.

**This is an acceptance task, and the thing most likely to go wrong is that it turns out to be VACUOUS.** Three tasks land before it and they may already have asserted some of what is above. If so, VERIFY each criterion and say which were already covered and where, rather than writing a second copy of an existing test. If you find that all of it is already covered and there is genuinely nothing to build, do NOT manufacture work: say so plainly and stop. A task that reports "already delivered, here is where, here is the evidence I checked it" is a good outcome for a fan-in; a task that pads is not.

The second thing most likely to go wrong is asserting the wrong quantity. "It appends" was true of the option this family rejected, which also stored the history a second time. Assert the stored rows, and assert the chain reads, the way every strong measurement in this family did.

The third: this task's own ADR and the retention spec both CITE it by path. The gate's reference check runs before the runner moves this file to `done/`, so the two orderings that seem obvious both fail -- one at the gate, one on `main` afterwards. The conductor changed both citations to name this task by SLUG instead of by path precisely so the move is harmless. Confirm that is still the case before you finish; if a new path citation has appeared, resolve it the same way rather than by updating the folder.

The seam to test at is the CLI's own deployment tests, over a real handle, restarted with an edited bundle.

Done means: a restarted deployment appends, nothing is stored twice, an unheld generation still answers reads, the stream survived, and the dissolved criterion is stated rather than dropped.

FIRST, check this task against current reality. It is the launch snapshot of a re-scope, written before its three blockers were built, so it is MORE likely than usual to have drifted. If what landed contradicts this body, say so and do what is right. This task has already been right to stop once.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT, including which criteria you found already covered and by what. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.

## Decisions

**Which criteria were already covered, and by what.** Criterion 1's wire half and criterion 2's no-duplication half are covered by `packages/cli/test/aRestartReFoldsTheStoredStream.test.ts`; I did not copy them. What is NOT covered there is **growth**, because that file's restarted chain serves the same logs and the same tip, so its stream cannot grow and "appends" is unassertable in it. Criterion 6's behavioural half is covered by `packages/core/test/rebuild.test.ts` ("DROPS the superseded generation on promotion and KEEPS its stream") and `aSuccessorLandsInADurableSlot`; what was NOT covered was the residue in the type and the prose, which is this task's finding. Criterion 8 needed verification only, and it holds. Everything else (criteria 3, 4, 5, 7's `/status` half) had no end-to-end CLI assertion and is what the new file adds.

**The negative control is not re-run, and no sabotage hook ships.** The prior attempt proved the test's sensitivity by suppressing the append in `packages/core/src/stream/writer.ts`; that configuration grows without bound and OOM-killed two builds. I deleted both hooks rather than bounding them: a `globalThis`-reachable sabotage switch in a published package is a defect on its own. The alternative considered was an out-of-tree patch harness under `docs/spikes/`; rejected as manufacturing work, because the measurement the task actually asks for (the stored rows plus the recorded `eth_getLogs` ranges) is stronger than a suppression and the test already takes it. This touches `work/notes/observations/a-stream-writer-whose-append-silently-does-nothing-grows-without-bound.md`, which stays an open, unreachable-on-today's-code robustness finding and is not mine to chase.

**`DeclinedReclaim.reason` is narrowed to one member rather than left unreachable, and it stays a union.** Deleting `'writes-a-followed-stream'` is a breaking type change on a published package; keeping it would have been a reason an operator can read in the type and never receive, which is the class of thing criterion 7 exists to remove, and the previous release note already told readers it was gone. I kept the field a one-member union rather than collapsing it to a string literal in the report shape, so a second decline reason can be told apart without a shape change. Touches `@etherfold/server`'s `reclaim-generations` response, which carries `reason` verbatim, and the `whoever-fetches-a-stream-writes-it` changeset, whose claim this makes true.

**`unslottedGenerations`' JSDoc was corrected rather than left ambiguous, on a checked fact.** It lives in shared `@etherfold/core` and reads as though the strand clause still applies somewhere; its only callers are `ReceivingIndexer.reclaim` and the server's admin listing, both receiving-side, so the clause has no subject at all there. The chain-facing `Indexer`'s own strand clause in `container.ts` is UNTOUCHED and still live, because ADR-0087 deliberately did not restructure the browser engine (a generation still fetches there). `CONTEXT.md` now states that difference explicitly instead of stating the retired rule flatly.

**No new ADR.** Every correction above is ADR-0087's own stated substance catching up with the code; a second number would fork the record, which is the reasoning the blocker's builder gave and I see no reason to depart from it.

**One process note, not a design decision:** reverting the sabotage hook with `git checkout origin/main -- packages/core/src/stream/writer.ts` staged that one path. The file's content is identical to `main`, so the net diff is empty and the runner's `git add -A` sees the same tree either way; I did not stage, commit, move or push anything else.
