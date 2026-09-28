---
title: 'Diagnose why a new tab-lease leader is demoted right after it displaces a frozen leader'
slug: the-frozen-leader-takeover-flake-is-diagnosed-under-load
blockedBy: []
covers: []
---

## What to build

A DIAGNOSIS, not a fix. On PR #250's `verify` job, `packages/browser/test/aVisibleTabTakesTheLeaseFromABackgroundedLeader.test.ts`, "a FROZEN leader, which never answers and never learns, is displaced within the settle time, and the store stays correct when both write", failed on 2 of 3 CI runs with `this indexer was DEMOTED to a reader (unknown)` thrown from `indexToTip(reader)` (around test line 275): the NEW leader was demoted right after its takeover. It passed on the third run and 5 of 5 times locally. The test's own design says the frozen leader's write must be the one refused (ADR-0097, "Election is for cost, never for correctness"), so either the test races (for example the frozen leader's still-running loop claims or writes between the takeover and the new leader's first advance in a way the test does not intend), or the takeover has a real window in which a displaced leader can make the new leader's claim lose. Which one it is is not established, and this task establishes it with evidence. Do not guess.

Reproduce first: repeat the one test (vitest `-t '<name>'` from `packages/browser`, many iterations) under load, for example with CPU contention or several parallel runs, until the failure rate is measured. Keep the load bounded (at most as many parallel runs as the machine has cores minus two, each under `timeout`), because an unbounded stress run can drive a developer machine into swap. Then instrument (temporary logging, or a trace the test collects) enough to name, for a failing run, the ordered sequence of lock grants, writer claims, applied blocks and the demotion, and why the demotion's reason is `unknown` rather than `write-refused` or `lease-lost`.

## Acceptance criteria

- [ ] `docs/spikes/the-frozen-leader-takeover-flake/` holds the repro script (committed, re-runnable, bounded) and a `README.md` stating: the load used, the iterations and failure rate with and without load, the event sequence of at least one failing run, and a VERDICT that is one of "test race" or "real takeover window", with the evidence that decides it. If no failure reproduces within a stated budget, the verdict is "not reproduced" with the budget and the conditions tried.
- [ ] If the verdict is "real takeover window", the README names the code path and the smallest change that closes it, and says whether that change alters ADR-0097 D4's contract.
- [ ] If the demotion reason `unknown` is itself a reporting gap (a demotion path that does not name its cause), the README says which path.
- [ ] No production code changes land in this task (temporary instrumentation is reverted); the repro script is the only new code. No changeset is needed unless a published package's directory changes.
- [ ] CI: the PR's CI is green as a whole (the script lives under `docs/spikes/`, outside the test run).

## Blocked by

- None: can start immediately.

## Prompt

> Goal: find out, with evidence, whether the FROZEN-leader flake is a test race or a real window in the foreground takeover (ADR-0097 D4 as amended 2026-09-28). Look at the test file above (the FROZEN case stubs `BroadcastChannel` with a silent channel and wraps `navigator.locks.request` so the frozen leader never learns it lost), the election and takeover code in `@etherfold/browser` (`leaderIsDisplaceable`, the `steal` request, `demoteToReader`, the writer claim through `createState`, ADR-0078's fresh start), and the writer claim in `@etherfold/state-store` (`openForWriting`, ADR-0075 and ADR-0077). The done tasks `a-visible-tab-takes-the-lease-from-a-backgrounded-leader` and `one-tab-indexes-and-the-others-read` are where the suites came from.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Read ADR-0097 and check the test still exists as described. If it was changed or deleted since, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> The fix is `the-tab-lease-suites-stop-flaking`, which is blocked by this task and reads your README. Do not fix anything here.
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Never write an em dash character. Bound every shell command (`timeout`, `head`), cap parallel load as stated above, and never grep `node_modules`, `dist`, `.git` or minified `*.bundle.js` files.
