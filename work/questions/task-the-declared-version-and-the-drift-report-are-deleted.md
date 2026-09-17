<!-- dorfl-sidecar: item=task:the-declared-version-and-the-drift-report-are-deleted type=task slug=the-declared-version-and-the-drift-report-are-deleted allAnswered=false -->

## Q1

**'task:the-declared-version-and-the-drift-report-are-deleted' was bounced — how should we proceed?**

> The task body's central premise is false: "Four migrate batches have already moved every caller, so this is a removal rather than a change." Every caller that has BYTES was moved. The three arrivals that have NO bytes were deliberately left behind by those same batches, each one deferred IN WRITING to a task that is `blockedBy: [the-declared-version-and-the-drift-report-are-deleted]`. So the deletion cannot land without also building parts of two-to-three blocked tasks, which is a circular sequencing problem a human should resolve rather than a gap I should close by choosing.
>
> WHAT IS FALSE, AND WHERE
>
> 1. THE BROWSER'S MODULE ARRIVAL HAS NOTHING TO FALL BACK TO.
>    - `packages/browser/src/IndexerState.ts:2251-2260` carries a section headed "## WHY THERE IS NO `processorIdentity` HERE", stating that `updateProcessor` compares the DECLARED hashes "until `a-module-handed-to-a-tab-is-identified-by-its-handler-sources` lands".
>    - `work/tasks/done/the-browser-takes-its-identity-from-the-arrival.md`, Decisions #1: "`updateProcessor` is deliberately NOT given a `processorIdentity`, and its suites stay on the declared path... Widening the options bag... invents an input the HMR task would have to delete. Touches: `a-module-handed-to-a-tab-is-identified-by-its-handler-sources`."
>    - `work/tasks/done/the-cli-server-and-examples-take-their-identity-from-the-arrival.md`, Decisions #3: "Both examples stay on the declared path, labelled, and I did NOT give either an identity... passing `processorIdentity` from the app... is forbidden rather than merely premature. Touches: `a-module-handed-to-a-tab-is-identified-by-its-handler-sources` (which will migrate `browser-reference`)."
>    - `examples/browser-reference/src/processor.ts:27-60` says so to the reader: "Until that lands, this app is on the declared path, and this string is what names its generation. The app deliberately does NOT supply an identity of its own."
>    Deleting `version` / `getVersionHash()` leaves `BrowserGenerationSpec.processorIdentity`, the browser hook's `updateProcessor`, `liveReload.test.ts`, `reconfigure.test.ts` and `examples/browser-reference` with no identity source at all. The only two ways out are (a) derive it from the handler sources inside the library, which IS acceptance criterion 1 of `a-module-handed-to-a-tab-is-identified-by-its-handler-sources`, or (b) let the app supply it, which that same task forbids in as many words ("do not let the app supply the identity... that is the author-declared identity re-entering through the one door left open"). Leaving `utils/fingerprint.ts` in the tree, which this task's prompt correctly instructs, does not resolve this: the browser never sees the author's module object (it is handed an already-built `EntityEventProcessorLike`), so the derivation has nowhere to be called from without a seam change that belongs to that task.
>
> 2. THE CLI'S UNBUNDLED PATH HAS NOTHING TO FALL BACK TO, AND ITS SUITES RUN ON IT.
>    - `packages/utils/src/processorArrival.ts` header says "What eventually deletes it is the contract task, at which point this function loses an arm rather than gaining one", which reads as this task's job.
>    - But `work/tasks/done/the-cli-server-and-examples-take-their-identity-from-the-arrival.md`, Decisions #4 assigns it elsewhere: "The CLI suites that stand a deployment up through an injected `importModule` were left alone (`run.test.ts`, `indexCommand.test.ts`, `oneShot.test.ts`, `commands.test.ts`, `fixedTableNamespace.test.ts`, `generationNamespaceBesideFixedTables.test.ts` and the rest)... `a-path-naming-an-unbundled-entry-point-is-refused` will have to decide whether an injected `importModule` is still an accepted arrival, and these suites are where that lands."
>    Deleting the declared identity forces that decision NOW: it introduces a new user-visible REFUSAL (the whole subject of `a-path-naming-an-unbundled-entry-point-is-refused`, whose criteria require it at CONFIGURATION RESOLUTION, in ADR-0048's shape, naming the build command), and it requires migrating 13 CLI/utils test files (44 `importModule` sites) from module injection to real self-contained bundles, because a test that injects an in-memory module object cannot produce bytes to hash.
>
> 3. `examples/event-processor-nfts` IS IN THE ACCEPTANCE GATE AND RUNS AN UNBUNDLED PATH.
>    - `examples/event-processor-nfts/package.json:34`: `etherfold build -p ./dist/cli.js` (a `tsc` output that imports its ABI, so not self-contained); `src/entities.ts:55` carries `version: '1.0.0'` labelled "`the-declared-version-and-the-drift-report-are-deleted` removes the field"; `test/cli.test.ts:101,109` runs that path through an injected `importModule`.
>    - Its migration is assigned to `the-build-command-and-its-pinning-rule-are-documented` (still in `work/tasks/ready/`), per the same batch's Decisions #3.
>    - The root `test` script includes `examples/*` deliberately ("an example is EVIDENCE... evidence nothing runs is a claim"), so this suite is part of "the whole tree is green".
>
> SECONDARY: TWO ACCEPTANCE CRITERIA CONTRADICT THE PROMPT AND EACH OTHER
>
> Criterion 1 requires `utils/fingerprint.ts` to be "gone from the published surface and from the tree", while the Prompt and the "What to build" section both say the derivation SURVIVES and, if the HMR task has not landed, to leave what it needs. Both cannot be satisfied. Whichever re-scope is chosen, criterion 1 should be reworded to "`getCodeFingerprint()` is gone from the processor seam; `processorCodeFingerprint` survives in its new role" and should say whether its two test files (`packages/core/test/processorFingerprint.test.ts`, `test/utils/fingerprintFixture.ts` + `printFingerprint.ts`) stay with it. They test the surviving derivation, not the drift report, so deleting them under criterion 2 would delete live coverage.
>
> SUGGESTED RE-SCOPE (in order of preference)
>
> A. RE-SEQUENCE, and add one more migrate batch.
>    - Drop this task from `a-module-handed-to-a-tab-is-identified-by-its-handler-sources`'s `blockedBy` and land that FIRST. It does not actually need the deletion: it needs `processorCodeFingerprint` to exist, which it does, and its own prompt already contemplates running first ("Read `packages/core/src/utils/fingerprint.ts` **if it still exists at the point you start**"). Its stated reason for the block ("must not remove the derivation this needs") is satisfied by ordering it before rather than after. That closes instance 1 and migrates `examples/browser-reference`.
>    - Add a FIFTH migrate batch ahead of this task: move the CLI suites and `examples/event-processor-nfts` onto bundle arrivals, deleting nothing and refusing nothing, so it is green on its own exactly as the other four were. That closes instances 2 and 3 and leaves `a-path-naming-an-unbundled-entry-point-is-refused` correctly blocked on this task for the REFUSAL alone, which is the part that genuinely cannot precede it.
>    - Then this task really is the removal it describes.
>
> B. WIDEN THIS TASK and say so. Absorb the three remainders explicitly into "What to build" and the acceptance criteria: the browser's handler-source derivation, the CLI's unbundled-path refusal plus its test migration, and the two example migrations. Then shrink the three blocked tasks to what is left of them (documentation, limits, outcome shape, ADR-0048 polish). This is honest but makes one task carry four tasks' worth of user-visible design, which is what the batch/contract split existed to avoid.
>
> C. SPLIT THIS TASK BY ARRIVAL. Land the contract deletion now for the packages with no module arrival (`core`, `processor-entities`, `processor-sqlite`, `server`), which I verified builds green, and move the browser/CLI/example halves into the three tasks that already own them. This leaves `version` alive in `EntityProcessor` for one more step, so it is the weakest option, but it unblocks the majority immediately.
>
> WHAT I VERIFIED IS UNAFFECTED, so the re-scope does not need re-discovery: the reach of the drift report is exactly the reconfigure endpoint's answer (`packages/cli/src/reconfigure.ts`), the admin route's response body (`packages/server/src/api/admin.ts:462` and `ReconfigureReport.drift` in `packages/server/src/registry.ts:92`), `Indexer.onProcessorDrift` / `ReceivingIndexer.onProcessorDrift`, `StreamBuilder`, `GenerationRebuild`, `ContextIdentifier.processorFingerprint`, `ProvidedIndexerConfig.strictProcessorDrift`, and `CONTEXT.md` line 54 (the **generation** entry, which describes the declared `version` hash, the advisory fingerprint, the `PROCESSOR DRIFT` phrase and `unchanged` reading two ways). The changeset must state that this retires `a-reload-that-changed-nothing-reports-processor-drift` (shipped 2026-09-16) and why that is its correct end rather than a reversal.

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):
