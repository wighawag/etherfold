---
title: 'A reload that changed nothing says whether the CODE changed, so a static version stops being silent'
slug: a-reload-that-changed-nothing-reports-processor-drift
blockedBy: []
covers: []
---

## What to build

The second opinion this system already computes, reaching the one place it matters most.

`an-endpoint-triggers-a-reconfigure-in-a-running-process` shipped three outcomes, and `unchanged` is truthful but ambiguous in a way that costs a developer their afternoon. A generation is identified by `getVersionHash()`, which is the DECLARED version plus the entity and config declarations, and not by the text of the handlers. So a developer who edits a handler body, saves, and calls the endpoint is told that nothing changed, and that answer is correct and useless: it looks identical to a save that genuinely changed nothing. Their edit is not being ignored because of a bug; it is being ignored because their `version` is static, and nothing tells them so.

The system already knows. `getCodeFingerprint()` exists for exactly this and `fingerprint.ts` says so in as many words: it is "the second opinion, derived from the handler implementations themselves, so that 'declared version unchanged but the code underneath it changed' becomes something the core can SAY rather than something nobody can see". The chain-facing `Indexer` says it, in `reportProcessorDriftIfAny`, with a `PROCESSOR DRIFT` message that names both fingerprints and tells the author to bump `version`.

The receiving side does not. It WRITES the fingerprint into the cursor context (the stream builder and the generation rebuild both record it) and never once compares it, so `run`, `index` and the reconfigure endpoint all hold the fact and none of them report it. Close that: the receiving container reports drift the way the chain-facing one does, and the reconfigure endpoint's `unchanged` outcome carries the answer, so "I saved and nothing happened" stops being indistinguishable from "your version has not moved since the day you wrote it".

**The fingerprint stays ADVISORY, and this task must not weaken that.** It never enters an identity, never discards state, and never causes a generation to be registered on its own. `fingerprint.ts` records why (a bundler or minifier re-emitting the same behaviour differently would otherwise force a full replay with no logic change), and this task is the half of that argument that pays off: the false positive is a log line rather than a rebuild, which is only true if something actually says the line.

## Acceptance criteria

- [ ] A reload that finds the same identity but DIFFERENT handler code is distinguishable, in the endpoint's answer, from one that finds the same identity and the same code. Both remain successful no-ops; they stop reading the same.
- [ ] The answer names what to do about it (bump `version`), rather than only reporting that two hashes differ.
- [ ] The receiving container reports processor drift in its own right, so a deployment that never calls the endpoint still learns from its logs, matching what the chain-facing indexer already does.
- [ ] The fingerprint remains ADVISORY end to end: no generation is registered because of drift, no state is discarded because of drift, and no identity contains it. Asserted directly, since this is the property the whole shape rests on.
- [ ] Either side of the comparison being absent reports NOTHING, and specifically is never reported as drift. A cursor written before the field existed and a processor that cannot fingerprint itself are both "unknown".
- [ ] A genuine no-op, where the code really is identical, reports no drift, so the signal does not cry wolf on every reload.
- [ ] The existing `PROCESSOR DRIFT` vocabulary and report shape are REUSED rather than a second one invented, so an operator greps for one phrase.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

- None. It can start immediately, and it is independent of the slot and artifact proposals (ADR-0084, ADR-0085), neither of which is accepted.

## Prompt

The goal is that a developer who edits a handler and gets told "nothing changed" is also told WHY, in the same answer, instead of concluding the endpoint is broken.

Read `packages/core/src/utils/fingerprint.ts` first and in full: it defines what a code fingerprint is, states that it is advisory and stays out of `getVersionHash()`, and lists precisely what it survives and does not (it survives restarts, reformatting and handler re-ordering; it does NOT survive minification, a change of transpiler or target, or a comment edit under a toolchain that keeps comments). Those limits are why the report must be phrased as a question for the author rather than a verdict. Then read `reportProcessorDriftIfAny` in `@etherfold/core`'s chain-facing indexer, which is the existing implementation, its message and its `ProcessorDriftReport` shape. Then the receiving container and the reconfigure module in the CLI, which is where the gap is.

Note what already exists so you do not rebuild it: the receiving side already STORES `processorFingerprint` (the stream builder and the generation rebuild both write it into the cursor context), and the reconfigure path already holds a freshly imported module, because defeating the module cache is what that endpoint does. Both halves of the comparison are in hand; nothing new needs computing.

