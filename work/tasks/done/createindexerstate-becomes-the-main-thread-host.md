---
title: 'createIndexerState becomes the main-thread host, and there is only one of it'
slug: createindexerstate-becomes-the-main-thread-host
spec: the-indexer-runs-in-a-worker-and-the-tab-talks-to-it
blockedBy: [a-sharedworker-serves-several-tabs-from-one-host]
covers: [14]
---

## What to build

The third hosting shape, and the task that closes the set.

Running on the main thread is not a product decision dressed up as an engineering one: an in-process path is needed for tests regardless, so the main-thread host EXISTS whether or not it is supported. Making it supported therefore costs documentation rather than code. What changes is that the guide stops leading with it.

**The substance of this task is that there is exactly ONE main-thread path, and it is `createIndexerState`.** Every earlier task in this spec adds a surface to the port while leaving that function alone, which is correct while the work is in flight and wrong at the end: shipping a separate main-thread constructor beside it would leave two ways to build a main-thread indexer with no rule for choosing between them, and `CONTEXT.md` names `createIndexerState` as the browser's entry point in two glossary entries. So adapt it into the main-thread hosting shape rather than adding a sibling. Whether it keeps its exact name and signature, or gains a hosting argument that defaults to the main thread, is yours to decide and record; what is not open is whether there are two.

The glossary is part of the deliverable, not follow-up. `CONTEXT.md` carries an **indexer host** entry marked NOT YET BUILT, and its **tx inclusion** and **processor kind** entries describe the browser surface in terms of `createIndexerState(...)`. Whatever this spec changed about that surface, those entries must say so when this lands. The repo treats the glossary as the vocabulary source of truth, so leaving it describing the pre-worker world is how the next author re-forks the terms this work just pinned.

This is also where the whole spec is checked as one thing rather than as seven. One implementation across three hosts is the claim ADR-0082 opens with, and until all three exist nobody could test it.

**This task removes ADR-0082's `status: accepted, not yet implemented` line.** It is the last task in the chain and the only one that can know it is last. Leaving the line is how a pending status outlives its pendingness — `work/protocol/ADR-FORMAT.md` records two ADRs where exactly that happened, each time because every builder in a chain could see they were not the last one.

## Acceptance criteria

- [ ] The main thread is a named, selectable hosting shape, and `createIndexerState` IS that shape rather than a parallel path beside it.
- [ ] There is exactly one way to construct a main-thread browser indexer. A reviewer can check this by grepping the package's exports.
- [ ] Existing callers of `createIndexerState` either keep working unchanged, or the break is deliberate, documented in the changeset, and named in the `## Decisions` block.
- [ ] One test exercises the SAME behaviour across all three hosting shapes and passes on each, demonstrating one implementation rather than three.
- [ ] An app's code against the port is unchanged across the three shapes.
- [ ] The package's guide documents the three shapes, leads with the dedicated worker, and says plainly what the main-thread shape is for and what it costs (the fold is on the UI thread).
- [ ] `CONTEXT.md` is updated: the **indexer host** entry loses its NOT YET BUILT marker and matches what shipped, and every other entry describing the browser surface through `createIndexerState` is corrected.
- [ ] ADR-0082's `status: accepted, not yet implemented` frontmatter line is removed.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`a-sharedworker-serves-several-tabs-from-one-host`, and through it every other task in this spec. That is deliberate: this task asserts a property of the whole set (one implementation, three hosts), decides the disposition of the package's existing entry point, and owns both the glossary update and the ADR's status line, so it must be unambiguously last.

## Prompt

The goal is to close out the worker work: three hosting shapes, one implementation, one main-thread path, and a glossary that describes what shipped.

Read `work/specs/tasked/the-indexer-runs-in-a-worker-and-the-tab-talks-to-it.md`, **ADR-0082** in full (including the paragraph deciding that `createIndexerState` IS the main-thread host), and the **indexer host** entry in `CONTEXT.md`. Then read the done records of the six tasks before this one — this is the task that checks their collective claim, so their `## Decisions` blocks are your map of where the seams actually landed versus where they were planned.

Where to look: `@etherfold/browser`'s README is the guide, and it currently presents a main-thread hook as the way to index in a browser. `createIndexerState` itself is large and holds the store, the container and three reactive stores; earlier tasks deliberately left it alone, so expect the adaptation to be the real work of this task rather than a rename.

The property to test is the one that is easy to assert weakly: "one implementation" must mean a shared body of code exercised identically, not three test files that happen to agree. Parameterise one behaviour suite over the three hosting shapes the way `@etherfold/state-store-conformance` parameterises over store implementations.

Note that the hosting shapes cannot all be tested by the same runner: the worker shapes need the real-browser Playwright run, the main-thread one can run under vitest with a fake IndexedDB. Say how you handled that rather than quietly testing only one.

On the glossary: `CONTEXT.md` is the stated vocabulary source of truth, and its entries are dense single-paragraph definitions written in the project's own voice. Match that style; do not append a section.

Done means: three hosting shapes, one implementation, one main-thread path, a guide that leads with the right shape, a glossary that matches the code, and ADR-0082 no longer claiming to be unimplemented.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. What happened to `createIndexerState`'s name and signature is exactly such a decision, as is any case where the three hosting shapes turned out NOT to share one implementation as cleanly as ADR-0082 assumes — that second one is the most valuable thing you can report. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.

## Decisions

