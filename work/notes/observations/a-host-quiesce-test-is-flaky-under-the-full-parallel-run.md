---
title: '`aHostIsNotKilledUnlessItIsQuiet` fails intermittently under the full parallel `pnpm test`, and never on its own'
slug: a-host-quiesce-test-is-flaky-under-the-full-parallel-run
observed: 2026-09-14
---

2026-09-14 — Noticed while gating `an-endpoint-triggers-a-reconfigure-in-a-running-process`, which touches only `@etherfold/server` and `etherfold` (neither is a dependency of `@etherfold/browser`). `packages/browser/test/aHostIsNotKilledUnlessItIsQuiet.test.ts` > "asks the host to STOP before releasing it, and reports quiesced" failed on two of five full `pnpm test` runs, and passed every time in isolation (3/3) and under a whole-package `pnpm --filter @etherfold/browser test` (350/350), so it reads as a load-sensitive timing assumption rather than a defect in the behaviour.

Recorded rather than chased: it is outside that task, and a wall-clock assumption in a quiesce test is exactly the kind of thing that turns an unrelated agent's gate red at random.
