# The tab-lease suites flake in CI

Observed 2026-09-28 by the conductor driving the query-layer tasks, on PRs that did not touch the takeover path:

- PR #243 (`every-backend-stores-a-u256-canonically`), `browser (firefox)`: `packages/browser/browser/oneTabIndexesAndTheOthersRead.spec.ts:178` ("a dedicated-worker host per tab: the lock is held in the worker, and KILLING it hands over") failed with `TypeError: Cannot read properties of undefined (reading 'from')` at `taker.ranges[0]!.from` (line 214): the tab that took over had not reported a fetched range yet when it was read. Passed on rerun.
- PR #250 (`a-worker-host-answers-graphql-over-its-port`), `verify`: `packages/browser/test/aVisibleTabTakesTheLeaseFromABackgroundedLeader.test.ts`, "a FROZEN leader, which never answers and never learns, is displaced within the settle time", failed on 2 of 3 CI runs with `this indexer was DEMOTED to a reader (unknown)` thrown from `indexToTip(reader)` (test line 275), i.e. the new leader was demoted right after its takeover. It passed on the third run, and 5 of 5 times locally, alone and in the full package run.

Both suites landed just before (`one-tab-indexes-and-the-others-read`, `a-visible-tab-takes-the-lease-from-a-backgrounded-leader`), and both failures are timing reads on a loaded CI runner: one reads a report before it exists, the other lets the frozen leader's still-running loop write between the takeover and the new leader's first advance. Neither was reproduced, so whether the second is a test race or a real window in the takeover is not established.
