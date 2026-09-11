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
