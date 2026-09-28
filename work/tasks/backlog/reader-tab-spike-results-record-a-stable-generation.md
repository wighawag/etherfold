---
title: 'The reader-tab spike records a stable generation, so a local browser run leaves the committed evidence unchanged'
slug: reader-tab-spike-results-record-a-stable-generation
blockedBy: []
covers: []
needsAnswers: true
---

## What to build

Running `pnpm --filter @etherfold/browser test:browser` locally rewrites the committed `docs/spikes/a-reader-tab-learns-from-the-indexing-tab/results/two-tabs-one-database-{chromium,firefox,webkit}.json` with a different `generation` value (for example `de92321b...` became `0f48ccab...`) and nothing else, so the recorded evidence churns on every run and a contributor either commits noise or reverts it by hand. The recorder in `packages/browser/browser/readerTabLearnsFromTheIndexingTab.spec.ts` already stabilises the coherence token (each distinct token becomes `fold-1`, `fold-2`, ... in order of first appearance) and the run stamp in channel names, following `sharedWorkerServesSeveralTabs.spec.ts`; it does not stabilise `generation`.

Find why the value differs per run (a digest over something run-specific, such as a database or stream name carrying the run's timestamp), then stabilise it in `stabilise` the same way the coherence token is: a stable label per distinct value in order of first appearance, so that the RELATION stays evidence (both tabs name the same generation, a different fold names a different one) while the bytes stop changing. If the value turns out to vary for a reason that IS evidence (the same inputs giving a different digest), stop and route to needs-attention instead, because that would be a real defect, not churn.

## Acceptance criteria

- [ ] Two consecutive local runs of `pnpm --filter @etherfold/browser exec playwright test readerTabLearnsFromTheIndexingTab` on each of the three projects leave `git status --porcelain docs/spikes/a-reader-tab-learns-from-the-indexing-tab/` empty after the committed files are regenerated once by this change.
- [ ] The committed results still show that the two tabs agree on the generation (the same label), and the spec's comment block explains the new rule beside the coherence one.
- [ ] Changesets: `@etherfold/browser` (patch), since its directory changes (patch or minor, never major).
- [ ] CI: dorfl's `verify` gate runs vitest only, so the PR's `browser (chromium)`, `browser (firefox)` and `browser (webkit)` jobs green are part of done (this spec runs only there).

## Blocked by

- None: can start immediately.

## Prompt

> Goal: committed spike evidence that a re-run does not churn. Look at `stabilise` and `record` in `packages/browser/browser/readerTabLearnsFromTheIndexingTab.spec.ts`, the same helpers in `sharedWorkerServesSeveralTabs.spec.ts`, where the reported `generation` comes from in `@etherfold/browser` (`streamDigestOf` and the generation's identity, ADR-0053), and the committed results folder above.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Check that a local run still changes only `generation` in those files. If more fields churn, stabilise only the ones that are not evidence and say which in `## Decisions`; if nothing churns any more, route to needs-attention saying so (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor, never major). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified `*.bundle.js` files.
>
> CI: dorfl's gate runs vitest only. The real-browser suites run in CI's `browser (chromium)`, `browser (firefox)` and `browser (webkit)` jobs; the PR is done only when those three are green too.
