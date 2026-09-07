---
title: The snapshot-only mode test never exercises the inside-reorg-window guard
slug: the-snapshot-only-mode-test-never-exercises-the-inside-reorg-window-guard
---

2026-09-07, spotted while reviewing PR #95..#96 for `a-generation-runs-with-no-stream-keeper-at-all`.

`packages/browser/test/snapshotOnlyMode.test.ts` publishes its snapshot with `fakeChain(BRANCH_A, SNAPSHOT_TIP)`, so the snapshot's `takenAt` equals its producer's observed `latestBlock`. The client then bootstraps without passing `finalityDepth`. ADR-0028's defence against a snapshot taken too close to the tip has two sides: the producer takes it at least the finality depth behind the tip, and the consumer refuses one that was not. The consumer side is `insideReorgWindow` in `packages/processor-entities/src/snapshot.ts` (`takenAt > tip - finalityDepth` → `not-bootstrapped` / `inside-reorg-window`), and with `finalityDepth` absent it never runs. Had the case passed `finalityDepth: FINALITY`, all three bootstraps would have been refused on this fixture.

Nothing the task asserted is weakened by this: the emptiness claim, the equivalence run, the reorg case and the reload case are all sound, and the reorg case's separate choice of `SNAPSHOT_TIP = 102` is correct for its own reason (a snapshot at the branch tip makes `revertTo` throw `RevertBeyondSnapshotError`). The signal is narrower: the file is the reference a developer will copy the mode FROM, and what it shows omits the consumer-side guard.

Two places this may matter:

- the documentation of this mode should state the producer rule (take the snapshot at least the finality depth behind the tip) and show `finalityDepth` being passed, rather than reproducing the fixture's shape;
- the stream-seed loader's capture-depth check is the stream analogue of exactly this guard, so it is worth confirming the seed path does not inherit the same "guard present, never exercised" gap.

Cheap fix if someone wants it: publish with `fakeChain(BRANCH_A, BRANCH_A_TIP)` and pass `finalityDepth: FINALITY` in `seededFromTheSnapshot`, or add one line saying why the guard is deliberately off in that fixture.
