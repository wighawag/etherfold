---
title: '`test:all-backends` finishes the IndexedDB replay, measured, and runs on a schedule'
slug: the-full-stratagems-replay-finishes-on-indexeddb
blockedBy: []
covers: []
---

## What to build

`pnpm --filter @etherfold/conformance-workload-stratagems test:all-backends` (`STRATAGEMS_WORKLOAD=all`) always fails on `indexeddb`: the `beforeAll` in `test/alpha1.test.ts` that replays the launched game (31,332 logs over 1,042 blocks, one `applyBlock` per block through `replayIntoStore`) has a 600,000 ms hook timeout, and on `fake-indexeddb` that replay took 2,599 s on one machine (it passed both cases, golden state and revert, with the timeout raised to 5,400,000 ms). The file's own header says the cost is the shim's and grows with the stored version count. Nothing runs this target, which is how it stayed red unnoticed.

MEASURE before choosing, within the builder's deadline (`dorfl.json` sets `agentDeadlineMinutes: 90`, and one full replay is about 43 minutes, so do NOT run the full replay locally). Measure on a bounded PREFIX of the fixture's blocks (enough blocks for the growth curve to show, and at most about 15 minutes per run): time per block across the prefix, the share spent in the shim versus the store, and the same prefix with batching. Extrapolate the full replay's time from the curve, and let the new workflow's own run on the PR (below) supply the real full-length figure. Then choose ONE of:

- **Raise the timeout** to the extrapolated full replay time times 2, rounded up (a CI runner is slower than a workstation; the workflow's first run shows by how much), when the cost is the shim's and batching does not change its shape; or
- **Make the replay faster**, when the measurement shows a change in the workload's own replay (fewer transactions, or packing blocks the way SQLite's `applyBlocks` does) cuts the prefix's time by at least half. Adding an `applyBlocks` verb to `@etherfold/state-store-indexeddb` is a change to a published backend's seam surface with conformance cases of its own: if that is what the measurement points at, record the numbers and route to needs-attention rather than folding it in here.

Then make CI run it, because a target nobody runs rots: a separate workflow (not `ci.yml`, whose jobs gate every PR) that runs `test:all-backends` on `workflow_dispatch` and on a weekly `schedule`, with `timeout-minutes` set from the measured time with headroom, plus a `pull_request` trigger filtered to the workflow's own file, so the PR that adds it (and any later PR that edits it) runs it once. It is too slow for every PR, and the fast smoke case (`test/workload.test.ts`) already covers IndexedDB on every PR.

## Acceptance criteria

- [ ] `docs/spikes/the-full-stratagems-replay-on-fake-indexeddb/` holds the committed measuring script and a `README.md` with the prefix measured, the per-block curve, the batching result, the extrapolation and its method, the machine it ran on, and which of the two options was chosen and why.
- [ ] `pnpm --filter @etherfold/conformance-workload-stratagems test:all-backends` passes on every backend including `indexeddb`, on a CI runner: the new workflow's run on the PR that adds it is green.
- [ ] A workflow under `.github/workflows/` runs it on `workflow_dispatch`, weekly, and on a `pull_request` that edits the workflow file itself, with a `timeout-minutes` derived from the measurement; `ci.yml`'s jobs are unchanged.
- [ ] `test/alpha1.test.ts`'s header states the chosen timeout (or the speedup), the measured time, and where the scheduled job lives.
- [ ] Changesets: none if only the private `@etherfold/conformance-workload-stratagems`, the workflow and `docs/` change; otherwise one per published package changed (patch or minor, never major).
- [ ] CI: if the change reaches `@etherfold/state-store-indexeddb`'s source, the PR's `browser (chromium)`, `browser (firefox)` and `browser (webkit)` jobs green are part of done (dorfl's `verify` gate runs vitest only); otherwise the PR's CI is green as a whole.

## Blocked by

- None: can start immediately.

## Prompt

> Goal: the full stratagems replay finishes on every backend and something runs it. Look at `packages/conformance-workload-stratagems` (`test/alpha1.test.ts` and its header, `src/workload.ts`, `src/replay.ts`, `test/utils/backends.ts`, the `test:all-backends` script), `@etherfold/state-store-indexeddb`'s `applyBlock`, SQLite's `applyBlocks` for what packing looks like, ADR-0026, and `.github/workflows/ci.yml` for how jobs are set up (pnpm, Node, install). Each measuring run is bounded to about 15 minutes: run it under `timeout`, in the background with its output to a file, and never with more than one replay at a time.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Check, by reading the code rather than running the full target, that the hook timeout is still 600,000 ms and that the replay still applies one block per `applyBlock`. If not, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor, never major). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified `*.bundle.js` files.

## Decisions

- **Timeouts anchored on the slowest measured replay, not on this machine's extrapolation.** I chose 5,400,000 ms, twice the 2,599 s full replay measured on another machine, rounded up. The task's rule applied literally ("extrapolated full replay × 2") gives about 1,800 s, which would already fail on the machine that measured 2,599 s, 2.9 times slower than this one; a CI runner is not faster than either. The alternative was the literal 1,800,000 ms, but the acceptance requires a green CI run, so I rejected it. This touches only `test/alpha1.test.ts`; the bound can be tightened once the workflow prints the real CI figure.
- **The revert case's timeout was raised too, not just the hook's.** The model puts the revert at about 900 s on this machine, above its 600,000 ms bound. The task only named the hook, but its acceptance ("passes on every backend") needs both. Both use the same bound, because the revert is the same scan at the same size.
- **`timeout-minutes: 200`.** That is the two 90-minute vitest bounds plus about 20 minutes for install, build and the three fast backends, so a named vitest timeout fails before the runner kills the job. The alternative was a tighter cap sized to the expected time, where the runner could kill the job first and name no case.
- **Spike path follows the acceptance criterion.** I used `docs/spikes/the-full-stratagems-replay-on-fake-indexeddb/`, as the acceptance names it, rather than the runner prompt's `docs/spikes/the-full-stratagems-replay-finishes-on-indexeddb/`. Both are stable `docs/` paths.
- **Timing lines added to the test.** The replay and revert times are now printed for every backend, every run, including the default CI's three backends, where the default reporter hides them. This is how the scheduled run supplies the real full-length figure; the other option was to rely on vitest's file duration, which lumps all four backends together.
- **Dropped a dangling reference.** The old header and package README cited an observation `fake-indexeddb-write-cost-grows-quadratically` that does not exist in the repo. I replaced it with the spike folder, which now documents the cause.
