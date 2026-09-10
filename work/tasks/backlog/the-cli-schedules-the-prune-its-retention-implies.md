---
title: 'The CLI schedules the prune its retention implies, on a budget a serverless host can use'
slug: the-cli-schedules-the-prune-its-retention-implies
spec: a-configured-window-is-actually-pruned
blockedBy: []
covers: [1, 4, 5, 6, 7, 12]
needsAnswers: true
---

## What to build

The same gap on the server side. `VersionedStateStore.prune` is implemented, budgeted and logs what it dropped, and no host calls it.

**The host here is the CLI, not `@etherfold/server`.** Verified: `packages/server` has no state-store dependency at all (its deps are `@etherfold/core`, `hono`, `named-logs`, `remote-sql`) and zero mutating calls; its only `StateStore` mentions are two prose comments. The server-side store is constructed in `packages/cli/src/folding.ts` and the recurring loop is `packages/cli/src/run.ts`. Note the CLI package is named **`etherfold`**, not `@etherfold/cli`.

**The trigger is a FLOOR, not a window.** `retentionFloor` (`packages/state-store/src/retention.ts`) returns a floor for `'window'` AND for `'revert-only'` when a `finalityDepth` is stated, and `undefined` for `'unbounded'` and for `revert-only` with no depth. So the condition is "this store has a floor", never "a window is set". Getting this wrong leaves a `revert-only` deployment refusing every historical read while retaining every version for ever, which is the exact defect this spec exists to kill, on the setting a browser app is told to prefer.

**The budget is the serverless story too.** `d1PruneBudget` (`platforms/cf-worker/src/d1.ts`) already computes how many versions may be deleted per invocation for a D1 plan, and is already exercised by `platforms/cf-worker/test/d1-limits.test.ts`. What has never existed is a host that LOOPS on `complete` with such a budget. Build the loop so that a budget is an argument rather than a constant, which is what makes it usable from a Worker's `scheduled` handler without this task inventing one.

## Acceptance criteria

- [ ] A CLI deployment whose store has a floor drops versions below it, asserted on stored version counts.
- [ ] A `revert-only` store with a `finalityDepth` prunes, because it has a floor.
- [ ] The live version of an entity survives a prune however old it is.
- [ ] The pruning loop takes its budget as a PARAMETER and loops until `complete`, so a caller with a per-invocation query allowance (a D1 host supplying `d1PruneBudget`) can drive the same loop without reimplementing it.
- [ ] A budgeted sequence of passes reaches the same end state as one unbounded pass, asserted rather than assumed.
- [ ] Nothing in the ingest or apply path performs a delete.
- [ ] `@etherfold/server` is not given a state-store dependency by this task. If you believe it needs one, that is a STOP: it would invert the layering the CLI and server already document.
- [ ] A changeset accompanies the change (`pnpm changeset`). This touches PUBLISHED packages and `pnpm changeset status --since=main` is in the acceptance gate.

## Blocked by

None, can start immediately.

## Prompt

Read `work/specs/tasked/a-configured-window-is-actually-pruned.md`, then `packages/state-store/src/retention.ts` (`retentionFloor`, every arm; `pruneBudget`; `PruneReport.complete`) and `packages/state-store-sqlite/src/store.ts`, whose `prune` already exists and whose docstring states the defect this closes: a deployment that never prunes "gets a store bounded in what it answers and unbounded in what it holds".

Then read `packages/cli/src/folding.ts` around `stateFor` (this is where `new VersionedStateStore(...)` happens) and `packages/cli/src/run.ts` (the loop). Confirm for yourself that `packages/server` constructs no store before you accept this task's premise.

Domain vocabulary: **retention** is in BLOCK NUMBERS (ADR-0019); `prune` is a call the HOST schedules, never a side effect of a write (ADR-0022). The shape to copy is the one `rebuildMore` already has: bounded work per call, reporting whether it finished, with the host looping.

`remote-sql` exposes transactions only as `batch`, so a prune is a sequence of ordinary batched deletes and not one long transaction. Do not add a transaction verb to that seam.

Out of scope: `VACUUM` and returning space to the filesystem. Dropping rows and shrinking a file are different operations, and D1 has no `VACUUM` at all.

Done means a CLI deployment with a floor shrinks, the loop is budget-driven so a Worker could call it, and nothing about the unbounded default changed.
