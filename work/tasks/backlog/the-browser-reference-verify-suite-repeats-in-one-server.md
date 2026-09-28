---
title: 'The browser reference verify suite can be repeated within one Vite server'
slug: the-browser-reference-verify-suite-repeats-in-one-server
blockedBy: []
covers: []
---

## What to build

`pnpm --filter browser-reference exec playwright test --repeat-each 2` (chromium) passes its first round of 8 and then fails every test of the second round with `#transfers` showing `10` instead of `5`. The likely cause, not yet verified, is `verify/reference.spec.ts` "an edited processor is swapped in by the worker, beside the live state, without a reload", which rewrites `src/processor.ts` to add 2 per transfer and restores it in `finally`, while the one Vite server started per invocation keeps serving the edited module (or a worker bundle built from it) to later pages. Separate invocations pass every time, so CI's single run is unaffected, but a whole-file `--repeat-each` is not usable as a flake check.

Verify the cause first (what still serves the edited module after the restore: Vite's module graph, the worker bundle, or state that survives between pages). Then make the test leave the server as it found it: restore the module in a way the same server demonstrably picks up (for example wait, after the restore, until the server serves the original again, the way the test waits for the edit to be taken), or isolate the edit so no later page can be served it. Keep what the test proves: an edited processor is taken by the worker without a reload, and the incumbent answers until the edit catches up.

## Acceptance criteria

- [ ] `pnpm --filter browser-reference exec playwright test --repeat-each 3` (chromium, the whole file) passes every round.
- [ ] The edited-processor test still fails if the worker does not take the edit (checked once by hand, by breaking the hot-update path locally, and said in `## Decisions`).
- [ ] `src/processor.ts` is byte-identical to its committed content after the run, including after a test failure mid-edit.
- [ ] Changesets: none, since `browser-reference` is private (add one only for a published package whose directory you change, patch or minor, never major).
- [ ] CI: dorfl's `verify` gate runs vitest only, so the PR's `browser (chromium)`, `browser (firefox)` and `browser (webkit)` jobs green are part of done (the reference's `verify:browser` runs in `browser (chromium)`).

## Blocked by

- None: can start immediately. Low priority.

## Prompt

> Goal: the reference's verify suite can be repeated as a flake check. Look at `examples/browser-reference/verify/reference.spec.ts` (the edited-processor test), the example's Playwright and Vite config, and how the worker takes a hot update in `@etherfold/browser` (`hotUpdate.ts`). `a-browser-app-queries-its-worker-with-graphql` (done) is where the observation came from.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Reproduce the `--repeat-each 2` failure first. If it no longer fails, route to needs-attention saying so; if it fails for a cause other than the edited processor, say which in `## Decisions` and fix that cause instead (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor, never major). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified `*.bundle.js` files. Before killing a leftover dev server, check what holds the port.
>
> CI: dorfl's gate runs vitest only. The real-browser suites run in CI's `browser (chromium)`, `browser (firefox)` and `browser (webkit)` jobs; the PR is done only when those three are green too.
