---
title: 'The stratagems replay records its measured CI figures, and its IndexedDB bounds are set from them'
slug: the-stratagems-replay-records-its-ci-figures
blockedBy: []
covers: []
---

## What to build

Follow-up to `the-full-stratagems-replay-finishes-on-indexeddb` (#258). Its new workflow's first run on a GitHub runner (run 36502194400, 2026-09-29, `ubuntu-latest`) measured the full IndexedDB replay at **2,052.8 s** and the revert case at **2,170.5 s** (51/51 passed, 4,238 s for the whole target; sqlite 9.2 s, patch 1.8 s). The header of `packages/conformance-workload-stratagems/test/alpha1.test.ts`, the package `README.md` and `docs/spikes/the-full-stratagems-replay-on-fake-indexeddb/README.md` still carry only the local extrapolation (about 890 s and 900 s) and the other machine's 2,599 s.

Record the CI figures in all three places, with the run they came from. Then set both IndexedDB bounds (the `beforeAll` replay and the revert case) from the SLOWEST real full-length measurement now known, times 2, rounded up to the next 5 minutes: that is 2 x 2,599 s for the replay and 2 x 2,170.5 s for the revert unless a slower real figure exists, so check before choosing; state the numbers in `## Decisions`. A bound that fails on a real machine is the failure to avoid, so never go below 2 x the slowest measurement. Recompute the workflow's `timeout-minutes` the same way (the two bounds plus install, build and the other backends) so a named vitest timeout still fails before the runner kills the job.

## Requeue 2026-09-29

Gate-3 BLOCK on PR #263: this PR's own workflow run 36523554754 measured IndexedDB replay 2,165.1 s and revert 2,295.1 s. The revert is now the slowest real revert, so by the task's rule (never below 2 x the slowest measurement) INDEXEDDB_REVERT_BOUND_MS must be 2 x 2,295.1 s rounded up to the next 5 minutes = 80 minutes (4,800,000 ms), not 75; timeout-minutes becomes 90 + 80 + 20 = 190. Keep the replay bound at 90 minutes (2 x 2,599 s still governs). Record the second run's figures beside the first in the test header, the package README and the spike README, noting the roughly 5% run-to-run spread. Update the Decisions arithmetic.

## Acceptance criteria

- [ ] The test header, the package README and the spike README state the CI replay and revert times and name the run.
- [ ] Both IndexedDB bounds and the workflow's `timeout-minutes` are derived as above, with the arithmetic in `## Decisions`; `ci.yml` is unchanged.
- [ ] The workflow runs on this PR (it edits the workflow file only if `timeout-minutes` changes; if it does not change, trigger nothing and say so) and, when it runs, is green.
- [ ] Changesets: none (the package is private, and only it, the workflow and `docs/` change).
- [ ] CI: the PR's CI green as a whole.

## Blocked by

- None: can start immediately.

## Prompt

> Goal: the recorded evidence for the full replay matches what CI measured, and its bounds rest on real measurements. Look at `test/alpha1.test.ts` (its header and the two IndexedDB bounds), the package `README.md`, `docs/spikes/the-full-stratagems-replay-on-fake-indexeddb/README.md`, and `.github/workflows/stratagems-all-backends.yml`.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-29. Check that the three documents still carry only the extrapolation. If the CI figures are already recorded, route to needs-attention saying so (WORK-CONTRACT.md, "Drift is a needs-attention signal"). Do NOT run the full replay locally; it takes over 30 minutes.
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified `*.bundle.js` files.
