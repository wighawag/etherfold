<!-- dorfl-sidecar: item=task:a-restarted-deployment-hands-over-the-write-duty-it-cannot-discharge type=task slug=a-restarted-deployment-hands-over-the-write-duty-it-cannot-discharge allAnswered=false -->

## Q1

**'task:a-restarted-deployment-hands-over-the-write-duty-it-cannot-discharge' was bounced — how should we proceed?**

> The task's DIAGNOSIS is correct and reproduces; its PREMISE that the existing machinery can be made to hand the duty over is what is false, and the decision it turns on is neither made nor named anywhere in the task.
>
> MEASURED, both directions, on the task's own scenario (`run` stood up as `packages/cli/test/theDeploymentSelectsItsPromotionPolicy.test.ts` does, stopped, re-run over the same libSQL handle with an edited bundle):
>
>   today                      `_emissions` holds 2 rows, `writesStream: false`, nothing appends. Exactly as the task says.
>   naive hand-over            `_emissions` holds 4 rows where 2 are correct. The whole history, stored a SECOND time.
>
> (The second was taken by patching `ReceivingIndexer.add` so a fold takes `writesStream` when the generation `writerOf` names is not held here, rebuilding `@etherfold/core`, and re-running. The patch is reverted; no source change is left behind.)
>
> WHY. The restarted successor's state is EMPTY, so its receiver fetches from `defaultFromBlock` — the recorded `eth_getLogs` ranges begin at 1000000 while `_emissions` already covers 1000000..1000050. Handing it `appendEmissions` re-appends that range, which is the "second history for every generation that re-folds it" that `ReceivingIndexer.add`'s own JSDoc, ADR-0052 and ADR-0055 forbid, and the same failure shape ADR-0071 section 1 measured (8 stored events where 4 are correct) when it rejected ITS candidate rule.
>
> WHAT THE TASK ASSUMES AND THE CODE CONTRADICTS. The Prompt says `reconcileWriters` / `handOverTheWire` are "the machinery that already exists for moving the duty and which currently declines to". That machinery is safe only because of `origin.level`, and ADR-0044's second amendment states why in terms: a receiver answers `expectedFromBlock` from its OWN fold position, so a fold that is behind must not take the wire. On this path `level` is a lie — `receivingContainer.ts` sets `level: !follows` at `add`, justified as "the wire is what feeds it", which is true for a fold whose stream nobody has stored and false for this one. It cannot simply be made honest: `reconcileWriters` runs once per fetch cycle, so the fold is observed BELOW the stream's coverage and then ABOVE it and never ON it. Handing over below duplicates `(position, coverage]`; handing over above leaves a HOLE of up to one batch minus the finality window between the coverage and the new writer's first `expectedFromBlock` — the silent, permanent, self-consistent damage `CONTEXT.md` defines under "hole versus gap". There is no observation point that is neither.
>
> THE UNRESOLVED DESIGN DECISION, which is load-bearing and hard to reverse because it decides the BYTES of the stored emission stream for every restarted deployment: WHAT DOES AN INHERITING WRITER DO ABOUT THE STREAM PREFIX THAT ALREADY REACHES FAR ABOVE ITS OWN FOLD POSITION? Two candidate answers, neither a detail:
>
>  (A) THE FOLD CATCHES UP THROUGH THE STORED STREAM, i.e. a restarted successor is a FOLLOWER, lands exactly on the coverage, and is then handed the wire by the `reconcileWriters` that already exists. This is ADR-0044's own design ("a generation on a SHARED stream is a follower") and it is what the reconfigure path already does — and it needs `follows` in `ReceivingIndexer.add` to stop being `this.folds.some(...)` (this process's in-memory array, the very source ADR-0071 section 1 condemned and fixed in the chain-facing twin) and derive from `writerOf` instead. But `run` and `build` STRUCTURALLY CANNOT HOLD A FOLLOWER AS THEIR OPENING FOLD: `packages/cli/src/folding.ts:583` takes `container.ingestion`, whose getter throws "the opening fold of this ReceivingIndexer has no receiver, which `open` cannot produce", and `driveCycles` skips `rebuildMore` entirely under `stopAtTip`, so `build` would fold nothing at all. That is a restructuring of the CLI's fetch assembly, not a defect fix, and it contradicts this task's "Blocked by: None. It can start immediately."
>
>  (B) THE INHERITING WRITER CONTINUES FROM THE STREAM'S COVERAGE — ADR-0044's own words for succession — meaning its appends below the coverage it inherited are SUPPRESSED and the claim is never lowered. This is a NEW persisted-stream mechanism (the container has no way to read a stream's coverage today: `ReplaySource` is `readChunk` and nothing else, so the port grows), and it carries a real, statable hazard that belongs in an ADR rather than in a defect fix: a reorg that happened BELOW the coverage while the deployment was down is folded into the successor's STATE but suppressed from the STREAM, so a third generation re-folding that stream derives a different state. Note it must NOT be pushed down into `appendEmissions`, which legitimately writes below the coverage on every reorg.
>
> Both are ADR-gate material (hard to reverse, surprising without context, a real trade-off), and a reviewer would rightly be surprised to find either decided inside a task framed as "a data-loss defect, measured, with no feature in front of it".
>
> WHAT IS NOT THE PROBLEM, so the re-scope does not chase it: this is NOT retention (`a-generation-retains-the-code-that-folds-it`), and the durable half of "the duty follows what is HELD" is tractable on its own — record the incumbent's stand-down as a durable registry fact (a monotone, permanent mark on the record, NOT an elected-writer pointer, so `writerOf` stays a pure function of the records, delete-succession stays atomic with the delete, and every reader derives the same answer independently). That half is buildable exactly as this task describes. It is the ENGINE half that is blocked.
>
> SUGGESTED RE-SCOPE, as two items:
>
>  1. Decide (A) vs (B) first, as a spec or an ADR, since it decides what a restarted deployment's stored stream LOOKS LIKE. My reading is that (A) is the right answer — it is the design ADR-0008 and ADR-0044 already state, it makes the restart upgrade cost a local scan instead of a full re-fetch (see `work/notes/observations/a-restarted-run-refetches-the-whole-chain-instead-of-refolding-the-stored-stream.md`, written this session), and it needs no new stream semantics — but it must be tasked WITH the CLI work it requires: `run`/`build` driving `liveIngestions` rather than one captured `container.ingestion`, and `build` settling and rebuilding before it exits (which is already the open observation `a-rerun-build-registers-a-successor-and-exits-without-ever-settling-the-pointer`).
>
>  2. THEN this task, unchanged in intent, on top of that: `writerOf` reads a durable stand-down so the duty follows what is HELD with one home, `reconcileWriters` records it and hands the wire to the level fold, and the ADR states the permanence (my recommendation: permanent, never returned if the incumbent's fold reappears, because a monotone mark is what makes the answer converge instead of oscillate between two processes that hold different folds).
>
> Re-scoping this task to ONLY the durable half (the stand-down + `writerOf` + `reconcileWriters` agreeing) is also viable and lands real value, but its first acceptance criterion ("a restarted deployment ... APPENDS to its stored stream, asserted end to end") cannot then be met, so the criterion would have to be rewritten rather than quietly reinterpreted.

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):

ANSWERED 2026-09-19 by **ADR-0087**, "A stream is written by whoever FETCHES it, never by a GENERATION, and it OUTLIVES every fold over it" (`docs/adr/0087-a-stream-is-written-by-whoever-fetches-it-and-outlives-every-fold-over-it.md`). Recorded by the conductor; the decision is the ADR's, not this sidecar's.

The report above asked for a choice between (A) the fold catches up through the stored stream and (B) the inheriting writer continues from the stream's coverage. **(A) is taken, and the ADR goes one step further than the question did.** (B) is rejected by name: suppressing appends below an inherited coverage carries a reorg hazard -- a reorg that happened below the coverage while the deployment was down is folded into the successor's STATE but suppressed from the STREAM, so a third generation re-folding that stream derives a different state.

The extra step is that the write duty comes OFF the generation entirely. The report's own suggestion 2 kept the duty a generation's and made it transferable by a durable stand-down mark; the ADR rejects that as the primary answer while agreeing it is a sound mechanism, on the ground that it "makes the duty transferable without making it correct" -- the newcomer is still BEHIND the stream, so the ahead/behind problem the report measured is untouched, and a role stays on the generation that does not belong to it. An elected-writer POINTER is rejected for the reasons the report itself would have given: it turns a derivable fact into a coordinated one, two processes can disagree, it can oscillate, and delete-succession stops being atomic with the delete.

So the re-scope is FOUR tasks and not two, and this task is the LAST of them rather than the second:

1. `run-and-build-drive-the-folds-they-hold-rather-than-one-captured-receiver` -- the CLI restructure the report correctly identified as a blocker.
2. `a-restarted-generation-re-folds-its-stream-instead-of-re-fetching-the-chain` -- the `follows`-from-the-registry fix, plus making an unknown stream position REFUSE.
3. `whoever-fetches-a-stream-writes-it-and-the-stream-outlives-every-fold` -- the duty moves off the generation, and the automatic stream reap goes.
4. this task, re-scoped to the end-to-end closure of the defect on its own measured scenario.

One correction to the report, measured rather than argued. It ordered the `follows` fix BEFORE the CLI restructure, and ADR-0087 repeats that order. It does not work: patching `ReceivingIndexer.add` to derive `follows` from the registry and running the suite puts **25 CLI tests red**, 17 of them on `the opening fold of this ReceivingIndexer has no receiver`. The restructure is the EXPAND step and the derivation fix is the MIGRATE step, so they are tasked in that order. (Measured in a throwaway clone and reverted.)

The observation the report ended on -- that a restart re-fetches the whole chain -- was filed and is `work/notes/observations/a-restarted-run-refetches-the-whole-chain-instead-of-refolding-the-stored-stream.md`. It is discharged by task 2 above.

## Q2

**'task:a-restarted-deployment-hands-over-the-write-duty-it-cannot-discharge' was bounced — how should we proceed?**

> agent failed: Warning: No models match pattern "ollama/glm-4.7:cloud"

<!-- q2 fields: id=q2 kind=stuck -->

**Your answer** (write below this line):