The decision most likely to be got wrong is WHICH two fingerprints to compare, and the two candidates answer different questions. The STORED one (what `reportProcessorDriftIfAny` uses) answers "the persisted state was computed by different logic", which is the boot-time question. The INCUMBENT'S LOADED one answers "the module I just re-read differs from the one I am running", which is the reload question and the one a developer saving a file is actually asking. They can disagree: a process that has been running since before a drift was introduced holds a loaded fingerprint matching its stored one, while a freshly imported module differs from both. Decide explicitly, say which question each surface answers, and do not silently use one where the other is meant.

The second: do not refresh the stored fingerprint after reporting. The existing docstring explains why and the reason is load-bearing: it describes the code that PRODUCED the state, so the report must repeat until the author bumps `version` rather than going quiet once seen.

The third: resist making drift do anything. It is tempting to register a generation when the code drifted, since that is "what the developer meant". That would fold the fingerprint into the identity through the back door and reintroduce exactly the full-replay-on-a-re-minification failure `fingerprint.ts` rejects. Report, and let the author act.

The seam to test at is the reconfigure path's existing tests, where a module is already edited between two calls, plus the receiving container's own tests for the reporting half. The claim worth asserting is "a handler-body edit with a static version produces a reload that says the code drifted, and still registers nothing".

Done means: the three outcomes stay three, `unchanged` splits into two readings that an operator can tell apart, the advisory property is intact and asserted, and nothing is registered or discarded that was not before.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise -- route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. Which two fingerprints each surface compares, and what the endpoint's answer carries for a drifted no-op, are both such decisions. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.

## Decisions

**Which two fingerprints each surface compares, and it is said in the type.** The receiving container asks the BOOT question: the STORED cursor's fingerprint against the code loaded now ("the state I am about to serve was computed by different logic"), matching `IndexerGeneration`. The reconfigure endpoint asks the RELOAD question: the RUNNING fold's loaded fingerprint against the module just re-imported ("the code I have just read differs from the code I am running"), because that is what a developer who pressed save is asking, and it is the only one true of an edit made after a process came up with no drift. They can disagree, so I made the answer explicit rather than implied by provenance: `ProcessorDriftReport` gains `compared: 'persisted-state' | 'reloaded-module'`. Alternative considered: use the stored fingerprint on the endpoint too (one comparison, but it answers the wrong question and would stay silent for exactly the developer this task is for); or leave the question implicit in the prose (a host routing both into one alert channel could not tell them apart). Touches: `ProcessorDriftReport` consumers (core only, plus the new `ReconfigureReport.drift`).

**`storedFingerprint` renamed to `previousFingerprint`.** On the reload question nothing about that value is stored — the running fold's cursor may carry a third value — so keeping the old name would make one field mean the cursor in one report and a loaded module in another, which is the coherence failure the brief warns about. Alternative considered: a discriminated union with different field names per arm (honest, but duplicates the shape and forces every consumer to switch). This is a breaking type change to a published `0.x` package with no external consumers; it is in the changeset. Touches: `packages/processor-sqlite/test/version.test.ts` and `packages/core/test/processorDrift.test.ts` (both read the report).

**Drift is carried ON `unchanged`, not made a fourth outcome, and it replaces the message rather than appending to it.** Nothing was registered and nothing changed, which is exactly what `unchanged` means; a fourth outcome would be the first step towards acting on an advisory signal. The drift message already states that the identity did not move, that nothing was registered and what to do about it, so appending the generic explanation would repeat the only sentence that matters. Absence of `drift` covers both "the code is identical" and "one side cannot be fingerprinted", deliberately — I did not invent a third reading for *unknown*. Touches: `ReconfigureReport` (`@etherfold/server`), the admin route's JSON body, any watcher reading it.

**`processorDriftReport` is exported from `@etherfold/core`; `announceProcessorDrift` is not.** The reload comparison can only be made where a module is re-imported, which is the CLI, and a message assembled there would be a second `PROCESSOR DRIFT` phrasing for an operator to grep. Where a report GOES, though, is the caller's: the CLI logs through its own logger and hands the report back on its response.

**The receiving container relays drift from EVERY held fold, unlike the chain-facing one, which filters to the canonical entry.** A generation that answers no read yet is precisely the one being built to answer them next, and a report suppressed until promotion would arrive after the upgrade it was about; `processorHash` names which fold it is about. Touches: `ReceivingIndexer.onProcessorDrift` consumers (none today; the log is the deployment-facing surface).

**`FoldParts` gains `codeFingerprint`** in `packages/cli/src/folding.ts`, beside `versionHash`, taken from the author's own declared object exactly as `EntityEventProcessor.getCodeFingerprint()` takes it — one formula, one spelling — so the re-read compares like with like. It enters no identity and nothing branches on it. Touches: `openFolding` and `reconfigure.ts`, the two callers of `foldPartsFor`.
