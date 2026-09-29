---
title: 'The reader-tab spike results are refreshed to the generation the current identity rule computes'
slug: reader-tab-spike-results-record-a-stable-generation
blockedBy: []
covers: []
---

## What to build

A ONE-TIME DATA REFRESH, re-scoped on 2026-09-29 by the maintainer (answer (a) to the question the first build raised). The committed `docs/spikes/a-reader-tab-learns-from-the-indexing-tab/results/two-tabs-one-database-{chromium,firefox,webkit}.json` are STALE, not churning: the first build measured that a local run changes only `generation` (`de92321be3f5a7985a83d20f8e3a4c0e` becomes `0f48ccab2c62b7bef25e4ba300c55d06`, the same value on all three engines), and that every later run reproduces `0f48ccab...` exactly. The value is `generationDigestOf({stream, processor})`, and the processor half comes from the arrival's handler sources (ADR-0086, `packages/browser/src/moduleIdentity.ts`), whose identity work (#163, #165, #167, #197) landed after these results were recorded (#147). So the digest is deterministic evidence and stays in the files as a real digest: a future change to the identity rule, the fixture's handlers or the transpile should show up as a diff.

Regenerate the three JSON files once with `pnpm --filter @etherfold/browser exec playwright test readerTabLearnsFromTheIndexingTab` (one project at a time is fine), and commit them. Do NOT relabel `generation` in `stabilise` and do not change the spec file or any source.

## Acceptance criteria

- [ ] The three committed results carry the generation the current code computes, and the diff against main changes only `generation` values (state any other field that changed, and why, in `## Decisions`; if another field changes for a reason that is not the identity work, stop and route to needs-attention).
- [ ] A second local run on each of the three projects leaves `git status --porcelain docs/spikes/a-reader-tab-learns-from-the-indexing-tab/` empty.
- [ ] The two tabs still agree on the generation in each file.
- [ ] No source or spec change, and no changeset (only `docs/` changes). Any other committed results a local Playwright run rewrites as a side effect are restored, not committed.
- [ ] CI: the PR's CI green as a whole (`verify`, `browser (chromium)`, `browser (firefox)`, `browser (webkit)`).

## Blocked by

- None: can start immediately.

## Prompt

> Goal: committed spike evidence that matches what the current code computes, with the real digest kept as evidence (ADR-0053, ADR-0086). Look at `record` and `stabilise` in `packages/browser/browser/readerTabLearnsFromTheIndexingTab.spec.ts` (read only) and the results folder above.
>
> FIRST, check this task against current reality: it was re-scoped on 2026-09-29. Run the spec once and check that only `generation` changes and that a second run changes nothing. If a second run DOES change the files, the premise is false again: route to needs-attention with what churns (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified `*.bundle.js` files.

## Decisions

- **All three projects in one invocation:** I regenerated with the single command from the task body instead of one project at a time, which the task allows. The config runs one worker in sequence, so each file is written by its own project. Nothing else is affected.
- **No fields other than `generation` changed**, so there is nothing further to justify.
