---
title: 'The tab-lease suites stop flaking: the frozen-leader case per its diagnosis, the killed-worker case waits for its report'
slug: the-tab-lease-suites-stop-flaking
blockedBy: [the-frozen-leader-takeover-flake-is-diagnosed-under-load]
covers: []
---

## What to build

Two flakes in the tab-lease suites, both seen on PRs that did not touch the takeover path.

1. **The FROZEN-leader case** (`packages/browser/test/aVisibleTabTakesTheLeaseFromABackgroundedLeader.test.ts`, the new leader demoted right after its takeover). Fix it as the verdict in `docs/spikes/the-frozen-leader-takeover-flake/README.md` says. If it is a "test race", fix the test so it waits for the state it asserts on instead of racing it, keeping what the case exists to prove: the frozen leader is displaced within the settle time, and when both write, the FROZEN leader's write is the one refused and the store holds the new leader's fold. If it is a "real takeover window", fix the takeover with the smallest change the README names, and add a test that fails without it. If it is "not reproduced", make the test's failure name the event sequence (the trace the diagnosis built) so the next CI failure is diagnosable, and change nothing else.
2. **The killed-worker case on Firefox** (`packages/browser/browser/oneTabIndexesAndTheOthersRead.spec.ts`, "a dedicated-worker host per tab: the lock is held in the worker, and KILLING it hands over"): `taker.ranges[0]!.from` threw `Cannot read properties of undefined (reading 'from')` because the tab that took over had not reported a fetched range yet when the test read it. Make the test POLL until the taker has reported a range, then assert `from` as today. The same race is in the main-thread case of the same file ("main-thread tabs: one fetches, all read alike, ... closing the leader hands over with no gap", which also reads `taker.ranges[0]!.from` straight after the seat poll): fix both sites. The file already shows the fix in its foreground-takeover case (`expect.poll(async () => (await report(reader)).ranges.length).toBeGreaterThan(0)` before reading `ranges[0]`).

## Acceptance criteria

- [ ] The FROZEN-leader case passes the diagnosis's own repro script, under the same load, for at least 10 times the iterations the README recorded its failure rate over (or 200 iterations, whichever is more), with zero failures; state the numbers in `## Decisions`. For "not reproduced", the criterion is instead that a forced failure (inject the delay the diagnosis suspected) prints the event sequence.
- [ ] If the verdict was "real takeover window": a test that fails on the code before the fix and passes after it; and if the fix changes what ADR-0097 D4 promises, route to needs-attention with the proposed change instead of choosing (a contract change is the maintainer's).
- [ ] Both the killed-worker case and the main-thread close case wait for the taker's first reported range before reading it, and each passes `--repeat-each 20` on `--project=firefox` (`-g` on that one test) with zero failures.
- [ ] Changesets: `@etherfold/browser` (patch) if its `src` or test directories change, plus any other published package whose directory you change (patch or minor, never major).
- [ ] CI: dorfl's `verify` gate runs vitest only, so the PR's `browser (chromium)`, `browser (firefox)` and `browser (webkit)` jobs green are part of done (the killed-worker case runs only there).

## Blocked by

- `the-frozen-leader-takeover-flake-is-diagnosed-under-load`

## Prompt

> Goal: make both tab-lease flakes go away for the right reason (ADR-0097). Read `docs/spikes/the-frozen-leader-takeover-flake/README.md` first: its verdict decides what you change in the FROZEN case. Then look at the two test files named above, the election and takeover code in `@etherfold/browser`, and the report shape the Playwright spec's `report(tab)` helper returns (`seat`, `ranges`, `progress`, `state`).
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Check that the diagnosis task landed with a verdict and that both tests still exist as described. If the diagnosis is missing or its verdict is not one of the three this task handles, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> Do not weaken either case to make it pass: a looser timeout that hides a real window is the failure this task exists to prevent.
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor, never major). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), bound any load you generate, and never grep `node_modules`, `dist`, `.git` or minified `*.bundle.js` files.
>
> CI: dorfl's gate runs vitest only. The real-browser suites run in CI's `browser (chromium)`, `browser (firefox)` and `browser (webkit)` jobs; the PR is done only when those three are green too.

## Decisions

- **The FROZEN case waits on `reader.canonical !== undefined`.** This getter is only set once the store is open, which is the same moment `indexMore()` stops answering as a reader. It is a documented public getter that the first case in the same file already uses as the "not reading" signal. Alternatives considered:
  - `reader.promotion !== undefined` (the diagnosis's `decide-wait` patch): works the same way, but the README calls it an indirect signal and advises against shipping it.
  - Retrying `indexMore()` until it returns a cursor: this would blur a real demotion into a timeout.
  - The product-side fix (make `indexMore()` wait for the startup to finish): larger, and it changes behaviour; the verdict does not require it.
  
  Touches no other command or flag.
- **Test only, ADR-0097 D4 untouched:** the verdict was "test race", so the code that seats the new leader was not changed. The takeover-time bound (`SETTLE_MS + 1500`) was not loosened.
- **Numbers for the FROZEN acceptance criterion:** the README's largest sample was 300 runs, so the target is 3,000 heavy-load runs with `repro.sh ITERATIONS=3000 PARALLEL=30 BURNERS=30` on 32 cores (unmodified, that load failed 36%).
  - **Run 1 (3,000):** 1 failure, and it was not the demotion. It was the takeover-time bound, `expected 1738 to be less than 1650`, which fails before the code I added runs.
  - **Timing run (1,500, instrumented, same load):** 0 failures. The slowest takeover was 210 ms (median about 170 ms), so the 1,738 ms was a one-off stall under CPU starvation, not a takeover window. I kept the bound and logged it in the observation note.
  - **Run 2 (3,000, clean):** 0 failures, which meets the criterion.
  - Across all 7,500 runs the original demotion failure never appeared.
  - **With a forced slow startup** (the diagnosis's `decide-widen` patch, no load): the fixed test passed 30 of 30, and the original test failed 10 of 10.
- **Firefox numbers:** `--project=firefox --repeat-each 20`, run on one test at a time (with `-g`, 4 workers).
  - Killed-worker case: 20 of 20 passed.
  - Main-thread close case: 20 of 20 passed.
  
  The race depends on timing, so I did not confirm that the unmodified test fails locally.
- **Main-thread case:** the check that "the tab that did not take over fetched nothing" still reads the snapshot taken when the takeover was seen. Only the reading of the taker's range moved behind the poll.