**`createIndexerState` keeps its exact name and signature, and the shape is reached as `indexer.mainThreadHost()`.** Alternatives considered: (a) a top-level `mainThreadHost(spec)` symmetric with `dedicatedWorkerHost` / `sharedWorkerHost` — rejected, it is precisely the second main-thread constructor ADR-0082 closes, and an app that used both would open two containers over one store and meet a writer refusal three layers from the line that caused it; (b) a hosting argument on `createIndexerState` (the ADR's other option) — rejected, there is no second value it could take, because the hook's three reactive stores publish a live read HANDLE that cannot cross a port, so a worker-backed `createIndexerState` is unbuildable without deleting `state`. The consequence to weigh: the third shape's construction is ASYMMETRIC with the other two (they take a factory, this is a method). That is the honest shape of "the host here already exists", and the port code after it is identical, which is the criterion that matters. Touches every later task that adds a shape or a port case.

**The three shapes do NOT share one implementation as cleanly as ADR-0082 assumes, and this is the finding worth reading.** They share the whole BOUNDARY (now one module, `src/host/cases.ts`) and they do not share the DRIVER: the worker shapes run `serveIndexerHost`'s loop, the main-thread host runs the hook's auto-index loop with its four verbs. I considered rebuilding `createIndexerState` on top of `serveIndexerHost` so there were literally two files. Rejected, and the reasons are structural rather than effort: `serveIndexerHost` takes its provider/source at CONSTRUCTION and starts folding immediately, while the hook defers them to `init` (which every existing caller, example and test depends on); and the hook carries seven surfaces the worker host does not have and does not want (the stream-seed install, the scheduled prune, demotion, `reset`, `promote`, `updateProcessor`, `updateIndexer`, the `createIndexer` injection point, `trackNumRequests`) — folding them into the worker driver would move a large amount of main-thread-only machinery into every worker bundle. So "one implementation" here precisely means: one implementation of everything that crosses the port, over two drivers. `cases.ts`'s module docstring and the **indexer host** glossary entry both say this in those words rather than letting the ADR's sentence stand unqualified. Touches any later task that adds a port case (it needs one edit) versus one that changes driver behaviour (it needs two).

**How the two runners were handled, since the shapes cannot all be driven by one.** The cases are data in `browser/hostingShapes.ts`, run three times in the Playwright page (the only place a `Worker` and a `SharedWorker` exist) and once under vitest against the main-thread shape. I deliberately did not simulate the worker shapes in node: `test/utils/port.ts` already serves the worker driver over a local `MessageChannel`, and running the suite over that would have looked like three shapes while being two. Alternative considered: assert only in Playwright — rejected, the acceptance gate has no browser binaries, so the list would be exercised by nothing on a normal commit.

**The main-thread wire is a real `MessageChannel`, not direct calls.** A hosting shape is how a port is obtained, and the port's contract includes what may cross it. Direct calls would make the shape an app develops against more permissive than the shape it ships (`assertClonable` would never fire, a class instance would sail through). The cost is one structured clone per call on a path that has no thread boundary to justify it; that is the right trade for a shape whose main job is tests and small backfills. Touches nothing else.

**`stopAutoIndexing()` now also stops an already-running cycle from re-arming the loop.** It previously cleared only the pending timer, so a stop landing mid-cycle was undone by that cycle's own re-arm. This is a real behaviour change to an existing verb and it was forced: `IndexerPort.stopIndexing()` promises no chain request is made after it answers, and the shared suite's stop case fails on the main thread without it. Alternative considered: keep the bug and weaken the suite's stop case — rejected, that is the "three test files that agree" failure mode. Called out in the changeset. Touches anything relying on `stopAutoIndexing` being timer-only; nothing in the repo did.

**`serveIndexerHost` stays exported, and `test/utils/port.ts` keeps labelling itself `main-thread`.** A reviewer grepping exports for "a second way to build a main-thread indexer" will see `serveIndexerHost`, so it now says in its own docstring that it is the WORKER hosts' driver, that it is reached from the two entry helpers (both of which refuse to run in a document), that it is exported so a deployment can write a shape this package does not ship, and that calling it on the UI thread would be the second container. `test/utils/port.ts`'s `host: 'main-thread'` label is still accurate about the CONTEXT the driver runs in, but it no longer names the main-thread SHAPE, so its docstring now says which is which and points at the new test. Alternative considered: unexport `serveIndexerHost` — rejected, it forecloses a custom hosting shape (an iframe, a `MessagePort` somebody else owns) for a naming worry the docstring answers.

**`mainThreadHost()` may be called more than once, its access carries no `reopen`, and `{watch: false}` is documented rather than forced.** Several wires to one host is what a SharedWorker already does for several tabs, so it needed no new rule. No `reopen` because a host on this thread cannot die independently of the tab holding the port — the restart task had already flagged `watch: false` as "right only for a host that cannot die independently (the coming main-thread shape)". I did not make `connectToIndexerHost` default `watch` off when an access has no `reopen`: that would silently change the SharedWorker path's future behaviour, and the port options are the app's to pass.

**`dispose()` does not close the wires it handed out.** A port belongs to whoever obtained it, exactly as it does on the other two shapes where `close()` is the sole owner of the wire. So a dispose resets the port's view instead: the phase goes back to `waiting`, a read that was waiting for a store this container will now never build is REJECTED rather than left hanging, and a later `init` gives the same wire a fresh container to answer from. Alternative considered: close the wires on dispose — rejected, it would break the documented "after `dispose()`, `init(...)` may be called again" contract for an app that also holds a port, and it would surface an ordinary teardown to the app as an `onHostDeath`.

**`packages/browser`'s `package.json` description was updated.** It described only the main-thread hook, which is now one of three shapes; it is published metadata, so it is a user-visible string and the changeset covers it.
